/**
 * player-stats.test.js
 *
 * The bridge's head-to-head (app/lib/stats/). A wrong record is the
 * failure this suite exists for: it renders fine, looks plausible, and is only
 * caught by someone in chat who knows the rivalry. TSH's own H2H was wrong in
 * exactly that way for months.
 *
 * Every rule in headToHead() here was found by checking the bridge against a
 * hand-verified record (ZODD-01's vs NAV / Big Matt / Yung John / Redd), and
 * each case below is the shape of set that broke it:
 *
 *   - a set played under an old tag, whose slot carries the OLD player id
 *   - a Project M set, which Player.sets mixes in with Melee
 *   - a doubles set where both players were first-listed on their teams
 *   - a DQ, and a set that never finished
 *   - the same set seen from both players' histories
 *
 * Also pins the two things that keep the crawl affordable: a top-up stops at the
 * first page it already holds, and a page start.gg refuses as too large is
 * re-read at half the size instead of being treated as empty (which is TSH's
 * bug). And that background requests wait for rate budget.
 *
 * Usage: node tests/player-stats.test.js
 */

const assert = require("assert");
const { headToHead, h2hPill, runFromEventSets, completedFromEventSets } =
  require("../app/lib/stats/normalize");
const { SetHistoryStore } = require("../app/lib/stats/set-history");
const StartggClient = require("../app/lib/startgg-client");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const A = "1097";  // the player
const B = "1069";  // the opponent
const A_OLD = "5297839"; // A's pre-merge player record

/** A compact set as set-history.js stores it. */
function set(id, sides, winnerSide, extra = {}) {
  const slots = sides.map((players, i) => ({ entrantId: `e${id}-${i}`, players: [].concat(players) }));
  return {
    id: String(id), state: 3, dq: false, videogameId: "1", eventId: "ev", eventStartAt: 1000,
    completedAt: 1000 + Number(id), winnerId: slots[winnerSide].entrantId, slots, ...extra,
  };
}

