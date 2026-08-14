/**
 * The control panel's status snapshot, rebuilt on a 2s tick and on demand.
 *
 * Also where a TSH-side "Swap Teams" is noticed: the swap probe is already part
 * of the tick, so reacting to it here costs nothing extra.
 */

const { evaluateReportability } = require("./report-set");
const { evaluateStartability }  = require("./start-set");

function createControlStatus(ctx) {
  const { config, tsh, portMapper, startgg, clipperSettings, obs, io, state } = ctx;

  state.lastControlStatus = {
    tsh: false,
    slippi: false,
    slippiDetail: { connected: false },
    portMapping: { method: "positional", ports: [] },
    tshSwapped: null,
    currentSet: {
      setId: null,
      scores: { team1: 0, team2: 0 },
      teamNames: { team1: "", team2: "" },
      canReport: false,
      reason: "starting up",
      canStart: false,
      startReason: "starting up",
    },
    tournament: { name: "", eventName: "" },
    shortLink: config.BRACKETS?.shortLink ?? "",
    startggEnabled: startgg.enabled,
    clipper: {
      settings: clipperSettings.get(),
      obs: obs.getStatus(),
      recentClips: [],
      clipsThisGame: 0,
    },
    ts: 0,
  };

  /**
   * React to the scoreboard's sides being swapped in TSH.
   *
   * TSH swaps names *and* scores, so re-running the name-based resolve against
   * fresh state re-derives the correct mapping right away rather than waiting for
   * the next game start.
   *
   * The bridge's own swapTeams() never calls TSH's swap endpoint (it only flips
   * the internal port→team map), so a change in the flag always means the
   * scoreboard's sides actually moved — whether the operator pressed TSH's button
   * or the control panel's Switch Sides. The reaction is the same either way, so
   * no origin bookkeeping is needed.
   *
   * @param {object} tshState — freshly read program_state.json
   */
  function handleTshSwap(tshState) {
    const { t1, t2 } = tsh.getTeamInfos(tshState);
    portMapper.resolve(t1, t2);

    // Already-logged games are stored as TSH column numbers, and those columns
    // just changed hands. TSH moves its own scores and game tracker across; the
    // per-game log has to move with them or a mid-set swap would report game 1 to
    // the wrong entrant.
    for (const g of state.currentSetGames) {
      g.winnerTeam = g.winnerTeam === 1 ? 2 : 1;
    }

    if (!state.currentGameState?.players) return;

    for (const p of Object.values(state.currentGameState.players)) {
      p.teamNum = portMapper.getTeam(p.playerIndex, p.teamNum);
    }
    io.emit("slippi_game_start", state.currentGameState);
    console.log("[bridge] Re-derived port mapping after TSH-side swap");
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

    let currentSet = {
      setId: null,
      scores: { team1: 0, team2: 0 },
      teamNames: { team1: "", team2: "" },
      canReport: false,
      reason: tshUp ? null : "TSH not reachable",
      canStart: false,
      startReason: tshUp ? null : "TSH not reachable",
    };
    // What TSH's provider actually loaded. Filled from the state read below, so
    // surfacing it costs the tick no extra round-trip.
    let tournament = { name: "", eventName: "" };

    if (tshUp) {
      try {
        const tshState = tsh.readState();
        const setId    = tsh.getSetId(tshState);
        const { t1, t2 } = tsh.getTeamInfos(tshState);
        const { canReport, reason } = evaluateReportability(ctx, setId);
        // Synchronous by contract — it reads a cache and schedules its own
        // lookup in the background, so the tick never waits on start.gg.
        const startable = evaluateStartability(ctx, setId);
        currentSet = {
          setId,
          scores: tsh.getLiveScores(tshState),
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
            // Isolated so a re-derive failure can't be reported as unreadable state.
            try {
              handleTshSwap(tshState);
            } catch (e) {
              console.warn(`[bridge] Swap re-derive failed: ${e.message}`);
            }
          }
          state.tshSwapped = swap.data;
        }
      } catch {
        currentSet.reason = "TSH state unreadable";
        currentSet.startReason = "TSH state unreadable";
      }
    }

    const src = state.source?.getStatus?.() ?? { connected: false };
    state.lastControlStatus = {
      tsh: tshUp,
      slippi: Boolean(src.connected),
      slippiDetail: src,
      portMapping: portMapper.getResolutionInfo(),
      tshSwapped: state.tshSwapped,
      currentSet,
      tournament,
      shortLink: config.BRACKETS?.shortLink ?? "",
      startggEnabled: startgg.enabled,
      clipper: {
        settings: clipperSettings.get(),
        obs: obs.getStatus(),
        recentClips: state.recentClips,
        clipsThisGame: state.clipsThisGame,
      },
      ts: Date.now(),
    };
    io.emit("control_status", state.lastControlStatus);
    return state.lastControlStatus;
  }

  // Eight call sites ask for a refresh — several of them in a burst when the
  // operator clicks through the panel. Without this, each click multiplies the
  // TSH round-trips; with it, concurrent callers share one in-flight rebuild.
  let inFlight = null;

  function refresh() {
    if (inFlight) return inFlight;
    inFlight = build().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { refresh, handleTshSwap };
}

module.exports = { createControlStatus };
