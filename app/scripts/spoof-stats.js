/**
 * spoof-stats.js — put a set with real stats on the scoreboard, to check the
 * stats popup in OBS with no bracket running.
 *
 *   node app/scripts/spoof-stats.js                     the newest singles games in SLP_FOLDER
 *   node app/scripts/spoof-stats.js --from <folder>     …in another folder (searched recursively)
 *   node app/scripts/spoof-stats.js a.slp b.slp …       these games, in this order
 *     --games N        how many (default 4; 1–9)
 *     --tags A,B       the names (default: the replays' netplay names)
 *     --round "Losers Finals"   --bestof Bo5
 *   node app/scripts/spoof-stats.js --restore           put the real scoreboard back
 *
 * The popup's numbers come from each game's .slp (lib/set-stats/), so the set
 * is real games with their files, recorded as Slippi game ends would record
 * them — run it on the machine OBS is on, against replays that are there. It
 * writes app/data/live-state.json with the app closed (a running app holds
 * the state in memory and would write over it): the first spoof keeps the
 * real state as live-state.before-spoof.json, and --restore moves it back.
 * The tournament, casters and the stats popup's settings are kept. The set is
 * a manual one (no start.gg set id), so nothing can be reported or uploaded.
 *
 * Then start the app and press Stats in the dock (or Ctrl+Shift+G).
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const APP = path.resolve(__dirname, "..");
const DATA = path.join(APP, "data");
const LIVE = path.join(DATA, "live-state.json");
const BACKUP = path.join(DATA, "live-state.before-spoof.json");

function args(argv) {
  const o = { files: [], games: 4, tags: null, round: "Winners Semis", bestOf: "Bo5", from: null, restore: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--restore") o.restore = true;
    else if (a === "--games") o.games = Math.max(1, Math.min(9, Number(argv[++i]) || 4));
    else if (a === "--tags") o.tags = String(argv[++i] || "").split(",").map((t) => t.trim());
    else if (a === "--round") o.round = String(argv[++i] || o.round);
    else if (a === "--bestof") o.bestOf = String(argv[++i] || o.bestOf);
    else if (a === "--from") o.from = argv[++i];
    else if (a.endsWith(".slp")) o.files.push(path.resolve(a));
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

/** Whether the app answers on its port: it must be closed while the file is written. */
function appRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/identity", timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function slpFiles(dir) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".slp")) { try { out.push({ p, t: fs.statSync(p).mtimeMs }); } catch { /* gone */ } }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.t - a.t).map((f) => f.p);
}

/** A replay's netplay names by port, where it has them. */
function namesOf(file) {
  try {
    const { SlippiGame } = require(path.join(APP, "node_modules", "@slippi", "slippi-js"));
    const g = new SlippiGame(file);
    const meta = g.getMetadata() || {};
    const out = {};
    for (const p of g.getSettings()?.players || []) {
      const m = meta.players?.[p.playerIndex]?.names || {};
      out[p.port] = p.displayName || m.netplay || p.nametag || null;
    }
    return out;
  } catch { return {}; }
}

async function main() {
  const o = args(process.argv.slice(2));
  const config = require(path.join(APP, "config"));
  if (await appRunning(config.BRIDGE_PORT)) {
    console.error(`The app is running on port ${config.BRIDGE_PORT}. Close it first: it would write its own scoreboard over this one.`);
    process.exit(1);
  }

  if (o.restore) {
    if (!fs.existsSync(BACKUP)) { console.error("Nothing to restore: no live-state.before-spoof.json."); process.exit(1); }
    fs.renameSync(BACKUP, LIVE);
    console.log("The real scoreboard is back in app/data/live-state.json.");
    return;
  }

  const { readGameStats } = require(path.join(APP, "lib", "set-stats", "game-stats"));
  const { ScoreboardStore } = require(path.join(APP, "lib", "scoreboard", "store"));
  const { createPersist } = require(path.join(APP, "lib", "scoreboard", "persist"));
  const { CHAR_MAP } = require(path.join(APP, "lib", "char_map"));

  // The games: the ones named, else the newest singles games of one matchup.
  const picked = [];
  if (o.files.length) {
    for (const f of o.files) {
      const r = readGameStats(f);
      if (!r.ok) { console.error(`${f}: ${r.error}`); process.exit(1); }
      picked.push({ file: f, r });
    }
  } else {
    const dir = o.from || config.SLP_FOLDER;
    const files = slpFiles(dir);
    if (!files.length) { console.error(`No .slp files in ${dir}. Name some, or --from <folder>.`); process.exit(1); }
    let pair = null;
    for (const f of files.slice(0, 80)) {
      const r = readGameStats(f);
      if (!r.ok || r.winnerPort == null) continue; // not a finished singles game
      const key = Object.values(r.players).map((p) => p.characterId).sort((a, b) => a - b).join("v");
      if (!pair) pair = key;
      if (key === pair) picked.push({ file: f, r });
      if (picked.length >= o.games) break;
    }
    if (!picked.length) { console.error(`No finished singles game in the newest files in ${dir}.`); process.exit(1); }
    picked.reverse(); // oldest first: game 1 is the first played
  }

  // Sides: the left is the lower port of game 1; later games follow that player's character.
  const first = picked[0].r;
  const firstPorts = Object.keys(first.players).map(Number).sort((a, b) => a - b);
  const leftChar = first.players[firstPorts[0]].characterId;
  const names = namesOf(picked[0].file);
  const tags = o.tags && o.tags.length === 2 ? o.tags : firstPorts.map((p, i) => names[p] || `Player ${i + 1}`);

  const store = new ScoreboardStore();
  const persist = createPersist(store, LIVE);
  persist.restore(); // keep the tournament, casters, popup settings
  if (fs.existsSync(LIVE) && !fs.existsSync(BACKUP)) fs.copyFileSync(LIVE, BACKUP);

  store.loadSet({ setId: null, roundName: o.round, lPlacement: 3, sides: tags.map((tag) => ({ players: [{ tag }] })) });
  store.setOverrides({ bestOf: o.bestOf });
  for (const { file, r } of picked) {
    const ports = Object.keys(r.players).map(Number).sort((a, b) => a - b);
    const mirror = r.players[ports[0]].characterId === r.players[ports[1]].characterId;
    const order = mirror || r.players[ports[0]].characterId === leftChar ? ports : [ports[1], ports[0]];
    order.forEach((p, side) => {
      const ch = CHAR_MAP[r.players[p].characterId];
      if (ch) store.setCharacter(side, 0, { codename: ch.codename, name: ch.display, skin: r.players[p].costume });
    });
    store.recordGame({
      winnerSide: order.indexOf(r.winnerPort),
      replay: { file, startMs: null, lastFrame: r.lastFrame, stageId: r.stageId,
        players: order.map((p) => [{ port: p, characterId: r.players[p].characterId, costume: r.players[p].costume }]), teamIds: [null, null] },
    });
  }
  if (!persist.saveNow()) process.exit(1);

  const sb = store.scoreboard();
  console.log(`${o.round}, ${o.bestOf}: ${sb.sides[0].players[0].tag} ${sb.sides[0].score}–${sb.sides[1].score} ${sb.sides[1].players[0].tag}`);
  for (const { file } of picked) console.log(`  ${file}`);
  console.log(`Written to app/data/live-state.json${fs.existsSync(BACKUP) ? " (the real one is live-state.before-spoof.json; --restore puts it back)" : ""}.`);
  console.log("Start the app, then the dock's Stats key (or Ctrl+Shift+G) puts the popup up.");
}

main().catch((e) => { console.error(e); process.exit(1); });
