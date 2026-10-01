/**
 * The side panel's player stats, fetched by the bridge instead of by TSH.
 *
 * TSH's own stats are what used to feed the side panel, and its head-to-head
 * was wrong in ways that changed from set to set: start.gg refused most of its
 * requests for being too large, and it read each refusal as "no sets"; it
 * discarded half its own results; and it only looked at events on a player's
 * user account. See docs/BRIDGE-API.md (`player_stats`) for what the layout
 * receives, and queries.js / set-history.js for how each problem is avoided.
 *
 * Driven by the scoreboard store: a change to the pair on the scoreboard (or to
 * the loaded event) is acted on at once. Loading a set is one store command, so
 * there is no half-loaded pair to wait out — TSH wrote a set load as several
 * separate writes, the first pairing the new player 1 with the old player 2.
 *
 * The loaded event's finished sets come from the event service's own reads
 * (every set of every phase group, refreshed every 90s and after a report),
 * so they cost no request of their own and need no token. Players in the
 * event's next playable sets are pre-fetched while idle (the event service
 * lists them), so a first-timer's history is usually saved before their set
 * is on air.
 *
 * Emits `player_stats` on every change and to each new connection. Without a
 * start.gg token `enabled` is false: no player cards or head-to-head, but the
 * finished sets still come through.
 */

const path = require("path");
const { SetHistoryStore } = require("./set-history");
const { setDetailsQuery, playerCardsQuery } = require("./queries");
const N = require("./normalize");

const COMPLETED_SHOWN  = 12;
const HISTORY_FRESH_MS = 120000; // a pair reloaded within this skips the top-up
const RETRY_MS         = 60000;
const REPORT_DELAY_MS  = 4000;   // start.gg takes a moment to reflect a report
const H2H_PILLS        = 5;
const PREWARM_SETS     = 3;      // how many playable sets' players to pre-fetch

/**
 * @param {object} ctx — { store, event, startgg, io } (event: lib/event/event-service.js)
 * @param {{ cacheDir?: string|null, log?: Function }} [opts]
 */
