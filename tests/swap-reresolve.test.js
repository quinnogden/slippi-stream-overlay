/**
 * Switching sides re-detects the ports instead of following the old names.
 *
 * Squarely this suite's charter: the scoreboard looks perfectly healthy either
 * way — the names are on the sides the operator wanted — and the only symptom of
 * getting it wrong is the next game's point landing on the wrong player, on
 * stream, with "run a tournament and press Switch Sides" as the repro.
 *
 * The scenario: game 1 is live at 0-0, the bridge's port→team guess is the
 * positional default, and the operator presses ⇆ Switch Sides (or TSH's own Swap
 * Teams). TSH moves both teams to the other column and flips its teamsSwapped
 * flag; the 2s tick notices and calls handleTshSwap().
 *
 * What this pins is that the reaction re-runs the game-start path rather than
 * portMapper.resolve():
 *   - at 0-0 resolve() takes its new-set reset branch and wipes _portToName, so
 *     the panel loses the names entirely — the reported symptom;
 *   - off 0-0 it matches the stored names to their new columns, which just
 *     carries the previous (possibly wrong) belief across.
 *
 * Pure logic — a real PortMapper and TshClient over the shared program-state
 * fixture, with the HTTP methods stubbed out.
 */

const assert = require("assert");
const path   = require("path");

const PortMapper      = require("../slippi-bridge/lib/port-mapper");
const TshClient       = require("../slippi-bridge/lib/tsh-client");
const { createState } = require("../slippi-bridge/lib/state");
const { createModes } = require("../slippi-bridge/lib/modes");
const { CHAR_MAP }    = require("../slippi-bridge/lib/char_map");
const { createControlStatus } = require("../slippi-bridge/lib/server/control-status");

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

/** Live singles game: port 3 on Falco (TSH team 1), port 1 on Falcon (team 2). */
const LIVE_PLAYERS = [
  { playerIndex: 1, characterId: charId("captain_falcon"), characterColor: 0 },
  { playerIndex: 3, characterId: charId("falco"),          characterColor: 0 },
];

/**
 * ctx wired the way index.js wires it, minus the I/O, plus the stubs
 * createControlStatus touches while building its first snapshot.
 */
function ctxFor(state) {
  const tsh = new TshClient({ TSH_URL: "http://127.0.0.1:0", SCOREBOARD_NUM: 1 },
                            path.join(__dirname, "nonexistent-tsh"));
  tsh.readState       = () => state;
  tsh.setCharacter    = async () => ({ ok: true });
  tsh.setTeamColor    = async () => ({ ok: true });
  tsh.setCurrentStage = async () => ({ ok: true });

  return {
    config:          { BRACKETS: {}, SCOREBOARD_NUM: 1 },
    tsh,
    portMapper:      new PortMapper(),
    startgg:         { enabled: false },
    clipperSettings: { get: () => ({}) },
    obs:             { getStatus: () => ({}) },
    io:              { emit() {} },
    state:           createState(),
  };
}

/** handleTshSwap, wired to the real reresolvePorts exactly as index.js does. */
function swapHandlerFor(ctx) {
  return createControlStatus(ctx, createModes(ctx).reresolvePorts).handleTshSwap;
}

/**
 * Game 1 live at 0-0 with the positional guess in force: port 1 → team 1,
 * port 3 → team 2. The fixture's characters say the opposite.
 */
function withLiveGameAtZeroZero(ctx) {
  ctx.state.currentRawPlayers = LIVE_PLAYERS;
  ctx.state.currentGameState  = {
    players: {
      1: { playerIndex: 1, teamNum: 1, codename: "captain_falcon", display: "Captain Falcon", costumeIndex: 0 },
      3: { playerIndex: 3, teamNum: 2, codename: "falco",          display: "Falco",          costumeIndex: 0 },
    },
    isDoubles: false,
  };
}

(async () => {
  console.log("swap-reresolve");

  test("a swap at 0-0 keeps the port→name map instead of wiping it", () => {
    const ctx = ctxFor(tshState());
    withLiveGameAtZeroZero(ctx);

    swapHandlerFor(ctx)(ctx.tsh.readState());

    // resolve()'s 0-0 branch would have left both of these null.
    assert.strictEqual(ctx.portMapper.getPortName(3), "AVERY");
    assert.strictEqual(ctx.portMapper.getPortName(1), "BLAKE");
  });

  test("a swap re-detects the sides from TSH's characters", () => {
    const ctx = ctxFor(tshState());
    withLiveGameAtZeroZero(ctx);

    swapHandlerFor(ctx)(ctx.tsh.readState());

    assert.strictEqual(ctx.portMapper.getResolutionInfo().method, "character");
    assert.strictEqual(ctx.portMapper.getTeam(3, null), 1, "port 3 (Falco) must be team 1");
    assert.strictEqual(ctx.portMapper.getTeam(1, null), 2, "port 1 (Falcon) must be team 2");
    // The live players the layouts read have to move with it, not keep the guess.
    assert.strictEqual(ctx.state.currentGameState.players[3].teamNum, 1);
    assert.strictEqual(ctx.state.currentGameState.players[1].teamNum, 2);
  });

  // Those entries are TSH column numbers and the columns just changed hands, so
  // they move whichever way the mapping is re-derived — otherwise a mid-set swap
  // reports game 1 to the wrong entrant.
  test("already-logged games still change columns", () => {
    const ctx = ctxFor(tshState({ score1: 1 }));
    withLiveGameAtZeroZero(ctx);
    ctx.state.currentSetGames = [{ gameNum: 1, winnerTeam: 1 }, { gameNum: 2, winnerTeam: 2 }];

    swapHandlerFor(ctx)(ctx.tsh.readState());

    assert.deepStrictEqual(ctx.state.currentSetGames,
      [{ gameNum: 1, winnerTeam: 2 }, { gameNum: 2, winnerTeam: 1 }]);
  });

  // Between games the re-detect declines — there is nothing to re-push or
  // re-emit — so the name match has to still be there as the fallback.
  test("between games it falls back to matching the names across", () => {
    const ctx = ctxFor(tshState({ score1: 1 }));
    ctx.portMapper.syncNames(
      { a: { playerIndex: 1, teamNum: 1 }, b: { playerIndex: 3, teamNum: 2 } },
      { 1: ["BLAKE"], 2: ["AVERY"] }   // pre-swap: BLAKE was in column 1
    );
    ctx.portMapper._portToTeam = { 1: 1, 3: 2 };
    ctx.state.currentGameState = null;

    swapHandlerFor(ctx)(ctx.tsh.readState());

    // The fixture has AVERY in column 1 and BLAKE in column 2, so the ports the
    // names belong to have to follow them.
    assert.strictEqual(ctx.portMapper.getTeam(1, null), 2, "BLAKE's port must be team 2");
    assert.strictEqual(ctx.portMapper.getTeam(3, null), 1, "AVERY's port must be team 1");
  });

  console.log(failed === 0 ? "swap-reresolve: all passed" : `swap-reresolve: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
