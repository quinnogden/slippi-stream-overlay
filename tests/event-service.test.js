/**
 * The event service: the dock's bracket buttons, its set picker, and what
 * loading a set puts on the scoreboard.
 *
 * Each failure here is silent until it is on stream:
 *
 *   - **A late answer for the previous event.** The picker refreshes on a timer;
 *     if a refresh for last event's bracket lands after the operator switched,
 *     the picker offers the other event's sets and a load puts the wrong set
 *     (and the wrong entrant ids, which is what gets reported) on air.
 *   - **A set load that ignores the player DB.** The pronoun and main the
 *     operator recorded never reach the scoreboard, and new players never get a
 *     record — so the port map has no mains to match on next time either.
 *   - **A set loaded from a stale list.** The picker can be 90s old; the load
 *     re-reads the set, and says so when it can't instead of failing.
 *   - **A restart that forgets the event.** The scoreboard survives a restart;
 *     the picker has to come back with it, without a button press.
 *
 * Answers come from captured tournaments (helpers/fake-startgg.js); the player
 * DB is a synthetic temp file.
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { EventService } = require("../app/lib/event/event-service");
const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { PlayerDb, serialize } = require("../app/lib/players/player-db");
const { fakeStartgg } = require("./helpers/fake-startgg");

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

const CONFIG = {
  BRACKETS: {
    shortLink: "100-acres",
    events: {
      singles: { match: ["melee", "singles"], fallbackSlug: "melee-singles-flex-bo5" },
      doubles: { match: ["melee", "doubles"], fallbackSlug: "melee-doubles" },
    },
  },
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-service-"));
let n = 0;
function playerDb(records = []) {
  const file = path.join(dir, `players-${++n}.json`);
  fs.writeFileSync(file, serialize(records, "\r\n"));
  return new PlayerDb(file, { debounceMs: 60000 });
}

function setup(capture, { startgg, records, store } = {}) {
  const ctx = {
    config: CONFIG,
    startgg: startgg ?? fakeStartgg(capture),
    store: store ?? new ScoreboardStore(),
    playerDb: playerDb(records),
  };
  return { ...ctx, svc: new EventService(ctx, { log: () => {} }) };
}

const called = (gg, method) => gg.calls.filter((c) => c.method === method);

(async () => {
  console.log("event-service");

  await test("Singles / Doubles load this week's event by keyword; a second press re-reads it", async () => {
    const { svc, store, startgg } = setup("hundred-acres-49");
    const r = await svc.switchEvent("singles");
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.refreshed, false);
    assert.strictEqual(r.eventName, "Melee Singles (Flex Bo5)");
    assert.deepStrictEqual(store.tournament(), {
      name: "Hundred Acres #49", slug: "tournament/hundred-acres-49",
      eventName: "Melee Singles (Flex Bo5)", eventSlug: "tournament/hundred-acres-49/event/melee-singles-flex-bo5",
      kind: "singles",
    });
    assert.strictEqual(svc.status().state, "ok");

    const again = await svc.switchEvent("singles");
    assert.ok(again.ok && again.refreshed, "same event → refresh, not a reload");
    assert.strictEqual(called(startgg, "getPhaseGroupSets").length, 1,
      "a completed phase group is read once, not on every refresh");

    const d = await svc.switchEvent("doubles");
    assert.strictEqual(d.eventName, "Melee Doubles");
    assert.strictEqual(store.tournament().kind, "doubles");
  });

  await test("switching events never touches the set on air", async () => {
    const { svc, store } = setup("hundred-acres-49");
    await svc.switchEvent("singles");
    const gf = svc.openSets({ includeDone: true }).find((s) => s.roundName === "Grand Final");
    await svc.loadSet(gf.setId);
    const before = store.scoreboard();
    await svc.switchEvent("doubles");
    assert.deepStrictEqual(store.scoreboard(), before);
  });

  await test("the picker offers playable sets first; a preview set loads without a start.gg read", async () => {
    const { svc, store, startgg } = setup("hundred-acres-51");
    await svc.switchEvent("singles");
    const list = svc.openSets();
    assert.ok(list.length > 0);
    assert.strictEqual(list[0].status, "playable");
    const firstWaiting = list.findIndex((s) => s.status !== "playable");
    assert.ok(list.slice(firstWaiting).every((s) => s.status !== "playable"), "no playable set after a waiting one");
    assert.strictEqual(list[0].phase, "", "a one-group event needs no phase label");

    const r = await svc.loadSet(list[0].setId);
    assert.ok(r.ok, r.error);
    assert.strictEqual(called(startgg, "getSet").length, 0, "preview ids don't exist on start.gg yet");
    const sb = store.scoreboard();
    assert.strictEqual(sb.setId, list[0].setId);
    assert.ok(sb.isPreview);
    assert.ok(sb.sides.every((s) => s.entrantId), "entrant ids ride along for the report");
    assert.deepStrictEqual(sb.sides.map((s) => s.players[0].tag), list[0].names);
  });

  await test("a set load takes pronoun and main from the player DB, and adds new players to it", async () => {
    const { svc, store, playerDb: db } = setup("hundred-acres-51", { records: [
      { prefix: "Team1", gamerTag: "Player1", name: "", twitter: "", pronoun: "they/them",
        mains: { ssbm: [["Captain Falcon", 3, ""]] }, country_code: "", state_code: "" },
    ] });
    await svc.switchEvent("singles");
    const row = svc.openSets().find((s) => s.names.includes("Player1"));
    await svc.loadSet(row.setId);

    const side = store.scoreboard().sides.find((s) => s.players[0].tag === "Player1");
    const p = side.players[0];
    assert.strictEqual(p.pronoun, "they/them");
    assert.deepStrictEqual(p.main, { codename: "captain_falcon", name: "Captain Falcon", skin: 3 });
    assert.deepStrictEqual(p.character, p.main, "shown until Slippi says otherwise");
    assert.strictEqual(db.find({ tag: "Player1" }).startggPlayerId, p.playerId, "known player linked by id");

    const other = store.scoreboard().sides.find((s) => s.players[0].tag !== "Player1");
    const added = db.find({ playerId: other.players[0].playerId });
    assert.ok(added, "a new player gets a record");
    assert.strictEqual(added.gamerTag, other.players[0].tag);
    assert.strictEqual(other.players[0].main, null, "and no invented main");
  });

  await test("the outgoing set is closed before the incoming players' mains are read", async () => {
    // Mains learning commits on set-closing; a player in back-to-back sets
    // must open the second on what they played in the first.
    const { svc, store, playerDb: db } = setup("hundred-acres-51", { records: [
      { prefix: "Team1", gamerTag: "Player1", name: "", mains: { ssbm: [["Captain Falcon", 3, ""]] } },
    ] });
    store.on("set-closing", () => db.learnMain(db.find({ tag: "Player1" }), { name: "Fox", skin: 1 }));
    await svc.switchEvent("singles");
    const row = svc.openSets().find((s) => s.names.includes("Player1"));
    await svc.loadSet(row.setId);
    const p = store.scoreboard().sides.map((s) => s.players[0]).find((x) => x.tag === "Player1");
    assert.deepStrictEqual(p.main, { codename: "fox", name: "Fox", skin: 1 });
  });

  await test("a real set is re-read before it loads; a failed re-read still loads, with a warning", async () => {
    const startgg = fakeStartgg("hundred-acres-49");
    const { svc, store } = setup("hundred-acres-49", { startgg });
    await svc.switchEvent("singles");
    const row = svc.openSets({ includeDone: true }).find((s) => s.roundName === "Losers Final");

    const ok = await svc.loadSet(row.setId);
    assert.ok(ok.ok && !ok.warning);
    assert.deepStrictEqual(called(startgg, "getSet").map((c) => c.args[0]), [row.setId]);

    startgg.getSet = async () => ({ ok: false, error: "network down" });
    const degraded = await svc.loadSet(row.setId);
    assert.ok(degraded.ok);
    assert.match(degraded.warning, /network down/);
    assert.strictEqual(store.scoreboard().setId, row.setId);

    assert.match((await svc.loadSet("nope")).error, /isn't in the loaded event/);
  });

  await test("a refresh still in flight for the previous event can't overwrite the new one", async () => {
    const startgg = fakeStartgg("hundred-acres-51");
    const { svc, store } = setup("hundred-acres-51", { startgg });
    await svc.switchEvent("singles");

    // Hold the timed refresh's singles read until after the switch to doubles.
    let release;
    const gate = new Promise((r) => { release = r; });
    const realEvent = startgg.getEvent;
    startgg.getEvent = async (slug, opts) => {
      if (opts?.background) await gate;
      return realEvent(slug, opts);
    };
    const stale = svc.refresh({ background: true });
    await new Promise((r) => setImmediate(r));
    await svc.switchEvent("doubles");
    release();
    await stale;

    assert.strictEqual(store.tournament().kind, "doubles");
    assert.ok(svc.openSets().every((s) => s.phaseGroupId === "100005"), "only doubles sets on offer");
    assert.deepStrictEqual(svc.snapshot().phaseGroups.map((g) => g.id), ["100005"]);
  });

  await test("a restart reloads the saved event without a button press", async () => {
    const before = setup("hundred-acres-51");
    await before.svc.switchEvent("singles");
    const saved = before.store.toJSON();

    const store = new ScoreboardStore();
    store.restore(JSON.parse(JSON.stringify(saved)));
    const { svc, startgg } = setup("hundred-acres-51", { store });
    svc.start();
    svc.stop();
    await svc.refresh(); // shares the start-up read
    assert.strictEqual(called(startgg, "resolveShortLink").length, 0, "no short-link hop on restart");
    assert.strictEqual(svc.status().state, "ok");
    assert.ok(svc.openSets().length > 0);
    assert.strictEqual(store.tournament().kind, "singles", "kind kept across the reload");
  });

  await test("an event start.gg can't read is an error the dock can show, not an empty list", async () => {
    const startgg = fakeStartgg("hundred-acres-49");
    startgg.listEvents = async () => ({ ok: false, error: "start.gg web fallback failed: 503" });
    startgg.getEvent = async () => ({ ok: false, error: "start.gg web fallback failed: 503" });
    const { svc } = setup("hundred-acres-49", { startgg });
    const r = await svc.switchEvent("singles");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /503/);
    assert.strictEqual(svc.status().state, "error");
    assert.match((await svc.refresh()).error, /No event loaded/);
  });

  await test("the refresh that sees the bracket finish still reads its last set", async () => {
    // hundred-acres-51 ended on a GF reset. Wound back to before its report: the
    // reset in progress, the group active. The next event read says completed —
    // that read must still fetch the sets, or the reset stays live in the picker.
    const startgg = fakeStartgg("hundred-acres-51.final");
    const { svc } = setup(null, { startgg });
    const finished = { getEvent: startgg.getEvent, getPhaseGroupSets: startgg.getPhaseGroupSets };
    startgg.getEvent = async (slug) => {
      const r = await finished.getEvent(slug);
      for (const ph of r.event?.phases ?? []) for (const pg of ph.phaseGroups.nodes) pg.state = 2;
      return r;
    };
    startgg.getPhaseGroupSets = async (id) => {
      const r = await finished.getPhaseGroupSets(id);
      const reset = r.sets.find((s) => s.fullRoundText === "Grand Final Reset");
      if (reset) Object.assign(reset, { state: 2, winnerId: null });
      return r;
    };
    await svc.switchEvent("singles");
    const live = (rows) => rows.filter((s) => s.status === "live").map((s) => s.roundName);
    assert.deepStrictEqual(live(svc.openSets()), ["Grand Final Reset"], "the wound-back state is what tonight looked like");

    Object.assign(startgg, finished);
    const before = called(startgg, "getPhaseGroupSets").length;
    await svc.refresh();
    assert.strictEqual(called(startgg, "getPhaseGroupSets").length, before + 1, "the group's last read was before it finished");
    assert.deepStrictEqual(svc.openSets(), [], "nothing left to play");
    await svc.refresh();
    assert.strictEqual(called(startgg, "getPhaseGroupSets").length, before + 1, "…and now it's read once");
  });

  await test("stats pre-fetch the players in the next playable sets", async () => {
    const { svc } = setup("hundred-acres-51");
    await svc.switchEvent("singles");
    const ids = svc.playablePlayerIds(2);
    const graph = svc.graph("100008");
    const want = svc.openSets().slice(0, 2).flatMap((row) =>
      graph.sets[row.setId].slots.flatMap((s) => graph.entrants[s.entrantId].players.map((p) => p.playerId)));
    assert.deepStrictEqual(ids, want);
    assert.strictEqual(ids.length, 4);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? "event-service: all passed" : `event-service: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
