/**
 * preflight.js — pre-event health check.
 *
 *   node scripts/preflight.js              full run (file checks + live probes)
 *   node scripts/preflight.js --offline    skip anything that touches the network
 *   node scripts/preflight.js --json       machine-readable output
 *
 * Automates the mechanical parts of docs/FRESH-INSTALL.md: the files a fresh
 * clone doesn't include (the token, the player DB), the ones that fail silently
 * on stream (the theme pack, the icons, the overlay pages), and the probes that
 * prove the chain is up (the app, start.gg, this week's events, OBS). Read-only
 * by design — it prints the command that fixes each thing rather than changing
 * anything, because "the tool quietly rewrote my config" is a worse failure
 * than a manual step.
 *
 * IMPORTANT: only Node built-ins may be required at the top level. One of the
 * things this script exists to diagnose is a missing node_modules/, so it has
 * to run before `npm install` does. Local modules are required inside the check
 * that uses them, and only the dependency-free ones before the dependency check
 * has passed (config.js, hotkey.js, char_map.js, api/setup.js and
 * clipper-settings.js are fs/path only). tests/preflight.test.js runs this
 * script, so a broken lazy require fails a test rather than a pre-event check.
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");

// This script lives in app/scripts/: the app is one level up, the
// repo root (overlays/ beside it) two.
const BRIDGE_DIR   = path.resolve(__dirname, "..");
const REPO_ROOT    = path.resolve(__dirname, "..", "..");
const OVERLAYS_DIR = path.join(REPO_ROOT, "overlays");

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
const rel = (p) => path.relative(REPO_ROOT, p) || ".";

/** Old TSH installs beside the repo — not used by the app, kept for rollback. */
function tshFolders() {
  try {
    return fs.readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^TournamentStreamHelper/.test(d.name))
      .map((d) => path.join(REPO_ROOT, d.name));
  } catch { return []; }
}

// ── Checks: environment + dependencies ────────────────────────────────────────

function checkNode() {
  at("environment");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) pass("Node.js", `v${process.versions.node}`);
  else fail("Node.js", `v${process.versions.node} — the app needs 18+`, "Install Node 18 or newer from https://nodejs.org");
}

/** @returns {boolean} whether every dependency resolves (uiohook-napi aside) */
function checkDeps() {
  at("dependencies");

  const pkg = parseJson(exists(path.join(BRIDGE_DIR, "package.json"))
    ? fs.readFileSync(path.join(BRIDGE_DIR, "package.json"), "utf8") : "");
  if (!pkg) { fail("package.json", "missing or unparseable"); return false; }

  if (!exists(path.join(BRIDGE_DIR, "node_modules"))) {
    fail("node_modules", "not installed", "cd app && npm install   (start.bat does this on its first run)");
    return false;
  }

  const missing = [];
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    try { require.resolve(dep, { paths: [BRIDGE_DIR] }); }
    catch { missing.push(dep); }
  }

  if (missing.length === 0) {
    pass("Dependencies", `${Object.keys(pkg.dependencies).length} resolved`);
    return true;
  }
  if (missing.length === 1 && missing[0] === "uiohook-napi") {
    // Native module. Its absence costs the global hotkeys and nothing else, so
    // it must not read as a blocking failure the night before an event.
    warn("uiohook-napi", "not resolvable — the global hotkeys fall back to keys typed into the app's own window",
         "cd app && npm install uiohook-napi");
    return true;
  }
  fail("Dependencies", `not resolvable: ${missing.join(", ")}`, "cd app && npm install");
  return false;
}

// ── Checks: config ────────────────────────────────────────────────────────────

function checkConfig() {
  at("config");

  let config;
  try {
    config = require("../config");
  } catch (e) {
    fail("config.js", `failed to load: ${e.message}`);
    return null;
  }
  pass("config.js", "loaded");

  // config.local.js — optional, but it's where the token and per-machine paths go.
  if (exists(path.join(BRIDGE_DIR, "config.local.js"))) {
    pass("config.local.js", "present");
  } else {
    warn("config.local.js", "absent — no start.gg token (no Start/Report) and the committed SLP_FOLDER, which is another machine's",
         "cd app && copy config.local.example.js config.local.js");
  }

  // Never print the token itself; length is enough to tell "set" from "pasted wrong".
  const token = config.STARTGG_TOKEN ?? "";
  if (token) pass("start.gg token", `set (${token.length} chars)`);
  else warn("start.gg token", "not set — Start and Report stay off and the side panel has no stats; brackets still load (keyless)");

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

  const port = Number(config.BRIDGE_PORT);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    info("Port", `${port} — the dock is http://localhost:${port}/dock and every OBS source is http://localhost:${port}/o/…`);
  } else {
    fail("BRIDGE_PORT", `${config.BRIDGE_PORT} is not a port number`);
  }

  checkHotkeys(config);
  return config;
}

