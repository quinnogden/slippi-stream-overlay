/**
 * The overlay channel keeps every browser source's copy of the state equal to
 * the store's — including after a missed update.
 *
 * The failure this exists for is the quietest one an overlay has: a source
 * that misses one patch keeps drawing the old score, looks perfectly healthy,
 * and never corrects itself, because every later patch only carries what
 * changed. A patch says which rev it was diffed from; a client that sees a gap
 * must ask for the whole state rather than apply it.
 *
 * Runs the real store, the real channel (lib/overlay/channel.js) and the real
 * client mirror (overlays/shared/overlay-client.js, which loads under Node)
 * against a stand-in for Socket.io. Loads are real set-model payloads.
 */

const assert = require("assert");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createOverlayChannel } = require("../app/lib/overlay/channel");
const { loadPayload } = require("../app/lib/event/set-model");
const { buildBracket } = require("../app/lib/event/bracket-model");
const { createMirror } = require("../overlays/shared/overlay-client");
const { eventFrom } = require("./helpers/fake-startgg");
const sandbox = require("./helpers/overlay-sandbox");

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

const tick = () => new Promise((r) => setImmediate(r));

const graph = (() => {
  const { phaseGroup, sets } = eventFrom("hundred-acres-49", "singles");
  return buildBracket(sets, { phaseGroupId: phaseGroup.id });
})();
const payloadOf = (name) => loadPayload(graph, Object.values(graph.sets).find((s) => s.name === name).id);
/** The same set as if nothing had been played yet, so scores come from the test. */
const unplayed = (name) => {
  const p = payloadOf(name);
  return { ...p, sides: p.sides.map((x) => ({ ...x, score: 0 })) };
};

/** Socket.io, as far as the channel uses it: io.emit, io.of(name).on/emit, socket.on/emit. */
function fakeIo() {
  const nsps = {};
  const io = {
    emitted: [],
    emit(event, payload) { io.emitted.push([event, payload]); },
    of(name) {
      if (!nsps[name]) {
        nsps[name] = {
          sockets: new Set(),
          handlers: {},
          on(event, fn) { this.handlers[event] = fn; },
          emit(event, payload) { for (const s of this.sockets) s.deliver(event, payload); },
        };
      }
      return nsps[name];
    },
  };
  return { io, nsps };
}

/**
 * A browser source on `namespace`: the real mirror, plus everything else it
 * was sent. `dropNext()` loses the next patch on the wire.
 */
function connectClient({ nsps }, namespace = "/overlay") {
  const nsp = nsps[namespace];
  const client = { events: [], resyncs: 0, drop: 0 };
  const socket = {
    handlers: {},
    on(event, fn) { this.handlers[event] = fn; },
    emit(event, payload) { this.deliver(event, payload); },
    deliver(event, payload) {
      const msg = JSON.parse(JSON.stringify(payload)); // over the wire
      if (event === "state:full") return client.mirror.full(msg);
      if (event === "state:patch") {
        if (client.drop > 0) { client.drop--; return; }
        return client.mirror.patch(msg);
      }
      client.events.push([event, msg]);
    },
  };
  client.mirror = createMirror({
    requestResync: () => { client.resyncs++; socket.handlers["state:resync"](); },
  });
  client.dropNext = () => { client.drop++; };
  nsp.sockets.add(socket);
  nsp.handlers.connection(socket);
  return client;
}

function setup() {
  const store = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
  const wire = fakeIo();
  const channel = createOverlayChannel({ io: wire.io, store });
  return { store, wire, channel };
}

const assertInSync = (client, store, msg) =>
  assert.deepStrictEqual(client.mirror.state, JSON.parse(JSON.stringify(store.snapshot())), msg);

