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
 * set is won, else "game".
 *
 * `layout` is the layout it draws: the config's, or with layout "random" one
 * picked at each show (never the last one twice running) — here, once, so the
 * dock and every source agree on it.
 *
 * `seed` is a fresh number at each show: with pack "random" every source
 * draws the same random poses from it (layouts.js randomPair), held for the
 * show and new at the next.
 */
const { RANDOM, layoutFor } = require("./catalog");

/** How long an automatic show waits for a game's stats to be read before giving up. */
const WAIT_FOR_STATS_MS = 20000;
const RETRY_MS = 1000;

const LIMITS = { delaySec: [0, 120], holdSec: [0, 600] };

/**
 * @param {{ store: import("../scoreboard/store").ScoreboardStore,
 *           now?: () => number, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 */
function createStatsDirector({ store, now = Date.now, timers = { setTimeout, clearTimeout }, rand = Math.random }) {
  let pendingTimer = null;
  let holdTimer = null;
  let waitedSince = null;

  const config = () => store.statsConfig();
  const data = () => store.setStats();

  function modeFor(cfg = config()) {
    if (cfg.mode === "game" || cfg.mode === "set") return cfg.mode;
    return data()?.over ? "set" : "game";
  }

  function clear(t) { if (t) timers.clearTimeout(t); return null; }

  function publish(shot) {
    store.setStatsShot({ ...store.statsShot(), ...shot });
  }

  function show({ auto = false } = {}) {
    pendingTimer = clear(pendingTimer);
    holdTimer = clear(holdTimer);
    waitedSince = null;
    publish({ shown: true, mode: modeFor(), since: now(), pendingAt: null, auto, layout: layoutFor(config().layout, store.statsShot().layout, rand), seed: 1 + Math.floor(rand() * 0x7ffffffe) });
    const hold = config().holdSec;
    if (auto && hold > 0) holdTimer = timers.setTimeout(() => { holdTimer = null; hide(); }, hold * 1000);
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
    pendingTimer = timers.setTimeout(fire, RETRY_MS);
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
    pendingTimer = timers.setTimeout(fire, cfg.delaySec * 1000);
  }

  /** The next game is starting, or another set was loaded. */
  function onInterrupt() { hide(); }

  /** The config changed while the popup is up: it reads the new mode, and draws a layout picked by hand at once. */
  function onConfig() {
    const s = store.statsShot();
    if (s.shown && s.mode !== modeFor()) publish({ mode: modeFor() });
    const want = config().layout;
    if (want !== RANDOM ? s.layout !== want : s.shown && !s.layout) publish({ layout: layoutFor(want, s.layout, rand) });
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

module.exports = { createStatsDirector, LIMITS };
