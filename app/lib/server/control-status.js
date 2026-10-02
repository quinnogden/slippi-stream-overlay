/**
 * The dock's status snapshot (health, the report/start buttons, the port map,
 * the clipper), rebuilt on a 2s tick and on demand.
 *
 * Everything is local: the Current Set card and the tournament come from the
 * scoreboard store, start.gg's health dot from the event service's last read.
 * Nothing here makes a network call, so a rebuild can't stall on one.
 *
 * A rebuild is sent only when it differs from the last one sent, or 5s have
 * passed — the heartbeat that lets the dock tell a quiet app from a dead one.
 * The scoreboard itself reaches the dock as state patches, not through here.
 */

const HEARTBEAT_MS = 5000;

const { evaluateReportability } = require("./report-set");
const { evaluateStartability }  = require("./start-set");

/** The Current Set card before anything is known about the loaded set. */
const emptyCurrentSet = (reason) => ({ setId: null, canReport: false, reason, canStart: false });

/**
 * @param {object} ctx
 * @param {() => object} portInfo — modes.portInfo: the port map and the
 *   heuristic that chose it, with each port's player name
 */
function createControlStatus(ctx, portInfo) {
  const { store, event, startgg, clipperSettings, obs, io, state } = ctx;

  /** The clipper block — also served on its own by GET /api/clipper. */
  function clipperSnapshot() {
    return {
      settings: clipperSettings.get(),
      obs: obs.getStatus(),
      recentClips: state.recentClips,
      clipsThisGame: state.clipsThisGame,
    };
  }

  /**
   * The whole control_status object. The one place its shape is written, so the
   * startup seed and the 2s rebuild can't disagree about which fields exist.
   */
  function compose({ currentSet }) {
    const src = state.source?.getStatus?.() ?? { connected: false };
    const ev = event?.status() ?? { state: "none", error: null };
    const t = store.tournament();
    return {
      // Up once an event read has succeeded; an error carries start.gg's wording.
      startgg: { ok: ev.state === "ok", state: ev.state, error: ev.error ?? null },
      slippi: Boolean(src.connected),
      slippiDetail: src,
      portMapping: portInfo(),
      currentSet,
      tournament: { name: t.name, eventName: t.eventName },
      startggEnabled: startgg.enabled,
      clipper: clipperSnapshot(),
      ts: Date.now(),
    };
  }

  // Seeded so a dock that connects before the first tick still gets every field.
  state.lastControlStatus = compose({ currentSet: emptyCurrentSet("starting up") });

  /** Whether the dock's Report and Start apply to the loaded set. */
  function currentSetCard() {
    const { setId } = store.scoreboard();
    const { canReport, reason } = evaluateReportability(ctx, setId);
    // Synchronous by contract — it reads a cache and schedules its own lookup
    // in the background, so the tick never waits on start.gg.
    const { canStart } = evaluateStartability(ctx, setId);
    return { setId, canReport, reason, canStart };
  }

  let sentJson = null;
  let sentAt = 0;

  /** Rebuild lastControlStatus; broadcast it if it changed or the heartbeat is due. */
  async function build() {
    const status = compose({ currentSet: currentSetCard() });
    state.lastControlStatus = status;
    const { ts, ...body } = status;
    const json = JSON.stringify(body);
    if (json !== sentJson || ts - sentAt >= HEARTBEAT_MS) {
      sentJson = json;
      sentAt = ts;
      io.emit("control_status", status);
    }
    return status;
  }

  // Many call sites ask for a refresh — several of them in a burst when the
  // operator clicks around. Concurrent callers share one in-flight rebuild.
  let inFlight = null;

  /**
   * Rebuild and broadcast. Never rejects — every caller is fire-and-forget, so a
   * failed rebuild resolves to the last good status instead.
   * @returns {Promise<object>}
   */
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = build()
      .catch((e) => {
        console.warn(`[status] Refresh failed: ${e.message}`);
        return state.lastControlStatus;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { refresh, clipperSnapshot };
}

module.exports = { createControlStatus, HEARTBEAT_MS };
