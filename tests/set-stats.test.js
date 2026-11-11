/**
 * set-stats.test.js
 *
 * The stats popup — each a way it goes wrong only on stream:
 *
 *   - the numbers stay with the players through Switch Sides (a side's
 *     stats come from the game's ports, which the switch moves);
 *   - a ± game counts in the score but not the stats, and the wrap-up comes
 *     once the set is won;
 *   - the automatic show comes up `delaySec` after a counted game — never
 *     during the next game, never after the operator said Hide, and not
 *     before the game's replay has been read;
 *   - every layout draws both readings in every picture style the dock
 *     offers, and a name from start.gg can't inject markup;
 *   - the page goes up and down with the shot, swaps live, and a hide ends
 *     even in a source that isn't painting (its animations never finish);
 *   - the art packs download in one click, a split archive joined in order,
 *     and a failed update keeps the pack that was there.
 *
 * The per-game numbers are game-stats.js's shape, written out: reading real
 * .slp files is checked by hand (docs/TESTING.md); what's pinned here is
 * everything downstream of the read.
 *
 * Usage: node tests/set-stats.test.js
 */

const assert = require("assert");
const path = require("path");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createOverlayChannel } = require("../app/lib/overlay/channel");
const { createSetStats } = require("../app/lib/set-stats");
const { LAYOUTS: CATALOG_LAYOUTS, STYLES: CATALOG_STYLES, normalizeStatsConfig, configError } = require("../app/lib/set-stats/catalog");
const Fit = require("../overlays/set-stats/portrait-fit");
const Layouts = require("../overlays/set-stats/layouts");
const { loadOverlay, fakeIo, sleep } = require("./helpers/overlay-sandbox");
const fs = require("fs");
const os = require("os");
const { createArtPacks, MANIFEST_URL } = require("../app/lib/set-stats/art-packs");
const { createPortraits } = require("../app/lib/set-stats/portraits");

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

// ── Material ──────────────────────────────────────────────────────────────────

/** One port's numbers (game-stats.js), Fox-ish unless told otherwise. */
const port = (p, o = {}) => ({
  port: p, characterId: 2, costume: 0, kills: 4, damage: 400, opk: 5.0, dpo: 18.0, neutral: 20, counter: 5,
  punish: 70, combo: 6, earliest: 90, avgkill: 110, lcancel: 85, ipm: 400, sd: 0, stocksLeft: 2, wavedash: 30,
  techMiss: 2, ledgegrabs: 5, maxDeficit: 0, firstBlood: true, ...o,
});
/** A game's read: Fox on port 0 (left at first) against Marth on port 3. */
function read({ fox = {}, marth = {}, stage = 31, seconds = 200, winnerPort = 0 } = {}) {
  return {
    ok: true, stageId: stage, lastFrame: seconds * 60 - 123, seconds, winnerPort, endMethod: 2, complete: true,
    players: {
      0: port(0, fox),
      3: port(3, { characterId: 9, kills: 2, damage: 300, opk: 8.0, dpo: 14.0, neutral: 16, punish: 55, combo: 4, earliest: 120, stocksLeft: 0, ...marth }),
    },
  };
}

/** A clock and timers the test moves by hand. */
function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const due = new Map();
  const timers = {
    setTimeout(fn, ms) { const id = ++seq; due.set(id, { at: t + ms, fn }); return id; },
    clearTimeout(id) { due.delete(id); },
    setInterval(fn, ms) { const id = ++seq; due.set(id, { at: t + ms, fn, every: ms }); return id; },
    clearInterval(id) { due.delete(id); },
  };
  async function advance(ms) {
    const end = t + ms;
    await flush(); // what a real event loop runs before the next timer
    for (;;) {
      const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, d] = next;
      t = d.at;
      if (d.every) d.at += d.every; else due.delete(id);
      d.fn();
      await flush();
    }
    t = end;
    await flush();
  }
  return { now: () => t, timers, advance };
}
const flush = () => new Promise((r) => setImmediate(r));

/**
 * A store with a Bo5 between Juniper (left) and Kestrel (right), the real
 * set-stats module on it, and replays "read" from `reads` (file → result).
 */
