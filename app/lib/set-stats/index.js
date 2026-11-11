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

/** One long-lived worker thread reading files in turn; restarted if it dies. */
function createWorkerReader() {
  const { Worker } = require("worker_threads");
  let worker = null;
  let seq = 0;
  const waiting = new Map();

  function ensure() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, "worker.js"));
    worker.unref();
    worker.on("message", ({ id, result }) => {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      clearTimeout(w.timer);
      w.resolve(result);
    });
    const fail = (err) => {
      worker = null;
      for (const [, w] of waiting) { clearTimeout(w.timer); w.resolve({ ok: false, error: `stats worker: ${err?.message ?? err}` }); }
      waiting.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => { if (code !== 0) fail(`exited ${code}`); else worker = null; });
    return worker;
  }

  return function read(file) {
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ ok: false, error: "timed out reading the replay" });
      }, READ_TIMEOUT_MS);
      timer.unref?.();
      waiting.set(id, { resolve, timer });
      ensure().postMessage({ id, file });
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
  const director = createStatsDirector({ store, now: opts.now, timers });

  /** file → { result, size } once read; `reading` while in the queue. */
  const cache = new Map();
  const reading = new Set();
  const queue = [];
  let busy = false;
  let recheck = null;
  let lastCount = store.scoreboard().games.length;

  const statsOf = (file) => cache.get(file)?.result;

  function want(file) {
    if (!file || reading.has(file)) return;
    const c = cache.get(file);
    if (c) {
      if (!c.result.ok || c.result.complete) return; // unreadable (said once), or final
      if (sizeOf(file) === c.size) return;           // read mid-write, not grown since
    }
    reading.add(file);
    queue.push(file);
    pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const file = queue.shift();
      const size = sizeOf(file);
      let result;
      try {
        result = await read(file);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      reading.delete(file);
      // A file that's gone (or unreadable) is remembered as such, so it isn't read in a loop.
      cache.set(file, { result: result ?? { ok: false, error: "no answer" }, size });
      if (!result?.ok) console.warn(`[set-stats] ${path.basename(file)}: ${result?.error ?? "unreadable"}`);
      rebuild();
    }
    busy = false;
    scheduleRecheck();
  }

  /** Files read before Slippi finished them are read again once they've grown. */
  function scheduleRecheck() {
    const open = [...cache.entries()].some(([, c]) => c.result.ok && !c.result.complete);
    if (open && !recheck) {
      recheck = timers.setInterval(() => {
        for (const [file, c] of cache) if (c.result.ok && !c.result.complete) want(file);
        if (![...cache.values()].some((c) => c.result.ok && !c.result.complete)) {
          timers.clearInterval(recheck);
          recheck = null;
        }
      }, RECHECK_MS);
      recheck.unref?.();
    }
  }

  function rebuild() {
    const sb = store.scoreboard();
    for (const g of sb.games) if (g.replay?.file) want(g.replay.file);
    const view = buildSetView(sb, statsOf, portraits.portraitsOf);
    for (const g of view.games) g.stage.pics = portraits.stagePicsOf(g.stage.icon);
    store.setSetStats(view);
  }

  function onChange({ keys }) {
    if (keys.includes("scoreboard")) {
      const sb = store.scoreboard();
      const n = sb.games.length;
      const added = n > lastCount && sb.games[n - 1]?.replay?.file;
      lastCount = n;
      rebuild();
      if (added) director.onGameRecorded();
      else director.onConfig(); // the set may have just been won: an "auto" reading follows it
    }
    if (keys.includes("statsConfig")) director.onConfig();
  }

  function onSetLoaded() {
    lastCount = store.scoreboard().games.length;
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
