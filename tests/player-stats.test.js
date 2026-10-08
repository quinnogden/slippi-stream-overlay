/**
 * The side panel's head-to-head (app/lib/stats/). A wrong record is the
 * failure this suite exists for: it renders fine, looks plausible, and is only
 * caught by someone in chat who knows the rivalry.
 *
 * Every rule in headToHead() here was found by checking the app against a
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
 * re-read at half the size instead of being treated as empty. And that
 * background requests wait for rate budget.
 *
 * Usage: node tests/player-stats.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { headToHead, h2hPill, luckyFromResponse, runFromEventSets, completedFromEventSets } =
  require("../app/lib/stats/normalize");
const { SetHistoryStore } = require("../app/lib/stats/set-history");
const { createPlayerStats } = require("../app/lib/stats");
const { LuckyStatsClient } = require("../app/lib/stats/luckystats");
const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { loadPayload } = require("../app/lib/event/set-model");
const { buildBracket } = require("../app/lib/event/bracket-model");
const { eventFrom } = require("./helpers/fake-startgg");
const StartggClient = require("../app/lib/startgg-client");

// A real luckystats.gg answer for a pair, scrubbed: its players are start.gg
// users 9001 (player1) and 9002 (player2).
const LUCKY_PAIR = () => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "luckystats", "pair.json"), "utf8"));

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

  // ── luckystats.gg ──────────────────────────────────────────────────────────
  //
  // Asked by start.gg USER id; a player id it doesn't refuse, it answers with
  // someone else. So nothing is placed by position — only by the user id it
  // came back with.

  await test("luckystats players are placed by the user id they came back with", () => {
    const { ratings, matchup } = luckyFromResponse(LUCKY_PAIR(), { 9001: A, 9002: B });
    assert.deepStrictEqual(Object.keys(ratings).sort(), [A, B].sort());
    assert.strictEqual(ratings[A].rank, 167);
    assert.strictEqual(ratings[A].className, "Regional Threat");
    assert.strictEqual(ratings[B].rank, 355);
    assert.ok(matchup, "both players were found, so there's a matchup");
  });

  await test("an answer for a user we didn't ask about is dropped, and with it the matchup", () => {
    const { ratings, matchup } = luckyFromResponse(LUCKY_PAIR(), { 9001: A, 7777: B });
    assert.deepStrictEqual(Object.keys(ratings), [A], "a user id we never asked about was put on a card");
    assert.strictEqual(matchup, null);
  });

  await test("the matchup's probabilities follow its own order", () => {
    const body = LUCKY_PAIR();
    // Asked the other way round: user 9001 is B now.
    const { matchup } = luckyFromResponse(body, { 9001: B, 9002: A });
    assert.strictEqual(matchup.winProbability[B], body.matchup.winProbability.glickoOnly.player1);
    assert.strictEqual(matchup.winProbability[A], body.matchup.winProbability.glickoOnly.player2);
  });

  await test("the region is the player's public Region with its artwork, else their own — never a crew", () => {
    const body = LUCKY_PAIR();
    let r = luckyFromResponse(body, { 9001: A, 9002: B }).ratings[A];
    assert.strictEqual(r.region, "Region A Melee");
    assert.strictEqual(r.regionImage, body.players[0].displayRegion.imageUrl);
    assert.strictEqual(r.regionRank, null, "no region rank in the answer, but one was shown");
    // displayRegion falls back to a crew; the card labels it "Region".
    body.players[0].displayRegion = { name: "Some Crew", imageUrl: "https://luckystats.gg/crew.png", url: null, source: "crew" };
    r = luckyFromResponse(body, { 9001: A, 9002: B }).ratings[A];
    assert.deepStrictEqual([r.region, r.regionImage], ["Region A", null], "a crew was shown as the region");
    // A rank in the Region's ranking rides with the Region it belongs to.
    body.players[1].displayRegion.rank = 10;
    assert.strictEqual(luckyFromResponse(body, { 9001: A, 9002: B }).ratings[B].regionRank, 10);
  });

  await test("a malformed value is dropped, never shown", () => {
    const body = LUCKY_PAIR();
    Object.assign(body.players[0], {
      luckyRank: { rank: 0 },
      playerClass: { key: "regional-threat", name: "  ", svgUrl: 42 },
      primaryRegion: { name: "Region A" },
      displayRegion: { name: "", imageUrl: "https://example.public.blob.vercel-storage.com/a.jpg", url: null, source: "region" },
    });
    body.players[1].luckyRank = { rank: "-3" };
    const { ratings } = luckyFromResponse(body, { 9001: A, 9002: B });
    assert.deepStrictEqual(
      [ratings[A].rank, ratings[A].className, ratings[A].classSvg, ratings[A].region, ratings[A].regionImage],
      [null, null, null, null, null]);
    assert.strictEqual(ratings[B].rank, null);
  });

  await test("region artwork: saved once, under its own type, and only from luckystats' hosts", async () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "lucky-art-"));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const asked = [];
    const http = { async get(url) {
      asked.push(url);
      return { status: 200, data: url.includes("page") ? Buffer.from("<html>not an image</html>".padEnd(64)) : jpeg };
    } };
    try {
      const client = new LuckyStatsClient({ apiKey: "k", http, imageDir: dir, log() {} });
      const art = "https://abc123.public.blob.vercel-storage.com/regions/1/avatar-1.jpg";
      const url = await client.regionArt(art);
      assert.ok(/^\/assets\/luckystats\/region-[0-9a-f]{16}\.jpg$/.test(url), `saved as ${url}`);
      assert.ok(fs.readFileSync(path.join(dir, url.split("/").pop())).equals(jpeg));
      assert.strictEqual(await client.regionArt(art), url);
      assert.strictEqual(asked.length, 1, "the same artwork was fetched twice");
      assert.strictEqual(await client.regionArt("https://evil.example.com/a.jpg"), null);
      assert.strictEqual(await client.regionArt("http://abc123.public.blob.vercel-storage.com/a.jpg"), null);
      assert.strictEqual(asked.length, 1, "fetched from a host that isn't luckystats'");
      assert.strictEqual(await client.regionArt("https://luckystats.gg/page.jpg"), null, "saved something that isn't an image");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("the probability is the ratings-only one, not blended with luckystats' head-to-head", () => {
    const body = LUCKY_PAIR();
    body.matchup.winProbability.blended = { player1: 0.5, player2: 0.5 };
    const { matchup } = luckyFromResponse(body, { 9001: A, 9002: B });
    assert.strictEqual(matchup.winProbability[A], body.matchup.winProbability.glickoOnly.player1);
  });

  // ── The stats module end to end: start.gg's user ids into luckystats ──────

  const singles = eventFrom("hundred-acres-49", "singles");
  const graph = buildBracket(singles.sets, { phaseGroupId: singles.phaseGroup.id });
  const payloadNamed = (name) => loadPayload(graph, Object.values(graph.sets).find((s) => s.name === name).id);
  const pidsOf = (payload) => payload.sides.map((s) => s.players[0].playerId);

  /** start.gg answering the cards with each player's user id, and every history empty. */
  function cardsGg(users) {
    return {
      enabled: true,
      async backgroundQuery(q) {
        if (q.includes("playerSets")) return { ok: true, data: { player: { sets: { pageInfo: { total: 0, totalPages: 0 }, nodes: [] } } } };
        const data = {};
        for (const [, i, id] of q.matchAll(/p(\d+): player\(id: (\d+)\)/g)) {
          data[`p${i}`] = { id, user: users[id] ? { id: users[id] } : null, recentStandings: [] };
        }
        return { ok: true, data };
      },
    };
  }

  /** luckystats answering whoever is asked with the fixture's numbers. `hold` delays an answer. */
  function fakeLucky() {
    const lucky = {
      enabled: true,
      calls: [],
      holds: [],
      async players(ids) {
        lucky.calls.push(ids);
        const body = LUCKY_PAIR();
        body.players = body.players.slice(0, ids.length).map((p, i) => ({ ...p, startggUserId: ids[i] }));
        if (ids.length === 2) body.matchup.order = ids; else delete body.matchup;
        const answer = { ok: true, data: body };
        if (lucky.hold) return new Promise((res) => lucky.holds.push(() => res(answer)));
        return answer;
      },
      badge: async (key) => `/assets/luckystats/class-${key}.svg`,
      regionArt: async () => "/assets/luckystats/region-0123456789abcdef.jpg",
    };
    return lucky;
  }

  function statsRig(users, lucky = fakeLucky()) {
    const store = new ScoreboardStore();
    const stats = createPlayerStats(
      { store, event: null, startgg: cardsGg(users), io: { emit() {} } },
      { cacheDir: null, lucky, log() {} });
    stats.start();
    return { store, lucky, stats };
  }

  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error(`timed out waiting for ${what}`);
  };

  await test("luckystats is asked by the user ids start.gg gave, and answers by player id", async () => {
    const gf = payloadNamed("Grand Final");
    const [a, b] = pidsOf(gf);
    const { store, lucky, stats } = statsRig({ [a]: "501", [b]: "502" });
    store.loadSet(gf);
    await until(() => stats.snapshot().lucky?.state === "done", "luckystats");
    assert.deepStrictEqual(lucky.calls, [["501", "502"]], "asked by player id — that's somebody else");
    const snap = stats.snapshot().lucky;
    assert.deepStrictEqual(snap.players, [a, b]);
    assert.strictEqual(snap.ratings[a].rank, 167);
    assert.ok(snap.matchup.winProbability[a] > 0.5);
    // The sources load only the app's copies: no luckystats url reaches them.
    assert.strictEqual(snap.ratings[a].badge, "/assets/luckystats/class-regional-threat.svg");
    assert.strictEqual(snap.ratings[a].regionIcon, "/assets/luckystats/region-0123456789abcdef.jpg");
    assert.ok(!/https?:/.test(JSON.stringify(snap.ratings)), "a web url went to the overlays");
    stats.stop();
  });

  await test("a late luckystats answer for the previous pair is dropped", async () => {
    const gf = payloadNamed("Grand Final");
    const lf = payloadNamed("Losers Final");
    const users = Object.fromEntries([...pidsOf(gf), ...pidsOf(lf)].map((pid, i) => [pid, String(600 + i)]));
    const { store, lucky, stats } = statsRig(users);
    lucky.hold = true;
    store.loadSet(gf);
    await until(() => lucky.holds.length === 1, "the first ask");
    lucky.hold = false;
    store.loadSet(lf);
    await until(() => stats.snapshot().lucky?.state === "done", "the second answer");
    lucky.holds[0]();                       // the Grand Final's answer, late
    await new Promise((r) => setTimeout(r, 20));
    const snap = stats.snapshot().lucky;
    assert.deepStrictEqual(snap.players, pidsOf(lf));
    assert.deepStrictEqual(Object.keys(snap.ratings).sort(), pidsOf(lf).sort(), "the previous pair's numbers landed on this pair");
    stats.stop();
  });

  await test("a player with no start.gg account is left out, and there's no matchup", async () => {
    const gf = payloadNamed("Grand Final");
    const [a] = pidsOf(gf);
    const { store, lucky, stats } = statsRig({ [a]: "501" });
    store.loadSet(gf);
    await until(() => stats.snapshot().lucky?.state === "done", "luckystats");
    assert.deepStrictEqual(lucky.calls, [["501"]]);
    assert.deepStrictEqual(Object.keys(stats.snapshot().lucky.ratings), [a]);
    assert.strictEqual(stats.snapshot().lucky.matchup, null);
    stats.stop();
  });

  await test("with no luckystats key nothing is asked and the snapshot has no lucky section", async () => {
    const gf = payloadNamed("Grand Final");
    const [a, b] = pidsOf(gf);
    const off = { ...fakeLucky(), enabled: false };
    const { store, stats } = statsRig({ [a]: "501", [b]: "502" }, off);
    store.loadSet(gf);
    await until(() => stats.snapshot().players[a]?.state === "done", "the cards");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(off.calls, []);
    assert.strictEqual(stats.snapshot().lucky, null);
    stats.stop();
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
