/**
 * director.js — whether the stats popup is up, published as the store's
 * `statsShot` section: { shown, mode, since, pendingAt, auto }.
 *
 *   manual   the dock's Show / Hide and the hotkey, at once. A Hide also
 *            cancels an automatic show that hasn't happened yet.
 *   auto     a game counted (a Slippi game end recorded on the scoreboard)
 *            puts the popup up `delaySec` later — long enough for the camera
 *            to catch the players' reaction first — and, with `holdSec`, takes
 *            it down again after that long. `pendingAt` is when it will go up,
 *            for the dock's countdown.
 *
 * The next game starting, or a different set loading, takes it down and
 * cancels a pending show: the popup is about the game just played, never the
 * one being played.
 *
 * `mode` is what the popup reads: "game" (the game just played, the set so far
 * underneath) or "set" (the wrap-up). Config mode "auto" picks "set" once the
 * set is won, else "game"; "random" picks either at each show (and when it's
 * picked), and holds it for the show — with one game counted the two are the
 * same game, so it reads the game.
 *
 * `layout` is the layout it draws: the config's, or with layout "auto" one
 * picked at each show from the pool for where the set is (`pools.mid`, or
 * `pools.over` once it's won; never the last one twice running when the pool
 * has another) — here, once, so the dock and every source agree on it. The set
 * being won while it's up, or the pool losing the layout up, picks again.
 *
 * `seed` is a fresh number at each show: with pack "random" every source
 * draws the same random poses from it (layouts.js randomPair), held for the
 * show and new at the next.
 */
const { AUTO, layoutFor, poolsOf } = require("./catalog");

/** How long an automatic show waits for a game's stats to be read before giving up. */
const WAIT_FOR_STATS_MS = 20000;
const RETRY_MS = 1000;

/**
 * @param {{ store: import("../scoreboard/store").ScoreboardStore,
 *           now?: () => number, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 */
function createStatsDirector({ store, now = Date.now, timers = { setTimeout, clearTimeout }, rand = Math.random }) {
  let pendingTimer = null;
  let holdTimer = null;
  let waitedSince = null;

  const config = () => store.statsConfig();
  let modeWas = config().mode; // a "random" reading is picked again only when the setting changes to it
  const data = () => store.setStats();

  function modeFor(cfg = config()) {
    if (cfg.mode === "game" || cfg.mode === "set") return cfg.mode;
    if (cfg.mode === "random") return (data()?.counted ?? 0) > 1 && rand() < 0.5 ? "set" : "game";
    return data()?.over ? "set" : "game";
  }

  function clear(t) { if (t) timers.clearTimeout(t); return null; }

  /** A timer's work, which must never throw: out of a timer, a throw ends the app. */
  const guarded = (fn) => () => {
    try { fn(); } catch (err) { console.error(`[set-stats] the popup's timer failed: ${err?.stack ?? err}`); }
  };

  function publish(shot) {
    store.setStatsShot({ ...store.statsShot(), ...shot });
  }

  function show({ auto = false } = {}) {
    pendingTimer = clear(pendingTimer);
    holdTimer = clear(holdTimer);
    waitedSince = null;
    publish({ shown: true, mode: modeFor(), since: now(), pendingAt: null, auto, layout: layoutFor(config(), store.statsShot().layout, !!data()?.over, rand), seed: 1 + Math.floor(rand() * 0x7ffffffe) });
    const hold = config().holdSec;
    if (auto && hold > 0) holdTimer = timers.setTimeout(guarded(() => { holdTimer = null; hide(); }), hold * 1000);
    return { ok: true };
  }

  function hide() {
    pendingTimer = clear(pendingTimer);
    holdTimer = clear(holdTimer);
    waitedSince = null;
    const s = store.statsShot();
    if (s.shown || s.pendingAt) publish({ shown: false, since: now(), pendingAt: null, auto: false });
    return { ok: true };
  }

  /** The auto show's moment: put it up if the counted game's stats are in, else wait a little. */
  function fire() {
    pendingTimer = null;
    const d = data();
    if (d?.available && !d.pending) return show({ auto: true });
    if (waitedSince == null) waitedSince = now();
    if (now() - waitedSince > WAIT_FOR_STATS_MS) {
      waitedSince = null;
      if (d?.available) return show({ auto: true }); // the older games' stats, rather than nothing
      publish({ pendingAt: null });
      return undefined;
    }
    pendingTimer = timers.setTimeout(guarded(fire), RETRY_MS);
    return undefined;
  }

  /** A Slippi game was counted on the scoreboard. */
  function onGameRecorded() {
    const cfg = config();
    if (!cfg.auto) return;
    holdTimer = clear(holdTimer);
    pendingTimer = clear(pendingTimer);
    waitedSince = null;
    const at = now() + cfg.delaySec * 1000;
    publish({ pendingAt: at });
    pendingTimer = timers.setTimeout(guarded(fire), cfg.delaySec * 1000);
  }

  /** The next game is starting, or another set was loaded. */
  function onInterrupt() { hide(); }

  /** The config (or the set) changed: it reads the new mode, and draws a layout picked by hand at once. */
  function onConfig() {
    const s = store.statsShot();
    const cfg = config();
    const modeChanged = cfg.mode !== modeWas;
    modeWas = cfg.mode;
    if (s.shown && (cfg.mode !== "random" || modeChanged)) {
      const m = modeFor(cfg);
      if (s.mode !== m) publish({ mode: m });
    }
    // A layout picked by hand is drawn at once; under Auto the one up stays while its phase's pool has it.
    const over = !!data()?.over;
    if (cfg.layout !== AUTO) {
      const want = layoutFor(cfg, s.layout, over, rand);
      if (s.layout !== want) publish({ layout: want });
    } else if (s.shown && !(s.layout && poolsOf(cfg.pools)[over ? "over" : "mid"].includes(s.layout))) {
      publish({ layout: layoutFor(cfg, s.layout, over, rand) });
    }
    if (!config().auto && s.pendingAt) {
      pendingTimer = clear(pendingTimer);
      publish({ pendingAt: null });
    }
  }

  /**
   * The dock and the hotkey.
   * @param {{ action: "show"|"hide"|"toggle" }} cmd
   */
  function command({ action } = {}) {
    if (action === "hide" || (action === "toggle" && store.statsShot().shown)) return hide();
    if (action === "show" || action === "toggle") {
      // Never "up" with nothing to draw: it would pop up by itself the moment stats arrived.
      const d = data();
      if (!d?.available) return { ok: false, status: 409, error: d?.reason ?? "No stats yet" };
      return show();
    }
    return { ok: false, status: 400, error: "action must be show, hide or toggle" };
  }

  return { command, show, hide, onGameRecorded, onInterrupt, onConfig, modeFor };
}

module.exports = { createStatsDirector };
