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
 * Singles only. A doubles set's (or a crew battle's) replays are never read
 * and its games start no automatic show; a four-player game played while a
 * singles set is up isn't counted, and calls off the show it started.
 *
 * Whatever goes wrong costs the stats, never the score: a view that can't be
 * built publishes none (`available: false`, never the last set's numbers), so
 * the popup can't be shown and comes down if it's up, and the side panel's
 * stats cards drop out of its rotation. A broken art pack costs the portraits.
 *
 * Nothing here talks to the network or writes a file.
 */

const fs = require("fs");
const path = require("path");
const { buildSetView, unavailable } = require("./set-view");
const { createStatsDirector } = require("./director");
const { createPortraits } = require("./portraits");
const { createArtPacks } = require("./art-packs");

/** Where the downloaded art packs go (gitignored; served at /assets/packs/). */
const PACKS_DIR = path.resolve(__dirname, "..", "..", "..", "overlays", "assets", "packs");

const RECHECK_MS = 2000;
const READ_TIMEOUT_MS = 30000;
/** A read that failed for a reason that can pass (a timeout, the worker dying, a half-written file) is tried this many times in all. */
const MAX_TRIES = 3;
/** How many sets back an accolade the audience saw is still scored down. */
const RECENT_SETS = 3;

/** The stats are singles only: a doubles set or a crew battle has none (set-view.js says why). */
const singles = (sb) => !sb.isDoubles && !sb.crew;

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
  /**
   * The accolades the last few sets showed (accolades.js scores them down), so
   * a new set doesn't open on the same ones the audience just saw. Taken as a
   * set closes — never mid-show, which would reword a popup that's up.
   */
  const pastSets = [];
  let recent = new Map();

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
        if (result?.notSingles) callOff(file);
      }
    } catch (err) {
      // Never a rejection nobody hears: in Node that ends the app.
      console.error(`[set-stats] reading the replays stopped: ${err?.stack ?? err}`);
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
   * The game just counted turned out to have four players (doubles played
   * while a singles set was still up): its automatic show is called off, or
   * the popup would come up on the game before it.
   */
  function callOff(file) {
    const games = store.scoreboard().games;
    if (games[games.length - 1]?.replay?.file !== file) return;
    const s = store.statsShot();
    if (s.pendingAt && !s.shown) director.hide();
  }

  /** A character's portraits, or none: a pack that throws costs the pictures, not the popup. */
  function portraitsOf(character) {
    try { return portraits.portraitsOf(character); } catch { return null; }
  }

  /**
   * The set's stats again. Never throws: it runs inside the store's change
   * event and after each read. A view that can't be built publishes none —
   * never the last one, which may be the previous set's — and says so in the
   * log. Returns whether the popup was up with nothing to draw and so came down.
   */
  function rebuild() {
    try {
      const sb = store.scoreboard();
      // Singles only: a doubles set's replays aren't read at all (set-view.js says why there's nothing).
      if (singles(sb)) for (const g of sb.games) if (g.replay?.file) want(g.replay.file);
      const view = buildSetView(sb, statsOf, portraitsOf, { recent });
      for (const g of view.games) {
        try { g.stage.pics = portraits.stagePicsOf(g.stage.icon); } catch { g.stage.pics = null; }
      }
      store.setSetStats(view);
    } catch (err) {
      console.error(`[set-stats] couldn't build the set's stats: ${err?.stack ?? err}`);
      try { store.setSetStats(unavailable("The set's stats couldn't be worked out (see the app's log)")); } catch { /* the store refused: nothing else to try */ }
    }
    return dropIfEmpty();
  }

  /**
   * Up with nothing to draw (Doubles switched on, the score cleared, a view that
   * failed): down, or it would pop back up by itself once stats returned.
   * Still being read (↻) keeps it up.
   */
  function dropIfEmpty() {
    try {
      const d = store.setStats();
      if (!store.statsShot().shown || d?.available || d?.pending) return false;
      director.hide();
      return true;
    } catch (err) {
      console.error(`[set-stats] ${err?.stack ?? err}`);
      return false;
    }
  }

  function onChange({ keys }) {
    try {
      if (keys.includes("scoreboard")) {
        const sb = store.scoreboard();
        const n = sb.games.length;
        const added = n > lastCount && sb.games[n - 1]?.replay?.file;
        lastCount = n;
        if (rebuild()) { /* came down: nothing to draw */ }
        else if (added && singles(sb)) director.onGameRecorded(); // a doubles game starts no countdown
        else director.onConfig(); // the set may have just been won: an "auto" reading follows it
      }
      if (keys.includes("statsConfig")) director.onConfig();
    } catch (err) {
      console.error(`[set-stats] ${err?.stack ?? err}`);
    }
  }

  function onSetClosing() {
    try {
      const d = store.setStats();
      const ids = new Set();
      for (const mode of ["game", "set"]) for (const x of d?.insights?.[mode] ?? []) if (x.kind === "accolade") ids.add(x.id.replace(/^acc-|-\d$/g, ""));
      if (!ids.size) return;
      pastSets.unshift(ids);
      pastSets.length = Math.min(pastSets.length, RECENT_SETS);
      recent = new Map();
      for (const set of pastSets) for (const id of set) recent.set(id, (recent.get(id) || 0) + 1);
    } catch { /* a memory, not a feature: losing it costs variety only */ }
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
      store.on("set-closing", onSetClosing);
      rebuild();
      const ids = portraits.packs().map((p) => p.id);
      console.log(`[set-stats] Portraits: ${ids.length ? ids.join(", ") : "none downloaded (the dock's Setup tab → Art packs)"}`);
    },
    stop() {
      store.off("change", onChange);
      store.off("set-loaded", onSetLoaded);
      store.off("set-closing", onSetClosing);
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
