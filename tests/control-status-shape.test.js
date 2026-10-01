/**
 * The control_status object has one shape, from the first push onward.
 *
 * A panel that connects before the first 2s tick gets the startup seed, and one
 * that connects later gets a rebuilt status. If the two disagree about which
 * fields exist, the panel reads `undefined` for a while after every bridge
 * restart and nothing reports it — render() has no try/catch, so a nested read
 * of a missing object freezes the dock outright. Both now come from compose();
 * this pins that they stay that way.
 *
 * Also pins that start.gg's token gate holds for every method that needs the
 * token, since the gate lives in one place (_gql) rather than in each method.
 * Reads that fall back to the web endpoint are covered by startgg-fallback.
 */

const assert = require("assert");

const { ScoreboardStore } = require("../slippi-bridge/lib/scoreboard/store");
const StartggClient   = require("../slippi-bridge/lib/startgg-client");
const { createState } = require("../slippi-bridge/lib/state");
const { createControlStatus } = require("../slippi-bridge/lib/server/control-status");

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

/** Every key path in an object, e.g. "currentSet.scores.team1". */
function keyPaths(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    const nested = v && typeof v === "object" && !Array.isArray(v) && k !== "slippiDetail"
      && k !== "settings" && k !== "obs";
    return nested ? [p, ...keyPaths(v, p)] : [p];
  }).sort();
}

function ctxFor() {
  const store = new ScoreboardStore();
  store.setTournament({ name: "Hundred Acres #49", eventName: "Melee Singles", eventSlug: "tournament/x/event/y" });
  return {
    config:          { BRACKETS: { shortLink: "x" } },
    store,
    event:           { status: () => ({ state: "ok", error: null, updatedAt: 1 }) },
    startgg:         { enabled: false },
    clipperSettings: { get: () => ({ enabled: false }) },
    obs:             { getStatus: () => ({ connected: false }) },
    io:              { emit() {} },
    state:           createState(),
  };
}

(async () => {
  console.log("control-status-shape");

  await test("the startup seed and a rebuilt status have the same fields", async () => {
    const ctx  = ctxFor();
    const cs   = createControlStatus(ctx, () => ({ method: "positional", ports: [] }));
    const seed = keyPaths(ctx.state.lastControlStatus);
    const built = await cs.refresh();
    assert.deepStrictEqual(keyPaths(built), seed);
    assert.deepStrictEqual(built.tournament, { name: "Hundred Acres #49", eventName: "Melee Singles" });
    assert.strictEqual(built.startgg.ok, true);
  });

  await test("a failed rebuild resolves to the last status instead of rejecting", async () => {
    const ctx = ctxFor();
    const cs = createControlStatus(ctx, () => ({ method: "positional", ports: [] }));
    ctx.event.status = () => { throw new Error("boom"); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const got = await cs.refresh();
      assert.strictEqual(got, ctx.state.lastControlStatus);
    } finally {
      console.warn = warn;
    }
  });

  await test("with no token, every start.gg method that needs one refuses without a request", async () => {
    // A broken gate would reach axios and fail with a network error instead.
    const gg = new StartggClient({ STARTGG_TOKEN: "" });
    const calls = [gg.reportSet(1, 2), gg.getSetState(1), gg.startSet(1)];
    for (const r of await Promise.all(calls)) {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /token not configured/);
    }
  });

  console.log(failed === 0 ? "control-status-shape: all passed" : `control-status-shape: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
