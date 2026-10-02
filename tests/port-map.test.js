/**
 * Which side gets the point: the port map, driven through the real game-mode
 * handlers, store and PortMap.
 *
 * A wrong port→side mapping is invisible until it's on stream — the scoreboard
 * looks healthy and the point lands on the wrong player — and reproducing one
 * by hand means running a tournament. Pinned here:
 *
 *   - game 1 matches ports to sides by the players' mains, even when the ports
 *     are "backwards"; with nothing to match on it falls back to positional and
 *     says so;
 *   - the same ports next game keep the mapping (a manual correction sticks);
 *     moved ports are matched against what each side just played;
 *   - the winner's side is read at game end, so a port swap, a set loaded
 *     mid-game, or Switch Sides during the game all credit the right player;
 *   - doubles: Slippi teams map as wholes, non-adjacent ports included.
 */

const assert = require("assert");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { PortMap, matchSingles } = require("../app/lib/ports/port-map");
const { createState } = require("../app/lib/state");
const { createModes } = require("../app/lib/modes");
const { CHAR_MAP } = require("../app/lib/char_map");

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

const id = (codename) => Number(Object.keys(CHAR_MAP).find((k) => CHAR_MAP[k].codename === codename));
const display = (codename) => CHAR_MAP[id(codename)].display;
const main = (codename, skin = 0) => ({ name: display(codename), skin });

/** A slippi-js player entry. Port is 0-based, as slippi-js has it. */
const raw = (port, codename, skin = 0, teamId) => ({ playerIndex: port, characterId: id(codename), characterColor: skin, teamId });

function rig() {
  const emitted = [];
  const ctx = {
    store: new ScoreboardStore(),
    portMap: new PortMap(),
    state: createState(),
    io: { emit: (ev, data) => emitted.push([ev, data]) },
  };
  const modes = createModes(ctx);
  return { ...ctx, modes, emitted };
}

/** Load a singles set: left = "Lefty" maining `l`, right = "Righty" maining `r`. */
function loadSingles(store, l, r, extra = {}) {
  store.loadSet({
    setId: "1001", roundName: "Winners Round 1", lPlacement: 17,
    sides: [
      { entrantId: "E-left", players: [{ playerId: "P-left", tag: "Lefty", main: l }] },
      { entrantId: "E-right", players: [{ playerId: "P-right", tag: "Righty", main: r }] },
    ],
    ...extra,
  });
}

const score = (store) => store.scoreboard().sides.map((s) => s.score);
const win = (modes, port) => modes.onGameEnd({ winnerPlayerIndex: port, isHandwarmer: false });

log("port-map");

test("game 1: backwards ports are matched to sides by the players' mains", () => {
  const { store, portMap, modes } = rig();
  loadSingles(store, main("fox"), main("marth"));
  modes.onGameStart([raw(0, "marth"), raw(3, "fox")]);   // Righty on port 1, Lefty on port 4
  assert.strictEqual(portMap.method, "character");
  assert.strictEqual(portMap.sideOf(3), 0);
  assert.strictEqual(portMap.sideOf(0), 1);
  const sb = store.scoreboard();
  assert.strictEqual(sb.sides[0].players[0].character.codename, "fox", "live character on the left");
  assert.strictEqual(sb.sides[1].players[0].character.codename, "marth");
  win(modes, 3);
  assert.deepStrictEqual(score(store), [1, 0], "Lefty's win scores on the left");
  assert.strictEqual(store.scoreboard().games[0].characters[0][0].codename, "fox", "game records what each side played");
});

test("nothing to match on: positional, and flagged as such", () => {
  const { store, portMap, modes } = rig();
  loadSingles(store, null, null);
  modes.onGameStart([raw(1, "fox"), raw(2, "marth")]);
  assert.strictEqual(portMap.method, "positional");
  assert.deepStrictEqual([portMap.sideOf(1), portMap.sideOf(2)], [0, 1]);
  assert.strictEqual(modes.portInfo().method, "positional");
});

test("same character both sides: the costume decides; identical costumes don't guess", () => {
  const a = { port: 0, name: "Fox", skin: 2 };
  const b = { port: 1, name: "Fox", skin: 0 };
  assert.deepStrictEqual(matchSingles(a, b, [{ name: "Fox", skin: 0 }, { name: "Fox", skin: 2 }]), { 0: 1, 1: 0 });
  assert.strictEqual(matchSingles(a, { ...b, skin: 2 }, [{ name: "Fox", skin: 0 }, { name: "Fox", skin: 2 }]), null);
  assert.strictEqual(matchSingles(a, b, [{ name: "Fox" }, { name: "Fox" }]), null, "no costume info: inconclusive");
});

test("next game on the same ports keeps the mapping, even through a counterpick", () => {
  const { store, portMap, modes } = rig();
  loadSingles(store, main("fox"), main("marth"));
  modes.onGameStart([raw(0, "marth"), raw(3, "fox")]);
  win(modes, 0);
  modes.onGameStart([raw(0, "sheik"), raw(3, "falco")]);   // both counterpick off their mains
  assert.strictEqual(portMap.sideOf(3), 0, "continuity, not a fresh guess");
  win(modes, 3);
  assert.deepStrictEqual(score(store), [1, 1]);
});

