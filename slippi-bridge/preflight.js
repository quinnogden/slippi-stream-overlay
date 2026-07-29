/**
 * preflight.js — pre-event health check.
 *
 *   node preflight.js              full run (file checks + live probes)
 *   node preflight.js --offline    skip anything that touches the network
 *   node preflight.js --json       machine-readable output
 *
 * Automates the mechanical parts of docs/FRESH-INSTALL.md: the files a fresh
 * clone doesn't include, the TSH settings that silently fight the bridge, and the
 * HTTP probes that prove the chain is up. Read-only by design — it reports exact
 * commands to fix things rather than changing anything itself, because "the tool
 * quietly rewrote my tournament config" is a worse failure than a manual step.
 *
 * IMPORTANT: only Node built-ins and dependency-free local modules may be
 * required at the top level. One of the things this script exists to diagnose is
 * a missing node_modules/, so it has to run before `npm install` does.
 * (config.js, tsh-root.js and clipper-settings.js are all fs/path only.)
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

const argv     = process.argv.slice(2);
const OFFLINE  = argv.includes("--offline");
const AS_JSON  = argv.includes("--json");

// ── Result accumulation ───────────────────────────────────────────────────────

/** @type {{section: string, status: string, label: string, detail: string, fix?: string}[]} */
const results = [];
let section = "general";

const at   = (name) => { section = name; };
const add  = (status, label, detail = "", fix) => results.push({ section, status, label, detail, fix });
const pass = (label, detail) => add("PASS", label, detail);
const warn = (label, detail, fix) => add("WARN", label, detail, fix);
const fail = (label, detail, fix) => add("FAIL", label, detail, fix);
const skip = (label, detail) => add("SKIP", label, detail);
const info = (label, detail) => add("INFO", label, detail);

// ── Small helpers ─────────────────────────────────────────────────────────────

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

function countEntries(dir, filterExt) {
  try {
    const all = fs.readdirSync(dir);
    return filterExt ? all.filter((f) => f.toLowerCase().endsWith(filterExt)).length : all.length;
  } catch { return -1; }
}

/**
 * Readable text for a socket error. Node tries both ::1 and 127.0.0.1 for
 * "localhost", so a refused connection arrives as an AggregateError whose own
 * .message is an empty string — which reads as a blank failure reason.
 */
function errText(e) {
  if (!e) return "unknown error";
  if (e.message) return e.message;
  const inner = Array.isArray(e.errors) ? e.errors.map((x) => x?.message).filter(Boolean) : [];
  if (inner.length) return [...new Set(inner)].join("; ");
  return e.code ?? String(e);
}

/** GET with a hard timeout. Resolves { ok, status, body } — never rejects. */
function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (body.length < 200000) body += c; });
        res.on("end", () => finish({ ok: true, status: res.statusCode, body }));
      });
    } catch (e) {
      return finish({ ok: false, error: errText(e) });
    }

    req.on("timeout", () => { req.destroy(); finish({ ok: false, error: `no response within ${timeoutMs}ms` }); });
    req.on("error", (e) => finish({ ok: false, error: errText(e) }));
  });
}

const parseJson = (body) => { try { return JSON.parse(body); } catch { return null; } };

// ── Checks: environment + dependencies ────────────────────────────────────────

function checkNode() {
  at("environment");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) pass("Node.js", `v${process.versions.node}`);
  else fail("Node.js", `v${process.versions.node} — the bridge needs 18+`, "Install Node 18 or newer from https://nodejs.org");
}

