/**
 * start.gg reads fall back to the keyless web endpoint; writes never do.
 *
 * Without TSH, the bracket and the set picker are read by the app itself, so a
 * spent rate limit or a missing token would otherwise blank the bracket mid-
 * event. The fallback covers that — and it must stay narrow, because each way
 * it could widen is silent:
 *
 *   - a mutation (report, start) sent keyless would be refused by start.gg at
 *     best and attributed to nobody at worst — it must never fall back;
 *   - a rejected token (401/403) falling back would hide an expired token until
 *     the first report of the night fails;
 *   - during a 429 cooldown, a paged read must not stall 30s between pages.
 *
 * No network: axios is stubbed, resolved from the bridge's own folder so this
 * patches the same module instance startgg-client.js uses.
 */

const assert = require("assert");
const path   = require("path");

const axios = require(require.resolve("axios", { paths: [path.join(__dirname, "..", "app", "lib")] }));
const StartggClient = require("../app/lib/startgg-client");

const OFFICIAL = "https://api.start.gg/gql/alpha";
const WEB      = "https://www.start.gg/api/-/gql";

let failed = 0;
async function test(name, fn) {
  const realPost = axios.post;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  } finally {
    axios.post = realPost;
  }
}

/** Stub axios.post with per-endpoint behaviour; returns the call log. */
function stub(handlers) {
  const calls = [];
  axios.post = async (url, body, cfg) => {
    calls.push({ url, body, headers: cfg?.headers ?? {} });
    const h = handlers[url];
    if (!h) throw new Error(`unexpected POST ${url}`);
    return h(body, calls.length);
  };
  return calls;
}
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const eventData = { data: { data: { event: { id: 1, name: "Melee Singles", phases: [] } } } };

(async () => {
  console.log("startgg-fallback");

  await test("no token: a read goes to the web endpoint with TSH's headers", async () => {
    const calls = stub({ [WEB]: async () => eventData });
    const gg = new StartggClient({ STARTGG_TOKEN: "" });
    const r = await gg.getEvent("tournament/t/event/e");
    assert.ok(r.ok && r.event.name === "Melee Singles");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, WEB);
    assert.strictEqual(calls[0].headers["client-version"], "20");
    assert.strictEqual(calls[0].headers.Authorization, undefined, "never sends a token there");
  });

  await test("no token: mutations refuse without any request", async () => {
    const calls = stub({});
    const gg = new StartggClient({ STARTGG_TOKEN: "" });
    for (const r of await Promise.all([gg.reportSet(1, 2), gg.startSet(1)])) {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /token not configured/);
    }
    assert.strictEqual(calls.length, 0);
  });

  await test("token + 429 on a read: answered from the web endpoint", async () => {
    const calls = stub({
      [OFFICIAL]: async () => { throw httpError(429); },
      [WEB]: async () => eventData,
    });
    const gg = new StartggClient({ STARTGG_TOKEN: "tok" });
    const r = await gg.getEvent("tournament/t/event/e");
    assert.ok(r.ok);
    assert.deepStrictEqual(calls.map((c) => c.url), [OFFICIAL, WEB]);
  });

  await test("token + 429 on a mutation: no fallback, the rate-limit error comes back", async () => {
    const calls = stub({ [OFFICIAL]: async () => { throw httpError(429); } });
    const gg = new StartggClient({ STARTGG_TOKEN: "tok" });
    const r = await gg.reportSet(1, 2);
    assert.strictEqual(r.ok, false);
    assert.ok(r.rateLimited);
    assert.deepStrictEqual(calls.map((c) => c.url), [OFFICIAL]);
  });

  await test("token rejected (401): no fallback — an expired token must surface", async () => {
    const calls = stub({ [OFFICIAL]: async () => { throw httpError(401); } });
    const gg = new StartggClient({ STARTGG_TOKEN: "tok" });
    const r = await gg.getEvent("tournament/t/event/e");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /rejected the token/);
    assert.deepStrictEqual(calls.map((c) => c.url), [OFFICIAL]);
  });

  await test("5xx, and the web endpoint fails too: the original error, not the fallback's", async () => {
    stub({
      [OFFICIAL]: async () => { throw httpError(502); },
      [WEB]: async () => { throw httpError(403); },
    });
    const gg = new StartggClient({ STARTGG_TOKEN: "tok" });
    const r = await gg.getEvent("tournament/t/event/e");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Network error contacting start.gg/);
  });

  // Both paths: an operator's read (a bracket switch, ↻) and the timed refresh,
  // which goes through the background budget.
  for (const background of [false, true]) {
    await test(`phase group paging (${background ? "timed refresh" : "operator"}): a 429 mid-read finishes the read from the web, without stalling`, async () => {
      const page = (n, total) => ({ data: { data: { phaseGroup: { sets: {
        pageInfo: { total: total * 2, totalPages: total }, nodes: [{ id: `${n}a` }, { id: `${n}b` }] } } } } });
      const calls = stub({
        [OFFICIAL]: async (body) => {
          if (body.variables.page === 1) return page(1, 3);
          throw httpError(429);
        },
        [WEB]: async (body) => page(body.variables.page, 3),
      });
      const gg = new StartggClient({ STARTGG_TOKEN: "tok" });
      const t0 = Date.now();
      const r = await gg.getPhaseGroupSets(42, { background });
      assert.ok(r.ok);
      assert.deepStrictEqual(r.sets.map((s) => s.id), ["1a", "1b", "2a", "2b", "3a", "3b"]);
      assert.ok(Date.now() - t0 < 2000, "no 30s cooldown wait between pages");
      // Page 3 goes straight to the web: the cooldown is running.
      assert.deepStrictEqual(calls.map((c) => c.url), [OFFICIAL, OFFICIAL, WEB, WEB]);
    });
  }

  await test("phase group paging: a complexity refusal restarts at a smaller page size", async () => {
    const sizes = [];
    stub({
      [OFFICIAL]: async (body) => {
        sizes.push(body.variables.perPage);
        if (body.variables.perPage === 40) return { data: { errors: [{ message: "Your query complexity is too high. A maximum of 1000 objects may be returned" }] } };
        return { data: { data: { phaseGroup: { sets: { pageInfo: { totalPages: 1 }, nodes: [{ id: 1 }] } } } } };
      },
    });
    const gg = new StartggClient({ STARTGG_TOKEN: "tok" });
    const r = await gg.getPhaseGroupSets(42);
    assert.ok(r.ok && r.sets.length === 1);
    assert.deepStrictEqual(sizes, [40, 20]);
  });

  console.log(failed === 0 ? "startgg-fallback: all passed" : `startgg-fallback: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
