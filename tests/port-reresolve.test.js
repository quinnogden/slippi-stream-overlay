/**
 * The Re-detect Players button re-derives the port→team mapping from scratch.
 *
 * This is squarely this suite's charter: a wrong port→team mapping is invisible
 * until it is on stream. The scoreboard looks perfectly healthy — the point just
 * lands on the wrong player, and the only way to reproduce it by hand is to run
 * a tournament and be late entering the names.
 *
 * The scenario throughout: a new set is loaded and game 1 is already running
 * while TSH still shows the *previous* set's players. The TO fixes the names,
 * presses the button, and the bridge must forget everything it recorded and
 * match the live ports against TSH's now-correct characters.
 *
 * Pure logic — a real PortMapper and TshClient (its accessors are pure) over the
 * shared program-state fixture, with the HTTP methods stubbed out.
 */

const assert = require("assert");
const path   = require("path");

const PortMapper     = require("../slippi-bridge/lib/port-mapper");
const TshClient      = require("../slippi-bridge/lib/tsh-client");
const { createState } = require("../slippi-bridge/lib/state");
const { createModes } = require("../slippi-bridge/lib/modes");
const { CHAR_MAP }    = require("../slippi-bridge/lib/char_map");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

// The fixture's two registered characters, by codename rather than by the magic
// numbers 20 and 0 — a char_map edit should break this loudly, not silently.
const charId = (codename) =>
  Number(Object.keys(CHAR_MAP).find((id) => CHAR_MAP[id].codename === codename));

const FIXTURE = require("./fixtures/program-state.json");
const clone   = (o) => JSON.parse(JSON.stringify(o));

/** The fixture, optionally with the set score moved off 0-0. */
function tshState({ score1 = 0, score2 = 0 } = {}) {
  const s = clone(FIXTURE);
  s.score["1"].team["1"].score = score1;
  s.score["1"].team["2"].score = score2;
  return s;
}

/**
 * A ctx wired the way index.js wires it, minus the I/O.
 * The TshClient is real so the `score.<sb>.team.<n>` digs are the shipping ones;
 * only readState and the fire-and-forget HTTP calls are replaced.
 */
function ctxFor(state) {
  const tsh = new TshClient({ TSH_URL: "http://127.0.0.1:0", SCOREBOARD_NUM: 1 },
                            path.join(__dirname, "nonexistent-tsh"));
  tsh.readState       = () => state;
  tsh.setCharacter    = async () => ({ ok: true });
  tsh.setTeamColor    = async () => ({ ok: true });
  tsh.setCurrentStage = async () => ({ ok: true });

  return {
    tsh,
    portMapper: new PortMapper(),
    io:         { emit() {} },
    state:      createState(),
  };
}

/** Live singles game: port 3 on Falco, port 1 on Captain Falcon. */
const LIVE_PLAYERS = [
  { playerIndex: 1, characterId: charId("captain_falcon"), characterColor: 0 },
  { playerIndex: 3, characterId: charId("falco"),          characterColor: 0 },
];

/**
 * Put the bridge in the failing state: a live game on ports {1,3}, but a mapping
 * still bound to the previous set's players on ports {0,1}.
 */
function withStaleMapping(ctx) {
  ctx.state.currentRawPlayers = LIVE_PLAYERS;
  ctx.state.currentGameState  = {
    players: {
      1: { playerIndex: 1, teamNum: 1, codename: "captain_falcon", display: "Captain Falcon", costumeIndex: 0 },
      3: { playerIndex: 3, teamNum: 2, codename: "falco",          display: "Falco",          costumeIndex: 0 },
    },
    isDoubles: false,
  };

  ctx.portMapper.syncNames(
    { a: { playerIndex: 0, teamNum: 1 }, b: { playerIndex: 1, teamNum: 2 } },
    { 1: ["OLD-WINNER"], 2: ["OLD-LOSER"] }
  );
  ctx.portMapper._portToTeam = { 0: 1, 1: 2 };
  ctx.portMapper._resolutionMethod = "name";
}

