/**
 * mains-learning.test.js
 *
 * What a player played, learned into the player DB at the end of their set
 * (app/lib/players/mains-learning.js), driven through the real game
 * modes, port map, store and PlayerDb — the path a set takes on stream.
 *
 * A wrong learned main is quiet and compounding: the next set opens on the
 * wrong character, and game 1's ports are matched against it, so the point
 * goes to the wrong player with nothing on the dock looking off. Pinned:
 *
 *   - what's learned is what each side played under the mapping the set
 *     *ended* with — a port swap made mid-game teaches the corrected players,
 *     not game 1's guess;
 *   - handwarmers and manual games teach nothing; nor do doubles, or a typed
 *     name with no record;
 *   - report-then-load learns once;
 *   - and the loop closes: the next set opens on the learned main, and game
 *     1's ports are matched by character even with the players on "backwards"
 *     ports.
 *
 * Usage: node tests/mains-learning.test.js
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { PortMap } = require("../app/lib/ports/port-map");
const { createState } = require("../app/lib/state");
const { createModes } = require("../app/lib/modes");
const { PlayerDb } = require("../app/lib/players/player-db");
const { createMainsLearning, mainsPlayed } = require("../app/lib/players/mains-learning");
const { CHAR_MAP, characterByName } = require("../app/lib/char_map");

const log = console.log.bind(console);
console.log = () => {};   // the modes' own logging; failures still print
console.warn = () => {};

let failed = 0;
function test(name, fn) {
  try {
    fn();
    log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mains-learning-"));
let fileNo = 0;

const id = (codename) => Number(Object.keys(CHAR_MAP).find((k) => CHAR_MAP[k].codename === codename));
/** A slippi-js player entry. Port is 0-based, as slippi-js has it. */
const raw = (port, codename, skin = 0, teamId) => ({ playerIndex: port, characterId: id(codename), characterColor: skin, teamId });

function rig(records = []) {
  const file = path.join(TMP, `players-${++fileNo}.json`);
  fs.writeFileSync(file, JSON.stringify(records));
  const ctx = {
    store: new ScoreboardStore(),
    portMap: new PortMap(),
    state: createState(),
    io: { emit() {} },
    playerDb: new PlayerDb(file, { debounceMs: 5 }),
  };
  const modes = createModes(ctx);
  const learned = [];
  const learning = createMainsLearning({ store: ctx.store, playerDb: ctx.playerDb, log: (m) => learned.push(m) });
  return { ...ctx, modes, learning, learned };
}

/** The DB's learned mains for a start.gg player, as [name, skin] pairs. */
const learnedOf = (db, playerId) => db.find({ playerId })?.learnedMains ?? null;

/** The DB's preferred main, as event-service.js prefills it. */
function mainFromDb(db, playerId) {
  const rec = db.find({ playerId });
  const m = rec && db.preferredMain(rec);
  return m ? characterByName(m.name, m.skin) : null;
}

/** A load as event-service.js does one: close the outgoing set, then read the DB. */
function loadSingles(r, setId, left, right) {
  r.store.closeSet();
  r.store.loadSet({
    setId, roundName: "Winners Round 1", lPlacement: 17,
    sides: [
      { entrantId: `E-${left}`, players: [{ playerId: left, tag: left, main: mainFromDb(r.playerDb, left) }] },
      { entrantId: `E-${right}`, players: [{ playerId: right, tag: right, main: mainFromDb(r.playerDb, right) }] },
    ],
  });
}

const win = (r, port, isHandwarmer = false) => r.modes.onGameEnd({ winnerPlayerIndex: port, isHandwarmer });

log("mains-learning");

test("a port swap mid-game teaches the corrected players, not game 1's guess", () => {
  const r = rig();
  loadSingles(r, "1001", "Lefty", "Righty");          // nobody's main is known yet
  // Righty (Marth) is on port 1, Lefty (Fox) on port 4: positional puts Marth on the left.
  r.modes.onGameStart([raw(0, "marth"), raw(3, "fox", 2)]);
  assert.strictEqual(r.portMap.method, "positional");
  r.modes.swapPorts();                                 // the operator sees it and fixes it
  win(r, 3);                                           // Lefty's Fox takes game 1
  r.modes.onGameStart([raw(0, "sheik"), raw(3, "fox", 2)]);
  win(r, 0);                                           // Righty's Sheik takes game 2
  r.modes.onGameStart([raw(0, "jigglypuff"), raw(3, "pichu")]);
  win(r, 0, true);                                     // a handwarmer: nothing recorded
  assert.deepStrictEqual(r.store.scoreboard().sides.map((s) => s.score), [1, 1]);

  r.store.clearSet();                                  // the set leaves the scoreboard
  assert.deepStrictEqual(learnedOf(r.playerDb, "Lefty"), [["Fox", 2]]);
  // One game each on Marth and Sheik: the later one leads.
  assert.deepStrictEqual(learnedOf(r.playerDb, "Righty"), [["Sheik", 0], ["Marth", 0]]);
  assert.strictEqual(r.learned.length, 1);
});

