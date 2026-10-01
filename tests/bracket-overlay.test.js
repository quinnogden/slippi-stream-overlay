/**
 * bracket-overlay.test.js
 *
 * The bracket overlay, from start.gg's sets to what the page draws, on every
 * captured tournament:
 *
 *   - **The layout** (overlays/bracket/layout.js, pure): every set in the
 *     view gets a card, no two cards in a column overlap, every edge inside a
 *     side gets a connector that starts on the feeder and ends on the row it
 *     fills, a set fed by two cards sits between them, and a losers drop-in
 *     gets its "W R2" tag instead of a line.
 *   - **The fit**: Top 8 always fits the viewport whole; a big full bracket
 *     stops at the legibility floor and pans rather than shrinking names
 *     past it.
 *   - **The feed** (lib/event/bracket-feed.js): the group shown follows the
 *     dock's pick, else the set on air; the on-air set's live score and
 *     characters reach its cards; everyone else shows their DB main.
 *   - **The page**: draws the dock's view, crossfades on a switch without
 *     leaving the old board behind, and ?view= pins it.
 *
 * Each failure here is a bracket that draws fine and says something untrue,
 * or a card nobody can read on stream.
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { buildBracket, selectView, VIEWS } = require("../slippi-bridge/lib/event/bracket-model");
const { createBracketFeed, pickGroup } = require("../slippi-bridge/lib/event/bracket-feed");
const { EventService } = require("../slippi-bridge/lib/event/event-service");
const { ScoreboardStore } = require("../slippi-bridge/lib/scoreboard/store");
const { createOverlayChannel } = require("../slippi-bridge/lib/overlay/channel");
const { PlayerDb, serialize } = require("../slippi-bridge/lib/players/player-db");
const L = require("../overlays/bracket/layout");
const { loadCapture, fakeStartgg } = require("./helpers/fake-startgg");
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

const CAPTURES = ["hundred-acres-47", "hundred-acres-48", "hundred-acres-49", "hundred-acres-51"];
const M = L.METRICS;
const CARD_H = M.rowH * 2;

/** Every phase group of every captured event, as the feed would send it. */
function allFeeds() {
  const out = [];
  for (const name of CAPTURES) {
    const cap = loadCapture(name);
    for (const ev of cap.tournament.events) for (const ph of ev.phases) for (const pg of ph.phaseGroups.nodes) {
      const sets = cap.phaseGroupSets[pg.id];
      if (!sets) continue;
      const g = buildBracket(sets, { phaseGroupId: pg.id });
      out.push({
        label: `${name} ${ev.name}`,
        feed: { ...g, views: Object.fromEntries(VIEWS.map((v) => [v, selectView(g, v)])) },
      });
    }
  }
  return out;
}
const FEEDS = allFeeds();

