/**
 * screenshots.js — retake the README's images in docs/images/.
 *
 *   node scripts/screenshots/screenshots.js                 every image
 *   node scripts/screenshots/screenshots.js dock bracket    just these
 *   node scripts/screenshots/screenshots.js --out <dir>     somewhere else
 *
 * Boots the app in this process, composed as in index.js but against the
 * scrubbed hundred-acres-51 capture (tests/fixtures/startgg/) with its
 * "Player<n>" tags renamed to invented ones, a throwaway player file in the
 * OS temp folder and no persistence — app/data/ is never touched. It serves on
 * its own port, so a running app is left alone. Two scenes, each staged
 * through the app's own commands before the shots that need it:
 *
 *   set   Grand Final loaded at 1–2 with a game live, two casters, the bracket
 *         on Top 8. The side panel's player cards and head-to-head come from
 *         the real stats module, with start.gg's stats queries answered from
 *         the invented records below and luckystats stood in for by its
 *         scrubbed fixture — no network, and stats-cache/ is never written.
 *   crew  A crew battle two games in, started and picked through /api/crew/*.
 *
 * Then drives headless Chrome over the DevTools protocol (Node's global
 * WebSocket), in real time: a --virtual-time-budget screenshot runs ahead of
 * the page and catches the side panel mid-entrance and the bracket before its
 * fit. Each overlay is framed by frame.html (offset, clip, scale) to the same
 * size and crop as the image it replaces; hero.html composes the hero.
 *
 * The Salty Suite image switches overlays/theme.css for its one shot; the
 * file's original bytes are written back afterwards, however the run ends.
 *
 * Chrome: $CHROME, else the usual Chrome / Edge install paths.
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawn } = require("child_process");

const APP  = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(APP, "..");
const PORT = 5099;
const DEBUG_PORT = 9333;

const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const OUT = outAt >= 0 ? path.resolve(argv[outAt + 1]) : path.join(REPO, "docs", "images");
const ONLY = argv.filter((_, i) => i !== outAt && !(outAt >= 0 && i === outAt + 1));

// ── The capture, renamed ──────────────────────────────────────────────────────
// Seed → tag, as the images have always shown them; the capture's "Player<n>"
// numbering isn't seed order, so SEED_TAG says which n holds each seed.
const SEED_NAMES = {
  1: "Thistle", 2: "Bramble", 3: "Juniper", 4: "Wrenfield", 5: "Mossback", 6: "Pinecone",
  7: "Cobblestone", 8: "Larkspur", 9: "Heronwood", 10: "Fennel", 11: "Emberly", 12: "Hazelnut",
  13: "Marten", 14: "Tamarack", 15: "Bluebell", 16: "Driftwood", 17: "Saltmarsh", 18: "Willowby",
  19: "Quillfeather", 20: "Sagebrush", 21: "Briarpatch", 22: "Acorn", 23: "Bracken", 24: "Kestrel",
  25: "Cloverleaf", 26: "Alderman", 27: "Lichen", 28: "Hollowlog", 29: "Fernhollow",
};
const SEED_TAG = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 10, 8: 7, 9: 12, 10: 8, 11: 13, 12: 17, 13: 11, 14: 9, 15: 15,
  16: 16, 17: 18, 18: 14, 19: 23, 20: 20, 21: 21, 22: 24, 23: 28, 24: 25, 25: 19, 26: 22, 27: 29, 28: 27, 29: 26,
};
const TAG = { 30: "Sparrow", 31: "Thornbury", 32: "Osprey" };   // doubles only
for (const [seed, n] of Object.entries(SEED_TAG)) TAG[n] = SEED_NAMES[seed];
const PREFIX = ["TRAIL", "CAMP", "RNGR", "GROVE", "MOSS", "PEAK", "FERN", "LODGE", "CREEK"];   // Team1…

const CAPTURE = "screenshots-51";
const capture = fs.readFileSync(path.join(REPO, "tests", "fixtures", "startgg", "hundred-acres-51.final.json"), "utf8")
  .replace(/\bPlayer(\d+)\b/g, (m, n) => TAG[n] ?? m)
  .replace(/\bTeam(\d+)\b/g, (m, n) => PREFIX[n - 1] ?? m);
// fake-startgg reads tests/fixtures/startgg/<name>.json; hand it the renamed
// copy instead of writing one into the fixtures.
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  return String(file).endsWith(`${CAPTURE}.json`) ? capture : readFileSync.call(this, file, ...rest);
};
const { fakeStartgg } = require(path.join(REPO, "tests", "helpers", "fake-startgg.js"));

// ── The player file ───────────────────────────────────────────────────────────
const MAINS = {
  Thistle: ["Fox", 0], Bramble: ["Marth", 0], Juniper: ["Pikachu", 0], Wrenfield: ["Falco", 0],
  Mossback: ["Peach", 0], Pinecone: ["Yoshi", 0], Cobblestone: ["Sheik", 0], Larkspur: ["Captain Falcon", 0],
  Heronwood: ["Jigglypuff", 0], Fennel: ["Ice Climbers", 0], Emberly: ["Samus", 0], Hazelnut: ["Luigi", 0],
  Marten: ["Dr. Mario", 0], Tamarack: ["Ganondorf", 0], Bluebell: ["Zelda", 0], Driftwood: ["Link", 0],
  Saltmarsh: ["Donkey Kong", 0], Willowby: ["Young Link", 0], Quillfeather: ["Mewtwo", 0], Sagebrush: ["Ness", 0],
  Briarpatch: ["Roy", 0], Acorn: ["Pichu", 0], Bracken: ["Kirby", 0], Kestrel: ["Falco", 1],
  Cloverleaf: ["Mario", 0], Alderman: ["Bowser", 0], Lichen: ["Mr. Game & Watch", 0], Hollowlog: ["Fox", 2],
  Fernhollow: ["Marth", 2],
};
const PRONOUN = { Thistle: "he/him", Bramble: "she/her", Mossback: "she/her", Kestrel: "he/him", Juniper: "they/them" };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "readme-shots-"));
const playersFile = path.join(TMP, "players.json");
fs.writeFileSync(playersFile, JSON.stringify(Object.entries(MAINS).map(([tag, [main, skin]]) => ({
  prefix: "", gamerTag: tag, name: "", pronoun: PRONOUN[tag] ?? "", mains: { ssbm: [[main, skin, ""]] },
})), null, 2));

// ── The side panel's stats ────────────────────────────────────────────────────
// Invented, and kept roughly consistent with each other: the two Grand Final
// players' past placements and their head-to-head.
const GF_AT = 1790907283;                                  // the capture's Grand Final start
const weeksAgo = (w) => GF_AT - w * 7 * 86400;
// [tournament, placement, entrants, weeks ago], newest first.
const PLACEMENTS = {
  Thistle: [["Hundred Acres #50", 1, 38, 1], ["Hundred Acres #49", 2, 41, 2], ["Hundred Acres #48", 1, 36, 3],
            ["Saltmarsh Showdown 3", 5, 112, 4], ["Hundred Acres #46", 1, 40, 5]],
  Bramble: [["Hundred Acres #50", 2, 38, 1], ["Hundred Acres #49", 1, 41, 2], ["Hundred Acres #48", 3, 36, 3],
            ["Hundred Acres #46", 2, 40, 5], ["Timberline Open 2", 4, 57, 14]],
};
// Thistle vs Bramble, newest first: [tournament, round, Thistle's games, Bramble's, weeks ago].
const H2H = [
  ["Hundred Acres #50", "Grand Final", 3, 1, 1],
  ["Hundred Acres #49", "Grand Final Reset", 1, 3, 2],
  ["Hundred Acres #49", "Grand Final", 2, 3, 2],
  ["Hundred Acres #49", "Winners Final", 3, 1, 2],
  ["Hundred Acres #48", "Winners Semi-Final", 2, 1, 3],
  ["Hundred Acres #46", "Grand Final", 3, 0, 5],
  ["Hundred Acres #45", "Losers Final", 2, 3, 6],
  ["Hundred Acres #43", "Winners Final", 1, 3, 8],
  ["Hundred Acres #42", "Grand Final", 3, 2, 9],
  ["Hundred Acres #40", "Winners Semi-Final", 2, 0, 11],
  ["Timberline Open 2", "Losers Quarter-Final", 1, 2, 14],
].map(([tournament, round, t, b, w], i) => ({
  id: 990001 + i, tournament, round, games: [t, b], at: weeksAgo(w) + 6 * 3600 - i * 600,
  entrants: [9900010 + i * 10 + 1, 9900010 + i * 10 + 2], winner: t > b ? 0 : 1,
}));

// Player id → tag, from the renamed capture.
const TAG_OF = {};
for (const s of Object.values(JSON.parse(capture).phaseGroupSets).flat()) {
  for (const slot of s.slots ?? []) {
    for (const p of slot.entrant?.participants ?? []) if (p.player?.id) TAG_OF[p.player.id] = p.gamerTag;
  }
}

/**
 * start.gg's stats queries (lib/stats/queries.js), answered: the player cards
 * from PLACEMENTS plus each player's run through this event from the capture,
 * the histories and head-to-head pills from H2H. Anything else is refused, as
 * fake-startgg does.
 */