function checkDeps() {
  at("dependencies");

  const pkgPath = path.join(__dirname, "package.json");
  const pkg = parseJson(exists(pkgPath) ? fs.readFileSync(pkgPath, "utf8") : "");
  if (!pkg) { fail("package.json", "missing or unparseable"); return; }

  if (!exists(path.join(__dirname, "node_modules"))) {
    fail("node_modules", "not installed", "cd slippi-bridge && npm install");
    return;
  }

  const missing = [];
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    try { require.resolve(dep, { paths: [__dirname] }); }
    catch { missing.push(dep); }
  }

  if (missing.length === 0) {
    pass("Dependencies", `${Object.keys(pkg.dependencies).length} resolved`);
  } else if (missing.length === 1 && missing[0] === "uiohook-napi") {
    // Native module. Its absence costs the global hotkey and nothing else, so it
    // must not read as a blocking failure the night before an event.
    warn("uiohook-napi", "not resolvable — the global Ctrl+Shift+S hotkey degrades to pressing S in the terminal",
         "cd slippi-bridge && npm install uiohook-napi");
  } else {
    fail("Dependencies", `not resolvable: ${missing.join(", ")}`, "cd slippi-bridge && npm install");
  }
}

// ── Checks: bridge config ─────────────────────────────────────────────────────

function checkBridgeConfig() {
  at("bridge config");

  let config;
  try {
    config = require("./config");
  } catch (e) {
    fail("config.js", `failed to load: ${e.message}`);
    return null;
  }
  pass("config.js", "loaded");

  // config.local.js — optional, but it's where the token and per-machine paths go.
  if (exists(path.join(__dirname, "config.local.js"))) {
    pass("config.local.js", "present");
  } else {
    warn("config.local.js", "absent — start.gg reporting stays disabled and machine-specific paths fall back to committed defaults",
         "cd slippi-bridge && cp config.local.example.js config.local.js");
  }

  // Never print the token itself; length is enough to tell "set" from "pasted wrong".
  const token = config.STARTGG_TOKEN ?? "";
  if (token) pass("start.gg token", `set (${token.length} chars)`);
  else warn("start.gg token", "not set — the Report to start.gg button will stay disabled");

  if (!config.SLP_FOLDER) {
    fail("SLP_FOLDER", "not configured");
  } else if (!exists(config.SLP_FOLDER)) {
    fail("SLP_FOLDER", `does not exist: ${config.SLP_FOLDER}`,
         "Point SLP_FOLDER at this machine's Slippi spectate folder (override it in config.local.js)");
  } else {
    const slp = countEntries(config.SLP_FOLDER, ".slp");
    if (slp < 0) fail("SLP_FOLDER", `exists but is not readable: ${config.SLP_FOLDER}`);
    // Pre-existing files are snapshotted and ignored at startup, so any count is fine.
    else pass("SLP_FOLDER", `readable, ${slp} existing .slp file(s) (ignored at startup)`);
  }

  info("Ports", `TSH ${config.TSH_URL}, bridge ${config.BRIDGE_PORT}, scoreboard ${config.SCOREBOARD_NUM}`);
  return config;
}

// ── Checks: TSH install ───────────────────────────────────────────────────────

function checkTshInstall(config) {
  at("TSH install");

  let tshRoot;
  try {
    const { resolveTshRoot } = require("./tsh-root");
    tshRoot = resolveTshRoot(REPO_ROOT, config?.TSH_ROOT ?? null);
    pass("TSH root", path.basename(tshRoot));
  } catch (e) {
    fail("TSH root", e.message);
    return null;
  }

  const launcher = ["TSH.exe", "TSH_bat.bat", "main.py"].find((f) => exists(path.join(tshRoot, f)));
  if (launcher) pass("Launcher", launcher);
  else fail("Launcher", "none of TSH.exe / TSH_bat.bat / main.py found");

  // ── The custom layouts. A TSH release zip also ships a layout/ folder, so
  // extracting a release over the repo replaces these with TSH's stock ones and
  // OBS shows the wrong overlay with no error anywhere.
  const required = [
    "theme.css", "main.css", "logo.png", "ThePark.png",
    "scoreboard/melee.html", "scoreboard/meleePlayers.html", "scoreboard/index.js", "scoreboard/index.css",
    "side-panel/side-panel.html", "side-panel/side-panel.js", "side-panel/side-panel.css",
    "bracket/index.html", "bracket/index.js", "bracket/index.css",
  ];
  const missingLayout = required.filter((rel) => !exists(path.join(tshRoot, "layout", rel)));
  if (missingLayout.length === 0) pass("Custom layouts", `all ${required.length} present`);
  else fail("Custom layouts", `missing: ${missingLayout.join(", ")}`,
            'git checkout -- "TournamentStreamHelper-*/layout/"');

  checkLayoutNotClobbered(tshRoot);
  checkUserData(tshRoot);
  return tshRoot;
}