/**
 * The global hotkeys change the live score from any window, so a chord that
 * silently didn't bind is found mid-set. The app logs the same errors at
 * startup; here they are found before the event.
 */
function checkHotkeys(config) {
  let keyTable;
  try {
    keyTable = require(require.resolve("uiohook-napi", { paths: [BRIDGE_DIR] })).UiohookKey;
  } catch {
    skip("Hotkeys", "uiohook-napi not loadable — the app falls back to keys typed into its own window");
    return;
  }
  let compiled;
  try {
    compiled = require("../lib/hotkey").compileHotkeys(config.HOTKEYS, keyTable);
  } catch (e) {
    fail("Hotkeys", `could not check: ${e.message}`);
    return;
  }
  const list = compiled.bindings.map((b) => `${b.chord} ${b.label.toLowerCase()}`).join(" · ");
  if (compiled.errors.length) {
    fail("Hotkeys", compiled.errors.join("; "), "Fix HOTKEYS in config.local.js (or config.js) — the rest still bind");
  } else {
    pass("Hotkeys", list || "none bound (every HOTKEYS entry is null)");
  }
}

// ── Checks: the player DB ─────────────────────────────────────────────────────

/**
 * The player DB is per machine and gitignored, so a fresh clone has none — and
 * the app runs without it, so nothing else says so: every regular just opens
 * on no main and loses their pronoun.
 */
function checkPlayers(config) {
  at("player DB");
  const file = config.PLAYERS_FILE ?? path.join(BRIDGE_DIR, "data", "local_players.json");
  const where = config.PLAYERS_FILE ? file : `${rel(file)} (the default; PLAYERS_FILE unset)`;

  // The copy an old TSH install holds, for the fix line.
  const tshCopy = tshFolders()
    .map((d) => path.join(d, "user_data", "local_players.json"))
    .find((p) => { try { return fs.statSync(p).size > 2; } catch { return false; } });
  const mkdir = exists(path.dirname(file)) ? "" : `mkdir "${path.dirname(file)}" & `;
  const copyFix = tshCopy
    ? `${mkdir}copy "${tshCopy}" "${file}"`
    : `Moving from TSH: copy its user_data/local_players.json to ${file}, or set PLAYERS_FILE in config.local.js. `
      + "Starting fresh: nothing to do (or seed regulars from app/data/local_players.example.json — see docs/FRESH-INSTALL.md)";

  if (!exists(file)) {
    warn("Player file", `${where} doesn't exist — the app starts with an empty DB and adds start.gg players as sets load`, copyFix);
    return;
  }

  const data = parseJson(fs.readFileSync(file, "utf8"));
  if (data == null) {
    fail("Player file", `${where} is not valid JSON — the app would start with an empty DB and overwrite it on the first save`,
         "Restore it from a backup or the old TSH install");
    return;
  }
  // A fresh TSH ships the file as {} — existence proves nothing.
  const count = Array.isArray(data) ? data.length : 0;
  if (count === 0) warn("Player file", `${where} is empty`, copyFix);
  else pass("Player file", `${where} — ${count} players`);

  if (/[\\/]TournamentStreamHelper[^\\/]*[\\/]/i.test(path.resolve(file))) {
    warn("Player file", "is inside a TSH install — TSH rewrites the whole file on save, so never run TSH while the app is up",
         "Copy it into app/data/ and unset PLAYERS_FILE");
  }
}

// ── Checks: what OBS loads ────────────────────────────────────────────────────