test("the most-played character leads, with its latest costume", () => {
  const sb = {
    isDoubles: false,
    sides: [{ players: [{ tag: "A" }] }, { players: [{ tag: "B" }] }],
    games: [
      { winnerSide: 0, manual: false, characters: [[{ name: "Falco", skin: 0 }], [{ name: "Marth", skin: 1 }]] },
      { winnerSide: 1, manual: false, characters: [[{ name: "Fox", skin: 0 }], [{ name: "Marth", skin: 4 }]] },
      { winnerSide: 0, manual: false, characters: [[{ name: "Falco", skin: 3 }], [{ name: "Marth", skin: 4 }]] },
      { winnerSide: 0, manual: true, characters: null },
    ],
  };
  const [a, b] = mainsPlayed(sb);
  // Learned in this order, so the most-played ends up first in the DB.
  assert.deepStrictEqual(a.chars, [{ name: "Fox", skin: 0 }, { name: "Falco", skin: 3 }]);
  assert.deepStrictEqual(b.chars, [{ name: "Marth", skin: 4 }]);
});

test("report, then the next load: learned once", () => {
  const r = rig();
  let calls = 0;
  const learnMain = r.playerDb.learnMain.bind(r.playerDb);
  r.playerDb.learnMain = (...a) => { calls++; return learnMain(...a); };
  loadSingles(r, "1001", "Lefty", "Righty");
  r.modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  win(r, 0);
  r.learning.commit(undefined, "reported");
  assert.strictEqual(calls, 2);
  loadSingles(r, "1002", "Lefty", "Other");
  assert.strictEqual(calls, 2, "loading the next set doesn't learn the reported one again");
  assert.strictEqual(r.learned.length, 1);
});

test("nothing is learned from manual games, doubles, or a typed name with no record", () => {
  const r = rig([{ prefix: "", gamerTag: "Known", name: "", mains: { ssbm: [] } }]);

  loadSingles(r, "1001", "Lefty", "Righty");
  r.store.bump(0, 1);                                  // the score typed in by hand
  r.store.bump(1, 1);
  r.store.clearSet();
  assert.strictEqual(learnedOf(r.playerDb, "Lefty"), null, "manual games carry no characters");

  r.store.loadSet({
    setId: "2001",
    sides: [
      { entrantId: "E1", players: [{ playerId: "D1", tag: "D1" }, { playerId: "D2", tag: "D2" }] },
      { entrantId: "E2", players: [{ playerId: "D3", tag: "D3" }, { playerId: "D4", tag: "D4" }] },
    ],
  });
  r.modes.onGameStart([raw(0, "fox", 0, 0), raw(1, "falco", 0, 0), raw(2, "marth", 0, 1), raw(3, "sheik", 0, 1)]);
  win(r, 0);
  r.store.clearSet();
  assert.ok(["D1", "D2", "D3", "D4"].every((p) => !r.playerDb.find({ playerId: p })),
    "doubles teaches no one (which teammate a port is can be a guess)");

  // A manual set: names typed into the strip.
  r.store.setPlayer(0, 0, { tag: "Known" });
  r.store.setPlayer(1, 0, { tag: "Typo" });
  r.modes.onGameStart([raw(0, "peach"), raw(1, "samus")]);
  win(r, 1);
  const size = r.playerDb.size;
  r.store.clearSet();
  assert.deepStrictEqual(r.playerDb.find({ tag: "Known" }).learnedMains, [["Peach", 0]], "a typed name in the list learns");
  assert.strictEqual(r.playerDb.size, size, "a typed name that isn't doesn't become a player");
});

test("the loop closes: the next set opens on the learned main and game 1 matches by character", () => {
  const r = rig();
  loadSingles(r, "1001", "Lefty", "Righty");
  r.modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);  // positional, and right this time
  win(r, 0);
  r.modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  win(r, 0);

  loadSingles(r, "1002", "Righty", "Lefty");              // they meet again, sides the other way
  const sb = r.store.scoreboard();
  assert.strictEqual(sb.sides[0].players[0].character.codename, "marth", "Righty opens on Marth");
  assert.strictEqual(sb.sides[1].players[0].character.codename, "fox", "Lefty opens on Fox");

  // Lefty's Fox on the lower port: positional would put him on the left.
  r.modes.onGameStart([raw(0, "fox"), raw(3, "marth")]);
  assert.strictEqual(r.portMap.method, "character");
  win(r, 0);
  assert.deepStrictEqual(r.store.scoreboard().sides.map((s) => s.score), [0, 1], "Lefty's win goes to Lefty's side");
});

fs.rmSync(TMP, { recursive: true, force: true });
log(failed === 0 ? "mains-learning: all passed" : `mains-learning: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