function createPlayerStats(ctx, opts = {}) {
  const { store: scoreboard, event: eventService, startgg, io } = ctx;
  const log = opts.log ?? ((m) => console.log(`[stats] ${m}`));
  const cacheDir = opts.cacheDir === undefined
    ? path.join(__dirname, "..", "..", "stats-cache")
    : opts.cacheDir;
  const store = new SetHistoryStore(startgg, cacheDir, { log });

  let snap = {
    enabled: startgg.enabled,
    event: null,
    players: {},
    h2h: null,
    completedSets: { state: "none", sets: [] },
    updatedAt: Date.now(),
  };

  // The pair the scoreboard shows, and what has been done about it.
  let loadedKey = null;
  let forceSync = false;
  let gen = 0;          // bumps on every pair load; stale async work checks it
  let busy = false;     // a pair load is running — prewarm waits
  let retryTimer = null;

  let eventSlug = null;
  let queued = [];      // player ids waiting to be pre-fetched

  const details = new Map(); // set id → detail node; finished sets don't change

  function emit() {
    snap.updatedAt = Date.now();
    io.emit("player_stats", snap);
  }

  const START_GG_ID = /^[1-9]\d*$/;

  /** What the scoreboard shows: the singles pair (if any) and the loaded event. */
  function readTarget() {
    const sb = scoreboard.scoreboard();
    const players = sb.isDoubles
      ? []
      : sb.sides.map((side) => side.players[0])
        .filter((p) => START_GG_ID.test(String(p?.playerId ?? "")))
        .map((p) => ({ playerId: String(p.playerId), name: p.tag }));
    return { players, slug: scoreboard.tournament().eventSlug || null };
  }

  // Sorted, so switching sides isn't a new pair.
  const pairKey = (t) => t.players.map((p) => p.playerId).sort().join("|");

  function evaluate() {
    const t = readTarget();

    eventSlug = t.slug;

    const key = pairKey(t);
    if (key === loadedKey) return;
    loadedKey = key;
    loadPair(t);
  }

  // ── The loaded pair ────────────────────────────────────────────────────────

  async function loadPair(t) {
    const my = ++gen;
    clearTimeout(retryTimer);
    const force = forceSync;
    forceSync = false;
    busy = true;

    const pids = t.players.map((p) => p.playerId);
    const samePair = snap.h2h && pids.length === 2 && pids.every((p) => snap.h2h.players.includes(p));

    // A new pair hides its panels until they're right. A refresh of the same
    // pair (after a report) keeps showing the old numbers until the new land.
    if (!samePair) {
      snap.players = Object.fromEntries(t.players.map((p) => [p.playerId, {
        playerId: p.playerId, name: p.name, state: "loading", history: [], run: [],
      }]));
      snap.h2h = pids.length === 2 ? { players: pids, state: "loading", wins: {}, total: 0, recent: [] } : null;
      emit();
    }

    try {
      if (pids.length > 0) await loadCards(my, t);
      if (pids.length === 2) await loadH2h(my, t, force);
    } finally {
      if (my === gen) busy = false;
    }
    if (my === gen) prewarm();
  }

  async function loadCards(my, t) {
    const pids = t.players.map((p) => p.playerId);
    const res = await startgg.backgroundQuery(playerCardsQuery(pids, eventSlug));
    if (my !== gen) return;

    if (!res.ok) {
      log(`player cards failed: ${res.error}`);
      for (const p of t.players) {
        snap.players[p.playerId] = { ...(snap.players[p.playerId] ?? { history: [], run: [] }),
          playerId: p.playerId, name: p.name, state: "error", error: res.error };
      }
      emit();
      return;
    }

    const ev = res.data?.ev;
    // A run only means something in a singles event; the scoreboard can hold a
    // singles pair while the loaded event is doubles.
    const runNodes = ev && ev.type === 1 ? ev.sets?.nodes ?? [] : [];
    t.players.forEach((p, i) => {
      snap.players[p.playerId] = {
        playerId: p.playerId,
        name: p.name,
        state: "done",
        history: N.historyFromStandings(res.data?.[`p${i}`]?.recentStandings, ev?.id),
        run: N.runFromEventSets(runNodes, p.playerId),
      };
    });
    emit();
  }

  async function loadH2h(my, t, force) {
    const [a, b] = t.players;
    const label = `${a.name || a.playerId} vs ${b.name || b.playerId}`;
    const maxAgeMs = force ? 0 : HISTORY_FRESH_MS;

    if (!store.has(a.playerId) || !store.has(b.playerId)) {
      log(`H2H ${label}: fetching start.gg history (first time for at least one player — can take a minute)`);
    }
    // Sequential: they share one rate budget, and the first answer is useless alone.
    const ra = await store.sync(a.playerId, { maxAgeMs });
    const rb = ra.ok ? await store.sync(b.playerId, { maxAgeMs }) : ra;
    if (my !== gen) return;

    if (!ra.ok || !rb.ok) {
      const error = (ra.ok ? rb : ra).error;
      log(`H2H ${label} failed: ${error} — retrying in ${RETRY_MS / 1000}s`);
      snap.h2h = { players: [a.playerId, b.playerId], state: "error", error, wins: {}, total: 0, recent: [] };
      emit();
      // Retry by forgetting the pair was loaded and looking again.
      retryTimer = setTimeout(() => { if (my === gen) { loadedKey = null; evaluate(); } }, RETRY_MS);
      return;
    }

    const h2h = N.headToHead(ra.sets, rb.sets, a.playerId, b.playerId);
    const recent = await pillsFor(h2h.sets.slice(0, H2H_PILLS));
    if (my !== gen) return;

    snap.h2h = {
      players: [a.playerId, b.playerId],
      state: "done",
      wins: h2h.wins,
      total: h2h.sets.length,
      recent,
    };
    log(`H2H ${label}: ${h2h.wins[a.playerId]}-${h2h.wins[b.playerId]} over ${h2h.sets.length} set(s)`);
    emit();
  }

  /** Round, scores and tournament for the few sets the panel draws. */
  async function pillsFor(sets) {
    const missing = sets.filter((s) => !details.has(s.id)).map((s) => s.id);
    if (missing.length) {
      const res = await startgg.backgroundQuery(setDetailsQuery(missing));
      if (res.ok) missing.forEach((id, i) => { if (res.data?.[`s${i}`]) details.set(id, res.data[`s${i}`]); });
      else log(`set details failed (${res.error}) — pills show without rounds/scores`);
    }
    return sets.map((s) => N.h2hPill(details.get(s.id), s));
  }

  // ── The loaded event ───────────────────────────────────────────────────────

  /** The event service read (or lost) the event: its finished sets, and who's next. */
  function onEvent() {
    const info = eventService?.eventInfo() ?? null;
    const status = eventService?.status().state;
    const next = {
      event: info && { id: info.id, slug: info.slug, name: info.name, singles: info.singles },
      completedSets: !info ? { state: "none", sets: [] }
        : status === "error" && snap.completedSets.state !== "done" ? { state: "error", sets: [] }
        : { state: "done", sets: N.completedFromEventSets(eventService.rawSets()).slice(0, COMPLETED_SHOWN) },
    };
    if (JSON.stringify(next) !== JSON.stringify({ event: snap.event, completedSets: snap.completedSets })) {
      Object.assign(snap, next);
      emit();
    }
    if (startgg.enabled) queuePlayable();
  }

  /** The players in the next playable sets, from the event service. */
  function queuePlayable() {
    queued = eventService?.playablePlayerIds(PREWARM_SETS) ?? [];
    prewarm();
  }

  /**
   * Crawl upcoming players' histories while nothing else needs the budget, so
   * a first-timer's head-to-head is ready before their set goes on air. One
   * player at a time, and only players with no saved history at all.
   */
  let prewarming = false;
  async function prewarm() {
    if (prewarming) return;
    prewarming = true;
    try {
      while (!busy && queued.length) {
        const pid = queued.shift();
        if (store.has(pid)) continue;
        await store.sync(pid);
      }
    } finally {
      prewarming = false;
    }
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  const onStoreChange = ({ keys }) => {
    if (keys.includes("scoreboard") || keys.includes("tournament")) evaluate();
  };

  return {
    start() {
      eventService?.on("change", onEvent);
      onEvent();
      if (!startgg.enabled) return; // the snapshot already says enabled: false
      scoreboard.on("change", onStoreChange);
      evaluate();
    },

    stop() {
      scoreboard.off("change", onStoreChange);
      eventService?.off("change", onEvent);
      clearTimeout(retryTimer);
    },

    /** The current snapshot, for a new socket and GET /api/player-stats. */
    snapshot: () => snap,

    /**
     * A set was reported: the pair's run and their head-to-head just changed.
     * Reload after start.gg has caught up. (The event's finished sets follow
     * the event service's own re-read.)
     */
    onSetReported() {
      if (!startgg.enabled) return;
      setTimeout(() => {
        forceSync = true;
        loadedKey = null;
        evaluate();
      }, REPORT_DELAY_MS);
    },
  };
}

module.exports = { createPlayerStats };
