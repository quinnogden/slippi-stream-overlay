/**
 * Set stats — the stats popup's data and its director.
 *
 *   scoreboard games ─ replay.file ─→ worker (game-stats.js, one file at a time)
 *                                        ↓ per-port numbers, cached per file
 *   store.scoreboard() + cache ─→ set-view.js ─→ store.setSetStats()   (`setStats`)
 *   game counted / next game / dock ─→ director.js ─→ store.setStatsShot() (`statsShot`)
 *
 * A game's file is read when the game is recorded. Slippi may not have closed
 * it yet (its header still says "live"), so a read that found no game end is
 * read again once the file stops growing — the numbers are right by the time
 * the popup goes up, `delaySec` later. A set restored on boot has its games
 * read then.
 *
 * Nothing here talks to the network or writes a file.
 */

const fs = require("fs");
const path = require("path");
const { buildSetView } = require("./set-view");
const { createStatsDirector } = require("./director");
const { createPortraits } = require("./portraits");
const { createArtPacks } = require("./art-packs");

/** Where the downloaded art packs go (gitignored; served at /assets/packs/). */
const PACKS_DIR = path.resolve(__dirname, "..", "..", "..", "overlays", "assets", "packs");

const RECHECK_MS = 2000;
const READ_TIMEOUT_MS = 30000;
/** A read that failed for a reason that can pass (a timeout, the worker dying, a half-written file) is tried this many times in all. */
const MAX_TRIES = 3;

/**
 * One long-lived worker thread reading files in turn; restarted if it dies.
 * A read that hangs past READ_TIMEOUT_MS ends the worker, so one bad file
 * can't hold up every read queued behind it. Each read belongs to the worker
 * it was posted to: a dead worker's last events can't fail a fresh one's reads.
 */
function createWorkerReader() {
  const { Worker } = require("worker_threads");
  let worker = null; // { thread, waiting: Map(id → { resolve, timer }) }
  let seq = 0;

  function ensure() {
    if (worker) return worker;
    const w = { thread: new Worker(path.join(__dirname, "worker.js")), waiting: new Map() };
    worker = w;
    w.thread.unref();
    w.thread.on("message", ({ id, result }) => {
      const r = w.waiting.get(id);
      if (!r) return;
      w.waiting.delete(id);
      clearTimeout(r.timer);
      r.resolve(result);
    });
    const fail = (why) => {
      if (worker === w) worker = null;
      for (const [, r] of w.waiting) { clearTimeout(r.timer); r.resolve({ ok: false, transient: true, error: `stats worker: ${why}` }); }
      w.waiting.clear();
    };
    w.thread.on("error", (err) => fail(err?.message ?? String(err)));
    w.thread.on("exit", (code) => fail(`exited ${code}`));
    return w;
  }

  return function read(file) {
    return new Promise((resolve) => {
      const id = ++seq;
      const w = ensure();
      const timer = setTimeout(() => {
        w.waiting.delete(id);
        resolve({ ok: false, transient: true, error: "timed out reading the replay" });
        // A worker stuck on one file would time out every read after it: start a fresh one.
        if (worker === w) worker = null;
        w.thread.terminate().catch(() => {});
      }, READ_TIMEOUT_MS);
      timer.unref?.();
      w.waiting.set(id, { resolve, timer });
      w.thread.postMessage({ id, file });
    });
  };
}

/**
 * @param {{ store: object, config?: object }} ctx
 * @param {{ read?: (file: string) => Promise<object>, portraits?: object, artPacks?: object, timers?: object, now?: () => number,
 *           sizeOf?: (file: string) => number|null }} [opts] — for tests
 */