/** Every character Slippi can report has a stock icon in every costume. */
function checkIcons() {
  at("overlays");
  const dir = path.join(OVERLAYS_DIR, "assets", "icons");
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
  } catch {
    fail("Character icons", `${rel(dir)} is missing`, "git checkout -- overlays/assets/icons");
    return;
  }
  let CHAR_MAP;
  try {
    ({ CHAR_MAP } = require("../lib/char_map"));
  } catch (e) {
    fail("Character icons", `could not check: ${e.message}`);
    return;
  }
  const have = new Set(files);
  const gaps = Object.values(CHAR_MAP)
    .filter(({ codename }) => [0, 1, 2, 3].some((n) => !have.has(`chara_2_${codename}_${String(n).padStart(2, "0")}.png`)))
    .map((c) => c.codename);
  if (gaps.length) fail("Character icons", `missing for ${gaps.join(", ")}`, "git checkout -- overlays/assets/icons");
  else pass("Character icons", `${files.length} PNGs, every character covered`);
}

/** The pages every OBS browser source names, and the scripts they all load. */
function checkPages(depsOk) {
  if (!depsOk) { skip("Overlay pages", "dependencies missing"); return; }
  let resolveOverlayPath, OVERLAYS;
  try {
    ({ resolveOverlayPath } = require("../lib/server/overlays"));
    ({ OVERLAYS } = require("../lib/server/api/setup"));
  } catch (e) {
    fail("Overlay pages", `could not check: ${e.message}`);
    return;
  }
  const urls = [...OVERLAYS.map((o) => o.path), "/o/theme.css", "/o/shared/overlay.css", "/o/shared/overlay-client.js"];
  const missing = urls.filter((u) => !resolveOverlayPath(u, { overlaysDir: OVERLAYS_DIR }));
  if (missing.length) fail("Overlay pages", `nothing to serve for ${missing.join(", ")}`, "git checkout -- overlays");
  else pass("Overlay pages", `${OVERLAYS.length} pages + the shared runtime`);
}

/**
 * overlays/theme.css is a switch: one @import naming the active pack under
 * overlays/themes/. Every colour, the brand font and both logos live in that
 * folder, so a missing or misnamed pack means an unstyled broadcast — and
 * because CSS fails silently, nothing else would report it.
 */
function checkThemePack() {
  let pack;
  try {
    pack = require("../lib/server/api/setup").activeThemePack(OVERLAYS_DIR);
  } catch (e) {
    fail("Theme pack", `could not check: ${e.message}`);
    return;
  }
  if (!pack) {
    fail("Theme pack", "overlays/theme.css has no ./themes/<pack>/theme.css @import — the active pack can't be determined",
         "git checkout -- overlays/theme.css");
    return;
  }

  const packDir = path.join(OVERLAYS_DIR, "themes", pack);
  const missing = ["theme.css", "logo.png", "sponsor.png"].filter((f) => !exists(path.join(packDir, f)));
  if (missing.length) {
    fail("Theme pack", `themes/${pack} is missing: ${missing.join(", ")}`,
         "Restore it, or point overlays/theme.css at a pack that exists");
    return;
  }
  pass("Theme pack", `${pack} (switch it in overlays/theme.css)`);

  // --logo-url / --sponsor-url are written relative to the CONSUMING overlay
  // (Chrome resolves a url() in a custom property where the var() is used), and
  // every overlay stylesheet sits one level under overlays/. A pack copied
  // without renaming these shows up only as a missing logo on stream.
  const css = fs.readFileSync(path.join(packDir, "theme.css"), "utf8");
  const broken = [];
  for (const token of ["--logo-url", "--sponsor-url"]) {
    const hit = css.match(new RegExp(`${token}\\s*:\\s*url\\(\\s*["']?([^"')]+)["']?\\s*\\)`));
    if (!hit) { broken.push(`${token} not declared`); continue; }
    if (!exists(path.resolve(OVERLAYS_DIR, "scoreboard", hit[1]))) broken.push(`${token} → ${hit[1]} (no such file)`);
  }
  if (broken.length === 0) pass("Theme logos", "--logo-url and --sponsor-url both resolve");
  else fail("Theme logos", broken.join("; "),
            `Paths are relative to an overlay, so they read "../themes/${pack}/<file>.png"`);
}

// ── Checks: clipper ───────────────────────────────────────────────────────────

