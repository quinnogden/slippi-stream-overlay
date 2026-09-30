/**
 * The control panel's status snapshot, rebuilt on a 2s tick and on demand.
 *
 * Also where a TSH-side "Swap Teams" is noticed: the swap probe is already part
 * of the tick, so reacting to it here costs nothing extra.
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

/**
 * @param {object} ctx
 * @param {Function} reresolvePorts — modes.reresolvePorts, the ↻ Re-detect Players
 *   path. Passed in rather than late-bound: createModes(ctx) needs nothing this
 *   file builds, so index.js constructs it first and the wiring stays a DAG.
 */
function createControlStatus(ctx, reresolvePorts) {
  const { config, tsh, portMapper, startgg, clipperSettings, obs, io, state } = ctx;

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
  function compose({ tshUp, currentSet, tournament }) {
    const src = state.source?.getStatus?.() ?? { connected: false };
    return {
      tsh: tshUp,
      slippi: Boolean(src.connected),
      slippiDetail: src,
      portMapping: portMapper.getResolutionInfo(),
      tshSwapped: state.tshSwapped,
      currentSet,
      tournament,
      shortLink: config.BRACKETS?.shortLink ?? "",
      startggEnabled: startgg.enabled,
      clipper: clipperSnapshot(),
      ts: Date.now(),
    };
  }

  // Seeded so a panel that connects before the first tick still gets every field.
  state.lastControlStatus = compose({
    tshUp: false,
    currentSet: emptyCurrentSet("starting up"),
    tournament: { name: "", eventName: "" },
  });

  /**
   * React to the scoreboard's sides being swapped in TSH.
   *
   * The bridge's own swapTeams() never calls TSH's swap endpoint (it only flips
   * the internal port→team map), so a change in the flag always means the
   * scoreboard's sides actually moved — whether the operator pressed TSH's button
   * or the control panel's Switch Sides. The reaction is the same either way, so
   * no origin bookkeeping is needed.
   *
   * **The reaction is a full re-detect, not a name match.** Name matching only
   * carries the bridge's *previous* belief across the columns: `_portToName` says
   * which TSH name sat in each port's column, so following those names to their
   * new columns reproduces whatever mapping was already there — including a wrong
   * one, which is usually why the sides were being switched. Worse, at 0-0
   * resolve() hits its new-set reset and throws the port→name map away entirely,
   * leaving a bare positional guess with no names in the panel at all. Re-running
   * the game-start path instead re-derives from TSH's characters, re-binds the
   * names TSH shows now, and re-pushes the characters so the columns stop showing
   * crossed icons.
   *
   * @param {object} tshState — freshly read program_state.json
   */
  function handleTshSwap(tshState) {
    // Already-logged games are stored as TSH column numbers, and those columns
    // just changed hands. TSH moves its own scores and game tracker across; the
    // per-game log has to move with them or a mid-set swap would report game 1 to
    // the wrong entrant. True regardless of how the mapping is re-derived below.
    for (const g of state.currentSetGames) {
      g.winnerTeam = g.winnerTeam === 1 ? 2 : 1;
    }

    const redone = reresolvePorts("Scoreboard sides switched", tshState);
    if (redone.ok) {
      console.log(`[bridge] Re-detected ports after swap (${redone.method}): ${redone.summary}`);
      return;
    }

    // The re-detect only declines between games (it is handed the state, so it
    // can't fail to read it), and then there is nothing live to re-push or
    // re-emit. Follow the names across instead: it keeps the mapping meaningful
    // for the next game start, which is the only thing that can use it now.
    console.log(`[bridge] Swap re-detect declined (${redone.error}); matching names instead`);
    const { t1, t2 } = tsh.getTeamInfos(tshState);
    portMapper.resolve(t1, t2);
  }

  /**
   * Is TSH's web server up?
   *
   * getSwapState() is a real HTTP round-trip whose success already proves it, so
   * the tick doesn't also need ping(). ping() stays as the fallback: /get-swap is
   * a 5.972 endpoint, and an older TSH would otherwise read as permanently down.
   *
   * @returns {Promise<{ up: boolean, swap: { ok: boolean, data?: boolean } }>}
   */
  async function probeTsh() {
    const swap = await tsh.getSwapState();
    if (swap.ok) return { up: true, swap };
    return { up: await tsh.ping(), swap };
  }

  /** Rebuild lastControlStatus from live TSH + Slippi state and broadcast it. */
  async function build() {
    const { up: tshUp, swap } = await probeTsh();

    let currentSet = emptyCurrentSet(tshUp ? null : "TSH not reachable");
    // What TSH's provider actually loaded. Filled from the state read below, so
    // surfacing it costs the tick no extra round-trip.
    let tournament = { name: "", eventName: "" };

    if (tshUp) {
      const read = tsh.tryReadState();
      if (!read.ok) {
        currentSet = emptyCurrentSet("TSH state unreadable");
      } else {
        const tshState = read.state;
        const setId    = tsh.getSetId(tshState);
        const { t1, t2 } = tsh.getTeamInfos(tshState);
        const { canReport, reason } = evaluateReportability(ctx, setId);
        // Synchronous by contract — it reads a cache and schedules its own
        // lookup in the background, so the tick never waits on start.gg.
        const startable = evaluateStartability(ctx, setId);
        currentSet = {
          setId,
          scores: { team1: t1.score, team2: t2.score },
          teamNames: { team1: t1.name, team2: t2.name },
          canReport,
          reason,
          canStart: startable.canStart,
          startReason: startable.reason,
        };
        tournament = tsh.getTournamentInfo(tshState);

        if (swap.ok) {
          if (state.tshSwapped !== null && swap.data !== state.tshSwapped) {
            console.log(`[bridge] TSH Swap Teams detected (swapped=${swap.data})`);
            // Isolated so a re-derive failure can't take the whole tick down.
            try {
              handleTshSwap(tshState);
            } catch (e) {
              console.warn(`[bridge] Swap re-derive failed: ${e.message}`);
            }
          }
          state.tshSwapped = swap.data;
        }
      }
    }

    state.lastControlStatus = compose({ tshUp, currentSet, tournament });
    io.emit("control_status", state.lastControlStatus);
    return state.lastControlStatus;
  }

  // Many call sites ask for a refresh — several of them in a burst when the
  // operator clicks through the panel. Without this, each click multiplies the
  // TSH round-trips; with it, concurrent callers share one in-flight rebuild.
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

  return { refresh, handleTshSwap, clipperSnapshot };
}

module.exports = { createControlStatus, emptyCurrentSet };