function rig({ bestOf = "Bo5", reads = {} } = {}) {
  const store = new ScoreboardStore();
  store.loadSet({ setId: "9", roundName: "Winners Final", sides: [{ players: [{ tag: "Juniper" }] }, { players: [{ tag: "Kestrel" }] }] });
  store.setOverrides({ bestOf });
  const clock = fakeClock();
  const held = new Map();
  const ss = createSetStats({ store, config: {} }, {
    read: (file) => {
      if (reads[file] === "hold") return new Promise((resolve) => held.set(file, resolve));
      if (typeof reads[file] === "function") return Promise.resolve(reads[file]());
      return Promise.resolve(reads[file] ?? { ok: false, error: "no such file" });
    },
    // Two portrait packs and two stage sets, as portraits.js gives them: every installed one's picture, by id.
    portraits: {
      portraitsOf: (c) => (c ? Object.fromEntries(["full", "csp"].map((id) => [id, { url: `/assets/packs/${id}/${c.codename}.png`, w: 900, h: 900, eye: [500, 300], k: 1, faces: "right", char: c.codename }])) : null),
      stagePicsOf: (icon) => (icon ? Object.fromEntries(["stage_icon", "st2"].map((id) => [id, `/assets/packs/${id}/${icon}.png`])) : null),
      packs: () => [], stagePacks: () => [], reload() {},
    },
    artPacks: {},
    timers: clock.timers, now: clock.now, sizeOf: () => 1,
  });
  ss.start();
  /** A Slippi game end: Fox's port on `foxSide`. */
  function game(file, winnerSide, foxSide = 0) {
    const players = [[{ port: 0, characterId: 2, costume: 0 }], [{ port: 3, characterId: 9, costume: 0 }]];
    if (foxSide === 1) players.reverse();
    store.recordGame({ winnerSide, replay: { file, startMs: null, lastFrame: null, stageId: 31, players, teamIds: [null, null] } });
  }
  return { store, ss, clock, game, held };
}