function statsAnswers(eventSets) {
  const pidOf = (tag) => Object.keys(TAG_OF).find((id) => TAG_OF[id] === tag);
  const pair = [pidOf("Thistle"), pidOf("Bramble")];
  return async (q, vars = {}) => {
    if (q.includes("recentStandings")) {
      const data = {};
      for (const [, i, id] of q.matchAll(/p(\d+): player\(id: (\d+)\)/g)) {
        data[`p${i}`] = {
          id, user: { id: `77${id}` },
          recentStandings: (PLACEMENTS[TAG_OF[id]] ?? []).map(([name, placement, numEntrants, w], n) => ({
            placement, isFinal: true,
            container: { id: 980000 + n, name: "Melee Singles", numEntrants, startAt: weeksAgo(w), isOnline: false, tournament: { name } },
          })),
        };
      }
      // The run: this event's sets finished before the Grand Final began.
      if (q.includes("ev: event(")) {
        data.ev = { id: 100006, type: 1, sets: { nodes: eventSets().filter((s) => s.state === 3 && s.completedAt < GF_AT) } };
      }
      return { ok: true, data };
    }
    if (q.includes("playerSets")) {
      const nodes = !pair.includes(String(vars.id)) || vars.page > 1 ? [] : H2H.map((s) => ({
        id: s.id, winnerId: s.entrants[s.winner], completedAt: s.at, state: 3, displayScore: "",
        event: { id: s.id, startAt: s.at, videogame: { id: 1 } },
        slots: s.entrants.map((e, side) => ({ entrant: { id: e, participants: [{ player: { id: pair[side] } }] } })),
      }));
      return { ok: true, data: { player: { id: vars.id, sets: { pageInfo: { total: nodes.length, totalPages: 1 }, nodes } } } };
    }
    if (/s\d+: set\(id:/.test(q)) {
      const data = {};
      for (const [, i, id] of q.matchAll(/s(\d+): set\(id: (\d+)\)/g)) {
        const s = H2H.find((x) => String(x.id) === id);
        if (!s) continue;
        data[`s${i}`] = {
          id: s.id, completedAt: s.at, fullRoundText: s.round, winnerId: s.entrants[s.winner],
          event: { name: "Melee Singles", startAt: s.at, isOnline: false, tournament: { name: s.tournament } },
          slots: s.entrants.map((e, side) => ({ entrant: { id: e }, standing: { stats: { score: { value: s.games[side] } } } })),
        };
      }
      return { ok: true, data };
    }
    return { ok: false, error: "screenshots: query not answered" };
  };
}

/**
 * luckystats.gg, stood in for by the scrubbed fixture tests/ use: renamed
 * Region, a rank in it, and a closer projection than the fixture's 96%. No
 * images — the class shows as text and the Region gets its pin, as when they
 * can't be saved.
 */
function luckyStandIn() {
  const fixture = readFileSync(path.join(REPO, "tests", "fixtures", "luckystats", "pair.json"), "utf8");
  return {
    enabled: true,
    async players(ids) {
      const body = JSON.parse(fixture);
      body.players = body.players.slice(0, ids.length).map((p, i) => ({
        ...p, startggUserId: ids[i], regionRank: [3, 7][i],
        displayRegion: { ...p.displayRegion, name: "Timberline Melee" },
      }));
      body.matchup.order = ids;
      body.matchup.winProbability.glickoOnly = { player1: 0.614, player2: 0.386 };
      return { ok: true, data: body };
    },
    badge: async () => null,
    regionArt: async () => null,
  };
}

// ── The crew battle ───────────────────────────────────────────────────────────
// Member ids run 1–5 on the left, 6–10 on the right (crew-model.js createCrew).
const CREWS = [
  ["Trailblazers", ["Thistle", "Juniper", "Mossback", "Pinecone", "Larkspur"]],
  ["Campfire Crew", ["Bramble", "Wrenfield", "Cobblestone", "Heronwood", "Fennel"]],
];

// ── The shots ─────────────────────────────────────────────────────────────────
// Sizes and crops are the images' own: change one and the README's layout moves.
const frame = (src, o = "") => `${fileUrl("frame.html")}?port=${PORT}&src=${encodeURIComponent(src)}${o}`;
const SHOTS = [
  { name: "hero", w: 1440, h: 810, url: `${fileUrl("hero.html")}?port=${PORT}`, wait: 9000 },
  { name: "scoreboard", w: 1190, h: 124, url: frame("/o/scoreboard?animate=false", "&x=60&y=0&w=1190&h=124") },
  { name: "players-bar", w: 1215, h: 242, url: frame("/o/scoreboard/players?animate=false", "&x=153&y=757&w=1620&h=323&s=0.75") },
  { name: "side-panel", w: 367, h: 648, url: frame("/o/side-panel?panel=completed-sets&animate=false", "&fw=611&w=611&h=1080&s=0.6"), wait: 9000 },
  { name: "side-panel-player", w: 367, h: 648, url: frame("/o/side-panel?panel=player-1&animate=false", "&fw=611&w=611&h=1080&s=0.6"), wait: 9000 },
  { name: "side-panel-h2h", w: 367, h: 648, url: frame("/o/side-panel?panel=recent-sets&animate=false", "&fw=611&w=611&h=1080&s=0.6"), wait: 9000 },
  { name: "bracket", w: 1155, h: 657, url: frame("/o/bracket?animate=false", "&x=190&y=12&w=1540&h=876&s=0.75"), wait: 8000 },
  { name: "casters", w: 712, h: 86, url: frame("/o/casters?animate=false", "&x=615&y=10&w=712&h=86") },
  { name: "highlights", w: 960, h: 540, url: frame("/o/highlights?guides=1&animate=false", "&s=0.5") },
  { name: "theme-hundred-acres-panel", theme: "hundred-acres", w: 244, h: 432, url: frame("/o/side-panel?panel=logo-primary&animate=false", "&fw=611&w=611&h=1080&s=0.4"), wait: 9000 },
  { name: "theme-salty-suite-panel", theme: "salty-suite", w: 244, h: 432, url: frame("/o/side-panel?panel=logo-primary&animate=false", "&fw=611&w=611&h=1080&s=0.4"), wait: 9000 },
  // Up next with the finished sets showing, as a full bracket would look mid-event.
  { name: "dock", w: 440, h: 1215, url: `http://localhost:${PORT}/dock`, wait: 3000,
    script: `document.querySelector('[data-tab="set"]').click(); document.getElementById("btn-toggle-finished").click()`, after: 3000 },
  // The crew battle: the side panel's card for the left crew, and the dock's live rosters.
  { name: "crew-panel", scene: "crew", w: 367, h: 648, url: frame("/o/side-panel?panel=crew-1&animate=false", "&fw=611&w=611&h=1080&s=0.6"), wait: 9000 },
  { name: "dock-crew", scene: "crew", w: 440, h: 900, url: `http://localhost:${PORT}/dock`, wait: 3000,
    script: `document.querySelector('[data-tab="crew"]').click()`, after: 2000 },
];

function fileUrl(name) {
  return "file:///" + path.join(__dirname, name).replace(/\\/g, "/");
}

// ── The app ───────────────────────────────────────────────────────────────────
const r = (p) => require(path.join(APP, p));
const config = { ...r("config"), BRIDGE_PORT: PORT, STARTGG_TOKEN: "", LUCKYSTATS_KEY: "", SLP_FOLDER: TMP, PLAYERS_FILE: playersFile };

const { createServer }         = r("lib/server/app");
const { ClipperSettings }      = r("lib/clipper-settings");
const { ComboDetector }        = r("lib/combo-detector");
const { ObsClient }            = r("lib/obs-client");
const { ScoreboardStore }      = r("lib/scoreboard/store");
const { PortMap }              = r("lib/ports/port-map");
const { PlayerDb }             = r("lib/players/player-db");
const { SavedCrews }           = r("lib/crew/saved-crews");
const { EventService }         = r("lib/event/event-service");
const { createBracketFeed }    = r("lib/event/bracket-feed");
const { createOverlayChannel } = r("lib/overlay/channel");
const { createState }          = r("lib/state");
const { createModes }          = r("lib/modes");
const { createClipRecorder }   = r("lib/clip-recorder");
const { activeThemePack, themePacks, setThemePack } = r("lib/server/api/setup");
const { createControlStatus }  = r("lib/server/control-status");
const { createReportSet }      = r("lib/server/report-set");
const { createStartSet }       = r("lib/server/start-set");
const { registerRoutes }       = r("lib/server/routes");
const { registerOverlays }     = r("lib/server/overlays");
const { createPlayerStats }    = r("lib/stats");

function bootApp() {
  const { app, io, start } = createServer(config);
  start();
  const clipperSettings = new ClipperSettings(config);
  const store = new ScoreboardStore({ setText: config.SET_TEXT });
  const channel = createOverlayChannel({ io, store });
  const startgg = fakeStartgg(CAPTURE);
  const ctx = {
    config, io: channel, state: createState(), store, portMap: new PortMap(),
    playerDb: new PlayerDb(playersFile), startgg,
    clipperSettings, comboDetector: new ComboDetector(() => clipperSettings.get()),
    obs: new ObsClient(() => clipperSettings.get()),
  };
  ctx.event = new EventService(ctx);
  startgg.backgroundQuery = statsAnswers(() => ctx.event.rawSets());
  const bracketFeed = createBracketFeed({ event: ctx.event, store, playerDb: ctx.playerDb });
  const modes = createModes(ctx);
  const controlStatus = createControlStatus(ctx, modes.portInfo);
  const clipRecorder = createClipRecorder(ctx, controlStatus.refresh);
  const playerStats = createPlayerStats(ctx, { cacheDir: null, lucky: luckyStandIn(), log() {} });
  const reportSet = createReportSet(ctx, controlStatus.refresh);
  const { startCurrentSet } = createStartSet(ctx, controlStatus.refresh);
  // A Slippi folder that's "there", so the dock's Slippi light is on.
  ctx.state.source = { getStatus: () => ({ connected: true, folder: config.SLP_FOLDER }) };

  const overlaysDir = path.join(REPO, "overlays");
  registerOverlays(app, { overlaysDir });
  registerRoutes(app, {
    publicDir: path.join(APP, "public"), iconsDir: path.join(overlaysDir, "assets", "icons"),
    store, event: ctx.event, playerDb: ctx.playerDb, clipperSettings, obs: ctx.obs,
    savedCrews: new SavedCrews(path.join(TMP, "crews.json")),
    refreshControlStatus: controlStatus.refresh, clipperSnapshot: controlStatus.clipperSnapshot,
    reportCurrentSet: reportSet.reportCurrentSet, startCurrentSet,
    swapPorts: modes.swapPorts, switchSides: () => store.switchSides(), reresolvePorts: modes.reresolvePorts,
    gameLive: () => !!ctx.state.currentGameState, recordClip: clipRecorder.recordClip,
    playerStatsSnapshot: playerStats.snapshot, overlaysDir, emit: channel.emit,
    setupInfo: () => ({
      base: `http://localhost:${PORT}`, lan: [], hotkeys: { mode: "global", bindings: [], errors: [] },
      players: { file: playersFile, count: ctx.playerDb.size },
      slippiFolder: config.SLP_FOLDER, startgg: { token: true, shortLink: "hundred-acres" },
      theme: activeThemePack(overlaysDir), themes: themePacks(overlaysDir),
    }),
  });
  setInterval(controlStatus.refresh, 2000).unref();

  const gameStarts = () => {
    ctx.state.currentGameState = { players: [], isDoubles: false };
    channel.emit("slippi_game_start", ctx.state.currentGameState);
  };
  const post = async (route, body) => {
    const res = await (await fetch(`http://localhost:${PORT}${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!res.ok) throw new Error(`${route}: ${res.error}`);
  };

  const SCENES = {
    async set() {
      const set = await ctx.event.loadSet("100009");   // Grand Final, set AC
      if (!set.ok) throw new Error(`loading the Grand Final: ${set.error}`);
      store.setScore(0, 1);
      store.setScore(1, 2);
      store.setCharacter(0, 0, { codename: "fox", name: "Fox", skin: 0 });
      store.setCharacter(1, 0, { codename: "marth", name: "Marth", skin: 0 });
      gameStarts();
      // The cards are drawn from the first answer, so wait for both parts.
      await until(() => {
        const s = playerStats.snapshot();
        return s.h2h?.state === "done" && s.lucky?.state === "done";
      }, "the side panel's stats");
    },
    async crew() {
      ctx.state.currentGameState = null;               // between games: a pick shows the member's main
      await post("/api/crew/start", { stocksEach: 4, teams: CREWS.map(([name, tags]) => ({ name, members: tags.map((tag) => ({ tag })) })) });
      // Thistle loses to Bramble, who keeps 2; Juniper then takes Bramble out on 3; Wrenfield is in.
      await post("/api/crew/pick", { side: 0, id: 1 });
      await post("/api/crew/pick", { side: 1, id: 6 });
      store.crewApplyGame({ winnerSide: 1, winnerStocks: 2 });
      await post("/api/crew/pick", { side: 0, id: 2 });
      store.crewApplyGame({ winnerSide: 0, winnerStocks: 3 });
      await post("/api/crew/pick", { side: 1, id: 7 });
      gameStarts();
    },
  };
  let scene = null;
  const useScene = async (name) => {
    if (scene === name) return;
    await SCENES[name]();
    await controlStatus.refresh();
    scene = name;
  };

  return (async () => {
    const ev = await ctx.event.loadEvent("tournament/hundred-acres-51/event/melee-singles-flex-bo5", { kind: "singles" });
    if (!ev.ok) throw new Error(`loading the event: ${ev.error}`);
    bracketFeed.start();
    playerStats.start();
    store.setCasters([{ tag: "Mossback", pronoun: "she/her" }, { tag: "Kestrel", pronoun: "he/him" }]);
    store.setBracketView("top8");
    return { overlaysDir, useScene };
  })();
}

async function until(fn, what) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── Chrome ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("no Chrome found — set CHROME to its path");
  return found;
}

async function devtools() {
  const chrome = spawn(findChrome(), [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${path.join(TMP, "chrome")}`, "about:blank",
  ], { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 40 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); } catch { await sleep(250); }
  }
  if (!targets) { chrome.kill(); throw new Error("Chrome's DevTools port never answered"); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Page.enable");
  return { send, close: () => { ws.close(); chrome.kill(); } };
}

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  const unknown = ONLY.filter((n) => !SHOTS.some((s) => s.name === n));
  if (unknown.length) throw new Error(`no image named ${unknown.join(", ")} — have: ${SHOTS.map((s) => s.name).join(", ")}`);

  const { overlaysDir, useScene } = await bootApp();
  const themeFile = path.join(overlaysDir, "theme.css");
  const themeBytes = readFileSync(themeFile);
  const onAir = activeThemePack(overlaysDir);
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await devtools();
  try {
    for (const s of SHOTS) {
      if (ONLY.length && !ONLY.includes(s.name)) continue;
      await useScene(s.scene ?? "set");
      const pack = s.theme ?? onAir;
      if (activeThemePack(overlaysDir) !== pack) {
        const res = setThemePack(overlaysDir, pack);
        if (!res.ok) throw new Error(res.error);
      }
      await chrome.send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
      await chrome.send("Page.navigate", { url: s.url });
      await sleep(s.wait ?? 6000);
      if (s.script) {
        await chrome.send("Runtime.evaluate", { expression: s.script });
        await sleep(s.after ?? 1500);
      }
      const { data } = await chrome.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: s.w, height: s.h, scale: 1 } });
      fs.writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(data, "base64"));
      console.log(`[screenshots] ${s.name}.png`);
    }
  } finally {
    chrome.close();
    fs.writeFileSync(themeFile, themeBytes);
  }
  console.log(`[screenshots] Done → ${OUT}`);
})()
  .catch((err) => { console.error(`[screenshots] ${err.message}`); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Chrome may still hold its profile */ }
    setTimeout(() => process.exit(), 500);
  });