function checkClipper(config) {
  at("combo clipper");

  let settings;
  try {
    const { ClipperSettings } = require("../lib/clipper-settings");
    settings = new ClipperSettings(config).get();
  } catch (e) {
    fail("clipper settings", `could not load: ${e.message}`);
    return null;
  }

  const file = path.join(BRIDGE_DIR, "clipper-settings.json");
  if (exists(file)) {
    if (parseJson(fs.readFileSync(file, "utf8"))) pass("clipper-settings.json", "present and valid");
    else warn("clipper-settings.json", "not valid JSON — the app falls back to committed defaults and logs it",
              "Delete it and re-save from the dock's Clips tab");
  } else {
    info("clipper-settings.json", "absent (normal first run) — using config.CLIPPER defaults; the Clips tab writes it on first save (every key: clipper-settings.example.json)");
  }

  if (!settings.enabled) {
    info("Clipper", "disabled — no combo detection, no OBS socket");
  } else {
    pass("Clipper", "enabled");
    info("Thresholds", `${settings.minMoves}+ moves, ${settings.minDamage}%+, requireKill=${settings.requireKill}, cooldown ${settings.cooldownSec}s, delay ${settings.saveDelayMs}ms`);
    // Report set/not-set only. The password is a secret even in a local report.
    info("OBS target", `${settings.obsUrl} (password ${settings.obsPassword ? "set" : "not set"})`);

    if (!settings.clipFolder) {
      warn("Clip folder", "not set — the Clips tab shows nothing and the OBS playlist script has no folder to watch");
    } else if (!exists(settings.clipFolder)) {
      warn("Clip folder", `does not exist: ${settings.clipFolder}`);
    } else {
      pass("Clip folder", `${countEntries(settings.clipFolder)} file(s) in ${settings.clipFolder}`);
    }
  }

  return settings;
}

/** An old TSH install is only a rollback now; say so, so nobody starts it by habit. */
function checkLeftovers() {
  const old = tshFolders();
  if (!old.length) return;
  at("leftovers");
  info("Old TSH install", `${old.map(rel).join(", ")} — the app doesn't use it. Keep it as a rollback for a couple of events, `
    + "then delete it; never run it against the app's player file");
}

// ── Live probes ───────────────────────────────────────────────────────────────

async function probeApp(config) {
  at("app (live)");
  const base = `http://localhost:${config.BRIDGE_PORT}`;

  const id = await httpGet(`${base}/api/identity`);
  if (!id.ok) {
    warn("App", `not running on ${base} — ${id.error}`, "Start it with start.bat (or node index.js in app/)");
    return;
  }
  const idJson = parseJson(id.body);
  if (idJson?.app !== "slippi-bridge") {
    fail("App", `something else is serving port ${config.BRIDGE_PORT} — it did not identify as this app`,
         "Free the port, or move the app with BRIDGE_PORT in config.local.js (and every OBS source with it)");
    return;
  }
  pass("App", `running (pid ${idJson.pid})`);

  const st = await httpGet(`${base}/api/status`);
  const s = st.ok ? parseJson(st.body) : null;
  if (!s) { warn("/api/status", st.ok ? "unparseable response" : st.error); return; }

  const ev = s.startgg ?? {};
  const name = [s.tournament?.name, s.tournament?.eventName].filter(Boolean).join(" — ");
  if (ev.ok) pass("Event", name || "loaded");
  else if (ev.error) fail("Event", ev.error, "Press Singles or Doubles in the dock's Bracket tab once start.gg is reachable");
  else warn("Event", "none loaded yet", "Press Singles or Doubles in the dock's Bracket tab");

  s.slippi ? pass("Slippi folder", "watched")
           : fail("Slippi folder", `not readable: ${s.slippiDetail?.detail ?? ""}`);
  info("start.gg reporting", s.startggEnabled ? "enabled" : "disabled (no token)");

  const setup = parseJson((await httpGet(`${base}/api/setup`)).body ?? "");
  const hk = setup?.hotkeys;
  if (hk?.mode === "global") pass("Hotkeys", `global — ${hk.bindings.map((b) => b.chord).join(", ") || "none bound"}`);
  else if (hk?.mode) warn("Hotkeys", `${hk.mode} — uiohook-napi didn't load in the running app, so they only work in its window`);

  const obs = s.clipper?.obs;
  if (obs?.enabled) {
    obs.connected ? pass("Clipper → OBS", `connected to ${obs.url}`)
                  : warn("Clipper → OBS", obs.lastError || "not connected");
  }
}

