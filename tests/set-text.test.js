/**
 * Loading a set puts the right text on the scoreboard, and the picker offers
 * the right sets first.
 *
 * The scoreboard's best-of and [L] are derived, not typed, so a wrong rule is
 * on every set of the night before anyone notices:
 *
 *   - the series runs flex (shown "Flex") outside top 8 and Bo5 in it, and "top
 *     8" is start.gg's lPlacement ≤ 8 — off by one and losers top 8 reads Flex;
 *   - [L] goes on the grand-finals player who came up through losers, and on
 *     both players in the reset;
 *   - an operator override always wins.
 *
 * The picker is how the operator actually chooses what goes on stream (sets are
 * picked as they become playable, not from start.gg's stream queue), so
 * playable-first ordering is the feature, not a nicety.
 */

const assert = require("assert");
const { bestOfLabel, losersMarks } = require("../slippi-bridge/lib/scoreboard/set-text");
const { loadPayload, pickerList, pickStatus } = require("../slippi-bridge/lib/event/set-model");
const { buildBracket } = require("../slippi-bridge/lib/event/bracket-model");
const { eventFrom } = require("./helpers/fake-startgg");

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

const graphOf = (cap, ev) => {
  const { phaseGroup, sets } = eventFrom(cap, ev);
  return buildBracket(sets, { phaseGroupId: phaseGroup.id });
};
const byName = (graph, name) => Object.values(graph.sets).filter((s) => s.name === name);

console.log("set-text");

test("best-of: Flex until the loser is guaranteed top 8, then Bo5", () => {
  assert.strictEqual(bestOfLabel({ lPlacement: 9 }), "Flex");
  assert.strictEqual(bestOfLabel({ lPlacement: 8 }), "Bo5");
  assert.strictEqual(bestOfLabel({ lPlacement: 7 }), "Bo5");
  assert.strictEqual(bestOfLabel({ lPlacement: 2 }), "Bo5");
  assert.strictEqual(bestOfLabel({ lPlacement: null }), "Flex", "unknown placement is not top 8");
  assert.strictEqual(bestOfLabel({}), "Flex");
});

test("best-of on a real bracket: winners quarters Flex, winners semis and losers top 8 Bo5", () => {
  const g = graphOf("hundred-acres-49", "singles");
  for (const s of byName(g, "Winners Quarter-Final")) assert.strictEqual(bestOfLabel(s), "Flex");
  for (const s of byName(g, "Losers Round 3")) assert.strictEqual(bestOfLabel(s), "Flex");
  for (const s of byName(g, "Winners Semi-Final")) assert.strictEqual(bestOfLabel(s), "Bo5");
  for (const s of byName(g, "Losers Round 4")) assert.strictEqual(bestOfLabel(s), "Bo5", "losers top 8 (7th)");
});

test("best-of: override wins, and the thresholds/labels are configurable", () => {
  assert.strictEqual(bestOfLabel({ lPlacement: 9 }, { override: "Bo5" }), "Bo5");
  assert.strictEqual(bestOfLabel({ lPlacement: 2 }, { override: "Bo3" }), "Bo3");
  assert.strictEqual(bestOfLabel({ lPlacement: 13 }, { topN: 16 }), "Bo5");
  assert.strictEqual(bestOfLabel({ lPlacement: 13 }, { topN: undefined }), "Flex", "undefined option keeps the default");
  assert.strictEqual(bestOfLabel({ lPlacement: 3 }, { topLabel: "Best of 5" }), "Best of 5");
});

test("[L]: grand final marks the losers-side player only; the reset marks both; other sets neither", () => {
  const g = graphOf("hundred-acres-49", "singles");
  const gf = loadPayload(g, byName(g, "Grand Final")[0].id);
  const gfr = loadPayload(g, byName(g, "Grand Final Reset")[0].id);
  const lf = loadPayload(g, byName(g, "Losers Final")[0].id);
  assert.ok(gf.isGrandFinal && !gf.isReset);
  assert.ok(gfr.isReset && !gfr.isGrandFinal);
  assert.deepStrictEqual(losersMarks(gf), [false, true]);
  assert.deepStrictEqual(losersMarks(gfr), [true, true]);
  assert.deepStrictEqual(losersMarks(lf), [false, false]);
});

test("[L]: per-side override wins; null leaves that side derived", () => {
  const g = graphOf("hundred-acres-49", "singles");
  const gf = loadPayload(g, byName(g, "Grand Final")[0].id);
  assert.deepStrictEqual(losersMarks(gf, [true, null]), [true, true]);
  assert.deepStrictEqual(losersMarks(gf, [null, false]), [false, false]);
});

test("load payload: entrants, players and seeds carried; a DQ's -1 starts the scoreboard at 0", () => {
  const g = graphOf("hundred-acres-49", "singles");
  const dq = Object.values(g.sets).find((s) => s.dq);
  const p = loadPayload(g, dq.id);
  assert.ok(p.sides.every((s) => s.score >= 0));
  assert.ok(p.sides.every((s) => s.entrantId && s.players.length === 1 && s.players[0].playerId));
  assert.ok(p.sides.every((s) => typeof s.seed === "number"));
  assert.strictEqual(loadPayload(g, "no-such-set"), null);
});

test("load payload: doubles entrants carry both players", () => {
  const g = graphOf("hundred-acres-48", "doubles");
  const p = loadPayload(g, byName(g, "Grand Final")[0].id);
  assert.ok(p.sides.every((s) => s.players.length === 2));
});

test("picker: playable sets first, then waiting; finished ones only on request", () => {
  const g = graphOf("hundred-acres-51", "singles");
  const list = pickerList(g);
  const statuses = list.map((x) => x.status);
  const firstWaiting = statuses.indexOf("waiting");
  assert.ok(firstWaiting > 0, "some playable sets come first");
  assert.ok(statuses.slice(0, firstWaiting).every((s) => s === "playable"));
  assert.ok(statuses.slice(firstWaiting).every((s) => s === "waiting"));
  // Winners Round 1 (loser finishes 9th) ahead of a playable quarter-final that
  // only exists because of byes.
  assert.strictEqual(list[0].roundName, "Winners Round 1");
  assert.ok(list.every((x) => x.status !== "playable" || x.names.every(Boolean)));

  const done = graphOf("hundred-acres-49", "singles");
  assert.strictEqual(pickerList(done).length, 0, "a finished bracket offers nothing by default");
  assert.strictEqual(pickerList(done, { includeDone: true }).length, Object.keys(done.sets).length);
});

test("pickStatus: live sets are their own group, ahead of waiting ones", () => {
  const g = graphOf("hundred-acres-51", "singles");
  const set = g.sets[pickerList(g)[0].setId];
  assert.strictEqual(pickStatus(set), "playable");
  assert.strictEqual(pickStatus({ ...set, state: "live" }), "live");
  assert.strictEqual(pickStatus({ ...set, state: "done" }), "done");
  // Make one set live and confirm it sorts after playable, before waiting.
  set.state = "live";
  const statuses = pickerList(g).map((x) => x.status);
  const live = statuses.indexOf("live");
  assert.ok(live > statuses.lastIndexOf("playable") && live < statuses.indexOf("waiting"));
});

console.log(failed === 0 ? "set-text: all passed" : `set-text: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
