/**
 * side-panel.test.js
 *
 * The side panel (overlays/side-panel/) run headlessly against the real
 * store, the real overlay channel and the real overlay client — every state
 * it sees is one the app would send, built from a captured tournament.
 *
 * Two families of failure, both of which look healthy on stream:
 *
 * **The rotation flashing the logo.** Slot 0 is always the tournament logo,
 * and a rotation restart starts from slot 0. Loading a set is not one update
 * but several (the scoreboard, then the stats saying "loading", then the
 * cards, then the head-to-head), and each can change which slots have
 * content. Restarting on every change flashed the logo 3–5 times per set
 * load. The rule: restart only when the panel ON SCREEN has dropped out —
 * and then it must restart, or that panel is stranded under the next one.
 *
 * **A healthy-looking card with the wrong numbers on it.** The stats are keyed
 * by start.gg player id and must be oriented against the columns as they are
 * NOW (Switch Sides moves the players, not the stats); a record for any other
 * pair — the previous set's, answered late — must show nothing; a set
 * reported as a bare winner reads W/L on the winner's side; doubles shows no
 * player cards or head-to-head.
 *
 * Usage: node tests/side-panel.test.js
 */

const assert = require("assert");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createOverlayChannel } = require("../app/lib/overlay/channel");
const { loadPayload } = require("../app/lib/event/set-model");
const { buildBracket } = require("../app/lib/event/bracket-model");
const N = require("../app/lib/stats/normalize");
const { eventFrom } = require("./helpers/fake-startgg");
const { loadOverlay, fakeIo, texts, sleep } = require("./helpers/overlay-sandbox");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 4).join("\n       ")}`);
  }
}

// ── Real material: a captured singles event and its doubles event ────────────

const singles = eventFrom("hundred-acres-49", "singles");
const graph = buildBracket(singles.sets, { phaseGroupId: singles.phaseGroup.id });
const setNamed = (g, name) => Object.values(g.sets).find((s) => s.name === name).id;
const GRAND_FINAL  = loadPayload(graph, setNamed(graph, "Grand Final"));   // Player1 vs Player2
const LOSERS_FINAL = loadPayload(graph, setNamed(graph, "Losers Final"));  // Player2 vs Player3
const doublesEv = eventFrom("hundred-acres-49", "doubles");
const dgraph = buildBracket(doublesEv.sets, { phaseGroupId: doublesEv.phaseGroup.id });
const DOUBLES = loadPayload(dgraph, Object.keys(dgraph.sets)[0]);

const pidsOf = (payload) => payload.sides.map((s) => s.players[0].playerId);

/**
 * A `player_stats` snapshot as lib/stats/index.js emits it for a pair. The
 * runs and the event's finished sets are the real normalizers over the
 * captured event; the histories and the head-to-head (start.gg reads that
 * aren't captured) are written in the documented shape.
 */
function statsFor(payload, { cards = "done", h2h = "done", wins = [22, 8], h2hPair = null } = {}) {
  const [a, b] = pidsOf(payload);
  const player = (pid, i) => ({
    playerId: pid,
    name: payload.sides[i].players[0].tag,
    state: cards,
    history: cards === "done" ? [{ tournament: `Hundred Acres #${48 - i}`, event: "Melee Singles", placement: 1 + i, entrants: 30 }] : [],
    run: cards === "done" ? N.runFromEventSets(singles.sets, pid) : [],
  });
  return {
    enabled: true,
    event: { id: "1", slug: "tournament/x/event/y", name: "Melee Singles", singles: true },
    players: { [a]: player(a, 0), [b]: player(b, 1) },
    h2h: {
      players: h2hPair ?? [b, a],   // deliberately not in column order
      state: h2h,
      wins: h2h === "done" ? { [a]: wins[0], [b]: wins[1] } : {},
      total: h2h === "done" ? wins[0] + wins[1] : 0,
      recent: h2h === "done" ? [
        { tournament: "HA #48", round: "Grand Final", completedAt: 1789701909, winner: a, scores: { [a]: 3, [b]: 1 } },
        { tournament: "HA #37", round: "Winners Final", completedAt: 1781000000, winner: b, scores: { [a]: null, [b]: null } },
      ] : [],
    },
    completedSets: { state: "done", sets: N.completedFromEventSets(singles.sets).slice(0, 12) },
    updatedAt: 0,
  };
}

