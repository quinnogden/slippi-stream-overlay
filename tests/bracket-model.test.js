/**
 * The bracket model reads start.gg's set graph correctly.
 *
 * Every way this is wrong is silent and on stream: a grand final drawn as an
 * ordinary winners set, a reset shown as certain before it is, a "top 8" view
 * missing losers top 8, a drop-in labelled from the wrong set. Nothing errors;
 * the bracket just says something untrue.
 *
 * All against real captures (fixtures/startgg/), never invented sets — the
 * edge cases worth pinning (byes as edges to sets that don't exist, a DQ's -1,
 * losers rounds starting at -4, a 2-entrant preview whose GF names a set that
 * doesn't exist) are exactly the things nobody would think to invent.
 */

const assert = require("assert");
const { buildBracket, selectView, isTopN, VIEWS } = require("../slippi-bridge/lib/event/bracket-model");
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

function graphOf(capture, eventMatch) {
  const { event, phaseGroup, sets } = eventFrom(capture, eventMatch);
  return { event, graph: buildBracket(sets, { phaseGroupId: phaseGroup.id, bracketType: phaseGroup.bracketType }) };
}
const setsOf = (graph, side) => Object.values(graph.sets).filter((s) => !side || s.side === side);

console.log("bracket-model");

test("grand final, played reset: GF and GFR found, the reset is certain, slot 1 came from losers", () => {
  const { graph } = graphOf("hundred-acres-49", "singles");
  const [gf] = setsOf(graph, "GF");
  const [gfr] = setsOf(graph, "GFR");
  assert.ok(gf && gfr, "both grand-final sets present");
  assert.strictEqual(setsOf(graph, "GF").length, 1);
  assert.strictEqual(gfr.conditional, false, "a reset that exists after GF 1 is done was played");
  assert.deepStrictEqual(gf.slots.map((s) => s.fromLosers), [false, true]);
  assert.strictEqual(gfr.slots[0].from.setId, gf.id);
  assert.strictEqual(gf.next.win, gfr.id);
});

test("grand final without a reset: start.gg deleted it, nothing invents one", () => {
  for (const cap of ["hundred-acres-47", "hundred-acres-48"]) {
    const { graph } = graphOf(cap, "singles");
    assert.strictEqual(setsOf(graph, "GF").length, 1, cap);
    assert.strictEqual(setsOf(graph, "GFR").length, 0, cap);
  }
});

test("unstarted bracket: preview sets, edges intact, reset is only a maybe", () => {
  const { graph } = graphOf("hundred-acres-51", "singles");
  assert.ok(graph.preview);
  assert.ok(setsOf(graph).every((s) => s.preview && s.state === "pending"));
  const [gfr] = setsOf(graph, "GFR");
  assert.strictEqual(gfr.conditional, true);
  assert.ok(setsOf(graph).every((s) => s.lPlacement != null), "preview sets carry lPlacement");
});

test("2-entrant preview: GF found by name when its losers feeder is a bye", () => {
  const { graph } = graphOf("hundred-acres-51", "doubles");
  const [gf] = setsOf(graph, "GF");
  assert.ok(gf, "GF found");
  assert.strictEqual(gf.slots[1].from.kind, "bye");
  assert.deepStrictEqual(gf.slots.map((s) => s.fromLosers), [false, true]);
  assert.strictEqual(setsOf(graph, "GFR").length, 1);
});

test("every edge joins: a 'set' feeder exists, and next.win / next.lose point back at it", () => {
  for (const [cap, ev] of [["hundred-acres-47", "singles"], ["hundred-acres-49", "singles"], ["hundred-acres-51", "singles"], ["hundred-acres-48", "doubles"]]) {
    const { graph } = graphOf(cap, ev);
    for (const set of setsOf(graph)) {
      set.slots.forEach((slot) => {
        if (slot.from.kind !== "set") return;
        const feeder = graph.sets[slot.from.setId];
        assert.ok(feeder, `${cap} ${set.identifier}: feeder exists`);
        const via = slot.from.placement === 2 ? feeder.next.lose : feeder.next.win;
        assert.strictEqual(via, set.id, `${cap} ${feeder.identifier} → ${set.identifier}`);
      });
    }
  }
});

test("byes: a bracket of n entrants has (next power of two − n) bye slots in winners", () => {
  for (const cap of ["hundred-acres-47", "hundred-acres-48", "hundred-acres-49"]) {
    const { event, graph } = graphOf(cap, "singles");
    const n = event.numEntrants;
    const expected = 2 ** Math.ceil(Math.log2(n)) - n;
    // A bye is visible where the bye "set" would have fed: one winners slot per bye.
    const byes = setsOf(graph, "W").flatMap((s) => s.slots).filter((x) => x.from.kind === "bye").length;
    assert.strictEqual(byes, expected, `${cap}: ${n} entrants`);
  }
});

