/**
 * The control panel's status snapshot, rebuilt on a 2s tick and on demand.
 *
 * Everything is local: the Current Set card and the tournament come from the
 * scoreboard store, start.gg's health dot from the event service's last read.
 * Nothing here makes a network call, so a rebuild can't stall on one.
 */

const { evaluateReportability } = require("./report-set");
const { evaluateStartability }  = require("./start-set");

/**
 * The Current Set card before anything is known about the loaded set.
 * @param {string|null} reason — shown in place of both buttons' hints
 */
function emptyCurrentSet(reason) {
  return {
    setId: null,
    scores: { team1: 0, team2: 0 },
    teamNames: { team1: "", team2: "" },
    canReport: false,
    reason,
    canStart: false,
    startReason: reason,
  };
}

const sideName = (side) => {
  const tags = (side?.players ?? []).map((p) => [p.prefix, p.tag].filter(Boolean).join(" ")).filter(Boolean);
  return side?.teamName || tags.join(" / ");
};

/**
 * @param {object} ctx
 * @param {() => object} portInfo — modes.portInfo: the port map and the
 *   heuristic that chose it, with each port's player name
 */
function createControlStatus(ctx, portInfo) {
  const { config, store, event, startgg, clipperSettings, obs, io, state } = ctx;

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
      shortLink: config.BRACKETS?.shortLink ?? "",
      startggEnabled: startgg.enabled,
      clipper: clipperSnapshot(),
      ts: Date.now(),
    };
  }

  // Seeded so a panel that connects before the first tick still gets every field.
  state.lastControlStatus = compose({ currentSet: emptyCurrentSet("starting up") });

  /** The Current Set card, from the store. */
  function currentSetCard() {
    const sb = store.scoreboard();
    const { canReport, reason } = evaluateReportability(ctx, sb.setId);
    // Synchronous by contract — it reads a cache and schedules its own lookup
    // in the background, so the tick never waits on start.gg.
    const startable = evaluateStartability(ctx, sb.setId);
    return {
      setId: sb.setId,
      scores: { team1: sb.sides[0].score, team2: sb.sides[1].score },
      teamNames: { team1: sideName(sb.sides[0]), team2: sideName(sb.sides[1]) },
      canReport,
      reason,
      canStart: startable.canStart,
      startReason: startable.reason,
    };
  }

  /** Rebuild lastControlStatus and broadcast it. */
  async function build() {
    state.lastControlStatus = compose({ currentSet: currentSetCard() });
    io.emit("control_status", state.lastControlStatus);
    return state.lastControlStatus;
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
        console.warn(`[bridge] Status refresh failed: ${e.message}`);
        return state.lastControlStatus;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { refresh, clipperSnapshot };
}

module.exports = { createControlStatus, emptyCurrentSet };