/** The store, the channel and the page, with `payload` on the scoreboard. */
async function setup(payload, stats = statsFor(payload)) {
  const store = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
  store.setTournament({ name: "Hundred Acres #49", eventName: "Melee Singles", eventSlug: "tournament/x/event/y" });
  store.loadSet(payload);
  const { io, nsps } = fakeIo();
  const channel = createOverlayChannel({ io, store });
  if (stats) channel.emit("player_stats", stats);
  const page = await loadOverlay({ page: "side-panel", nsps });
  await sleep(20); // ready → rotation started
  const sp = page.window.SidePanel;

  // Every panel that actually fades in, and every restart.
  const transitions = [];
  const restarts = [];
  const origTo = sp.rotator._transitionTo.bind(sp.rotator);
  sp.rotator._transitionTo = (id, done) => { transitions.push(id); return origTo(id, done); };
  const origRestart = sp.rotator.restart.bind(sp.rotator);
  sp.rotator.restart = () => { restarts.push(1); return origRestart(); };

  /** A change in the store, carried to the page as the app carries it. */
  const settle = () => sleep(15);
  return { store, channel, page, sp, transitions, restarts, settle };
}

const visibleText = (page, sel) => texts(page.$(sel));
const plain = (v) => JSON.parse(JSON.stringify(v)); // the page's arrays are another realm's