(async () => {
  console.log("set-stats");

  await test("the stats stay with the players through Switch Sides", async () => {
    const r = rig({ reads: { a: read(), b: read({ fox: { combo: 11, punish: 92 } }) } });
    r.game("a", 0);
    r.game("b", 0);
    await flush();
    let d = r.store.setStats();
    assert.deepStrictEqual(d.rows.kills.g, [4, 2]);
    assert.deepStrictEqual(d.sides.map((s) => s.tag), ["Juniper", "Kestrel"]);
    assert.strictEqual(d.sides[0].character.codename, "fox");
    const combo = d.insights.game.find((x) => x.row === "combo");
    assert.ok(combo && combo.side === 0 && combo.who === "Juniper", "Juniper's 11-hit combo is a set high, on the left");

    r.store.switchSides();
    await flush();
    d = r.store.setStats();
    assert.deepStrictEqual(d.rows.kills.g, [2, 4], "the numbers moved with the players");
    assert.deepStrictEqual(d.sides.map((s) => s.tag), ["Kestrel", "Juniper"]);
    assert.strictEqual(d.sides[1].character.codename, "fox", "and the portraits");
    const after = d.insights.game.find((x) => x.row === "combo");
    assert.ok(after.side === 1 && after.who === "Juniper", "the callout's edge is on Juniper's new side");
    r.ss.stop();
  });

  await test("a ± game is in the score, not the stats; the wrap-up comes once the set is won", async () => {
    const r = rig({ bestOf: "Bo3", reads: { a: read(), b: read() } });
    r.game("a", 0);
    r.store.bump(1, 1); // a game Slippi didn't see
    await flush();
    let d = r.store.setStats();
    assert.strictEqual(d.counted, 1);
    assert.strictEqual(d.total, 2);
    assert.strictEqual(d.over, false);
    assert.ok(d.facts.game.some((f) => f.lab === "Set so far" && f.val.startsWith("2 games")), "the set so far counts every game");
    r.game("b", 0);
    await flush();
    d = r.store.setStats();
    assert.strictEqual(d.over, true, "2–1 in a Bo3");
    assert.strictEqual(r.ss.director.modeFor(), "set", "the automatic reading is the wrap-up");
    assert.ok(d.stories.set[0].some((s) => s.em === "2–1"), "the summary says the result");
    r.ss.stop();
  });

  await test("doubles and crew battles have no stats, and say why", async () => {
    const r = rig();
    r.store.setDoubles(true);
    await flush();
    assert.strictEqual(r.store.setStats().available, false);
    assert.match(r.store.setStats().reason, /singles/i);
    const shown = r.ss.command({ action: "show" });
    assert.strictEqual(shown.ok, false, "Show refuses: nothing to draw");
    assert.strictEqual(r.store.statsShot().shown, false, "…so it can't pop up by itself when stats arrive");
    r.ss.stop();
  });

  await test("a stats failure never stops the score, a read that can pass is tried again, and the popup goes when its stats do", async () => {
    let tries = 0;
    const r = rig({ reads: { a: () => (++tries === 1 ? { ok: false, transient: true, error: "timed out reading the replay" } : read()) } });
    r.store.setStatsConfig({ auto: false });
    const portraitsOf = r.ss.portraits.portraitsOf;
    r.ss.portraits.portraitsOf = () => { throw new Error("a broken pack"); };
    r.game("a", 0); // throws out of recordGame if a rebuild can throw
    assert.deepStrictEqual(r.store.scoreboard().sides.map((s) => s.score), [1, 0], "the game is counted");
    r.ss.portraits.portraitsOf = portraitsOf;
    await flush();
    assert.strictEqual(r.store.setStats().available, false, "the first read timed out");
    await r.clock.advance(2000);
    assert.strictEqual(tries, 2, "…and was tried again");
    assert.strictEqual(r.store.setStats().available, true);
    assert.ok(r.ss.command({ action: "show" }).ok);
    r.store.clearScore();
    await flush();
    assert.strictEqual(r.store.statsShot().shown, false, "no stats left: down, so it can't pop back up by itself");
    r.ss.stop();
  });

  await test("the automatic show comes `delaySec` after a counted game, and never into the next one", async () => {
    const r = rig({ reads: { a: read(), b: read(), c: read() } });
    r.store.setStatsConfig({ auto: true, delaySec: 8 });
    const shown = () => r.store.statsShot().shown;

    r.game("a", 0);
    await flush();
    assert.ok(r.store.statsShot().pendingAt, "the dock's countdown");
    await r.clock.advance(7900);
    assert.strictEqual(shown(), false, "not before the delay: the camera has the players' reaction");
    await r.clock.advance(200);
    assert.strictEqual(shown(), true);
    assert.strictEqual(r.store.statsShot().mode, "game");

    r.ss.onGameStart();
    assert.strictEqual(shown(), false, "the next game starting takes it down");

    r.game("b", 1);
    await r.clock.advance(3000);
    r.ss.command({ action: "hide" });
    assert.strictEqual(r.store.statsShot().pendingAt, null, "Hide cancels the countdown");
    await r.clock.advance(20000);
    assert.strictEqual(shown(), false, "…for good");

    r.game("c", 0);
    await r.clock.advance(2000);
    r.ss.onGameStart(); // the players were quick
    await r.clock.advance(20000);
    assert.strictEqual(shown(), false, "a game already running is never covered");

    r.store.setStatsConfig({ auto: false });
    r.store.recordGame({ winnerSide: 0, replay: { file: "a", players: [[{ port: 0 }], [{ port: 3 }]] } });
    await r.clock.advance(20000);
    assert.strictEqual(shown(), false, "auto off: only the dock or the hotkey");
    r.ss.stop();
  });

  await test("an automatic show waits for the game's replay to be read; Hold takes it down, a manual show stays", async () => {
    const r = rig({ reads: { a: read(), b: "hold" } });
    r.store.setStatsConfig({ auto: true, delaySec: 2, holdSec: 30 });
    r.game("a", 0);
    await r.clock.advance(2000);
    assert.strictEqual(r.store.statsShot().shown, true);
    await r.clock.advance(30000);
    assert.strictEqual(r.store.statsShot().shown, false, "held 30s, then down");

    r.game("b", 1);
    await r.clock.advance(2500);
    assert.strictEqual(r.store.statsShot().shown, false, "game 2 isn't read yet: not the stale game 1");
    r.held.get("b")(read({ winnerPort: 3 }));
    await flush();
    await r.clock.advance(1000); // the next retry
    const s = r.store.statsShot();
    assert.strictEqual(s.shown, true);
    assert.strictEqual(r.store.setStats().counted, 2, "up with game 2 in it");

    r.ss.command({ action: "hide" });
    r.ss.command({ action: "show" });
    await r.clock.advance(60000);
    assert.strictEqual(r.store.statsShot().shown, true, "a manual show isn't timed out");
    r.store.loadSet({ setId: "10", sides: [{ players: [{ tag: "A" }] }, { players: [{ tag: "B" }] }] });
    assert.strictEqual(r.store.statsShot().shown, false, "another set loading takes it down");
    r.ss.stop();
  });

  await test("Random draws a different layout at each show, and a layout picked by hand at once", async () => {
    const r = rig({ reads: { a: read() } });
    r.game("a", 0);
    await flush();
    r.store.setStatsConfig({ layout: "random", auto: false });
    const seen = [];
    for (let i = 0; i < 6; i++) {
      r.ss.command({ action: "show" });
      seen.push(r.store.statsShot().layout);
      r.ss.command({ action: "hide" });
    }
    assert.ok(seen.every((l) => CATALOG_LAYOUTS.some((x) => x.id === l)), "always a real layout");
    assert.ok(seen.every((l, i) => i === 0 || l !== seen[i - 1]), "never the same one twice running");
    // Each show's seed (random poses) is new, and held while it's up.
    const seeds = [];
    for (let i = 0; i < 4; i++) { r.ss.command({ action: "show" }); seeds.push(r.store.statsShot().seed); r.store.setStatsConfig({ mode: "set" }); assert.strictEqual(r.store.statsShot().seed, seeds[i]); r.store.setStatsConfig({ mode: "auto" }); r.ss.command({ action: "hide" }); }
    assert.ok(seeds.every((x) => Number.isInteger(x) && x > 0) && new Set(seeds).size === seeds.length, "a fresh seed at each show");
    r.ss.command({ action: "show" });
    r.store.setStatsConfig({ layout: "tape" });
    assert.strictEqual(r.store.statsShot().layout, "tape", "picked by hand: drawn now, while it's up");
    assert.ok(!configError({ layout: "random" }) && configError({ layout: "nope" }), "random is a layout the config takes");
    r.ss.stop();
  });

  await test("every layout draws both readings in every style the dock offers, and names can't inject markup", async () => {
    assert.deepStrictEqual(CATALOG_LAYOUTS.map((l) => l.id).sort(), Object.keys(Layouts.LAYOUTS).sort(), "the dock's layouts are the overlay's");
    for (const s of CATALOG_STYLES) if (s.id !== "auto") assert.ok(Layouts.STYLES[s.id], `style ${s.id} isn't drawn`);
    for (const l of CATALOG_LAYOUTS) {
      assert.ok(Layouts.STYLES[l.style] && Layouts.LAYOUTS[l.id].style === l.style, `${l.id}'s own style`);
      assert.deepStrictEqual(Layouts.LAYOUTS[l.id].packs, l.packs, `${l.id}'s best-fit packs: the dock's are the overlay's`);
    }

    const evil = '<img src=x onerror="alert(1)">';
    const r = rig({ reads: { a: read(), b: read({ fox: { combo: 12 } }), c: read({ winnerPort: 3, marth: { stocksLeft: 1 }, fox: { stocksLeft: 0 } }) } });
    r.store.setPlayer(0, 0, { tag: evil });
    r.game("a", 0); r.game("b", 0); r.game("c", 1);
    await flush();
    const d = r.store.setStats();
    for (const layout of Object.keys(Layouts.LAYOUTS)) {
      for (const mode of ["game", "set"]) {
        for (const style of CATALOG_STYLES.map((s) => s.id)) {
          const out = Layouts.render(d, { layout, mode, style });
          const all = out.content + out.portraits + out.rots.flatMap((x) => x.items).join("");
          assert.ok(!all.includes("<img src=x"), `${layout}/${mode}/${style}: the tag went in as markup`);
          if (layout !== "players") assert.ok(all.includes("&lt;img src=x"), `${layout}/${mode}: the tag is shown, escaped`);
        }
      }
    }
    // The pack picked draws the characters, the stage set picked the stages; one that
    // isn't downloaded falls back to one that is, and stages "none" draws none.
    const pics = (pack) => Layouts.render(d, { layout: "spotlight", mode: "game", style: "auto", pack }).portraits;
    assert.ok(pics("csp").includes("/assets/packs/csp/") && !pics("csp").includes("/assets/packs/full/"), "the picked pack");
    assert.ok(pics("gone").includes("/assets/packs/full/"), "a missing pack falls back to the first");
    const stagePics = (stages) => Object.keys(Layouts.LAYOUTS).map((layout) => Layouts.render(d, { layout, mode: "set", style: "auto", stages }).content).join("");
    assert.ok(stagePics("st2").includes("/assets/packs/st2/") && !stagePics("st2").includes("/assets/packs/stage_icon/"), "the picked stage set");
    assert.ok(stagePics("gone").includes("/assets/packs/stage_icon/"), "a missing stage set falls back to the first");
    assert.ok(!/\/assets\/packs\/(stage_icon|st2)\//.test(stagePics("none")), "none: no stage pictures");
    // A mirror match never draws the same pose twice: the left keeps the pack, the right takes another, the style stays.
    const mirror = Object.assign({}, d, { sides: [d.sides[0], Object.assign({}, d.sides[1], { character: d.sides[0].character, portraits: d.sides[0].portraits })] });
    const packsIn = (dd, o) => {
      const r = Layouts.render(dd, Object.assign({ layout: "spotlight", mode: "game", style: "riso" }, o));
      return { style: r.style, ids: [...new Set([...r.portraits.matchAll(/\/assets\/packs\/(\w+)\//g)].map((m) => m[1]))] };
    };
    assert.deepStrictEqual(packsIn(mirror, { pack: "csp" }), { style: "riso", ids: ["csp", "full"] }, "a mirror: the left on the picked pack, the right on another");
    assert.deepStrictEqual(packsIn(mirror, { pack: "auto" }).ids, ["full", "csp"], "and under best fit");
    // A pose that looks outward and can't be mirrored (lettering, `o`) gives way to the next pack's.
    const lettered = { csp: { [d.sides[0].portraits.csp.char]: { o: 1 } } };
    assert.deepStrictEqual(packsIn(d, { pack: "csp", fit: lettered }).ids, ["full", "csp"], "the lettered side takes another pack, the other keeps the pick");
    assert.deepStrictEqual(packsIn(d, { pack: "csp" }).ids, ["csp"], "two characters share the pack");
    // Random poses: a pack per side from the show's seed — never a bust pack (cut), both
    // from one family of renders, a mirror's two different — in the style "auto" or the pick gives.
    const families = (s) => {
      const as = (id, extra) => Object.assign({}, s.portraits.csp, { url: s.portraits.csp.url.replace("/csp/", `/${id}/`) }, extra);
      return Object.assign({}, s, { portraits: { full: Object.assign({}, s.portraits.full, { family: "vs" }), csp: as("csp", { family: "c" }), alt: as("alt", { family: "c" }), bust: as("bust", { family: "b", cut: true }) } });
    };
    const rd = Object.assign({}, d, { sides: d.sides.map(families) });
    const FAM = { full: "vs", csp: "c", alt: "c" };
    const sidesIn = (dd, o) => {
      const r = Layouts.render(dd, Object.assign({ layout: "spotlight", mode: "game", style: "auto", pack: "random" }, o));
      return { style: r.style, ids: r.portraits.split(/(?=<div class="por )/).map((x) => (/\/assets\/packs\/(\w+)\//.exec(x) || [])[1]).filter(Boolean) };
    };
    const pairs = new Set();
    for (let seed = 1; seed <= 80; seed++) {
      const { ids } = sidesIn(rd, { seed });
      assert.strictEqual(ids.length, 2, `seed ${seed}: a portrait each side`);
      assert.ok(!ids.includes("bust") && FAM[ids[0]] === FAM[ids[1]], `seed ${seed}: full-body, one family (${ids})`);
      assert.deepStrictEqual(sidesIn(rd, { seed }).ids, ids, "the same seed, the same poses");
      pairs.add(ids.join("+"));
    }
    assert.strictEqual(pairs.size, 5, `every pair that can be drawn turns up (${[...pairs]})`);
    const rmirror = Object.assign({}, rd, { sides: [rd.sides[0], Object.assign({}, rd.sides[1], { character: rd.sides[0].character, portraits: rd.sides[0].portraits })] });
    for (let seed = 1; seed <= 20; seed++) {
      const { ids } = sidesIn(rmirror, { seed });
      assert.ok(ids[0] !== ids[1] && FAM[ids[0]] === "c" && FAM[ids[1]] === "c", `a mirror: two poses from one family (${ids})`);
    }
    assert.strictEqual(sidesIn(rd, { seed: 3, combos: { spotlight: { style: "riso", pack: "csp" } } }).style, "riso", "random poses keep the saved style");
    assert.strictEqual(sidesIn(rd, { seed: 3, style: "halftone" }).style, "halftone", "and a style picked by hand");
    const savedRandom = sidesIn(rd, { seed: 3, pack: "auto", combos: { spotlight: { style: "cream", pack: "random" } } });
    assert.ok(savedRandom.style === "cream" && savedRandom.ids.length === 2 && !savedRandom.ids.includes("bust"), "random saved as a layout's best fit");
    assert.deepStrictEqual(normalizeStatsConfig({ pack: "random", combos: { tape: { style: "riso", pack: "random" } } }).combos, { tape: { style: "riso", pack: "random" } });

    // Best fit: "auto" is the layout's saved combo, else its own pick (a pack not
    // downloaded gives way to the next it ranks, else to one that is).
    const draw = (o) => Layouts.render(d, Object.assign({ layout: "spotlight", mode: "game" }, o));
    assert.strictEqual(draw({ style: "auto", pack: "auto" }).style, Layouts.LAYOUTS.spotlight.style, "auto: the layout's own style");
    assert.ok(draw({ style: "auto", pack: "auto" }).portraits.includes("/assets/packs/full/"), "auto: its packs, the first downloaded");
    const saved = { combos: { spotlight: { style: "riso", pack: "csp" } }, style: "auto", pack: "auto" };
    assert.strictEqual(draw(saved).style, "riso", "a saved combo is the layout's best fit");
    assert.ok(draw(saved).portraits.includes("/assets/packs/csp/"), "with its pack");
    assert.strictEqual(draw(Object.assign({}, saved, { layout: "tape" })).style, Layouts.LAYOUTS.tape.style, "only for its layout");
    assert.strictEqual(draw(Object.assign({}, saved, { style: "halftone" })).style, "halftone", "a style picked by hand still wins");
    const cfg = normalizeStatsConfig({ combos: { spotlight: { style: "riso", pack: "csp" }, nope: { style: "riso", pack: "x" }, tape: { style: "auto", pack: "full" } } });
    assert.deepStrictEqual(cfg.combos, { spotlight: { style: "riso", pack: "csp" } }, "only whole combos for real layouts are kept");
    assert.ok(configError({ combos: { tape: { style: "auto", pack: "full" } } }), "a combo can't be auto");

    // The per-pose tweaks: mirror, zoom and move are drawn; the pack's "*" combines.
    const fit = { full: { "*": { z: 2, card: { z: 3 } }, [d.sides[0].portraits.full.char]: { f: 1, z: 0.5, x: 10 } } };
    assert.deepStrictEqual(Fit.tweak("full", d.sides[0].portraits.full.char, "spotlight", "edge", fit), { f: 1, z: 1, x: 10 }, "zooms multiply");
    assert.strictEqual(Fit.tweak("full", "nobody", "polaroids", "card", fit).z, 3, "a slot's own value");
    const imgOf = (o) => /<img [^>]*style="([^"]*)"/.exec(draw(Object.assign({ pack: "full", style: "plain" }, o)).portraits)[1];
    assert.ok(!imgOf({ fit: {} }).includes("scaleX(-1)") && imgOf({ fit }).includes("scaleX(-1)"), "f mirrors the art");
    assert.ok(imgOf({ fit }) !== imgOf({ fit: {} }), "the tweak moves it");
    r.ss.stop();
  });

  await test("the page goes up and down with the shot, swaps live, and a hide ends in a source that isn't painting", async () => {
    const r = rig({ reads: { a: read(), b: read() } });
    const { io, nsps } = fakeIo();
    createOverlayChannel({ io, store: r.store });
    r.game("a", 0); r.game("b", 1);
    await flush();
    // Animations take 1000× their length: as good as never finishing.
    const page = await loadOverlay({ page: "set-stats", nsps, timeScale: 1000 });
    const bar = await loadOverlay({ page: "scoreboard", htmlFile: path.join(__dirname, "../overlays/scoreboard/players.html"), nsps, timeScale: 1000 });
    const logo = bar.$(".logo");
    // Where the players bar's logo is headed: the --logo-y its newest animation ends on.
    const logoTo = () => { const a = logo._anims.find((x) => x.keyframes.some((k) => "--logo-y" in k)); return a && a.keyframes[a.keyframes.length - 1]["--logo-y"]; };
    const win = page.$("#win");
    const S = page.window.SetStats;
    assert.strictEqual(S.up, false, "down until shown");
    assert.strictEqual(logoTo(), undefined, "the logo is left to its own entrance");

    r.ss.command({ action: "show" });
    await sleep(30);
    assert.strictEqual(S.up, true);
    assert.strictEqual(logoTo(), "100%", "the logo sinks into the round card for the popup");
    assert.strictEqual(win.dataset.layout, "spotlight");
    assert.ok(page.$(".lr"), "the ledger is drawn");

    r.store.setStatsConfig({ layout: "rangerlog", style: "riso" });
    for (let i = 0; i < 100 && win.dataset.layout !== "rangerlog"; i++) await sleep(30);
    assert.strictEqual(win.dataset.layout, "rangerlog", "the layout switched while up");
    assert.strictEqual(win.dataset.style, "riso");
    assert.ok(win.className.includes("skin-paper"));

    r.store.setStatsConfig({ layout: "lowerthird" });
    for (let i = 0; i < 200 && win.dataset.layout !== "lowerthird"; i++) await sleep(30);
    assert.strictEqual(win.dataset.layout, "lowerthird", "a window of another size goes down and comes back up in it");
    assert.strictEqual(win.style.top, "556px");
    assert.ok(S.up);

    r.ss.command({ action: "hide" });
    for (let i = 0; i < 100 && S.up; i++) await sleep(30);
    assert.strictEqual(S.up, false, "the hide finished on its timer, not on an animation that never ends");
    assert.strictEqual(win.className, "win");
    assert.strictEqual(logoTo(), "0%", "and climbs back out once it's gone");
    r.ss.stop();
  });

  await test("the art packs download in one click, a split archive joined in order, and a failed update keeps what was there", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-packs-"));
    try {
      let version = "2";
      const manifest = () => ({ ssbm: { assets: {
        full: { has_eyesight_data: true, version, files: { "ssbm.full.7z.002": { name: "ssbm.full.7z.002", size: 2 }, "ssbm.full.7z.001": { name: "ssbm.full.7z.001", size: 2 } } },
        stage_icon: { has_eyesight_data: false, version, files: { "ssbm.stage_icon.7z.001": { name: "ssbm.stage_icon.7z.001", size: 2 } } },
        CSProject_Icon: { has_eyesight_data: false, version, files: { "x.7z.001": { name: "x.7z.001", size: 9 } } }, // icons: the popup can't use them
      } } });
      const parts = { "ssbm.full.7z.001": "ab", "ssbm.full.7z.002": "cd", "ssbm.stage_icon.7z.001": "st" };
      const fetch = async (url) => (url === MANIFEST_URL ? new Response(JSON.stringify(manifest()))
        : new Response(parts[decodeURIComponent(url.split("/").pop())] ?? null, { status: parts[decodeURIComponent(url.split("/").pop())] ? 200 : 404 }));
      const png = (w, h) => { const b = Buffer.alloc(24); b.write("IHDR", 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
      let breakFull = false;
      const archives = {};
      const extract = async (archive, into) => {
        const id = path.basename(archive, ".7z");
        archives[id] = fs.readFileSync(archive, "utf8");
        if (breakFull && id === "full") throw new Error("couldn't unpack (truncated)");
        fs.mkdirSync(path.join(into, id));
        if (id === "full") {
          fs.writeFileSync(path.join(into, id, "config.json"), JSON.stringify({ type: ["full"], eyesights: { fox: { 0: { x: 400, y: 300 } } }, credits: "v" + version }));
          fs.writeFileSync(path.join(into, id, "fox_0.png"), png(942, 941));
        } else {
          fs.writeFileSync(path.join(into, id, "config.json"), JSON.stringify({ type: ["stage_icon"] }));
          fs.writeFileSync(path.join(into, id, "battlefield.png"), png(1273, 717));
        }
      };
      const portraits = createPortraits({ dir });
      assert.strictEqual(portraits.portraitsOf({ codename: "fox", skin: 0 }), null, "nothing before the download");
      const packs = createArtPacks({ dir, fetch, extract, onInstalled: () => portraits.reload() });

      const r = await packs.downloadAll();
      assert.ok(r.ok && r.job.running, "it starts in the background");
      await packs.job.finished;
      assert.strictEqual(archives.full, "abcd", "the parts are joined in order");
      assert.deepStrictEqual(packs.list().map((p) => [p.id, p.current]).filter(([id]) => id === "full" || id === "stage_icon"), [["full", true], ["stage_icon", true]]);
      assert.ok(!packs.list().some((p) => p.id === "CSProject_Icon"), "an icon pack isn't offered");
      const fox = portraits.portraitsOf({ codename: "fox", skin: 3 });
      assert.deepStrictEqual([fox.full.url, fox.full.eye], ["/assets/packs/full/fox_0.png", [400, 300]], "a costume without its own picture falls back to the first, placed by its face");
      assert.deepStrictEqual(portraits.stagePicsOf("battlefield"), { stage_icon: "/assets/packs/stage_icon/battlefield.png" });
      assert.deepStrictEqual(portraits.stagePacks().map((p) => p.id), ["stage_icon"], "the stages are a set of their own, not a portrait pack");
      assert.ok((await packs.downloadAll()).upToDate, "a second click has nothing to do");

      version = "3";
      breakFull = true;
      await packs.downloadAll();
      await packs.job.finished;
      assert.deepStrictEqual(packs.job.failed.map((f) => f.id), ["full"]);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "full", "config.json"), "utf8")).credits, "v2", "the old pack is still there");
      assert.ok(packs.list().find((p) => p.id === "stage_icon").current, "and the others updated");
      assert.ok(!fs.existsSync(path.join(dir, ".download")), "no download left behind");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("two quick clicks are one download, a stalled one gives up, and an interrupted swap is put back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-packs-"));
    try {
      // A swap cut off after the old copy was moved aside: the pack is only in .download/full.old.
      fs.mkdirSync(path.join(dir, ".download", "full.old"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".download", "full.old", "config.json"), "{}");
      const manifest = { ssbm: { assets: { stage_icon: { version: "1", files: { "s.7z.001": { name: "s.7z.001", size: 2 } } } } } };
      let manifestReads = 0;
      const fetch = async (url) => {
        if (url === MANIFEST_URL) { manifestReads++; return new Response(JSON.stringify(manifest)); }
        return new Response(new ReadableStream({ pull: () => new Promise(() => {}) })); // headers, then nothing
      };
      const packs = createArtPacks({ dir, fetch, extract: async () => {}, stallMs: 50 });
      assert.ok(fs.existsSync(path.join(dir, "full", "config.json")), "the moved-aside copy is back in place");
      const [a, b] = await Promise.all([packs.downloadAll(), packs.downloadAll()]);
      assert.strictEqual(a.job, b.job, "one job");
      assert.strictEqual(manifestReads, 1);
      await packs.job.finished;
      assert.strictEqual(packs.job.running, false, "the job ends, so the button comes back");
      assert.match(packs.job.failed[0].error, /stalled/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(failed ? `set-stats: ${failed} failed` : "set-stats: all passed");
  process.exit(failed ? 1 : 0);
})();