function createSetStats(ctx, opts = {}) {
  const { store } = ctx;
  const read = opts.read ?? createWorkerReader();
  const portraits = opts.portraits ?? createPortraits({ dir: PACKS_DIR });
  // A pack that lands mid-set draws at once: the sides are rebuilt with it.
  const artPacks = opts.artPacks ?? createArtPacks({ dir: PACKS_DIR, onInstalled: () => { portraits.reload(); rebuild(); } });
  const timers = opts.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const sizeOf = opts.sizeOf ?? ((file) => { try { return fs.statSync(file).size; } catch { return null; } });
  const director = createStatsDirector({ store, now: opts.now, timers, rand: opts.rand });

  /** file → { result, size, tries } once read; `reading` while in the queue. */
  const cache = new Map();
  const reading = new Set();
  const queue = [];
  let busy = false;
  let recheck = null;
  let lastCount = store.scoreboard().games.length;

  const statsOf = (file) => cache.get(file)?.result;
  /** Read mid-write (no game end yet), or failed for a reason that can pass and not tried out yet. */
  const open = (c) => (c.result.ok ? !c.result.complete : !!c.result.transient && c.tries < MAX_TRIES);

  /** `retry`: the recheck's call — a failed read is tried again only from there, RECHECK_MS later, never straight away. */
  function want(file, { retry = false } = {}) {
    if (!file || reading.has(file)) return;
    const c = cache.get(file);
    if (c) {
      if (!open(c)) return;                                     // final, or unreadable (said once)
      if (!c.result.ok && !retry) return;                       // failed: the recheck tries it again
      if (c.result.ok && sizeOf(file) === c.size) return;       // read mid-write, not grown since
    }
    reading.add(file);
    queue.push(file);
    pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const file = queue.shift();
        const size = sizeOf(file);
        let result;
        try {
          result = await read(file);
        } catch (err) {
          result = { ok: false, transient: true, error: err?.message ?? String(err) };
        }
        reading.delete(file);
        // A file that's gone (or unreadable) is remembered as such, so it isn't read in a loop;
        // one that failed for a reason that can pass is tried again (MAX_TRIES in all).
        const tries = (cache.get(file)?.tries ?? 0) + 1;
        cache.set(file, { result: result ?? { ok: false, transient: true, error: "no answer" }, size, tries });
        if (!result?.ok) console.warn(`[set-stats] ${path.basename(file)}: ${result?.error ?? "unreadable"}${result?.transient && tries < MAX_TRIES ? " — trying again" : ""}`);
        rebuild();
      }
    } finally {
      busy = false;
      reading.clear(); // nothing is in flight now: a file dropped by a throw can be wanted again
      scheduleRecheck();
    }
  }

  /** Files read before Slippi finished them are read again once they've grown; a passing failure, a little later. */
  function scheduleRecheck() {
    const anyOpen = () => [...cache.values()].some(open);
    if (anyOpen() && !recheck) {
      recheck = timers.setInterval(() => {
        for (const [file, c] of cache) if (open(c)) want(file, { retry: true });
        if (!anyOpen()) {
          timers.clearInterval(recheck);
          recheck = null;
        }
      }, RECHECK_MS);
      recheck.unref?.();
    }
  }

  /**
   * The set's stats again. Never throws: it runs inside the store's change
   * event, so a throw here would come out of whatever changed the scoreboard —
   * a Slippi game end, a score bump, a set load. A view that can't be built
   * leaves the last one up and says so in the log.
   */
  function rebuild() {
    try {
      const sb = store.scoreboard();
      for (const g of sb.games) if (g.replay?.file) want(g.replay.file);
      const view = buildSetView(sb, statsOf, portraits.portraitsOf);
      for (const g of view.games) {
        try { g.stage.pics = portraits.stagePicsOf(g.stage.icon); } catch { g.stage.pics = null; }
      }
      store.setSetStats(view);
    } catch (err) {
      console.error(`[set-stats] couldn't build the set's stats: ${err?.stack ?? err}`);
    }
  }

  function onChange({ keys }) {
    if (keys.includes("scoreboard")) {
      const sb = store.scoreboard();
      const n = sb.games.length;
      const added = n > lastCount && sb.games[n - 1]?.replay?.file;
      lastCount = n;
      rebuild();
      // Stats gone with the popup up (Doubles switched on, the score cleared): down, or it
      // would pop back up by itself once they returned. Still being read (↻) keeps it up.
      const d = store.setStats();
      if (store.statsShot().shown && d && !d.available && !d.pending) director.hide();
      else if (added) director.onGameRecorded();
      else director.onConfig(); // the set may have just been won: an "auto" reading follows it
    }
    if (keys.includes("statsConfig")) director.onConfig();
  }

  function onSetLoaded() {
    lastCount = store.scoreboard().games.length;
    // Only this set's replays are wanted again: a long event's reads don't pile up.
    const keep = new Set(store.scoreboard().games.map((g) => g.replay?.file).filter(Boolean));
    for (const file of cache.keys()) if (!keep.has(file)) cache.delete(file);
    director.onInterrupt();
  }

  return {
    director,
    portraits,
    artPacks,
    start() {
      store.on("change", onChange);
      store.on("set-loaded", onSetLoaded);
      rebuild();
      const ids = portraits.packs().map((p) => p.id);
      console.log(`[set-stats] Portraits: ${ids.length ? ids.join(", ") : "none downloaded (the dock's Setup tab → Art packs)"}`);
    },
    stop() {
      store.off("change", onChange);
      store.off("set-loaded", onSetLoaded);
      if (recheck) timers.clearInterval(recheck);
      recheck = null;
    },
    /** The next game started: the popup is about the last one, so it goes. */
    onGameStart() { director.onInterrupt(); },
    /** Read every game's file again (the dock's ↻). */
    refresh() {
      cache.clear();
      rebuild();
      return { ok: true };
    },
    command: director.command,
    /** Whether every counted file has been read (for tests and the dock). */
    get idle() { return !busy && !queue.length; },
  };
}

module.exports = { createSetStats };
