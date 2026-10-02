/**
 * Who gets the point when a game ends.
 *
 * pickWinner() decides which port the bridge credits, and from there which TSH
 * score goes up. Every way it can be wrong is silent until it's on stream: the
 * scoreboard ticks up, just for the wrong player. The rage-quit path is the one
 * with a trap in it — in doubles the point must go to the OTHER team, never to
 * the quitter's partner — and the RESOLVED path (how most doubles games end)
 * leans on a last-frame fallback when placements are missing.
 */

const assert = require("assert");
const path   = require("path");
// Resolved from the bridge's node_modules — tests/ has none of its own.
const { GameEndMethod } = require(require.resolve("@slippi/slippi-js",
  { paths: [path.join(__dirname, "..", "app")] }));
const { pickWinner } = require("../app/lib/game-source");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    say(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const SINGLES = { players: [{ playerIndex: 0 }, { playerIndex: 2 }] };
// Ports 0+3 on team 1 (red), 1+2 on team 0 — deliberately not consecutive.
const DOUBLES = {
  players: [
    { playerIndex: 0, teamId: 1 },
    { playerIndex: 1, teamId: 0 },
    { playerIndex: 2, teamId: 0 },
    { playerIndex: 3, teamId: 1 },
  ],
};
const noStocks = () => { throw new Error("stock fallback should not run"); };

// The rage-quit path logs a line; keep the test output readable.
console.log = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");

say("game-winner");

test("GAME! takes the position-0 placement", () => {
  const end = { gameEndMethod: GameEndMethod.GAME, lrasInitiatorIndex: -1,
                placements: [{ playerIndex: 0, position: 1 }, { playerIndex: 2, position: 0 }] };
  assert.strictEqual(pickWinner(end, SINGLES, false, noStocks), 2);
});

test("GAME! with no placements falls back to last-frame stocks", () => {
  const end = { gameEndMethod: GameEndMethod.GAME, lrasInitiatorIndex: -1, placements: [] };
  assert.strictEqual(pickWinner(end, SINGLES, false, () => 0), 0);
});

test("a singles rage quit goes to the other player", () => {
  const end = { gameEndMethod: GameEndMethod.NO_CONTEST, lrasInitiatorIndex: 0, placements: [] };
  assert.strictEqual(pickWinner(end, SINGLES, false, noStocks), 2);
});

test("a doubles rage quit never goes to the quitter's partner", () => {
  const end = { gameEndMethod: GameEndMethod.NO_CONTEST, lrasInitiatorIndex: 0, placements: [] };
  const winner = pickWinner(end, DOUBLES, false, noStocks);
  assert.ok([1, 2].includes(winner), `port ${winner} is on the quitter's team`);
});

test("an LRAS handwarmer is not treated as a rage quit", () => {
  const end = { gameEndMethod: GameEndMethod.NO_CONTEST, lrasInitiatorIndex: 0, placements: [] };
  assert.strictEqual(pickWinner(end, SINGLES, true, () => null), null);
});

test("RESOLVED (doubles elimination) uses placements, then stocks", () => {
  const withPlacements = { gameEndMethod: GameEndMethod.RESOLVED, lrasInitiatorIndex: -1,
                           placements: [{ playerIndex: 3, position: 0 }] };
  assert.strictEqual(pickWinner(withPlacements, DOUBLES, false, noStocks), 3);

  const without = { gameEndMethod: GameEndMethod.RESOLVED, lrasInitiatorIndex: -1, placements: null };
  assert.strictEqual(pickWinner(without, DOUBLES, false, () => 1), 1);
});

// Older replays carry null here. `null >= 0` is true in JS, so an unguarded
// check routed these into the rage-quit branch and credited the first player.
test("a missing initiator index is not a rage quit", () => {
  const end = { gameEndMethod: GameEndMethod.RESOLVED, lrasInitiatorIndex: null,
                placements: [{ playerIndex: 2, position: 0 }] };
  assert.strictEqual(pickWinner(end, SINGLES, false, noStocks), 2);
});

say(failed === 0 ? "game-winner: all passed" : `game-winner: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