(async () => {
  console.log("overlay-patch");

  await test("a source's state follows the store through a whole set", async () => {
    const { store, wire } = setup();
    const ov = connectClient(wire);
    const dock = connectClient(wire, "/dock");
    assertInSync(ov, store, "state:full on connect");

    const steps = [
      () => store.loadSet(payloadOf("Losers Final")),
      () => store.setCharacter(0, 0, { codename: "fox", name: "Fox", skin: 2 }),
      () => store.recordGame({ winnerSide: 0, characters: [[{ codename: "fox", skin: 2 }], [null]] }),
      () => store.bump(1, 1),
      () => store.switchSides(),
      () => store.setOverrides({ bestOf: "Bo5", losers: [true, null] }),
      () => store.setCasters([{ tag: "Caster One", pronoun: "they/them" }, { tag: "Caster Two" }]),
      () => store.setBracketView("losers"),
      () => store.setTournament({ name: "Hundred Acres #49", eventName: "Melee Singles" }),
      () => store.clearSet(),
    ];
    for (const [i, step] of steps.entries()) {
      step();
      await tick();
      assertInSync(ov, store, `overlay after step ${i}`);
      assertInSync(dock, store, `dock after step ${i}`);
    }
    assert.strictEqual(ov.resyncs, 0, "nothing was missed, so nothing resynced");
  });

  await test("a burst of commands is one patch, and only the selectors whose part changed run", async () => {
    const { store, wire } = setup();
    store.loadSet(unplayed("Losers Final"));
    await tick();
    const ov = connectClient(wire);
    const calls = { scoreboard: 0, casters: 0, leftScore: [] };
    ov.mirror.select("scoreboard", () => calls.scoreboard++);
    ov.mirror.select("casters", () => calls.casters++);
    ov.mirror.select("scoreboard.sides.0.score", (now) => calls.leftScore.push(now));
    calls.scoreboard = 0; calls.casters = 0; calls.leftScore = [];

    store.setScore(0, 3); // three store commands
    await tick();
    assert.strictEqual(calls.scoreboard, 1, "one patch → the score animates once, not per game");
    assert.deepStrictEqual(calls.leftScore, [3]);
    assert.strictEqual(calls.casters, 0, "a scoreboard change must not redraw the casters");

    store.setCasters([{ tag: "Caster One" }]);
    await tick();
    assert.strictEqual(calls.scoreboard, 1, "a casters change must not redraw the scoreboard");
    assert.strictEqual(calls.casters, 1);
  });

  // The test this file exists for.
  await test("a missed patch resyncs instead of freezing the source", async () => {
    const { store, wire } = setup();
    store.loadSet(unplayed("Losers Final"));
    await tick();
    const ov = connectClient(wire);

    ov.dropNext();
    store.bump(0, 1);          // lost on the wire
    await tick();
    assert.strictEqual(ov.mirror.state.scoreboard.sides[0].score, 0, "the dropped patch really was dropped");

    store.setCasters([{ tag: "Caster One" }]); // a patch that doesn't carry the scoreboard
    await tick();
    assert.strictEqual(ov.resyncs, 1, "the gap was noticed");
    assertInSync(ov, store, "and the full state put the missed score back");
    assert.strictEqual(ov.mirror.state.scoreboard.sides[0].score, 1);
  });

  await test("a source that connects mid-burst ignores the patch its full state already holds", async () => {
    const { store, wire } = setup();
    store.loadSet(payloadOf("Losers Final"));
    await tick();

    store.bump(1, 1);                // queued, not yet sent
    const ov = connectClient(wire);  // its state:full already has the point
    await tick();                    // the queued patch arrives
    assert.strictEqual(ov.resyncs, 0, "an already-applied patch is not a gap");
    assertInSync(ov, store);

    store.bump(1, 1);
    await tick();
    assertInSync(ov, store, "and the next one still applies");
  });

  await test("after an app restart the new state replaces the old, even at a lower rev", async () => {
    const { store, wire } = setup();
    for (let i = 0; i < 5; i++) store.bump(0, 1);
    await tick();
    const ov = connectClient(wire);
    assert.ok(ov.mirror.rev >= 5);

    // A restarted app: a new store at a low rev; the socket reconnects and is sent state:full.
    const restarted = setup();
    restarted.store.loadSet(payloadOf("Grand Final"));
    ov.mirror.full(JSON.parse(JSON.stringify(restarted.store.snapshot())));
    assertInSync(ov, restarted.store, "a lower rev from a restarted app is still taken");

    restarted.store.bump(0, 1);
    await tick();
    ov.mirror.patch(JSON.parse(JSON.stringify({ from: restarted.store.rev - 1, rev: restarted.store.rev,
      ops: [{ path: "scoreboard", value: restarted.store.scoreboard() }] })));
    assertInSync(ov, restarted.store, "and the restarted app's patches apply on top");
  });

  await test("game, clip and stats events reach the overlays under the channel's names", async () => {
    const { wire, channel } = setup();
    const ov = connectClient(wire);
    const dock = connectClient(wire, "/dock");

    const game = { players: { 0: { playerIndex: 0, side: 0, codename: "fox", costumeIndex: 2 } }, isDoubles: false };
    channel.emit("slippi_game_start", game);
    channel.emit("player_stats", { enabled: true, players: {} });
    channel.emit("control_status", { startgg: { ok: true } });
    channel.emit("slippi_clip_error", { error: "OBS closed" });

    const names = (c) => c.events.map(([e]) => e);
    assert.deepStrictEqual(names(ov), ["game:start", "stats"], "overlays: no operator status or clip errors");
    assert.deepStrictEqual(names(dock), ["game:start", "status", "clip:error"]);
    assert.deepStrictEqual(wire.io.emitted, [], "nothing goes to the default namespace — no client listens there");

    const late = connectClient(wire);
    assert.deepStrictEqual(names(late), ["game:start", "stats"], "a source loaded mid-game gets the live game and the stats");

    channel.emit("slippi_game_end", { winner: null, handwarmer: true });
    const after = connectClient(wire);
    assert.deepStrictEqual(names(after), ["stats"], "once the game is over it isn't replayed");
  });

  await test("a theme switch fades out and reloads every source — the highlights frame too, which reads no state", async () => {
    const store = new ScoreboardStore();
    const { io, nsps } = sandbox.fakeIo();
    const channel = createOverlayChannel({ io, store });
    const pages = [];
    for (const page of ["side-panel", "bracket", "casters", "highlights"]) pages.push([page, await sandbox.loadOverlay({ page, nsps })]);

    channel.emit("theme_changed", { pack: "salty-suite" });
    channel.emit("theme_changed", { pack: "hundred-acres" }); // mid-fade: still one reload
    await sandbox.sleep(30);
    for (const [page, p] of pages) assert.strictEqual(p.window.location.reloads, 1, `${page} reloaded ${p.window.location.reloads} times`);
  });

  console.log(failed === 0 ? "overlay-patch: all passed" : `overlay-patch: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
