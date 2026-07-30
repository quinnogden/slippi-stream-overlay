/**
 * The Start Set button's gating doesn't poll start.gg.
 *
 * evaluateStartability() is called from the 2s control-status tick. start.gg
 * allows 80 requests per 60 seconds across the whole bridge, so a lookup on
 * every tick would burn 30 of them a minute on a value that changes twice per
 * set — and the first thing to break would be *reporting*, mid-stream, with no
 * error anywhere near the cause. That is squarely this suite's charter.
 *
 * The module's cache is keyed by set id, so each case here uses its own id
 * rather than needing a reset hook.
 */

const assert = require("assert");
const { evaluateStartability } = require("../slippi-bridge/lib/server/start-set");

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

/** A startgg stub that counts how many times the set state was fetched. */
function stubGg(state, { enabled = true } = {}) {
  const gg = {
    enabled,
    calls: 0,
    async getSetState() {
      gg.calls++;
      return state == null ? { ok: false, error: "nope" } : { ok: true, state };
    },
  };
  return gg;
}

const ctxFor = (startgg, crew = false) => ({ startgg, tsh: { isCrewBattle: () => crew } });
const STATE = {};   // the TSH program state — only isCrewBattle reads it here

(async () => {
  console.log("start-set");

  await test("a not-started set becomes startable, with exactly one lookup", async () => {
    const gg  = stubGg(1);
    const ctx = ctxFor(gg);

    // The 2s tick, thirty times over — one minute of the panel being open.
    for (let i = 0; i < 30; i++) {
      const r = evaluateStartability(ctx, STATE, "set-a");
      assert.strictEqual(r.canStart, false, "must not claim startable before the answer lands");
    }
    assert.strictEqual(gg.calls, 1, `polled start.gg ${gg.calls} times in one minute`);

    await new Promise((r) => setImmediate(r));

    const after = evaluateStartability(ctx, STATE, "set-a");
    assert.strictEqual(after.canStart, true, after.reason);
    assert.strictEqual(gg.calls, 1, "answering from cache must not re-query");
  });

  await test("a called set (state 6) is startable too", async () => {
    const ctx = ctxFor(stubGg(6));
    evaluateStartability(ctx, STATE, "set-called");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(evaluateStartability(ctx, STATE, "set-called").canStart, true);
  });

  await test("an already-running or finished set is refused, and says which", async () => {
    for (const [state, id, wording] of [[2, "set-live", /in progress/i], [3, "set-done", /finished/i]]) {
      const ctx = ctxFor(stubGg(state));
      evaluateStartability(ctx, STATE, id);
      await new Promise((r) => setImmediate(r));
      const r = evaluateStartability(ctx, STATE, id);
      assert.strictEqual(r.canStart, false, `state ${state} must not be startable`);
      assert.ok(wording.test(r.reason), `state ${state} reason was "${r.reason}"`);
    }
  });

  await test("a lookup failure refuses rather than defaulting to startable", async () => {
    const ctx = ctxFor(stubGg(null));
    evaluateStartability(ctx, STATE, "set-broken");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(evaluateStartability(ctx, STATE, "set-broken").canStart, false);
  });

  // Each of these must short-circuit before the network — no token, no set, a
  // crew battle and a preview id all mean there is nothing to start.
  await test("no token / no set / crew / preview never touch start.gg", async () => {
    const cases = [
      [ctxFor(stubGg(1, { enabled: false })), "set-x"],
      [ctxFor(stubGg(1)), null],
      [ctxFor(stubGg(1), true), "set-y"],
      [ctxFor(stubGg(1)), "preview_12345_1"],
    ];
    for (const [ctx, setId] of cases) {
      const r = evaluateStartability(ctx, STATE, setId);
      assert.strictEqual(r.canStart, false, `${setId} should not be startable`);
      assert.ok(r.reason, "a refusal must say why — the panel shows it");
      assert.strictEqual(ctx.startgg.calls, 0, `queried start.gg for ${setId}`);
    }
  });

  console.log(failed === 0 ? "start-set: all passed" : `start-set: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