(async () => {
  console.log("side-panel");

  // ── Rotation ───────────────────────────────────────────────────────────────

  await test("the rotation starts on the logo and every panel with content is in it", async () => {
    const { sp } = await setup(GRAND_FINAL);
    assert.strictEqual(sp.rotator._current, "logo-primary");
    assert.deepStrictEqual(plain(sp.rotator._slots),
      ["logo-primary", "player-1", "player-2", "recent-sets", "logo-sponsor", "completed-sets"]);
  });

  await test("steady: the same state and stats again disturb nothing", async () => {
    const { store, channel, transitions, restarts, settle } = await setup(GRAND_FINAL);
    channel.emit("player_stats", statsFor(GRAND_FINAL));
    store.setCasters([{ tag: "Mic" }]); // another section changing
    await settle();
    assert.deepStrictEqual(transitions, []);
    assert.strictEqual(restarts.length, 0);
  });

  /** A set load as the app delivers it: the scoreboard, then the stats module's three emits. */
  async function loadSetBurst({ store, channel, settle }, payload) {
    store.loadSet(payload);
    await settle();
    channel.emit("player_stats", statsFor(payload, { cards: "loading", h2h: "loading" }));
    await settle();
    channel.emit("player_stats", statsFor(payload, { h2h: "loading" }));
    await settle();
    channel.emit("player_stats", statsFor(payload, { wins: [5, 9] }));
    await settle();
  }

  await test("loading a set with the logo on screen never flashes the logo again", async () => {
    const env = await setup(GRAND_FINAL);
    await loadSetBurst(env, LOSERS_FINAL);
    await sleep(30);
    assert.strictEqual(env.transitions.filter((t) => t === "logo-primary").length, 0, `transitions: ${env.transitions}`);
    assert.strictEqual(env.restarts.length, 0);
    assert.ok(env.sp.rotator._slots.includes("recent-sets"), "the new pair's head-to-head joined the rotation");
  });

  await test("loading a set with a player card on screen restarts once (that card can't stay up)", async () => {
    const env = await setup(GRAND_FINAL);
    env.sp.rotator._advance(); // → player-1
    await sleep(30);
    assert.strictEqual(env.sp.rotator._current, "player-1");
    env.transitions.length = 0;
    await loadSetBurst(env, LOSERS_FINAL);
    await sleep(30);
    assert.ok(env.restarts.length >= 1, "player-1 dropped out of the rotation but it never restarted — it would be stranded on screen");
    assert.strictEqual(env.transitions.filter((t) => t === "logo-primary").length, 1, `transitions: ${env.transitions}`);
    // Stranded panels: after the restart only the visible panel may be showing.
    const shown = ["#panel-player-1", "#panel-player-2", "#panel-recent-sets", "#panel-completed-sets", ".logo-sponsor"]
      .filter((sel) => env.page.$(sel).style.opacity === "1" || env.page.$(sel).getAnimations().length > 0);
    assert.deepStrictEqual(shown, [], "a panel other than the visible one is still on screen");
  });

  await test("Switch Sides changes no slot, so it moves nothing in the rotation", async () => {
    const env = await setup(GRAND_FINAL);
    env.sp.rotator._advance();
    await sleep(30);
    env.transitions.length = 0;
    env.store.switchSides();
    await env.settle();
    assert.deepStrictEqual(env.transitions, []);
    assert.strictEqual(env.restarts.length, 0);
  });

  // ── What the panels say ────────────────────────────────────────────────────

  await test("the head-to-head is oriented by player id, and Switch Sides flips it", async () => {
    const env = await setup(GRAND_FINAL);
    assert.ok(visibleText(env.page, "#panel-recent-sets").includes("22 – 8"),
      `tally ${visibleText(env.page, "#panel-recent-sets")} — want 22 – 8 (Player1 left)`);
    env.store.switchSides();
    await env.settle();
    assert.ok(visibleText(env.page, "#panel-recent-sets").includes("8 – 22"), "after Switch Sides the tally didn't follow the players");
    const names = env.page.$$("#panel-recent-sets .h2h-name").map((n) => n.textContent);
    assert.deepStrictEqual(names, ["Player2", "Player1"]);
  });

  await test("a set reported as a bare winner reads W/L on the winner's side", async () => {
    const env = await setup(GRAND_FINAL);
    const pills = env.page.$$("#panel-recent-sets .recent-set-pill");
    const labels = pills.map((p) => p.querySelectorAll(".pill-score-val").map((x) => x.textContent));
    assert.deepStrictEqual(labels, [["3", "1"], ["L", "W"]]);
  });

  await test("another pair's head-to-head, or one still loading, shows nothing", async () => {
    const env = await setup(GRAND_FINAL);
    const [a] = pidsOf(GRAND_FINAL);
    env.channel.emit("player_stats", statsFor(GRAND_FINAL, { h2hPair: [a, "424242"] }));
    await env.settle();
    assert.strictEqual(env.sp.h2hView(), null, "a record for a different pair was drawn under these names");
    assert.ok(!env.sp.rotator._slots.includes("recent-sets"));
    env.channel.emit("player_stats", statsFor(GRAND_FINAL, { h2h: "loading" }));
    await env.settle();
    assert.strictEqual(env.sp.h2hView(), null);
  });

  await test("player cards carry the scoreboard's tag, prefix and character, and the run from the event", async () => {
    const env = await setup(LOSERS_FINAL);
    env.store.setCharacter(0, 0, { codename: "falco", name: "Falco", skin: 0 });
    await env.settle();
    assert.deepStrictEqual(visibleText(env.page, "#panel-player-1 .player-identity"), ["Team1 ", "Player2", "FALCO"]);
    const runRows = env.page.$$("#panel-player-1 .run-list .panel-pill");
    assert.strictEqual(runRows.length, Math.min(5, N.runFromEventSets(singles.sets, pidsOf(LOSERS_FINAL)[0]).length));
    assert.ok(runRows.length > 0);
  });

  await test("Just Finished is the event's real finished sets, newest first", async () => {
    const env = await setup(GRAND_FINAL);
    const rows = env.page.$$("#panel-completed-sets .completed-set-pill");
    assert.strictEqual(rows.length, 8);
    assert.deepStrictEqual(texts(rows[0]).filter((t) => /Player/.test(t)), ["Player2", "Player1"]);
  });

  await test("doubles: no player cards and no head-to-head in the rotation", async () => {
    const env = await setup(DOUBLES, { ...statsFor(GRAND_FINAL), players: {}, h2h: null });
    assert.deepStrictEqual(plain(env.sp.rotator._slots), ["logo-primary", "logo-sponsor", "completed-sets"]);
  });

  await test("no stats at all (no token, nothing loaded) still rotates the logos", async () => {
    const env = await setup(GRAND_FINAL, null);
    assert.deepStrictEqual(plain(env.sp.rotator._slots), ["logo-primary", "logo-sponsor"]);
  });

  await test("the header shows the tournament name, and follows a change", async () => {
    const env = await setup(GRAND_FINAL);
    assert.strictEqual(env.page.$(".tournament-name").textContent, "Hundred Acres #49");
    env.store.setTournament({ name: "Hundred Acres #50", eventSlug: "tournament/x/event/z" });
    await env.settle();
    assert.strictEqual(env.page.$(".tournament-name").textContent, "Hundred Acres #50");
  });

  await test("clip toasts queue: a second clip waits, a third replaces the second", async () => {
    const env = await setup(GRAND_FINAL);
    const toast = env.page.$(".clip-toast");
    env.channel.emit("slippi_clip_saved", { playerName: "Player1", moveCount: 5, damage: 41.2 });
    env.channel.emit("slippi_clip_saved", { playerName: "Player2", moveCount: 4, damage: 30 });
    env.channel.emit("slippi_clip_saved", { playerName: "Player3", moveCount: 6, damage: 55 });
    assert.strictEqual(toast.querySelector(".clip-toast-detail").textContent, "Player1 · 5 moves, 41%");
    assert.strictEqual(toast.getAnimations().length, 1, "two toasts animating at once");
    await sleep(80);
    assert.strictEqual(toast.querySelector(".clip-toast-detail").textContent, "Player3 · 6 moves, 55%",
      "the queued clip shown next wasn't the newest");
  });

  console.log(failed === 0 ? "side-panel: all passed" : `side-panel: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