(async () => {
  console.log("port-reresolve");

  test("the stale mapping is cleared and re-derived from TSH's characters", () => {
    const ctx = ctxFor(tshState());
    withStaleMapping(ctx);

    const r = createModes(ctx).reresolvePorts();
    assert.strictEqual(r.ok, true, r.error);

    // Falco is TSH team 1 in the fixture (AVERY), Captain Falcon team 2 (BLAKE).
    assert.strictEqual(ctx.portMapper.getTeam(3, null), 1, "port 3 (Falco) must be team 1");
    assert.strictEqual(ctx.portMapper.getTeam(1, null), 2, "port 1 (Falcon) must be team 2");

    // Without the reset, name matching would keep port 0 and its old assignment.
    assert.ok(!ctx.portMapper.getKnownPorts().includes(0),
      `port 0 survived the reset: ${JSON.stringify(ctx.portMapper.getKnownPorts())}`);
  });

  test("names re-bind to the ones TSH shows now", () => {
    const ctx = ctxFor(tshState());
    withStaleMapping(ctx);
    createModes(ctx).reresolvePorts();

    assert.strictEqual(ctx.portMapper.getPortName(3), "AVERY");
    assert.strictEqual(ctx.portMapper.getPortName(1), "BLAKE");
  });

  test("the result reports character matching, not name or positional", () => {
    const ctx = ctxFor(tshState());
    withStaleMapping(ctx);

    const r = createModes(ctx).reresolvePorts();
    assert.strictEqual(r.method, "character", `method was "${r.method}"`);
    assert.strictEqual(r.mode, "singles");
    // The summary is the toast the operator reads; a blank team reads as "?".
    assert.ok(/P4→T1 AVERY/.test(r.summary), `summary was "${r.summary}"`);
    assert.ok(/P2→T2 BLAKE/.test(r.summary), `summary was "${r.summary}"`);
  });

  // The name/score step is skipped outright rather than relying on resolve()'s
  // 0-0 reset — off 0-0 that path would run and, in doubles, would set a
  // positional mapping that suppresses the character heuristic entirely.
  test("mid-set (1-0) still resolves by character, not by score", () => {
    const ctx = ctxFor(tshState({ score1: 1 }));
    withStaleMapping(ctx);

    const r = createModes(ctx).reresolvePorts();
    assert.strictEqual(r.method, "character", `method was "${r.method}"`);
    assert.strictEqual(ctx.portMapper.getTeam(3, null), 1);
    assert.strictEqual(ctx.portMapper.getTeam(1, null), 2);
  });

  // reset() drops the tallies and syncNames only re-seeds zeros, which would
  // leave the score fallback comparing 0-0 against a mid-set scoreboard.
  test("the win tallies are reseeded from TSH's live score", () => {
    const ctx = ctxFor(tshState({ score1: 2, score2: 1 }));
    withStaleMapping(ctx);
    createModes(ctx).reresolvePorts();

    assert.deepStrictEqual(ctx.portMapper._portScore, { 3: 2, 1: 1 });
  });

  // The reason resolveDoubles is guarded rather than left to reset on its own.
  // With the mapper cleared and the score off 0-0, resolveDoubles finds no names
  // and no matching win sums, falls through to applyDoublesPositional() and
  // thereby SETS _portToTeam — which makes doubles.js's !hasMapping() guard skip
  // tryCharacterBasedDoubles, i.e. skip the one heuristic this button exists to
  // run. Here positional and character disagree, so only one of them can pass.
  test("doubles: the positional fallback does not pre-empt character matching", () => {
    const s = tshState({ score1: 2, score2: 1 });
    const team = (n, entries) => {
      s.score["1"].team[n].player = {};
      entries.forEach(([name, char], i) => {
        s.score["1"].team[n].player[String(i + 1)] =
          { name, character: { 1: { name: char, skin: 0 } } };
      });
    };
    team("1", [["AVERY", "Marth"], ["CASEY", "Sheik"]]);
    team("2", [["BLAKE", "Falco"], ["DREW",  "Peach"]]);

    // Slippi teamId 0 holds ports {0,3} (Falco/Peach → TSH team 2);
    // teamId 1 holds ports {1,2} (Marth/Sheik → TSH team 1). The positional
    // default would hand team 1 to the group containing port 0 — the wrong one.
    const players = [
      { playerIndex: 0, teamId: 0, characterId: charId("falco"),  characterColor: 0 },
      { playerIndex: 1, teamId: 1, characterId: charId("marth"),  characterColor: 0 },
      { playerIndex: 2, teamId: 1, characterId: charId("sheik"),  characterColor: 0 },
      { playerIndex: 3, teamId: 0, characterId: charId("peach"),  characterColor: 0 },
    ];

    const ctx = ctxFor(s);
    ctx.state.currentRawPlayers = players;
    ctx.state.currentGameState  = { players: {}, isDoubles: true };

    const r = createModes(ctx).reresolvePorts();
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.mode, "doubles");
    assert.strictEqual(r.method, "character", `method was "${r.method}"`);
    assert.strictEqual(ctx.portMapper.getTeam(1, null), 1, "Marth's port must be TSH team 1");
    assert.strictEqual(ctx.portMapper.getTeam(2, null), 1, "Sheik's port must be TSH team 1");
    assert.strictEqual(ctx.portMapper.getTeam(0, null), 2, "Falco's port must be TSH team 2");
    assert.strictEqual(ctx.portMapper.getTeam(3, null), 2, "Peach's port must be TSH team 2");
  });

  test("with no game in progress it refuses and leaves the mapping alone", () => {
    const ctx = ctxFor(tshState());
    withStaleMapping(ctx);
    ctx.state.currentGameState = null;   // between games

    const before = JSON.stringify(ctx.portMapper.getResolutionInfo());
    const r = createModes(ctx).reresolvePorts();

    assert.strictEqual(r.ok, false);
    assert.ok(r.error, "a refusal must say why — the panel toasts it");
    assert.strictEqual(JSON.stringify(ctx.portMapper.getResolutionInfo()), before,
      "a refused re-resolve must not touch the mapping");
  });

  console.log(failed === 0 ? "port-reresolve: all passed" : `port-reresolve: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
