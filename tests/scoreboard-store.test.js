/**
 * The scoreboard store: what gets reported, and what survives a restart.
 *
 * Two failures this pins are silent on stream and expensive after it:
 *
 *   - **Reporting the wrong entrant.** Under TSH, which start.gg entrant sat in
 *     a column depended on TSH's swap flag (the entrantSlot inversion). Now each
 *     side carries its entrant id and Switch Sides moves it — so the report
 *     after any number of switches must still name the player who won, and
 *     every per-game winner must still be the right entrant.
 *   - **Losing the set to a restart.** The app is the scoreboard now; a crash
 *     mid-set without the live-state save blanks names, score and the game
 *     list a report is built from.
 *
 * Loads are real set-model payloads from captured brackets, never hand-written
 * set shapes.
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { ScoreboardStore, STATE_VERSION } = require("../slippi-bridge/lib/scoreboard/store");
const { createPersist } = require("../slippi-bridge/lib/scoreboard/persist");
const { gameDataOf, createReportSet } = require("../slippi-bridge/lib/server/report-set");
const { loadPayload } = require("../slippi-bridge/lib/event/set-model");
const { buildBracket } = require("../slippi-bridge/lib/event/bracket-model");
const { eventFrom } = require("./helpers/fake-startgg");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

const graph = (() => {
  const { phaseGroup, sets } = eventFrom("hundred-acres-49", "singles");
  return buildBracket(sets, { phaseGroupId: phaseGroup.id });
})();
const setNamed = (name) => Object.values(graph.sets).find((s) => s.name === name);
const payloadOf = (name) => loadPayload(graph, setNamed(name).id);

/** A loaded, unplayed-looking copy of a real set (score zeroed so games come from the test). */
function freshStore(name = "Losers Final") {
  const store = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
  const p = payloadOf(name);
  store.loadSet({ ...p, sides: p.sides.map((s) => ({ ...s, score: 0 })) });
  return store;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-store-"));

(async () => {
  console.log("scoreboard-store");

  await test("a real set loads with its entrants; a set loaded mid-way keeps its score", async () => {
    const p = payloadOf("Grand Final");
    const store = new ScoreboardStore();
    store.loadSet(p);
    const sb = store.scoreboard();
    assert.strictEqual(sb.sides[0].entrantId, p.sides[0].entrantId);
    assert.deepStrictEqual(sb.sides.map((s) => s.score), p.sides.map((s) => s.score));
    assert.ok(sb.games.every((g) => g.manual), "pre-existing games are manual (order unknown)");
    assert.deepStrictEqual(sb.sides.map((s) => s.losers), [false, true], "GF: [L] on the losers-side player");
    assert.strictEqual(sb.bestOfLabel, "Bo5");
  });

  await test("score is the game list: ± adds and removes that side's games", async () => {
    const store = freshStore();
    store.bump(0, 1); store.bump(1, 1); store.bump(0, 1);
    assert.deepStrictEqual(store.scoreboard().sides.map((s) => s.score), [2, 1]);
    store.bump(0, -1);
    assert.deepStrictEqual(store.scoreboard().games.map((g) => g.winnerSide), [0, 1], "removes that side's latest");
    store.bump(1, -1); store.bump(1, -1);
    assert.deepStrictEqual(store.scoreboard().sides.map((s) => s.score), [1, 0], "never below zero");
    store.setScore(1, 3);
    assert.deepStrictEqual(store.scoreboard().sides.map((s) => s.score), [1, 3]);
  });

  await test("reportable refuses a tie, a preview set, and no set", async () => {
    const store = freshStore();
    assert.match(store.reportable().reason, /tied/);
    store.bump(0, 1);
    assert.ok(store.reportable().ok);
    store.clearSet();
    assert.match(store.reportable().reason, /No start.gg set/);
    const pre = new ScoreboardStore();
    pre.loadSet({ setId: "preview_1_1_1", isPreview: true, sides: [{ entrantId: "1" }, { entrantId: "2" }] });
    pre.bump(0, 1);
    assert.match(pre.reportable().reason, /preview/);
  });

  await test("Switch Sides any number of times: the report names the entrant who won, game by game", async () => {
    const store = freshStore();
    const [left, right] = store.scoreboard().sides.map((s) => s.entrantId);
    store.recordGame({ winnerSide: 0 });                 // left wins G1
    store.switchSides();                                 // left player now on the right
    store.recordGame({ winnerSide: 1 });                 // ...and wins G2 from there
    store.recordGame({ winnerSide: 0 });                 // right player takes G3
    store.switchSides();
    store.recordGame({ winnerSide: 0 });                 // original left wins G4, back on the left
    const r = store.reportable();
    assert.ok(r.ok);
    assert.strictEqual(r.winnerEntrantId, left);
    assert.deepStrictEqual(gameDataOf(r).map((g) => g.winnerId), [left, left, right, left]);
    assert.deepStrictEqual(gameDataOf(r).map((g) => g.gameNum), [1, 2, 3, 4]);
  });

  await test("Switch Sides carries the [L] override and characters with the side", async () => {
    const store = new ScoreboardStore();
    store.loadSet(payloadOf("Grand Final"));
    store.setOverrides({ losers: [true, null] });
    store.recordGame({ winnerSide: 0, characters: [[{ codename: "fox", name: "Fox", skin: 0 }], [{ codename: "marth", name: "Marth", skin: 1 }]] });
    store.switchSides();
    const sb = store.scoreboard();
    assert.deepStrictEqual(sb.sides.map((s) => s.losers), [true, true], "derived [L] moved right; override moved too");
    assert.strictEqual(sb.games.at(-1).winnerSide, 1);
    assert.strictEqual(sb.games.at(-1).characters[1][0].codename, "fox");
  });

  await test("report-set sends the store's result to start.gg", async () => {
    const store = freshStore();
    store.recordGame({ winnerSide: 1 });
    store.recordGame({ winnerSide: 1 });
    const calls = [];
    const startgg = { enabled: true, reportSet: async (...a) => { calls.push(a); return { ok: true }; } };
    const { reportCurrentSet } = createReportSet({ store, startgg }, () => {});
    const res = await reportCurrentSet();
    assert.ok(res.ok, res.error);
    assert.strictEqual(res.score, "0-2");
    const sb = store.scoreboard();
    assert.deepStrictEqual(calls[0].slice(0, 2), [sb.setId, sb.sides[1].entrantId]);
    assert.strictEqual(calls[0][2].length, 2);
  });

  await test("every change bumps rev and says which section changed", async () => {
    const store = freshStore();
    const seen = [];
    store.on("change", (c) => seen.push(c));
    const rev = store.rev;
    store.bump(0, 1);
    store.setCasters([{ tag: "Caster" }]);
    store.setBracketView("losers");
    store.setBracketView("losers");                       // no-op
    assert.deepStrictEqual(seen.map((c) => c.keys[0]), ["scoreboard", "casters", "view"]);
    assert.strictEqual(store.rev, rev + 3);
  });

  await test("persist: a restart restores the set, score, games, casters and view", async () => {
    const file = path.join(tmpDir, "live-state.json");
    const a = freshStore();
    const persist = createPersist(a, file, { debounceMs: 5 });
    persist.start();
    a.recordGame({ winnerSide: 0 });
    a.switchSides();
    a.setCasters([{ tag: "Mic", pronoun: "they/them" }]);
    a.setBracketView("full");
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(fs.existsSync(file) && !fs.existsSync(`${file}.tmp`), "written atomically");

    const b = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
    assert.ok(createPersist(b, file).restore());
    const strip = (s) => ({ ...s, rev: 0 });
    assert.deepStrictEqual(strip(b.snapshot()), strip(a.snapshot()));
    assert.strictEqual(b.reportable().winnerEntrantId, a.reportable().winnerEntrantId);
  });

  await test("persist: a missing, corrupt or other-version save leaves the scoreboard empty", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const file = path.join(tmpDir, "bad.json");
      const s = new ScoreboardStore();
      assert.strictEqual(createPersist(s, path.join(tmpDir, "none.json")).restore(), false);
      fs.writeFileSync(file, "{ not json");
      assert.strictEqual(createPersist(s, file).restore(), false);
      fs.writeFileSync(file, JSON.stringify({ v: STATE_VERSION + 1, set: { setId: "x" } }));
      assert.strictEqual(createPersist(s, file).restore(), false);
      assert.strictEqual(s.scoreboard().setId, null);
    } finally {
      console.warn = warn;
    }
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(failed === 0 ? "scoreboard-store: all passed" : `scoreboard-store: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