(async () => {
  console.log("player-stats");

  await test("counts a set played under an old tag, found by the opponent's id", () => {
    const histA = [
      set(1, [A, B], 0),
      set(2, [A_OLD, B], 0), // "CG | JI" 3-2 Redd: A's side has the old id
      set(3, [B, A], 0),
    ];
    const h = headToHead(histA, [], A, B);
    assert.deepStrictEqual(h.wins, { [A]: 2, [B]: 1 },
      "requiring A's current id on A's side drops sets played before the account merge");
  });

  await test("leaves out other games, doubles, DQs and unfinished sets", () => {
    const histA = [
      set(10, [A, B], 0),
      set(11, [A, B], 1, { videogameId: "2" }),   // Project M Singles, Tiger Smash 4
      set(12, [[A, "x"], [B, "y"]], 0),            // doubles, both first-listed
      set(13, [A, B], 1, { dq: true }),
      set(14, [A, B], 1, { state: 2 }),
    ];
    const h = headToHead(histA, [], A, B);
    assert.deepStrictEqual(h.sets.map((s) => s.id), ["10"]);
    assert.deepStrictEqual(h.wins, { [A]: 1, [B]: 0 });
  });

  await test("unions both histories without double-counting", () => {
    const B_OLD = "7777";
    const shared = set(20, [A, B], 1);           // in both histories: count it once
    const aAlias = set(21, [A_OLD, B], 0);       // only A's history can place A here
    const bAlias = set(22, [A, B_OLD], 1);       // only B's history can place B here
    const both   = set(23, [A_OLD, B_OLD], 0);   // aliases on both sides: neither can
    const h = headToHead([shared, aAlias, both], [shared, bAlias, both], A, B);
    assert.deepStrictEqual(h.sets.map((s) => s.id).sort(), ["20", "21", "22"]);
    assert.deepStrictEqual(h.wins, { [A]: 1, [B]: 2 });
  });

  await test("orders newest first and keys every record by player id", () => {
    const h = headToHead([set(30, [A, B], 0), set(31, [B, A], 0)], [], A, B);
    assert.deepStrictEqual(h.sets.map((s) => s.id), ["31", "30"]);
    assert.strictEqual(h.sets[0].winner, B);
    const pill = h2hPill({
      fullRoundText: "Grand Final", event: { name: "Melee Singles", tournament: { name: "HA #50" } },
      slots: [
        { entrant: { id: "e31-0" }, standing: { stats: { score: { value: 3 } } } },
        { entrant: { id: "e31-1" }, standing: { stats: { score: { value: 1 } } } },
      ],
    }, h.sets[0]);
    assert.deepStrictEqual(pill.scores, { [B]: 3, [A]: 1 }, "scores must follow the entrant, not the slot order");
  });

  await test("a winner-only report keeps its winner and has null scores", () => {
    const h = headToHead([set(40, [B, A], 1)], [], A, B);
    const pill = h2hPill({ slots: [{ entrant: { id: "e40-0" } }, { entrant: { id: "e40-1" } }] }, h.sets[0]);
    assert.strictEqual(pill.winner, A);
    assert.deepStrictEqual(pill.scores, { [A]: null, [B]: null });
  });

  await test("run and just-finished skip DQs and follow the winner id", () => {
    const node = (id, p0, p1, s0, s1, winner, extra = {}) => ({
      id, completedAt: id, fullRoundText: "R", winnerId: winner,
      slots: [
        { entrant: { id: "a" + id, name: p0, participants: [{ gamerTag: p0, player: { id: p0 } }] }, standing: { stats: { score: { value: s0 } } } },
        { entrant: { id: "b" + id, name: p1, participants: [{ gamerTag: p1, player: { id: p1 } }] }, standing: { stats: { score: { value: s1 } } } },
      ],
      ...extra,
    });
    const nodes = [node(1, A, "9", 3, 1, "a1"), node(2, "9", A, 2, 3, "b2"), node(3, A, "8", -1, 0, "b3")];
    const run = runFromEventSets(nodes, A);
    assert.deepStrictEqual(run.map((r) => [r.won, r.myScore, r.oppScore]), [[true, 3, 2], [true, 3, 1]]);
    const done = completedFromEventSets(nodes);
    assert.deepStrictEqual(done.map((d) => d.winner), [1, 0], "DQ'd set must not appear");
  });

  // ── The crawl ──────────────────────────────────────────────────────────────

  /** A start.gg stub serving `total` sets newest-first, refusing big pages. */
  function stubGg(total, { maxPerPage = Infinity } = {}) {
    const all = Array.from({ length: total }, (_, i) => ({
      id: total - i, winnerId: 1, state: 3, completedAt: total - i,
      event: { id: 5, startAt: 1, videogame: { id: 1 } },
      slots: [{ entrant: { id: 1, participants: [{ player: { id: A } }] } }, { entrant: { id: 2, participants: [{ player: { id: B } }] } }],
    }));
    const gg = {
      calls: [],
      add(n) { for (let i = 0; i < n; i++) all.unshift({ ...all[0], id: all[0].id + 1 }); },
      async backgroundQuery(_q, { page, perPage }) {
        gg.calls.push({ page, perPage });
        if (perPage > maxPerPage) return { ok: false, complexity: true, error: "complexity is too high" };
        const nodes = all.slice((page - 1) * perPage, page * perPage);
        return { ok: true, data: { player: { sets: { pageInfo: { total: all.length, totalPages: Math.ceil(all.length / perPage) }, nodes } } } };
      },
    };
    return gg;
  }
  const quiet = { log() {} };

  await test("a refused page is re-read smaller, never counted as empty", async () => {
    const gg = stubGg(100, { maxPerPage: 30 });
    const r = await new SetHistoryStore(gg, null, quiet).sync(A);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.sets.length, 100, `held ${r.sets.length} of 100 sets`);
  });

  await test("a top-up stops at the first page it already holds", async () => {
    const gg = stubGg(300);
    const store = new SetHistoryStore(gg, null, quiet);
    await store.sync(A);
    const crawl = gg.calls.length;
    gg.add(3);
    const r = await store.sync(A);
    assert.strictEqual(r.sets.length, 303);
    assert.ok(gg.calls.length - crawl <= 2, `top-up took ${gg.calls.length - crawl} requests (full crawl took ${crawl})`);
    await store.sync(A, { maxAgeMs: 60000 });
    assert.ok(gg.calls.length - crawl <= 2, "a fresh copy must not touch the network");
  });

  await test("background requests wait for rate budget; others don't", async () => {
    const gg = new StartggClient({ STARTGG_TOKEN: "t" });
    gg._gql = async () => { gg._sent.push(Date.now()); return { ok: true, data: {} }; };
    // 50 requests that leave the 60s window in ~150ms.
    const t0 = Date.now();
    gg._sent = Array.from({ length: 50 }, () => t0 - 59850);
    await gg.backgroundQuery("{}");
    const waited = Date.now() - t0;
    assert.ok(waited >= 100, `a full window let a background request through after ${waited}ms`);
  });

  console.log(failed === 0 ? "player-stats: all passed" : `player-stats: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
