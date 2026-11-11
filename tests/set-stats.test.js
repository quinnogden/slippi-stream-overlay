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
 *     even in a source that isn't painting (its animations never finish).
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
const { LAYOUTS: CATALOG_LAYOUTS, STYLES: CATALOG_STYLES } = require("../app/lib/set-stats/catalog");
const Layouts = require("../overlays/set-stats/layouts");
const { loadOverlay, fakeIo, sleep } = require("./helpers/overlay-sandbox");

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
      return Promise.resolve(reads[file] ?? { ok: false, error: "no such file" });
    },
    portraits: { dir: null, stagesDir: null, portraitOf: (c) => (c ? { url: `/p/${c.codename}.png`, w: 900, h: 900, eye: [500, 300], k: 1, faces: "right" } : null), stageIcon: () => null },
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

  await test("every layout draws both readings in every style the dock offers, and names can't inject markup", async () => {
    assert.deepStrictEqual(CATALOG_LAYOUTS.map((l) => l.id).sort(), Object.keys(Layouts.LAYOUTS).sort(), "the dock's layouts are the overlay's");
    for (const s of CATALOG_STYLES) if (s.id !== "auto") assert.ok(Layouts.STYLES[s.id], `style ${s.id} isn't drawn`);
    for (const l of CATALOG_LAYOUTS) assert.ok(Layouts.STYLES[l.style] && Layouts.LAYOUTS[l.id].style === l.style, `${l.id}'s own style`);

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

  console.log(failed ? `set-stats: ${failed} failed` : "set-stats: all passed");
  process.exit(failed ? 1 : 0);
})();