/** The viewport bracket.css gives the board: 1920 × 1080 less its insets. */
function viewportSize() {
  const css = fs.readFileSync(path.join(__dirname, "..", "overlays", "bracket", "bracket.css"), "utf8");
  const rule = /\.viewport\s*\{([^}]*)\}/.exec(css)[1];
  const px = (k) => Number(new RegExp(`(?:^|;|\\s)${k}:\\s*(\\d+)px`).exec(rule)[1]);
  return { w: 1920 - px("left") - px("right"), h: 1080 - px("top") - px("bottom") };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  console.log("bracket-overlay");

  // ── Layout ─────────────────────────────────────────────────────────────────

  await test("every set in every view has a card, and no two cards in a column overlap", () => {
    for (const { label, feed } of FEEDS) for (const v of VIEWS) {
      const lay = L.layoutBracket(feed, v);
      assert.deepStrictEqual(Object.keys(lay.cards).sort(), [...feed.views[v].setIds].sort(), `${label} ${v}: cards ≠ the view's sets`);
      const byCol = {};
      for (const [id, c] of Object.entries(lay.cards)) (byCol[c.x] ??= []).push([id, c.y]);
      for (const col of Object.values(byCol)) {
        col.sort((a, b) => a[1] - b[1]);
        for (let i = 1; i < col.length; i++) {
          assert.ok(col[i][1] - col[i - 1][1] >= CARD_H, `${label} ${v}: ${col[i - 1][0]} and ${col[i][0]} overlap`);
        }
      }
      for (const c of Object.values(lay.cards)) {
        assert.ok(c.x >= 0 && c.y >= 0 && c.x + M.cardW <= lay.width + 0.5 && c.y + CARD_H <= lay.height + 0.5,
          `${label} ${v}: a card outside the board`);
      }
    }
  });

  await test("every winner's path inside a side is a connector from the feeder to the row it fills", () => {
    for (const { label, feed } of FEEDS) for (const v of VIEWS) {
      const lay = L.layoutBracket(feed, v);
      const inView = new Set(feed.views[v].setIds);
      const side = (s) => (s.side === "L" ? "L" : "W");
      const want = new Set();
      for (const id of inView) {
        const set = feed.sets[id];
        for (const slot of set.slots) {
          const f = slot.from;
          if (f.kind !== "set" || !inView.has(f.setId) || side(feed.sets[f.setId]) !== side(set)) continue;
          if (f.placement === 2 && set.side !== "GFR") continue;
          want.add(`${f.setId}>${id}`);
        }
      }
      assert.deepStrictEqual(new Set(lay.links.map((l) => `${l.from}>${l.to}`)), want, `${label} ${v}: connectors`);
      for (const l of lay.links) {
        const a = lay.cards[l.from];
        const b = lay.cards[l.to];
        const start = /^M([\d.]+) ([\d.]+)/.exec(l.d).slice(1).map(Number);
        const end = /H([\d.]+)$/.exec(l.d)[1];
        assert.ok(Math.abs(start[0] - (a.x + M.cardW)) < 0.2 && Math.abs(start[1] - (a.y + M.rowH)) < 0.2, `${label} ${v}: link leaves ${l.from} off its edge`);
        assert.ok(Math.abs(Number(end) - b.x) < 0.2, `${label} ${v}: link to ${l.to} doesn't reach it`);
        assert.strictEqual(l.lit, feed.sets[l.from].state === "done", `${label} ${v}: lit ≠ feeder finished`);
      }
    }
  });

  await test("a set fed by two cards sits exactly between them", () => {
    let checked = 0;
    for (const { feed } of FEEDS) {
      const lay = L.layoutBracket(feed, "full");
      const kids = {};
      for (const l of lay.links) (kids[l.to] ??= []).push(l.from);
      for (const [id, ks] of Object.entries(kids)) {
        if (ks.length !== 2) continue;
        const mid = (lay.cards[ks[0]].y + lay.cards[ks[1]].y) / 2;
        assert.ok(Math.abs(lay.cards[id].y - mid) < 0.01, `${id} isn't centred on its feeders`);
        checked++;
      }
    }
    assert.ok(checked > 20);
  });

  await test("a losers drop-in is tagged with where it dropped from, not joined by a line", () => {
    const { feed } = FEEDS.find((f) => f.label === "hundred-acres-49 Melee Singles (Flex Bo5)");
    const lay = L.layoutBracket(feed, "losers");
    const tagged = Object.entries(lay.tags).filter(([, t]) => t.some(Boolean));
    assert.ok(tagged.length >= 5, "losers sets with drop-ins should carry tags");
    for (const [id, tags] of tagged) {
      tags.forEach((t, i) => {
        if (!t) return;
        assert.match(t.label, /^W (R\d+|QF|SF|F)$/, `${id}: tag "${t.label}"`);
        assert.strictEqual(t.loser, true);
        assert.ok(!lay.links.some((l) => l.to === id && l.slot === i), `${id}: a drop-in also got a connector`);
      });
    }
    const top8 = L.layoutBracket(feed, "top8");
    const gf = Object.values(feed.sets).find((s) => s.side === "GF");
    const fromLosers = gf.slots.findIndex((s) => s.fromLosers);
    assert.deepStrictEqual(top8.tags[gf.id][fromLosers], { label: "L F", loser: false }, "the grand final's losers-side slot");
    assert.strictEqual(L.shortRound("Winners Round 2"), "W R2");
    assert.strictEqual(L.shortRound("Winners Semi-Final"), "W SF");
    assert.strictEqual(L.shortRound("Grand Final"), "Grand Final");
  });

  // ── Fit ────────────────────────────────────────────────────────────────────

  await test("Top 8 always fits whole; a big full bracket stops at the floor and pans", () => {
    const { w, h } = viewportSize();
    for (const { label, feed } of FEEDS) {
      const lay = L.layoutBracket(feed, "top8");
      const fit = L.fitScale(lay.width, lay.height, w, h);
      assert.ok(!fit.panX && !fit.panY, `${label}: Top 8 pans (${lay.width}×${lay.height} in ${w}×${h})`);
    }
    const big = FEEDS.find((f) => f.label === "hundred-acres-48 Melee Singles (Flex Bo5)");
    const lay = L.layoutBracket(big.feed, "full");
    const fit = L.fitScale(lay.width, lay.height, w, h);
    assert.strictEqual(fit.scale, fit.floor, "a 35-entrant full bracket should sit at the floor");
    assert.ok(fit.panX && fit.panY);
    assert.ok(M.nameSize * fit.scale >= M.floorNamePx - 1e-9, "names below the legibility floor");
  });

  await test("the pan starts on the round being played, else the set finished last", () => {
    for (const { label, feed } of FEEDS.filter((f) => /Singles/.test(f.label) && !f.feed.preview)) {
      const done = L.layoutBracket(feed, "full");
      const last = Object.values(feed.sets).filter((s) => s.state === "done")
        .sort((a, b) => b.completedAt - a.completedAt)[0];
      assert.match(last.side, /^GFR?$/, `${label}: the last set finished should be a grand final`);
      assert.deepStrictEqual(done.focus, { x: done.cards[last.id].x + M.cardW / 2, y: done.cards[last.id].y + M.rowH },
        `${label}: a finished bracket should open on its grand final, not the losers final further right`);
    }
    const { feed } = FEEDS.find((f) => f.label === "hundred-acres-49 Melee Singles (Flex Bo5)");
    const live = plain(feed);
    const ws = Object.values(live.sets).find((s) => s.name === "Winners Semi-Final");
    live.sets[ws.id].state = "live";
    const lay = L.layoutBracket(live, "full");
    assert.strictEqual(lay.focus.x, lay.cards[ws.id].x + M.cardW / 2);
  });

  // ── Feed ───────────────────────────────────────────────────────────────────

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bracket-overlay-"));
  async function feedEnv(records = []) {
    const file = path.join(dir, `players-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, serialize(records, "\r\n"));
    const playerDb = new PlayerDb(file, { debounceMs: 60000 });
    const store = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
    const startgg = fakeStartgg("hundred-acres-49");
    const config = { BRACKETS: { shortLink: "x", events: { singles: { match: ["melee", "singles"] }, doubles: { match: ["melee", "doubles"] } } } };
    const event = new EventService({ config, startgg, store, playerDb }, { log: () => {} });
    const feed = createBracketFeed({ event, store, playerDb });
    feed.start();
    return { store, event, feed, playerDb };
  }

  await test("the feed shows the dock's group, else the on-air set's, else the furthest running", async () => {
    const env = await feedEnv();
    assert.strictEqual(env.store.bracket(), null, "no event, no bracket");
    await env.event.switchEvent("singles");
    const b = env.store.bracket();
    assert.ok(b && b.views.top8.setIds.length > 0);
    assert.strictEqual(b.eventName, "Melee Singles (Flex Bo5)");
    const groups = [{ id: "1", state: 3 }, { id: "2", state: 2 }, { id: "3", state: 2 }, { id: "4", state: 1 }];
    assert.strictEqual(pickGroup(groups, null, null).id, "3");
    assert.strictEqual(pickGroup(groups, null, "1").id, "1");
    assert.strictEqual(pickGroup(groups, "4", "1").id, "4");
    assert.strictEqual(pickGroup(groups, "99", "98").id, "3", "an unknown id falls through");
  });

  await test("the on-air set's live score and characters reach its card; others show their DB main", async () => {
    const env = await feedEnv([{ gamerTag: "Player3", prefix: "", startggPlayerId: "100027", mains: { ssbm: [["Marth", 2]] } }]);
    await env.event.switchEvent("singles");
    const before = env.store.bracket();
    const lf = Object.values(before.sets).find((s) => s.name === "Losers Final");
    await env.event.loadSet(lf.id);
    // As if the set were still being played: start.gg's copy unfinished, Slippi live.
    const raw = env.event.groups()[0].graph.sets[lf.id];
    raw.state = "live";
    env.store.setScore(0, 2);
    env.store.setScore(1, 1);
    env.store.setCharacter(0, 0, { codename: "falco", name: "Falco", skin: 1 });
    const b = env.store.bracket();
    const card = b.sets[lf.id];
    const sideOf = (i) => env.store.scoreboard().sides.findIndex((s) => s.entrantId === card.slots[i].entrantId);
    assert.deepStrictEqual(card.slots.map((s) => s.score), card.slots.map((_, i) => env.store.scoreboard().sides[sideOf(i)].score));
    const left = env.store.scoreboard().sides[0].entrantId;
    assert.deepStrictEqual(plain(b.entrants[left].character), { codename: "falco", name: "Falco", skin: 1 });
    const p3 = Object.values(b.entrants).find((e) => e.players[0]?.playerId === "100027");
    assert.deepStrictEqual(plain(p3.character), { codename: "marth", name: "Marth", skin: 2 });
  });

  await test("a bracket refresh isn't saved with the scoreboard", async () => {
    const env = await feedEnv();
    await env.event.switchEvent("singles");
    assert.ok(env.store.bracket());
    assert.strictEqual(env.store.toJSON().bracket, undefined);
  });

  // ── Page ───────────────────────────────────────────────────────────────────

  async function pageEnv(search = "") {
    const env = await feedEnv();
    await env.event.switchEvent("singles");
    const { io, nsps } = fakeIo();
    createOverlayChannel({ io, store: env.store });
    const page = await loadOverlay({ page: "bracket", nsps, search });
    await sleep(20);
    return { ...env, page };
  }

  const layers = (page) => page.$$(".viewport .layer");

  await test("the page draws the dock's view: one card per set, the view's title", async () => {
    const { store, page } = await pageEnv();
    const want = store.bracket().views[store.view().bracketView].setIds.length;
    assert.strictEqual(layers(page).length, 1);
    assert.strictEqual(page.$$(".layer .card").length, want);
    assert.strictEqual(page.$(".title-main .text").textContent, "Top 8");
    assert.strictEqual(page.$(".title-sub .text").textContent, "Hundred Acres #49 · Melee Singles (Flex Bo5)");
    assert.ok(page.$$(".layer .links path").length > 0);
  });

  await test("switching views crossfades to a new board and removes the old one", async () => {
    const { store, page } = await pageEnv();
    store.setBracketView("losers");
    await sleep(5);
    assert.strictEqual(layers(page).length, 2, "the new board should fade in over the old");
    await sleep(60);
    assert.strictEqual(layers(page).length, 1, "the old board was left behind");
    assert.strictEqual(page.$$(".layer .card").length, store.bracket().views.losers.setIds.length);
    assert.ok(page.$$(".layer .drop").length > 0, "losers drop-ins should be tagged");
  });

  await test("?view= pins a source: the dock's switch doesn't move it", async () => {
    const { store, page } = await pageEnv("?view=winners");
    const want = store.bracket().views.winners.setIds.length;
    assert.strictEqual(page.$$(".layer .card").length, want);
    store.setBracketView("losers");
    await sleep(60);
    assert.strictEqual(page.$$(".layer .card").length, want);
    assert.strictEqual(page.$(".title-main .text").textContent, "Winners Bracket");
  });

  await test("a reported set redraws in place, without a view crossfade", async () => {
    const { store, page, event } = await pageEnv();
    const anims = page.animations.length;
    const before = layers(page)[0];
    event.groups()[0].graph.sets[store.bracket().views.top8.setIds[0]].slots[0].score = 9;
    event.emit("change");
    await sleep(30);
    assert.strictEqual(layers(page)[0], before, "a data change rebuilt the layer");
    assert.ok(texts(page.$(".viewport")).includes("9"));
    assert.ok(!page.animations.slice(anims).some(({ el }) => el.classList.contains("layer")), "a data change crossfaded");
  });

  console.log(failed === 0 ? "bracket-overlay: all passed" : `bracket-overlay: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