test("DQ: flagged, -1 kept on the DQ'd slot, winner still known", () => {
  const { graph } = graphOf("hundred-acres-49", "singles");
  const dqs = setsOf(graph).filter((s) => s.dq);
  assert.strictEqual(dqs.length, 3);
  for (const s of dqs) {
    assert.ok(s.slots.some((x) => x.score === -1));
    assert.ok(s.winner === 0 || s.winner === 1);
  }
});

test("drop-ins: every losers slot fed by a winners set's loser is labelled with that set", () => {
  const { graph } = graphOf("hundred-acres-49", "singles");
  let n = 0;
  for (const s of setsOf(graph, "L")) {
    for (const slot of s.slots) {
      const f = slot.from;
      if (f.kind === "set" && f.placement === 2 && graph.sets[f.setId].side === "W") {
        n++;
        assert.strictEqual(f.dropIn.identifier, graph.sets[f.setId].identifier);
      } else {
        assert.strictEqual(f.dropIn, undefined);
      }
    }
  }
  assert.ok(n > 0);
});

test("top 8 = exactly the sets whose loser is guaranteed 8th or better", () => {
  const { graph } = graphOf("hundred-acres-49", "singles");
  const v = selectView(graph, "top8");
  const names = new Set(v.setIds.map((id) => graph.sets[id].name));
  assert.deepStrictEqual([...names].sort(), [
    "Grand Final", "Grand Final Reset", "Losers Final", "Losers Quarter-Final", "Losers Round 4",
    "Losers Semi-Final", "Winners Final", "Winners Semi-Final",
  ]);
  // WS 2 + WF + GF + GFR + L top 8 (2) + LQF 2 + LSF + LF
  assert.strictEqual(v.setIds.length, 11);
  // Winners semis are fed by quarter-finals the view doesn't draw.
  for (const id of v.setIds.filter((i) => graph.sets[i].name === "Winners Semi-Final")) {
    assert.deepStrictEqual(v.fedFromOutside[id], [true, true]);
  }
});

test("top 16 is a superset of top 8; winners/losers split the bracket with GF on the winners side", () => {
  const { graph } = graphOf("hundred-acres-47", "singles");
  const t8 = new Set(selectView(graph, "top8").setIds);
  const t16 = new Set(selectView(graph, "top16").setIds);
  for (const id of t8) assert.ok(t16.has(id));
  assert.ok(t16.size > t8.size);

  const w = selectView(graph, "winners").setIds.map((id) => graph.sets[id].side);
  const l = selectView(graph, "losers").setIds.map((id) => graph.sets[id].side);
  assert.ok(!w.includes("L") && w.includes("GF"));
  assert.ok(l.every((s) => s === "L"));
  assert.strictEqual(w.length + l.length, selectView(graph, "full").setIds.length);
});

test("rounds: winners outward-in, then GF and reset, then losers; columns in start.gg's top-to-bottom order", () => {
  const { graph } = graphOf("hundred-acres-49", "singles");
  const keys = graph.rounds.map((r) => r.key);
  assert.deepStrictEqual(keys, ["W1", "W2", "W3", "W4", "W5", "GF", "GFR", "L4", "L5", "L6", "L7", "L8", "L9", "L10"]);
  const w1 = graph.rounds[0].setIds.map((id) => graph.sets[id].identifier);
  assert.deepStrictEqual(w1, [...w1].sort());
  const l4 = graph.rounds.find((r) => r.key === "L4").setIds.map((id) => graph.sets[id].identifier);
  assert.deepStrictEqual(l4, ["X", "Y", "Z", "AA", "AB", "AC"], "two-letter identifiers sort after one-letter");
});

test("single elimination: no grand final, the final stays a winners set", () => {
  const { graph } = graphOf("hundred-acres-47", "redemption");
  assert.ok(setsOf(graph).every((s) => s.side === "W"));
  assert.strictEqual(selectView(graph, "losers").setIds.length, 0);
});

test("isTopN and an unknown view", () => {
  assert.ok(isTopN({ lPlacement: 7 }, 8));
  assert.ok(isTopN({ lPlacement: 8 }, 8));
  assert.ok(!isTopN({ lPlacement: 9 }, 8));
  assert.ok(!isTopN({ lPlacement: null }, 8));
  assert.deepStrictEqual(VIEWS, ["winners", "losers", "top8", "top16", "full"]);
  const { graph } = graphOf("hundred-acres-49", "singles");
  assert.throws(() => selectView(graph, "pools"), /unknown bracket view/);
});

console.log(failed === 0 ? "bracket-model: all passed" : `bracket-model: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
