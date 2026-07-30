/**
 * start.gg result reporting.
 *
 * Manual-trigger only — the control panel two-step-confirms before POSTing.
 * Singles and doubles; crew battles are excluded (no set to report against).
 */

/**
 * Determine whether the current set can be reported, and why not if it can't.
 * Shared with the control-status loop, which surfaces `reason` in the panel.
 *
 * @param {object} deps — { startgg, tsh }
 * @param {object} state — TSH program state
 * @param {string|number|null} setId
 */
function evaluateReportability({ startgg, tsh }, state, setId) {
  if (!startgg.enabled)                  return { canReport: false, reason: "start.gg token not configured" };
  if (tsh.isCrewBattle(state))           return { canReport: false, reason: "Crew battles can't be reported" };
  if (setId == null)                     return { canReport: false, reason: "No start.gg set loaded (manual/exhibition)" };
  if (String(setId).includes("preview")) return { canReport: false, reason: "Set hasn't started on start.gg yet" };
  return { canReport: true, reason: null };
}

/**
 * Map a TSH column number to its start.gg entrant slot.
 *
 * getSetEntrants() keys entrants by start.gg's own slot order (slot 0 → 1), and
 * TSH's provider fills column 1 from that same slot 0 — but only while the sides
 * aren't swapped. TSH's Swap Teams moves each team to the other column and keeps
 * that orientation for every set loaded afterwards (`scoreContainers.reverse()`
 * in TSHScoreboardWidget), so while swapped, column 1 holds slot 2's entrant.
 * Ignoring the flag reports the loser as the winner.
 *
 * @param {number} tshTeam — 1 or 2, a scoreboard column
 * @param {boolean} swapped — TSH's teamsSwapped flag
 * @returns {number} start.gg entrant slot, 1 or 2
 */
function entrantSlot(tshTeam, swapped) {
  if (!swapped) return tshTeam;
  return tshTeam === 1 ? 2 : 1;
}

function createReportSet(ctx, refreshControlStatus) {
  const { tsh, startgg, state } = ctx;

  /**
   * Translate the accumulated per-game winners into BracketSetGameDataInput[].
   * Returns undefined when the log is empty or inconsistent with the final score,
   * so the report falls back to set winner + score only.
   * @param {object} entrants — slot-keyed entrants from getSetEntrants()
   * @param {boolean} swapped — TSH's teamsSwapped flag
   */
  function buildGameData(entrants, swapped) {
    if (!entrants[1] || !entrants[2] || state.currentSetGames.length === 0) return undefined;
    return state.currentSetGames.map((g) => ({
      gameNum:  g.gameNum,
      winnerId: entrants[entrantSlot(g.winnerTeam, swapped)]?.id,
    }));
  }

  /**
   * Report the currently-loaded set to start.gg using the live score as the result.
   * @returns {Promise<{ ok: boolean, winnerName?: string, score?: string, error?: string }>}
   */
  async function reportCurrentSet() {
    let tshState;
    try { tshState = tsh.readState(); }
    catch { return { ok: false, error: "Cannot read TSH state" }; }

    const setId = tsh.getSetId(tshState);
    const { canReport, reason } = evaluateReportability(ctx, tshState, setId);
    if (!canReport) return { ok: false, error: reason };

    const scores = tsh.getLiveScores(tshState);
    if (scores.team1 === scores.team2) {
      return { ok: false, error: `Score is tied ${scores.team1}-${scores.team2}; play out a winner first` };
    }
    const winnerTeam = scores.team1 > scores.team2 ? 1 : 2;

    // Which start.gg entrant a column holds depends on TSH's swap state, so read
    // it fresh and authoritatively rather than trusting the 2s poll. Guessing
    // wrong publishes the loser as the winner to a live bracket, so a swap state
    // that can't be established at all is a refusal, not a default.
    const swap = await tsh.getSwapState();
    const swapped = swap.ok ? swap.data : state.tshSwapped;
    if (swapped == null) {
      return { ok: false, error: "Can't read TSH's swap state — reporting could pick the wrong entrant" };
    }

    const ent = await startgg.getSetEntrants(setId);
    if (!ent.ok) return { ok: false, error: ent.error };
    const winner = ent.entrants[entrantSlot(winnerTeam, swapped)];
    if (!winner) return { ok: false, error: "Could not resolve the winning team's start.gg entrant" };

    const result = await startgg.reportSet(setId, winner.id, buildGameData(ent.entrants, swapped));
    if (result.ok) {
      // Refresh so the panel reflects the reported state on its next tick.
      refreshControlStatus().catch(() => {});
      return { ok: true, winnerName: winner.name, score: `${scores.team1}-${scores.team2}` };
    }
    return result;
  }

  return { reportCurrentSet };
}

module.exports = { createReportSet, evaluateReportability, entrantSlot };
