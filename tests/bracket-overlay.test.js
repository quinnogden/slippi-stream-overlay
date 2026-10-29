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

const { buildBracket, selectView, VIEWS } = require("../app/lib/event/bracket-model");
const { createBracketFeed, pickGroup } = require("../app/lib/event/bracket-feed");
const { createBracketDirector } = require("../app/lib/event/bracket-director");
const { EventService } = require("../app/lib/event/event-service");
const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createOverlayChannel } = require("../app/lib/overlay/channel");
const { PlayerDb, serialize } = require("../app/lib/players/player-db");
const L = require("../overlays/bracket/layout");
const { loadCapture, fakeStartgg, rewind } = require("./helpers/fake-startgg");
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

const CAPTURES = ["hundred-acres-47", "hundred-acres-48", "hundred-acres-49", "hundred-acres-50", "hundred-acres-51", "bair-necessities"];
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

  // ── Pages ──────────────────────────────────────────────────────────────────

  const flat = (pages) => pages.flatMap((p) => p.setIds);

  await test("layout.js's viewport is bracket.css's", () => {
    assert.deepStrictEqual(viewportSize(), L.VIEWPORT);
  });

  await test("every page of every view fits the screen at or above the legibility floor", () => {
    const { w, h } = L.VIEWPORT;
    const floor = M.floorNamePx / M.nameSize;
    for (const { label, feed } of FEEDS) for (const v of VIEWS) {
      for (const page of L.paginate(feed, v)) {
        const lay = L.layoutPage(feed, page);
        const scale = Math.min(1, w / lay.width, h / lay.height);
        assert.ok(scale >= floor - 1e-9, `${label} ${v} ${page.key}: ${lay.width}×${lay.height} only fits at ${scale.toFixed(2)}`);
        assert.ok(Math.abs(scale - page.scale) < 0.005, `${label} ${v} ${page.key}: paginate measured ${page.scale}, the layout is ${scale}`);
      }
    }
  });

  await test("every set worth drawing is on exactly one page, and a page draws every line between its own sets", () => {
    for (const { label, feed } of FEEDS) for (const v of VIEWS) {
      const pages = L.paginate(feed, v);
      const want = L.prunedView(feed, v)?.setIds ?? [];
      assert.deepStrictEqual([...flat(pages)].sort(), [...want].sort(), `${label} ${v}: pages ≠ the view's sets`);
      // Pages are cut between rounds (the line back to the previous band goes)
      // and, wrapped k-up, between subtrees — never through a subtree: every
      // line the whole board draws between two sets on one page is on it.
      const lines = L.layoutView(feed, L.prunedView(feed, v)).links.map((l) => `${l.from}>${l.to}`);
      for (const p of pages) {
        const on = new Set(p.setIds);
        const drawn = new Set(L.layoutPage(feed, p).links.map((l) => `${l.from}>${l.to}`));
        for (const line of lines) {
          const [a, b] = line.split(">");
          if (on.has(a) && on.has(b)) assert.ok(drawn.has(line), `${label} ${v} ${p.key}: the line ${line} is cut`);
        }
      }
    }
  });

  await test("a 51-player bracket is a handful of readable pages, not a pan", () => {
    const { feed } = FEEDS.find((f) => f.label === "hundred-acres-50 Melee Singles (Flex Bo5)");
    assert.ok(L.paginate(feed, "full").length <= 5, "HA #50's full bracket");
    assert.strictEqual(L.paginate(feed, "winners").length, 2, "HA #50's winners side");
    const pool = FEEDS.find((f) => f.label.startsWith("bair-necessities") && f.feed.views.full.setIds.length > 60);
    assert.ok(L.paginate(pool.feed, "full").length <= 4, "a 37-player pool");
    for (const { label, feed } of FEEDS.filter((f) => f.feed.views.top8.setIds.length > 0)) {
      const top8 = L.paginate(feed, "top8");
      assert.strictEqual(top8.length, 1, `${label}: Top 8 is one page`);
      assert.strictEqual(top8[0].key, "all");
    }
  });

  await test("mid-event, empty rounds past the next one aren't drawn; a view that fits is drawn whole", () => {
    for (const frac of [0.1, 0.4, 0.75]) {
      const cap = rewind(loadCapture("hundred-acres-50"), frac);
      const ev = cap.tournament.events.find((e) => /singles/i.test(e.name));
      const pg = ev.phases[0].phaseGroups.nodes[0];
      const g = buildBracket(cap.phaseGroupSets[pg.id], { phaseGroupId: pg.id });
      const feed = { ...g, views: Object.fromEntries(VIEWS.map((v) => [v, selectView(g, v)])) };
      const pv = L.prunedView(feed, "full");
      assert.ok(pv.pruned, `${frac}: a 51-player bracket should be pruned`);
      const known = (s) => s.state !== "pending" || s.slots.some((x) => x.entrantId);
      const onSide = (side) => (r) => (feed.sets[r.setIds[0]].side === "L") === (side === "L");
      for (const side of ["W", "L"]) {
        const all = feed.views.full.rounds.filter(onSide(side));
        const last = all.reduce((at, r, i) => (r.setIds.some((id) => known(feed.sets[id])) ? i : at), -1);
        const kept = pv.rounds.filter(onSide(side)).map((r) => r.key);
        assert.deepStrictEqual(kept, all.slice(0, last + 2).map((r) => r.key), `${frac} ${side}: one round past the furthest with anybody in it`);
      }
      assert.ok(pv.setIds.length < feed.views.full.setIds.length, `${frac}: nothing was dropped`);
      assert.strictEqual(L.prunedView(feed, "top8"), feed.views.top8, `${frac}: Top 8 fits, so it keeps its empty future`);
    }
  });

  await test("a page's key survives a score change, so a refresh mid-hold doesn't jump", () => {
    const { feed } = FEEDS.find((f) => f.label === "hundred-acres-50 Melee Singles (Flex Bo5)");
    const before = L.paginate(feed, "full").map((p) => p.key);
    const bumped = plain(feed);
    Object.values(bumped.sets)[0].slots[0].score = 7;
    assert.deepStrictEqual(L.paginate(bumped, "full").map((p) => p.key), before);
  });

  await test("the action: the set on air, else the round being played, else the set finished last", () => {
    for (const { label, feed } of FEEDS.filter((f) => /Singles/.test(f.label) && !f.feed.preview && f.feed.views.full.setIds.length > 20)) {
      const last = Object.values(feed.sets).filter((s) => s.state === "done")
        .sort((a, b) => b.completedAt - a.completedAt)[0];
      assert.strictEqual(L.actionSetId(feed, feed.views.full), last.id,
        `${label}: a finished bracket should open on its last set, not the losers final further right`);
    }
    const { feed } = FEEDS.find((f) => f.label === "hundred-acres-49 Melee Singles (Flex Bo5)");
    const live = plain(feed);
    const ws = Object.values(live.sets).find((s) => s.name === "Winners Semi-Final");
    live.sets[ws.id].state = "live";
    assert.strictEqual(L.actionSetId(live, live.views.full), ws.id);
    const lf = Object.values(live.sets).find((s) => s.name === "Losers Final");
    assert.strictEqual(L.actionSetId(live, live.views.full, lf.id), lf.id, "the set on air beats a live one");
  });

  await test("the Board camera settles on a column's edge, stays on the board, and zooms in whole columns", () => {
    const { feed } = FEEDS.find((f) => f.label === "hundred-acres-50 Melee Singles (Flex Bo5)");
    const lay = L.layoutView(feed, L.prunedView(feed, "full"));
    const steps = L.boardZooms(lay);
    const floor = M.floorNamePx / M.nameSize;
    assert.ok(steps[0] >= floor - 1e-9 && steps[steps.length - 1] === 1, `zooms ${steps}`);
    for (const s of steps.slice(0, -1)) {
      const cols = (L.VIEWPORT.w / s + M.colGap) / (M.cardW + M.colGap);
      assert.ok(Math.abs(cols - Math.round(cols)) < 1e-6, `zoom ${s} doesn't fit whole columns`);
    }
    const xs = new Set(lay.sections.flatMap((s) => s.columns.map((c) => c.x)));
    let cam = L.cameraAt(lay, 900, 700);
    assert.ok(xs.has(cam.x), `x ${cam.x} isn't a column edge`);
    for (let i = 0; i < 30; i++) cam = L.moveCamera(lay, cam, "right");
    assert.ok(Math.abs(cam.x - (lay.width - L.VIEWPORT.w / cam.zoom)) < 1e-6, "panning right ends flush with the board's right edge");
    for (let i = 0; i < 30; i++) cam = L.moveCamera(lay, cam, "up");
    assert.strictEqual(cam.y, 0);
    const zoomed = L.zoomCamera(lay, cam, "in");
    assert.ok(zoomed.zoom > cam.zoom);
    assert.strictEqual(L.zoomCamera(lay, L.zoomCamera(lay, zoomed, "out"), "out").zoom, steps[0], "never below the widest readable zoom");
    const ov = L.cameraTransform(lay, { overview: true });
    assert.ok(lay.width * ov.scale <= L.VIEWPORT.w + 0.5 && lay.height * ov.scale <= L.VIEWPORT.h + 0.5, "the Overview fits whole");
  });

  // ── Feed ───────────────────────────────────────────────────────────────────

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bracket-overlay-"));
  async function feedEnv(records = [], capture = "hundred-acres-49") {
    const file = path.join(dir, `players-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, serialize(records, "\r\n"));
    const playerDb = new PlayerDb(file, { debounceMs: 60000 });
    const store = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
    const startgg = fakeStartgg(capture);
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

  /**
   * The page, the channel and the director, as the app wires them. The
   * director's clock is in the test's hands: `tick()` fires the tour's
   * pending timer, if there is one.
   */
  async function pageEnv(search = "", capture = "hundred-acres-49") {
    const env = await feedEnv([], capture);
    let pending = null;
    const timers = {
      setTimeout: (fn) => { pending = fn; return 1; },
      clearTimeout: () => { pending = null; },
    };
    const director = createBracketDirector({ store: env.store, timers });
    director.start();
    await env.event.switchEvent("singles");
    const { io, nsps } = fakeIo();
    createOverlayChannel({ io, store: env.store });
    const page = await loadOverlay({ page: "bracket", nsps, search });
    await sleep(20);
    const tick = async () => {
      const fn = pending;
      pending = null;
      if (fn) fn();
      await sleep(30);
      return !!fn;
    };
    return { ...env, page, director, tick, timerSet: () => !!pending };
  }

  const layers = (page) => page.$$(".viewport .layer");
  const pageUp = (store) => {
    const v = store.view().bracketView;
    return store.bracket().pages[v].find((p) => p.key === store.bracketShot().page);
  };
  const cardsOn = (page) => page.$$(".layer .card").length;

  await test("the page draws the dock's view: one card per set, the view's title", async () => {
    const { store, page } = await pageEnv();
    const want = store.bracket().views[store.view().bracketView].setIds.length;
    assert.strictEqual(layers(page).length, 1);
    assert.strictEqual(cardsOn(page), want);
    assert.strictEqual(page.$(".title-main .text").textContent, "Top 8");
    assert.strictEqual(page.$(".title-sub .text").textContent, "Hundred Acres #49 · Melee Singles (Flex Bo5)");
    assert.ok(page.$$(".layer .links path").length > 0);
    assert.ok(page.$(".page-dots").classList.contains("empty"), "one page needs no dots");
  });

  await test("switching views crossfades to a new board and removes the old one", async () => {
    const { store, page } = await pageEnv();
    store.setBracketView("losers");
    await sleep(5);
    assert.strictEqual(layers(page).length, 2, "the new board should fade in over the old");
    await sleep(60);
    assert.strictEqual(layers(page).length, 1, "the old board was left behind");
    assert.strictEqual(cardsOn(page), pageUp(store).setIds.length);
    assert.ok(page.$$(".layer .drop").length > 0, "losers drop-ins should be tagged");
  });

  await test("?view= pins a source: the dock's switch doesn't move it", async () => {
    const { store, page } = await pageEnv("?view=winners");
    const want = store.bracket().pages.winners[0].setIds.length;
    assert.strictEqual(cardsOn(page), want);
    store.setBracketView("losers");
    await sleep(60);
    assert.strictEqual(cardsOn(page), want);
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

  await test("the tour turns the pages, opening on the action; the dots and the subtitle follow", async () => {
    const { store, page, tick } = await pageEnv("", "hundred-acres-50");
    store.setBracketView("full");
    await sleep(60);
    const pages = store.bracket().pages.full;
    assert.ok(pages.length > 1);
    const last = Object.values(store.bracket().sets).filter((s) => s.state === "done").sort((a, b) => b.completedAt - a.completedAt)[0];
    assert.ok(pageUp(store).setIds.includes(last.id), "a finished bracket opens on the page with its last set");
    const first = store.bracketShot().page;
    assert.strictEqual(store.bracketShot().mode, "tour");
    assert.strictEqual(store.bracketShot().holdMs, L.holdMs(pageUp(store)));
    assert.strictEqual(page.$$(".page-dots i").length, pages.length);
    assert.ok(!page.$(".page-dots").classList.contains("empty"));
    assert.ok(page.$(".title-sub .text").textContent.startsWith(pageUp(store).label), "the subtitle names the page");

    assert.ok(await tick(), "the tour should have a turn pending");
    const i = pages.findIndex((p) => p.key === first);
    assert.strictEqual(store.bracketShot().page, pages[(i + 1) % pages.length].key);
    await sleep(60);
    assert.strictEqual(cardsOn(page), pageUp(store).setIds.length);
    const lit = page.$$(".page-dots i").findIndex((d) => d.classList.contains("on"));
    assert.strictEqual(lit, (i + 1) % pages.length);
  });

  await test("a held page stays until Auto; a view switch while held opens held on the action", async () => {
    const { store, director, tick, timerSet } = await pageEnv("", "hundred-acres-50");
    store.setBracketView("full");
    await sleep(20);
    const pages = store.bracket().pages.full;
    const r = director.command({ action: "page", page: pages[2].key });
    assert.ok(r.ok);
    assert.strictEqual(store.bracketShot().mode, "page");
    assert.strictEqual(store.bracketShot().page, pages[2].key);
    assert.ok(!timerSet(), "a held page has no turn pending");
    assert.strictEqual(await tick(), false);
    director.command({ action: "next" });
    assert.strictEqual(store.bracketShot().page, pages[3 % pages.length].key);

    store.setBracketView("winners");
    assert.strictEqual(store.bracketShot().mode, "page", "the camera doesn't start touring behind the operator");
    assert.strictEqual(store.bracketShot().view, "winners");
    assert.ok(store.bracket().pages.winners.some((p) => p.key === store.bracketShot().page));

    director.command({ action: "auto" });
    assert.strictEqual(store.bracketShot().mode, "tour");
    assert.ok(timerSet());
    assert.strictEqual(director.command({ action: "page", page: "nope" }).ok, false);
    assert.strictEqual(director.command({ action: "spin" }).status, 400);
  });

  await test("a page that's gone (the pages were cut again) gives way to the page with the action", async () => {
    const { store, director } = await pageEnv("", "hundred-acres-50");
    store.setBracketView("full");
    await sleep(20);
    const pages = store.bracket().pages.full;
    director.command({ action: "page", page: pages[pages.length - 1].key });
    const b = store.bracket();
    b.pages.full = b.pages.full.slice(0, -1);
    store.setBracket(b);
    assert.strictEqual(store.bracketShot().mode, "page");
    assert.ok(b.pages.full.some((p) => p.key === store.bracketShot().page), "still pointing at a page that exists");
  });

  await test("the Board: steered from the dock, the whole board with a minimap; Overview fits it; Auto goes back", async () => {
    const { store, page, director } = await pageEnv("", "hundred-acres-50");
    store.setBracketView("full");
    await sleep(60);
    assert.ok(director.command({ action: "pan", dir: "right" }).ok);
    const shot = store.bracketShot();
    assert.strictEqual(shot.mode, "board");
    assert.ok(shot.camera && Number.isFinite(shot.camera.zoom), "entering the Board frames the page that was up");
    await sleep(60);
    const board = L.prunedView(store.bracket(), "full");
    assert.strictEqual(cardsOn(page), board.setIds.length, "the Board is the whole (pruned) bracket");
    assert.ok(page.$(".layer .minimap"), "a minimap shows where the camera is");
    assert.ok(page.$(".page-dots").classList.contains("empty"), "no page dots on the Board");

    director.command({ action: "pan", dir: "down" });
    const moved = store.bracketShot().camera;
    assert.ok(moved.y > shot.camera.y || moved.x !== shot.camera.x);
    director.command({ action: "overview" });
    assert.deepStrictEqual(store.bracketShot().camera, { overview: true });
    await sleep(80);
    assert.ok(layers(page).at(-1).classList.contains("overview"));
    director.command({ action: "pan", dir: "left" });
    assert.ok(Number.isFinite(store.bracketShot().camera.zoom), "an arrow from the Overview comes back to a readable zoom");

    director.command({ action: "auto" });
    await sleep(80);
    assert.strictEqual(store.bracketShot().mode, "tour");
    assert.strictEqual(cardsOn(page), pageUp(store).setIds.length);
    assert.ok(!page.$(".layer .minimap"));
    assert.strictEqual(director.command({ action: "pan", dir: "sideways" }).status, 400);
  });

  // ── Up Next ────────────────────────────────────────────────────────────────

  /** Bair Necessities wound back to mid-pools: four pools running at once. */
  function midPools() {
    return rewind(loadCapture("bair-necessities"), 0.3, { live: 1 });
  }

  await test("Up Next: every live and ready set across every pool, the set on air first with its live score", async () => {
    const cap = midPools();
    const env = await feedEnv([], cap);
    await env.event.switchEvent("singles");
    const open = env.event.openSets().filter((r) => r.status === "playable" || r.status === "live");
    const ready = open.find((r) => r.status === "playable" && r.phaseGroupId !== env.event.groups()[0].id);
    await env.event.loadSet(ready.setId);
    env.store.setScore(0, 2);
    const b = env.store.bracket();
    const rows = b.upNext;
    assert.deepStrictEqual(rows.map((r) => r.setId).sort(), open.map((r) => String(r.setId)).sort(), "exactly the live and ready sets");
    assert.ok(new Set(rows.map((r) => r.group)).size >= 3, "sets from several pools, each labelled");
    assert.strictEqual(rows[0].setId, String(ready.setId));
    assert.strictEqual(rows[0].status, "onstream");
    const order = { onstream: 0, live: 1, ready: 2 };
    rows.forEach((r, i) => { if (i) assert.ok(order[rows[i - 1].status] <= order[r.status], `row ${i} out of order`); });
    assert.ok(rows.some((r) => r.status === "live"), "the in-progress sets are listed");
    const left = env.store.scoreboard().sides[0].entrantId;
    assert.strictEqual(rows[0].slots.find((s) => s.entrantId === left).score, 2, "the on-air set carries the scoreboard's score");
    for (const r of rows) for (const s of r.slots) assert.ok(b.upNextEntrants[s.entrantId], "every entrant on a card is in upNextEntrants");
    const pages = b.pages.upnext;
    assert.deepStrictEqual(pages.flatMap((p) => p.setIds), rows.map((r) => r.setId), "every row on exactly one page, in order");
    const { w, h } = L.VIEWPORT;
    for (const p of pages) {
      const g = L.layoutList(p.setIds.length);
      assert.ok(g.width * g.scale <= w + 0.5 && g.height * g.scale <= h + 0.5 && g.scale >= M.floorNamePx / M.nameSize - 1e-9);
    }
  });

  await test("Up Next on the page: the cards, the On Stream chip first; no Board", async () => {
    const env = await pageEnv("", midPools());
    const ready = env.event.openSets().find((r) => r.status === "playable");
    await env.event.loadSet(ready.setId);
    env.store.setBracketView("upnext");
    await sleep(80);
    const page1 = env.store.bracket().pages.upnext[0];
    assert.strictEqual(env.page.$$(".layer .ucard").length, page1.setIds.length);
    const first = env.page.$(".layer .ucard");
    assert.ok(first.classList.contains("onstream"));
    assert.strictEqual(first.querySelector(".chip").textContent, "On Stream");
    assert.strictEqual(env.page.$(".title-main .text").textContent, "Up Next");
    assert.strictEqual(env.director.command({ action: "pan", dir: "up" }).status, 409);
  });

  await test("/api/bracket-view takes upnext, and /api/bracket-camera reaches the director", async () => {
    const env = await pageEnv("", "hundred-acres-50");
    const routes = {};
    const app = { get() {}, post(p, fn) { routes[p] = fn; } };
    require("../app/lib/server/api/event").register(app, { store: env.store, event: env.event, bracketDirector: env.director, refreshControlStatus() {} });
    const call = (p, body) => new Promise((resolve) => {
      const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code, body: v }); } };
      routes[p]({ body }, res);
    });
    assert.strictEqual((await call("/api/bracket-view", { view: "upnext" })).code, 200);
    assert.strictEqual(env.store.view().bracketView, "upnext");
    assert.strictEqual((await call("/api/bracket-view", { view: "nonsense" })).code, 400);
    await call("/api/bracket-view", { view: "full" });
    const r = await call("/api/bracket-camera", { action: "zoom", dir: "in" });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.shot.mode, "board");
    assert.strictEqual((await call("/api/bracket-camera", { action: "goto", cx: "x" })).code, 400);
  });

  await test("the shot isn't saved with the scoreboard", async () => {
    const env = await pageEnv("", "hundred-acres-50");
    env.director.command({ action: "next" });
    assert.strictEqual(env.store.toJSON().bracketShot, undefined);
    assert.ok(!require("../app/lib/scoreboard/store").PERSISTED.includes("bracketShot"));
  });

  console.log(failed === 0 ? "bracket-overlay: all passed" : `bracket-overlay: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