/**
 * Detect stock TSH layouts having landed on top of the tracked custom ones.
 * The files all still *exist* in that case, so only git can tell.
 */
function checkLayoutNotClobbered(tshRoot) {
  const rel = `${path.basename(tshRoot)}/layout`;
  let out;
  try {
    out = execFileSync("git", ["status", "--porcelain", "--", rel],
                       { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    skip("Layout integrity", "git not available or not a repo — cannot compare against the tracked layouts");
    return;
  }

  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    pass("Layout integrity", "matches the committed custom layouts");
    return;
  }

  const changed = lines.filter((l) => /^(M|D| M| D|MM)/.test(l));
  if (changed.length) {
    warn("Layout integrity", `${changed.length} tracked layout file(s) modified or deleted — a TSH release may have overwritten them`,
         'Review with: git diff -- "TournamentStreamHelper-*/layout/"   then restore with: git checkout -- "TournamentStreamHelper-*/layout/"');
  } else {
    info("Layout integrity", `${lines.length} untracked file(s) under layout/ (harmless)`);
  }
}

/** user_data/ is gitignored, so a fresh clone has none of it. */
function checkUserData(tshRoot) {
  at("TSH user_data");
  const ud = path.join(tshRoot, "user_data");

  if (!exists(ud)) {
    fail("user_data/", "missing — copy it from your previous TSH install");
    return;
  }

  const icons = path.join(ud, "games", "ssbm", "base_files", "icon");
  const iconCount = countEntries(icons, ".png");
  if (iconCount > 0) pass("Character icons", `${iconCount} PNGs in games/ssbm/base_files/icon`);
  else fail("Character icons", "games/ssbm/base_files/icon is missing or empty — no character icons will render",
            "Copy user_data/games/ from the previous TSH install");

  const stages = countEntries(path.join(ud, "games", "ssbm", "stage_icon"), ".png");
  if (stages > 0) pass("Stage icons", `${stages} PNGs`);
  else warn("Stage icons", "games/ssbm/stage_icon is missing or empty — per-game stage reporting will log warnings and skip (cosmetic)");

  // A fresh extract *creates* these as empty stubs, so existence proves nothing.
  const players = sizeOf(path.join(ud, "local_players.json"));
  if (players > 2) pass("local_players.json", `${(players / 1024).toFixed(1)} KB`);
  else if (players >= 0) warn("local_players.json", "empty stub ({}) — the player database wasn't copied across",
                              "Copy user_data/local_players.json from the previous TSH install");
  else warn("local_players.json", "missing");

  if (exists(path.join(ud, "pronouns_list.txt"))) pass("pronouns_list.txt", "present");
  else warn("pronouns_list.txt", "missing");
}

// ── Checks: TSH settings.json ─────────────────────────────────────────────────

/**
 * The four `general` keys that decide whether TSH cooperates with the bridge or
 * fights it. See docs/FRESH-INSTALL.md Phase 4 for why each one matters.
 */
function checkTshSettings(tshRoot, config) {
  at("TSH settings");
  if (!tshRoot) { skip("settings.json", "TSH root unresolved"); return; }

  const file = path.join(tshRoot, "user_data", "settings.json");
  if (!exists(file)) {
    fail("settings.json", "missing — TSH will start on its own defaults (web server port 5500, auto-update on)");
    return;
  }

  const s = parseJson(fs.readFileSync(file, "utf8"));
  if (!s) { fail("settings.json", "present but not valid JSON"); return; }

  const g = s.general ?? {};

  // Cross-check the port against what the bridge and the OBS sources expect,
  // rather than hardcoding 5000 here.
  const expectedPort = Number(new URL(config?.TSH_URL ?? "http://localhost:5000").port || 80);
  const actualPort   = g.webserver_port;
  if (actualPort === expectedPort) {
    pass("webserver_port", `${actualPort} — matches TSH_URL`);
  } else if (actualPort == null) {
    fail("webserver_port", `not set — TSH 5.972 defaults to 5500, but this setup expects ${expectedPort}`,
         `Set general.webserver_port to ${expectedPort} (TSH → Settings → General), or point TSH_URL at the port TSH is really using`);
  } else {
    fail("webserver_port", `${actualPort}, but TSH_URL expects ${expectedPort} — start-all will time out while TSH runs fine on the other port`,
         `Set general.webserver_port to ${expectedPort} (TSH → Settings → General)`);
  }

  if (g.disable_scoreupdate === true) {
    pass("disable_scoreupdate", "true");
  } else {
    fail("disable_scoreupdate", "not true — TSH's auto-update will write start.gg's scores over the ones the bridge is driving from live games",
         "Enable 'Disable automatic score updating for the scoreboard' in TSH → Settings → General");
  }

  if (g.disable_autoupdate === true) {
    pass("disable_autoupdate", "true");
  } else {
    warn("disable_autoupdate", "not true — TSH re-pulls the selected set from start.gg every 5s",
         "Enable 'Disable automatic set updating for the scoreboard' in TSH → Settings → General");
  }

  if (g.hide_track_player === true) pass("hide_track_player", "true");
  else info("hide_track_player", "not set — start.gg player tracking UI stays visible (cosmetic)");

  if (s.TOURNAMENT_URL) pass("TOURNAMENT_URL", String(s.TOURNAMENT_URL));
  else warn("TOURNAMENT_URL", "not set — no bracket, stream queue, or side-panel tournament data");
}

// ── Checks: clipper + OBS-side settings ───────────────────────────────────────

function checkClipper(config) {
  at("combo clipper");

  let settings;
  try {
    const { ClipperSettings } = require("./clipper-settings");
    settings = new ClipperSettings(config).get();
  } catch (e) {
    fail("clipper settings", `could not load: ${e.message}`);
    return null;
  }

  const file = path.join(__dirname, "clipper-settings.json");
  if (exists(file)) {
    if (parseJson(fs.readFileSync(file, "utf8"))) pass("clipper-settings.json", "present and valid");
    else warn("clipper-settings.json", "not valid JSON — the bridge falls back to committed defaults and logs it",
              "Delete it and re-save from the control panel");
  } else {
    info("clipper-settings.json", "absent (normal first run) — using config.CLIPPER defaults; the control panel writes it on first save");
  }

  if (!settings.enabled) {
    info("Clipper", "disabled — no combo detection, no OBS socket");
  } else {
    pass("Clipper", "enabled");
    info("Thresholds", `${settings.minMoves}+ moves, ${settings.minDamage}%+, requireKill=${settings.requireKill}, cooldown ${settings.cooldownSec}s, delay ${settings.saveDelayMs}ms`);
    // Report set/not-set only. The password is a secret even in a local report.
    info("OBS target", `${settings.obsUrl} (password ${settings.obsPassword ? "set" : "not set"})`);

    if (!settings.clipFolder) {
      warn("Clip folder", "not set — the control panel shows nothing and the OBS playlist script has no folder to watch");
    } else if (!exists(settings.clipFolder)) {
      warn("Clip folder", `does not exist: ${settings.clipFolder}`);
    } else {
      pass("Clip folder", `${countEntries(settings.clipFolder)} file(s) in ${settings.clipFolder}`);
    }
  }

  return settings;
}

// ── Live probes ───────────────────────────────────────────────────────────────

async function probeTsh(config, tshRoot) {
  at("TSH (live)");

  const res = await httpGet(`${config.TSH_URL}/`);
  // Any HTTP response means the server is up — TSH answers / with a 404.
  if (res.ok) pass("TSH web server", `HTTP ${res.status} from ${config.TSH_URL}`);
  else {
    fail("TSH web server", `${config.TSH_URL} — ${res.error}`,
         "Start TSH (or slippi-bridge/start-all.bat). If TSH is already open, check general.webserver_port.");
    return;
  }

  if (!tshRoot) return;

  const stateFile = path.join(tshRoot, "out", "program_state.json");
  if (!exists(stateFile)) {
    warn("program_state.json", "not written yet — TSH creates it once it has finished loading");
  } else {
    const state = parseJson(fs.readFileSync(stateFile, "utf8"));
    const num = String(config.SCOREBOARD_NUM);
    if (!state) warn("program_state.json", "present but not parseable this instant (TSH may be mid-write)");
    else if (!state.score?.[num]) fail("program_state.json", `has no score["${num}"] — SCOREBOARD_NUM ${num} does not exist in TSH`);
    else {
      const t = state.score[num].team ?? {};
      const names = ["1", "2"].map((k) => t[k]?.player?.["1"]?.name || "—");
      pass("program_state.json", `scoreboard ${num}: ${names[0]} vs ${names[1]}`);
    }
  }

  const nameFile = path.join(tshRoot, "out", "tournamentInfo", "tournamentName.txt");
  if (exists(nameFile)) pass("Tournament name", fs.readFileSync(nameFile, "utf8").trim() || "(blank)");
  else warn("Tournament name", "out/tournamentInfo/tournamentName.txt absent — the side panel header will be empty");
}

async function probeBridge(config) {
  at("bridge (live)");
  const base = `http://localhost:${config.BRIDGE_PORT}`;

  const id = await httpGet(`${base}/api/identity`);
  if (!id.ok) {
    warn("Bridge", `not running on ${base} — ${id.error}`, "Start it with slippi-bridge/start-bridge.bat (or node index.js)");
    return;
  }
  const idJson = parseJson(id.body);
  if (idJson?.app === "slippi-bridge") pass("Bridge", `running (pid ${idJson.pid})`);
  else fail("Bridge", `something else is serving port ${config.BRIDGE_PORT} — it did not identify as slippi-bridge`,
            "Free the port, or move the bridge with BRIDGE_PORT in config.local.js");

  const st = await httpGet(`${base}/api/status`);
  const s = st.ok ? parseJson(st.body) : null;
  if (!s) { warn("/api/status", st.ok ? "unparseable response" : st.error); return; }

  s.tsh    ? pass("Health: TSH",    "up")   : fail("Health: TSH",    "the bridge cannot reach TSH");
  s.slippi ? pass("Health: Slippi", "up")   : fail("Health: Slippi", `SLP_FOLDER unreadable: ${s.slippiDetail?.detail ?? ""}`);

  if (s.portMapping) {
    const m = s.portMapping.method ?? s.portMapping.resolutionMethod ?? "unknown";
    if (m === "positional") warn("Port → Team", "decided positionally — a low-confidence guess; verify sides before game 1");
    else info("Port → Team", `decided by ${m}`);
  }
  if (s.tshSwapped != null) info("TSH swap state", String(s.tshSwapped));
  info("start.gg reporting", s.startggEnabled ? "enabled" : "disabled (no token)");

  const obs = s.clipper?.obs;
  if (obs?.enabled) {
    obs.connected ? pass("Clipper → OBS", `connected to ${obs.url}`)
                  : warn("Clipper → OBS", obs.lastError || "not connected");
    if (obs.bufferActive === false) warn("Replay buffer", "not running in OBS — nothing to save until it is");
    else if (obs.bufferActive === true) pass("Replay buffer", "running");
  }
}

/**
 * Direct OBS probe — independent of whether the bridge is up, and the only way
 * to check the buffer *length*, which is the setting that quietly truncates
 * clips (conversions run 6-9s and the clipper waits saveDelayMs on top).
 */
async function probeObs(settings) {
  at("OBS (live)");
  if (!settings) { skip("OBS", "clipper settings unavailable"); return; }

  let OBSWebSocket;
  try {
    ({ OBSWebSocket } = require("obs-websocket-js"));
  } catch {
    skip("OBS", "obs-websocket-js not installed");
    return;
  }

  // With the clipper off, nothing in the bridge touches OBS — an unreachable OBS
  // is then just information, not a warning about a broken setup. Still probed,
  // so the chain can be proven before the clipper is switched on.
  const unreachable = settings.enabled ? warn : info;

  const obs = new OBSWebSocket();
  try {
    await obs.connect(settings.obsUrl || "ws://127.0.0.1:4455", settings.obsPassword || undefined);
    pass("OBS WebSocket", `connected to ${settings.obsUrl}`);
  } catch (e) {
    const msg = errText(e);
    unreachable("OBS WebSocket", /authentication/i.test(msg)
      ? "password rejected (OBS → Tools → WebSocket Server Settings → Show Connect Info)"
      : `cannot reach ${settings.obsUrl} — ${msg}${settings.enabled ? "" : " (clipper is off, so nothing depends on this)"}`);
    return;
  }

  try {
    const { outputActive } = await obs.call("GetReplayBufferStatus");
    outputActive ? pass("Replay buffer", "running")
                 : warn("Replay buffer", "not running", "Start it in OBS, or leave 'Auto-start OBS buffer' on in the dock (the first combo is still lost)");

    // Best-effort: the buffer length lives in the profile config, and which key
    // holds it depends on Simple vs Advanced output mode. Reported raw so a
    // wrong guess about the key is visible rather than silently reassuring.
    try {
      const mode = (await obs.call("GetProfileParameter", { parameterCategory: "Output", parameterName: "Mode" })).parameterValue;
      const category = mode === "Advanced" ? "AdvOut" : "SimpleOutput";
      const raw = (await obs.call("GetProfileParameter", { parameterCategory: category, parameterName: "RecRBTime" }));
      const secs = Number(raw.parameterValue ?? raw.defaultParameterValue);
      if (!Number.isFinite(secs)) info("Buffer length", `could not read (${category}/RecRBTime empty; ${mode} mode)`);
      else if (secs >= 20) pass("Buffer length", `${secs}s (${mode} mode)`);
      else warn("Buffer length", `${secs}s — too short; combos run 6-9s and the clipper waits ~${settings.saveDelayMs}ms after detection`,
                "OBS → Settings → Output → Replay Buffer → at least 20s");
    } catch (e) {
      info("Buffer length", `not readable via obs-websocket (${e?.message ?? e})`);
    }
  } finally {
    await obs.disconnect().catch(() => {});
  }
}

// ── Reporting ─────────────────────────────────────────────────────────────────

const ICON = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL", SKIP: "SKIP", INFO: "info" };

function report() {
  const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});

  if (AS_JSON) {
    console.log(JSON.stringify({ counts, results }, null, 2));
    return counts;
  }

  let current = null;
  for (const r of results) {
    if (r.section !== current) {
      current = r.section;
      console.log(`\n── ${current} ${"─".repeat(Math.max(0, 58 - current.length))}`);
    }
    console.log(`  ${ICON[r.status]}  ${r.label}${r.detail ? `: ${r.detail}` : ""}`);
    if (r.fix) console.log(`        → ${r.fix}`);
  }

  const line = ["FAIL", "WARN", "PASS", "SKIP"].map((k) => `${counts[k] ?? 0} ${k.toLowerCase()}`).join(", ");
  console.log(`\n${"═".repeat(62)}\n  ${line}`);

  if (counts.FAIL) console.log("  Not ready — fix the FAIL items above.");
  else if (counts.WARN) console.log("  Usable, with caveats. Review the WARN items.");
  else console.log("  All clear.");
  console.log("  Full checklist: docs/FRESH-INSTALL.md");

  return counts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  if (!AS_JSON) console.log("slippi-bridge preflight" + (OFFLINE ? " (offline)" : ""));

  checkNode();
  checkDeps();
  const config   = checkBridgeConfig();
  const tshRoot  = config ? checkTshInstall(config) : null;
  if (config) checkTshSettings(tshRoot, config);
  const clipper  = config ? checkClipper(config) : null;

  if (OFFLINE) {
    at("live probes");
    skip("Live probes", "--offline");
  } else if (config) {
    await probeTsh(config, tshRoot);
    await probeBridge(config);
    await probeObs(clipper);
  }

  const counts = report();
  process.exit(counts.FAIL ? 1 : 0);
})();
