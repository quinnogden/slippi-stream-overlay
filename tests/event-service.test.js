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
const { createBracketOps } = require("../app/lib/event/bracket-ops");
const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { PlayerDb, serialize } = require("../app/lib/players/player-db");
const { fakeStartgg, loadCapture, rewind, startBracket } = require("./helpers/fake-startgg");

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

/** Wait until `cond()` holds. */
async function until(cond, what, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

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

  await test("a preview set loads without a start.gg read", async () => {
    const { svc, store, startgg } = setup("hundred-acres-51");
    await svc.switchEvent("singles");
    const list = svc.openSets();
    assert.ok(list.length > 0);
    assert.strictEqual(list[0].status, "playable");
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

    // While the re-read is out, a game that ends waits for the set (lib/modes): it says so, and when it's done.
    let release;
    startgg.getSet = () => new Promise((r) => { release = () => r({ ok: false, error: "network down" }); });
    let settled = 0;
    svc.on("set-load-settled", () => settled++);
    const loading = svc.loadSet(row.setId);
    assert.strictEqual(svc.loadingSet, true, "a load waiting on start.gg isn't said to be in flight");
    release();
    const degraded = await loading;
    assert.strictEqual(svc.loadingSet, false);
    assert.strictEqual(settled, 1);
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

  await test("a saved event start.gg couldn't read at boot loads on a later poll", async () => {
    // Venue Wi-Fi is often not up when the app starts. The poll has to keep
    // trying the saved event, or the bracket and Up next stay empty until
    // someone presses a button.
    const before = setup("hundred-acres-51");
    await before.svc.switchEvent("singles");
    const store = new ScoreboardStore();
    store.restore(JSON.parse(JSON.stringify(before.store.toJSON())));

    const startgg = fakeStartgg("hundred-acres-51");
    const realEvent = startgg.getEvent;
    let down = true;
    startgg.getEvent = async (...args) =>
      (down ? { ok: false, error: "Network error contacting start.gg: ENOTFOUND" } : realEvent(...args));
    const svc = new EventService({ config: CONFIG, startgg, store, playerDb: playerDb() }, { pollMs: 10, log: () => {} });
    svc.start();
    try {
      await until(() => svc.status().state === "error", "the failed read at boot");
      down = false;
      await until(() => svc.status().state === "ok", "the saved event, on a later poll");
      assert.ok(svc.openSets().length > 0);
    } finally { svc.stop(); }
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

  // When a bracket starts, start.gg reads as empty for a minute and then
  // renumbers every set. The bracket on stream must not go blank, and the set
  // on air must reach its new id with its games — reloading it would drop the
  // game already played, and its replay with it.
  await test("a bracket starting: the blank read keeps the last list, and the set on air follows its new id with its games", async () => {
    const capture = loadCapture("hundred-acres-51");
    const startgg = fakeStartgg(capture);
    const { svc, store } = setup(null, { startgg });
    await svc.switchEvent("singles");
    const row = svc.openSets()[0];
    await svc.loadSet(row.setId);
    store.recordGame({ winnerSide: 0 });
    const open = svc.openSets().length;

    const sets = capture.phaseGroupSets[row.phaseGroupId];
    capture.phaseGroupSets[row.phaseGroupId] = [];
    await svc.refresh();
    svc.stop();
    assert.strictEqual(svc.openSets().length, open, "the last list stays up");
    assert.ok(svc.status().rebuilding);
    assert.strictEqual(store.scoreboard().setId, row.setId, "nothing moves while it's blank");

    capture.phaseGroupSets[row.phaseGroupId] = sets;
    startBracket(capture);
    let relinked = null;
    svc.on("set-relinked", (e) => { relinked = e; });
    await svc.refresh();
    svc.stop();
    const sb = store.scoreboard();
    assert.ok(!svc.status().rebuilding);
    assert.ok(!sb.isPreview && !String(sb.setId).startsWith("preview"), "on the real id");
    assert.deepStrictEqual(relinked, { from: row.setId, to: sb.setId });
    assert.strictEqual(sb.games.length, 1, "the game played on the preview set is kept");
    assert.ok(store.reportable().ok, "and it can be reported now");
  });

  // start.gg's lists show a report seconds later. The bracket on stream and
  // Up next mustn't show a reported set as still open in the meantime — nor
  // keep showing it done once start.gg says otherwise.
  await test("a press shows at once, over start.gg's lagging lists, until they agree", async () => {
    const capture = rewind(loadCapture("hundred-acres-49"), 0.5);
    // Mid-event the groups are running, so every refresh reads them.
    for (const ev of capture.tournament.events) for (const ph of ev.phases) for (const pg of ph.phaseGroups.nodes) pg.state = 2;
    const { svc } = setup(null, { startgg: fakeStartgg(capture) });
    await svc.switchEvent("singles");
    const row = svc.openSets().find((s) => s.status === "playable");
    const [a, b] = svc.findSet(row.setId).set.slots.map((s) => s.entrantId);
    svc.afterAction(row.setId, { state: 3, winnerId: a, scores: { [a]: 2, [b]: 0 } });
    svc.stop();
    const state = () => svc.findSet(row.setId).set.state;
    assert.strictEqual(state(), "done", "shown done at once");
    await svc.refresh();
    assert.strictEqual(state(), "done", "a lagging read doesn't bring it back");
    const shown = svc.findSet(row.setId).set;
    assert.deepStrictEqual(shown.slots.map((s) => s.score), shown.slots.map((s) => (s.entrantId === a ? 2 : 0)));

    const raw = capture.phaseGroupSets[row.phaseGroupId].find((s) => String(s.id) === row.setId);
    raw.state = 3;
    await svc.refresh(); // start.gg agrees: the press is forgotten…
    raw.state = 1;
    await svc.refresh(); // …so a TO's reset on start.gg shows
    svc.stop();
    assert.strictEqual(state(), "pending");
  });

  // A set reported, its winner already sat down for the next one, and Up next
  // still showing it waiting for a minute: start.gg's lists lag a report. The
  // report moves its players on by start.gg's own edges the moment it lands.
  const running = (frac) => {
    const capture = rewind(loadCapture("hundred-acres-49"), frac);
    for (const ev of capture.tournament.events) for (const ph of ev.phases) for (const pg of ph.phaseGroups.nodes) pg.state = 2;
    return capture;
  };
  const fedFrom = (set, id) => set.slots.find((x) => x.from.kind === "set" && x.from.setId === id);

  await test("a report puts its winner and loser in their next sets at once; a lagging read can't take them back", async () => {
    const capture = running(0.5);
    const { svc } = setup(null, { startgg: fakeStartgg(capture) });
    await svc.switchEvent("singles");
    const node = (id) => svc.findSet(id).set;
    const status = (id) => svc.openSets().find((r) => r.setId === id)?.status;
    // A winners set whose winner meets someone already waiting.
    const row = svc.openSets().find((r) => {
      const s = node(r.setId);
      return r.status === "playable" && s.next.lose && s.next.win &&
        node(s.next.win).slots.some((x) => x.entrantId && x !== fedFrom(node(s.next.win), s.id));
    });
    assert.ok(row, "the rewound bracket has one");
    const set = node(row.setId);
    const [a, b] = set.slots.map((x) => x.entrantId);
    assert.strictEqual(status(set.next.win), "waiting");

    // start.gg's answer to the report: the next set with the winner in (on station 7).
    const raws = capture.phaseGroupSets[row.phaseGroupId];
    const winner = raws.find((s) => String(s.id) === row.setId).slots.find((x) => String(x.entrant?.id) === a).entrant;
    const answer = raws.find((s) => String(s.id) === set.next.win);
    const slots = answer.slots.map((x) => (String(x.prereqId) === row.setId ? { ...x, entrant: winner } : x));
    svc.afterAction(row.setId, { state: 3, winnerId: a, scores: { [a]: 3, [b]: 1 } }, [{ ...answer, slots, station: { id: 1, number: 7 } }]);
    svc.stop();
    assert.strictEqual(fedFrom(node(set.next.win), row.setId).entrantId, a, "the winner is in their next set");
    assert.strictEqual(fedFrom(node(set.next.lose), row.setId).entrantId, b, "the loser in theirs");
    assert.strictEqual(status(set.next.win), "playable", "ready in Up next");
    assert.strictEqual(node(set.next.win).station, 7, "start.gg's answer replaces the list's copy");

    await svc.refresh(); // start.gg's lists haven't caught up yet
    svc.stop();
    assert.strictEqual(status(set.next.win), "playable", "a lagging read doesn't take it back");
    assert.strictEqual(fedFrom(node(set.next.lose), row.setId).entrantId, b);
  });

  await test("a grand final's reset fills only when the losers side won; a DQ'd loser isn't moved on", async () => {
    for (const fromLosers of [false, true]) {
      const { svc } = setup(null, { startgg: fakeStartgg(running(0.97)) });
      await svc.switchEvent("singles");
      const sets = Object.values(svc.graph("100008").sets);
      const gf = sets.find((s) => s.side === "GF");
      const reset = sets.find((s) => s.side === "GFR");
      assert.ok(gf.slots.every((x) => x.entrantId) && reset.state === "pending", "GF up, its reset after it");
      const winner = gf.slots.find((x) => x.fromLosers === fromLosers).entrantId;
      svc.afterAction(gf.id, { state: 3, winnerId: winner });
      svc.stop();
      const status = svc.openSets().find((r) => r.setId === reset.id)?.status;
      assert.strictEqual(status, fromLosers ? "playable" : "waiting",
        fromLosers ? "the losers side won: the reset is on" : "the winners side won: start.gg deletes the reset");
    }

    const { svc } = setup(null, { startgg: fakeStartgg(running(0.5)) });
    await svc.switchEvent("singles");
    const row = svc.openSets().find((r) => r.status === "playable" && svc.findSet(r.setId).set.next.lose);
    const set = svc.findSet(row.setId).set;
    const [a, b] = set.slots.map((x) => x.entrantId);
    svc.afterAction(row.setId, { state: 3, winnerId: a, scores: { [a]: 0, [b]: -1 }, dq: true });
    svc.stop();
    assert.strictEqual(fedFrom(svc.findSet(set.next.win).set, row.setId).entrantId, a);
    assert.strictEqual(fedFrom(svc.findSet(set.next.lose).set, row.setId).entrantId, null, "start.gg takes a DQ out, not on");
  });

  // The timer asks start.gg only what changed since the newest change it
  // holds — one request where a weekly's whole read is four — and reads a
  // group whole only when a list of changes can't be the whole story.
  // Update times a minute and a half apart, as a running bracket's are; the
  // changes a test makes come after all of them.
  const stamped = (frac) => {
    const capture = running(frac);
    Object.values(capture.phaseGroupSets).flat().forEach((s, i) => { s.updatedAt = 1000 + i * 90; });
    return capture;
  };
  const LATER = 100000;

  await test("a poll asks only what changed: a TO's report shows in one request; a set start.gg renumbered gets a whole read", async () => {
    const capture = stamped(0.5);
    const startgg = fakeStartgg(capture);
    const { svc } = setup(null, { startgg });
    await svc.switchEvent("singles");
    svc.stop();
    const reads = (m) => called(startgg, m).length;
    const [whole, events] = [reads("getPhaseGroupSets"), reads("getEvent")];

    // Reported on start.gg, not from the dock: the set and the one its winner went to change.
    const row = svc.openSets().find((r) => r.status === "playable" && svc.findSet(r.setId).set.next.win);
    const nextId = svc.findSet(row.setId).set.next.win;
    const raws = capture.phaseGroupSets[row.phaseGroupId];
    const raw = raws.find((s) => String(s.id) === row.setId);
    const winner = raw.slots[0].entrant;
    Object.assign(raw, { state: 3, winnerId: winner.id, updatedAt: LATER });
    const next = raws.find((s) => String(s.id) === nextId);
    next.slots = next.slots.map((x) => (String(x.prereqId) === row.setId ? { ...x, entrant: winner } : x));
    next.updatedAt = LATER;

    await svc.refresh({ background: true });
    svc.stop();
    assert.strictEqual(reads("getChangedSets"), 1, "one request");
    assert.deepStrictEqual([reads("getPhaseGroupSets"), reads("getEvent")], [whole, events], "nothing read whole, the event not re-read inside its minute");
    assert.strictEqual(svc.findSet(row.setId).set.state, "done");
    assert.strictEqual(fedFrom(svc.findSet(nextId).set, row.setId).entrantId, String(winner.id), "the winner shows in their next set");

    // A TO's reset renumbers sets: a change with an id the app doesn't hold.
    const moved = raws.find((s) => s.state !== 3);
    const oldId = String(moved.id);
    Object.assign(moved, { id: 990001, updatedAt: LATER + 100 });
    await svc.refresh({ background: true });
    svc.stop();
    assert.strictEqual(reads("getPhaseGroupSets"), whole + 1, "the group is read whole");
    assert.ok(svc.findSet("990001") && !svc.findSet(oldId), "under start.gg's new id");
  });

  await test("a grand final won from the winners side: the reset start.gg deleted goes, though a deletion isn't a change", async () => {
    const capture = stamped(0.97);
    const { svc } = setup(null, { startgg: fakeStartgg(capture) });
    await svc.switchEvent("singles");
    svc.stop();
    const sets = Object.values(svc.graph("100008").sets);
    const gf = sets.find((s) => s.side === "GF");
    const reset = sets.find((s) => s.side === "GFR");
    const raws = capture.phaseGroupSets["100008"];
    const raw = raws.find((s) => String(s.id) === gf.id);
    Object.assign(raw, { state: 3, winnerId: Number(gf.slots.find((x) => !x.fromLosers).entrantId), updatedAt: LATER });
    raws.splice(raws.findIndex((s) => String(s.id) === reset.id), 1);

    await svc.refresh({ background: true });
    svc.stop();
    assert.strictEqual(svc.findSet(gf.id).set.state, "done");
    assert.strictEqual(svc.findSet(reset.id), null, "no reset left in Up next or on the bracket");
  });

  // ── The Bracket tab's "Run the bracket" card (lib/event/bracket-ops.js) ──

  const opsFor = (svc, store, startgg) => {
    const ops = createBracketOps({ event: svc, store, startgg, io: { emit() {} } }, { log: () => {} });
    ops.start();
    return ops;
  };
  const midEvent = () => {
    const capture = rewind(loadCapture("hundred-acres-49"), 0.4);
    for (const ev of capture.tournament.events) for (const ph of ev.phases) for (const pg of ph.phaseGroups.nodes) pg.state = 2;
    return capture;
  };

  // The set on the scoreboard is the strip's to report: it sends each game in
  // order and queues the replays. A report from the card sends the games too
  // (start.gg keeps no score without them), ending on the winner's.
  await test("the bracket card: ready sets in call order, the on-air set refused, a report's games ending on the winner's", async () => {
    const startgg = fakeStartgg(midEvent());
    const { svc, store } = setup(null, { startgg });
    await svc.switchEvent("singles");
    const ops = opsFor(svc, store, startgg);
    const ready = ops.snapshot().sets.filter((r) => r.status === "ready");
    assert.ok(ready.length >= 3, "the rewound bracket has sets to call");
    assert.deepStrictEqual(ready.map((r) => r.callOrder), ready.map((_, i) => i + 1));
    for (let i = 1; i < ready.length; i++) {
      const [p, q] = [ready[i - 1], ready[i]];
      const gap = (r) => Math.abs(r.slots[0].seed - r.slots[1].seed);
      assert.ok(p.lPlacement > q.lPlacement || (p.lPlacement === q.lPlacement && gap(p) <= gap(q)),
        `#${p.callOrder} before #${q.callOrder}: earliest in the bracket, then the closest seeds`);
    }

    await svc.loadSet(ready[0].setId);
    const onAir = await ops.act({ action: "report", setId: ready[0].setId, scores: {} });
    assert.ok(!onAir.ok && /strip/.test(onAir.error));

    const r = ready[1];
    const [a, b] = r.slots.map((s) => s.entrantId);
    assert.ok(!(await ops.act({ action: "report", setId: r.setId, scores: { [a]: 1, [b]: 1 } })).ok, "a tie is refused");
    const done = await ops.act({ action: "report", setId: r.setId, scores: { [a]: 1, [b]: 2 } });
    assert.ok(done.ok, done.error);
    svc.stop();
    const [, winner, games] = called(startgg, "reportSet")[0].args;
    assert.strictEqual(winner, b);
    assert.deepStrictEqual(games.map((g) => g.winnerId), [a, b, b]);
    assert.ok(ops.snapshot().recent.some((x) => x.setId === r.setId), "shown reported at once");

    const dq = await ops.act({ action: "report", setId: ready[2].setId, dq: ready[2].slots[0].entrantId });
    svc.stop();
    assert.ok(dq.ok, dq.error);
    assert.deepStrictEqual(called(startgg, "reportSet")[1].args[3], { isDQ: true });
  });

  // A set loaded before the TO starts the bracket is a preview set: start.gg
  // can't put it on a stream yet. The mark waits, and goes to the set's real
  // id once the bracket starts.
  await test("a preview set loaded goes on our start.gg stream once the bracket starts", async () => {
    const capture = loadCapture("hundred-acres-51");
    capture.tournament.streams = [{ id: 77, streamName: "rvamelee", streamSource: "TWITCH", enabled: true }];
    const startgg = fakeStartgg(capture);
    const { svc, store } = setup(null, { startgg });
    await svc.switchEvent("singles");
    const ops = opsFor(svc, store, startgg);
    const row = svc.openSets()[0];
    await svc.loadSet(row.setId);
    const r = await ops.markLoaded(row.setId);
    assert.ok(r.ok && r.queued);
    assert.strictEqual(called(startgg, "assignStream").length, 0, "nothing sent for a preview id");

    startBracket(capture);
    await svc.refresh();
    svc.stop();
    await until(() => called(startgg, "assignStream").length === 1, "the queued stream mark");
    const sb = store.scoreboard();
    assert.deepStrictEqual(called(startgg, "assignStream")[0].args, [sb.setId, "77"]);
    await until(() => ops.snapshot().sets.some((x) => x.onAir && x.onStream), "shown on stream");
    svc.stop();
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