/**
 * The token is checked against start.gg itself (a pasted token can be expired
 * or truncated), and the short link is followed to this week's tournament and
 * its two events — exactly what the Singles / Doubles buttons will do, so a
 * short link the TO forgot to re-point shows up here instead of on stream.
 */
async function probeStartgg(config, depsOk) {
  at("start.gg (live)");

  const token = config.STARTGG_TOKEN ?? "";
  if (!token) {
    skip("Token", "not set");
  } else {
    try {
      const res = await fetch("https://api.start.gg/gql/alpha", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: "{ currentUser { id slug } }" }),
        signal: AbortSignal.timeout(10000),
      });
      const body = parseJson(await res.text());
      const user = body?.data?.currentUser;
      if (res.ok && user) pass("Token", `accepted (${user.slug ?? `user ${user.id}`})`);
      else if (res.status === 401 || res.status === 403) fail("Token", `rejected (HTTP ${res.status}) — expired or pasted wrong`,
        "Make a new one at https://start.gg/admin/profile/developer and put it in config.local.js");
      else warn("Token", `unexpected answer (HTTP ${res.status}): ${body?.message ?? body?.errors?.[0]?.message ?? "no user"}`);
    } catch (e) {
      warn("Token", `couldn't reach start.gg — ${errText(e)}`);
    }
  }

  if (!depsOk) { skip("Short link", "dependencies missing"); return; }
  let StartggClient, normalizeBrackets, pickEvent;
  try {
    StartggClient = require("../lib/startgg-client");
    ({ normalizeBrackets, pickEvent } = require("../lib/event/event-target"));
  } catch (e) {
    fail("Short link", `could not check: ${e.message}`);
    return;
  }
  const brackets = normalizeBrackets(config);
  const client = new StartggClient(config);
  const link = await client.resolveShortLink(brackets.shortLink);
  if (!link.ok) { fail("Short link", link.error); return; }

  const events = await client.listEvents(link.slug);
  if (!events.ok) { warn("Short link", `start.gg/${brackets.shortLink} → ${link.slug}, but its events couldn't be read: ${events.error}`); return; }
  pass("Short link", `start.gg/${brackets.shortLink} → ${events.name || link.slug}`);
  for (const [kind, spec] of Object.entries(brackets.events)) {
    const pick = pickEvent(events.events, spec, kind);
    if (pick.ok) pass(`${kind[0].toUpperCase()}${kind.slice(1)} button`, pick.event.name);
    else warn(`${kind[0].toUpperCase()}${kind.slice(1)} button`, pick.error);
  }
}

/**
 * Direct OBS probe — independent of whether the app is up, and the only way to
 * check the replay buffer's *length*, which is the setting that quietly
 * truncates clips (conversions run 6-9s and the clipper waits saveDelayMs on top).
 */
async function probeObs(settings) {
  at("OBS (live)");
  if (!settings) { skip("OBS", "clipper settings unavailable"); return; }

  let OBSWebSocket;
  try {
    ({ OBSWebSocket } = require(require.resolve("obs-websocket-js", { paths: [BRIDGE_DIR] })));
  } catch {
    skip("OBS", "obs-websocket-js not installed");
    return;
  }

  // With the clipper off, nothing in the app touches OBS — an unreachable OBS
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
                 : warn("Replay buffer", "not running", "Start it in OBS, or leave 'Auto-start OBS buffer' on in the Clips tab (the first combo is still lost)");

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
  if (!AS_JSON) console.log("preflight" + (OFFLINE ? " (offline)" : ""));

  checkNode();
  const depsOk = checkDeps();
  const config = checkConfig();
  if (config) checkPlayers(config);
  checkIcons();
  checkPages(depsOk);
  checkThemePack();
  const clipper = config ? checkClipper(config) : null;
  checkLeftovers();

  if (OFFLINE) {
    at("live probes");
    skip("Live probes", "--offline");
  } else if (config) {
    await probeApp(config);
    await probeStartgg(config, depsOk);
    await probeObs(clipper);
  }

  const counts = report();
  process.exit(counts.FAIL ? 1 : 0);
})();