test("ports moved between games: matched against what each side just played", () => {
  const { store, portMap, modes } = rig();
  loadSingles(store, null, null);                           // no mains: game 1 is positional
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);      // Lefty Fox on 1, Righty Marth on 2
  win(modes, 0);
  modes.onGameStart([raw(2, "marth"), raw(3, "fox")]);      // they moved: Marth now on the lower port
  assert.strictEqual(portMap.method, "character");
  assert.strictEqual(portMap.sideOf(3), 0, "Fox stays left");
  assert.strictEqual(portMap.sideOf(2), 1);
});

test("a manual port swap mid-game credits the corrected side, and sticks for the set", () => {
  const { store, portMap, modes, state } = rig();
  loadSingles(store, null, null);
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);      // positional: port 1 left — but it's wrong
  assert.ok(modes.swapPorts().ok);
  assert.strictEqual(portMap.method, "manual");
  assert.strictEqual(store.scoreboard().sides[1].players[0].character.codename, "fox", "live characters re-applied");
  assert.strictEqual(state.currentGameState.players[0].side, 1);
  win(modes, 0);
  assert.deepStrictEqual(score(store), [0, 1]);
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  assert.strictEqual(portMap.method, "manual", "same ports: the correction is kept");
  assert.strictEqual(portMap.sideOf(0), 1);
});

test("a set loaded mid-game re-detects against the new set's mains", () => {
  const { store, portMap, modes } = rig();
  loadSingles(store, main("peach"), main("jigglypuff"));         // the previous set, still loaded
  modes.onGameStart([raw(0, "marth"), raw(3, "fox")]);
  loadSingles(store, main("fox"), main("marth"), { setId: "1002" });
  assert.strictEqual(portMap.method, "character");
  assert.strictEqual(portMap.sideOf(3), 0);
  assert.strictEqual(store.scoreboard().sides[0].players[0].character.codename, "fox",
    "the live character replaces the loaded main");
  win(modes, 3);
  assert.deepStrictEqual(score(store), [1, 0]);
  assert.strictEqual(store.scoreboard().setId, "1002");
});

test("Switch Sides mid-game: the point still goes to the player who won it", () => {
  const { store, portMap, modes, emitted } = rig();
  loadSingles(store, main("fox"), main("marth"));
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  win(modes, 0);                                             // Lefty 1-0
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  store.switchSides();                                       // Lefty is now on the right
  assert.strictEqual(portMap.sideOf(0), 1);
  assert.strictEqual(portMap.method, "character", "a sides switch keeps the method");
  assert.strictEqual(emitted.at(-1)[1].players[0].teamNum, 2, "overlays told the new side");
  win(modes, 0);
  const sb = store.scoreboard();
  assert.strictEqual(sb.sides[1].players[0].tag, "Lefty");
  assert.deepStrictEqual(score(store), [0, 2]);
});

test("a handwarmer records nothing; re-detect needs a live game", () => {
  const { store, modes } = rig();
  loadSingles(store, main("fox"), main("marth"));
  assert.strictEqual(modes.reresolvePorts().ok, false);
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  modes.onGameEnd({ winnerPlayerIndex: 0, isHandwarmer: true });
  assert.deepStrictEqual(score(store), [0, 0]);
  assert.strictEqual(modes.reresolvePorts().ok, false, "the game is over");
});

test("doubles: non-adjacent teams map as wholes; mains place them, and the players within", () => {
  const { store, portMap, modes } = rig();
  store.loadSet({
    setId: "2001", roundName: "Grand Final", lPlacement: 2,
    sides: [
      { entrantId: "E-a", name: "Team A", players: [{ tag: "A1", main: main("fox") }, { tag: "A2", main: main("marth") }] },
      { entrantId: "E-b", name: "Team B", players: [{ tag: "B1", main: main("peach") }, { tag: "B2", main: main("sheik") }] },
    ],
  });
  // Slippi team 1 (blue) = ports 1 and 4 playing B's mains, with B2 on the lower port.
  modes.onGameStart([raw(0, "sheik", 0, 1), raw(1, "fox", 0, 0), raw(2, "marth", 0, 0), raw(3, "peach", 0, 1)]);
  assert.strictEqual(portMap.method, "character");
  assert.deepStrictEqual([0, 1, 2, 3].map((p) => portMap.sideOf(p)), [1, 0, 0, 1]);
  assert.strictEqual(portMap.slotOf(3), 0, "B1 (Peach) is port 4");
  assert.strictEqual(portMap.slotOf(0), 1, "B2 (Sheik) is port 1");
  const sb = store.scoreboard();
  assert.strictEqual(sb.sides[1].color, "#1565C0", "the right side shows blue");
  assert.strictEqual(sb.sides[1].players[0].character.codename, "peach");
  win(modes, 0);
  assert.deepStrictEqual(score(store), [0, 1]);
});

test("doubles with nothing to match: the team holding the lowest port goes left", () => {
  const { store, portMap, modes } = rig();
  modes.onGameStart([raw(0, "fox", 0, 0), raw(1, "marth", 0, 1), raw(2, "peach", 0, 1), raw(3, "sheik", 0, 0)]);
  assert.strictEqual(portMap.method, "positional");
  assert.deepStrictEqual([0, 1, 2, 3].map((p) => portMap.sideOf(p)), [0, 1, 1, 0]);
  assert.ok(store.scoreboard().isDoubles, "no set loaded: the game's shape decides");
});

log(failed === 0 ? "port-map: all passed" : `port-map: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
