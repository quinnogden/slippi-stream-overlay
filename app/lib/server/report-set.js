/**
 * start.gg result reporting.
 *
 * Manual-trigger only — the control panel two-step-confirms before POSTing.
 *
 * Everything comes from the scoreboard store. Each side carries its start.gg
 * entrant id and moves with Switch Sides, and the per-game list is the score,
 * so the old hazards — TSH's swapped columns inverting the entrant slot, a
 * per-game log disagreeing with the scoreboard — no longer have anywhere to
 * live. There is no entrant lookup and no swap read before a report.
 */

const { startggSetGate } = require("./set-gate");

/**
 * Determine whether the current set can be reported, and why not if it can't.
 * Shared with the control-status loop, which surfaces `reason` in the panel.
 *
 * @param {object} deps — { startgg }
 * @param {string|number|null} setId
 */
function evaluateReportability({ startgg }, setId) {
  const reason = startggSetGate(startgg, setId);
  return { canReport: reason === null, reason };
}

/**
 * The store's game list as start.gg BracketSetGameDataInput[]. Winners only —
 * no stages or characters (decision #13).
 * @param {{ sides: Array<{ entrantId: string }>, games: Array<{ winnerSide: 0|1 }> }} r — store.reportable()
 */
function gameDataOf(r) {
  if (!r.games.length || r.sides.some((s) => !s.entrantId)) return undefined;
  return r.games.map((g, i) => ({ gameNum: i + 1, winnerId: r.sides[g.winnerSide].entrantId }));
}

function createReportSet(ctx, refreshControlStatus) {
  const { store, startgg } = ctx;

  /**
   * Report the loaded set to start.gg with the scoreboard's result.
   * @returns {Promise<{ ok: boolean, winnerName?: string, score?: string, error?: string }>}
   */
  async function reportCurrentSet() {
    const { setId } = store.scoreboard();
    const { canReport, reason } = evaluateReportability(ctx, setId);
    if (!canReport) return { ok: false, error: reason };

    const r = store.reportable();
    if (!r.ok) return { ok: false, error: r.reason };

    const result = await startgg.reportSet(r.setId, r.winnerEntrantId, gameDataOf(r));
    if (!result.ok) return result;

    // Refresh so the panel reflects the reported state on its next tick.
    refreshControlStatus();
    const w = r.sides[r.winnerSide];
    const winnerName = w.teamName || w.players.map((p) => p.tag).filter(Boolean).join(" / ");
    return { ok: true, winnerName, score: `${r.sides[0].score}-${r.sides[1].score}` };
  }

  /**
   * Report the loaded set as a DQ: `winnerSide` advances, the other side was
   * disqualified. No game data — a DQ has no games. Same gate as a report;
   * the score on the scoreboard doesn't matter.
   * @param {0|1} winnerSide
   * @returns {Promise<{ ok: boolean, winnerName?: string, error?: string }>}
   */
  async function reportDq(winnerSide) {
    if (winnerSide !== 0 && winnerSide !== 1) return { ok: false, error: "winnerSide must be 0 or 1" };
    const sb = store.scoreboard();
    const { canReport, reason } = evaluateReportability(ctx, sb.setId);
    if (!canReport) return { ok: false, error: reason };
    if (sb.crew) return { ok: false, error: "A crew battle isn't a start.gg set" };
    const w = sb.sides[winnerSide];
    if (!w.entrantId || !sb.sides[1 - winnerSide].entrantId) return { ok: false, error: "Both sides need their start.gg entrant — reload the set from Up next" };

    const result = await startgg.reportSet(sb.setId, w.entrantId, undefined, { isDQ: true });
    if (!result.ok) return result;
    refreshControlStatus();
    const winnerName = w.teamName || w.players.map((p) => p.tag).filter(Boolean).join(" / ");
    return { ok: true, winnerName };
  }

  return { reportCurrentSet, reportDq };
}

module.exports = { createReportSet, evaluateReportability, gameDataOf };
