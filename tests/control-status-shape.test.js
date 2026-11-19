/**
 * The control_status object has one shape, from the first push onward.
 *
 * A dock that connects before the first 2s tick gets the startup seed, and one
 * that connects later gets a rebuilt status. If the two disagree about which
 * fields exist, the dock reads `undefined` for a while after every restart and
 * nothing reports it. Both come from compose(); this pins that they stay that way.
 *
 * It also carries OBS's health (lib/obs-health.js), whose rules are pinned here
 * against facts gathered by the real ObsClient from OBS-shaped answers: the
 * stream, the audio and the overlays, each a problem nobody sees until it's
 * on stream.
 */

const assert = require("assert");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createState } = require("../app/lib/state");
const { createControlStatus, HEARTBEAT_MS } = require("../app/lib/server/control-status");
const { ObsClient } = require("../app/lib/obs-client");
const { evaluate, GRACE } = require("../app/lib/obs-health");

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

/** Every key path in an object, e.g. "currentSet.canReport". */
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
    store,
    event:           { status: () => ({ state: "ok", error: null, updatedAt: 1 }) },
    startgg:         { enabled: false },
    clipperSettings: { get: () => ({ enabled: false }) },
    obs:             new ObsClient(() => ({ enabled: false, obsMonitor: true }), { port: 5001 }),
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

  await test("status goes out when it changes, and on the heartbeat — not every tick", async () => {
    const ctx = ctxFor();
    const sent = [];
    ctx.io = { emit: (ev, s) => sent.push(s) };
    const cs = createControlStatus(ctx, () => ({ method: "positional", ports: [] }));
    await cs.refresh();
    await cs.refresh();
    assert.strictEqual(sent.length, 1, "an unchanged rebuild isn't re-sent");
    ctx.store.setTournament({ name: "Hundred Acres #50", eventName: "Melee Singles" });
    await cs.refresh();
    assert.strictEqual(sent.length, 2, "a change is sent at once");
    const realNow = Date.now;
    Date.now = () => realNow() + HEARTBEAT_MS + 1;
    try {
      await cs.refresh();
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(sent.length, 3, "and an unchanged one goes out once the heartbeat is due");
  });

  // ── OBS's health ──────────────────────────────────────────────────────────
  // An ObsClient that thinks it's connected, fed what OBS would send.
  const T0 = 1_000_000;
  function obsAt(settings = {}) {
    const obs = new ObsClient(() => ({ obsMonitor: true, obsUrl: "ws://x", ...settings }), { port: 5001 });
    obs._connected = true;
    obs._health.connectedAt = T0;
    obs._health.targetFps = 60;
    return obs;
  }
  const streamAt = (bytes, sent, dropped, active = true) =>
    ({ outputActive: active, outputReconnecting: false, outputCongestion: 0, outputBytes: bytes, outputTotalFrames: sent, outputSkippedFrames: dropped });
  const RECORD_OFF = { outputActive: false, outputPaused: false };
  const STATS = { activeFps: 60, availableDiskSpace: 200000, renderSkippedFrames: 0, renderTotalFrames: 0, outputSkippedFrames: 0, outputTotalFrames: 0 };
  const meters = (obs, t, levels) => obs._onMeters(Object.entries(levels).map(([inputName, mul]) => ({ inputName, inputLevelsMul: [[mul, mul, mul]] })), t);
  const ids = (r) => r.issues.map((i) => `${i.level} ${i.id}`);

  await test("OBS's counters become the stream's bitrate and drop rate", async () => {
    const obs = obsAt();
    obs._sample(streamAt(0, 0, 0), RECORD_OFF, STATS, T0);
    obs._sample(streamAt(2_250_000, 180, 18), RECORD_OFF, STATS, T0 + 3000);
    const f = obs.health(T0 + 3000);
    assert.strictEqual(f.stream.kbps, 6000, "2.25 MB in 3s is 6000 kbps");
    assert.strictEqual(f.stream.dropPct, 10);
    assert.deepStrictEqual(ids(evaluate(f, {}, T0 + 3000)).filter((x) => x.includes("stream")), ["error stream-drops"]);
  });

  await test("not streaming: a warning with a set loaded, an error with a game on", async () => {
    const obs = obsAt();
    obs._sample(streamAt(0, 0, 0, false), RECORD_OFF, STATS, T0);
    const f = obs.health(T0 + 1000);
    assert.deepStrictEqual(ids(evaluate(f, {}, T0 + 1000)).filter((x) => x.includes("streaming")), [], "nothing loaded: nothing to say");
    const loaded = evaluate(f, { setLoaded: true }, T0 + 1000);
    assert.ok(ids(loaded).includes("warn not-streaming") && loaded.lights.live === "warn");
    const live = evaluate(f, { setLoaded: true, gameLive: true, gameSince: T0 }, T0 + 1000);
    assert.ok(ids(live).includes("error not-streaming") && live.lights.live === "down");
  });

  await test("the game's sound: silent through a game is an error once its grace is out; muted, at once", async () => {
    const obs = obsAt();
    obs._sample(streamAt(0, 0, 0), RECORD_OFF, STATS, T0);
    meters(obs, T0, { "Elgato Game Capture": 0.3, "Mic": 0.2 });
    for (let t = T0 + 500; t <= T0 + 30000; t += 500) meters(obs, t, { "Elgato Game Capture": 0, "Mic": 0.2 });
    const game = (now) => evaluate(obs.health(now), { setLoaded: true, gameLive: true, gameSince: T0 + 2000 }, now);
    assert.strictEqual(game(T0 + 30000).gameAudio, "Elgato Game Capture", "guessed by its name");
    assert.ok(!ids(game(T0 + 2000 + GRACE.silentGame - 500)).includes("error game-silent"), "a quiet moment isn't a problem");
    assert.ok(ids(game(T0 + 2000 + GRACE.silentGame)).includes("error game-silent"));
    obs._obs.emit("InputMuteStateChanged", { inputName: "Elgato Game Capture", inputMuted: true });
    const muted = game(T0 + 3000);
    assert.ok(ids(muted).includes("error game-muted") && muted.lights.audio === "down");
    assert.ok(ids(evaluate(obs.health(T0 + 3000), { setLoaded: true }, T0 + 3000)).includes("warn game-muted"), "between games, a warning");
  });

  await test("an overlay OBS shows that never connected is flagged, with a Refresh, once it's had time to load", async () => {
    const obs = obsAt();
    const settings = {
      "Side panel": { url: "http://localhost:5001/o/side-panel?panel=player-1" },
      "Scoreboard": { url: "http://192.168.0.5:5001/o/scoreboard/" },
      "Other site": { url: "https://example.com/o/x" },
      "Local file": { is_local_file: true, url: "http://localhost:5001/o/bracket" },
    };
    obs._obs.call = async (req, args) => {
      if (req === "GetInputList") return { inputs: Object.keys(settings).map((inputName) => ({ inputName })) };
      if (req === "GetInputSettings") return { inputSettings: settings[args.inputName] };
      throw new Error(`unexpected ${req}`);
    };
    const realNow = Date.now;
    Date.now = () => T0;
    try { await obs._listSources(); } finally { Date.now = realNow; }
    assert.deepStrictEqual(obs.health(T0).sources.map((x) => x.name), ["Side panel", "Scoreboard"], "only this app's overlays");
    const at = (now, pages) => evaluate(obs.health(now), { pages }, now).issues.filter((i) => i.id.startsWith("source:"));
    assert.deepStrictEqual(at(T0 + GRACE.source - 1000, []), [], "still loading");
    const missing = at(T0 + GRACE.source, ["/o/scoreboard"]);
    assert.deepStrictEqual(missing.map((i) => [i.id, i.fix.action, i.fix.input]), [["source:Side panel", "refresh-source", "Side panel"]]);
    assert.deepStrictEqual(at(T0 + GRACE.source, ["/o/scoreboard", "/o/side-panel?panel=player-1"]), []);
  });

  console.log(failed === 0 ? "control-status-shape: all passed" : `control-status-shape: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
