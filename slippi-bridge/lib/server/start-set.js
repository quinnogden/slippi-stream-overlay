/**
 * "Start set" — mark the loaded set in progress on start.gg.
 *
 * The TO calls a set, loads it onto the scoreboard, and it stays "not started"
 * on the bracket until someone opens start.gg and presses Start. This puts that
 * press in the dock, on the card that already shows which set is loaded.
 *
 * Manual-trigger only. It is not derived from the first game starting, because
 * a handwarmer, a restart or a mis-loaded set would each mark the wrong set —
 * and the operator is looking at this card when they load the set anyway.
 */

// start.gg set states. 1 = created, 6 = called to station: both mean "hasn't
// started", which is exactly when the button applies. 2 = in progress, 3 = done.
const NOT_STARTED = new Set([1, 6]);

/**
 * The last state we fetched, keyed by set id.
 *
 * Module-level for the same reason as bracket-switch's inFlight: one bridge per
 * process, and threading a two-field cache through ctx buys nothing. Keying on
 * the set id is what makes it self-invalidating — loading another set simply
 * misses, and the miss is what schedules the next fetch.
 *
 * @type {{ setId: string|null, state: number|null, error: string|null, pending: boolean }}
 */
let cache = { setId: null, state: null, error: null, pending: false };

/**
 * Fetch the set's state once, in the background.
 *
 * evaluateStartability() runs on the 2s status tick, so this must never be
 * awaited there — the tick would inherit start.gg's latency, and one query
 * every 2s would eat the 80-per-60s rate limit that reporting depends on. The
 * cache is claimed synchronously before the await so the next tick sees
 * `pending` rather than firing a second query.
 */
function ensureState(startgg, setId) {
  if (cache.setId === setId) return;
  cache = { setId, state: null, error: null, pending: true };

  startgg.getSetState(setId).then((r) => {
    if (cache.setId !== setId) return;   // a different set loaded while in flight
    cache = {
      setId,
      state: r.ok ? r.state : null,
      error: r.ok ? null : r.error,
      pending: false,
    };
  }).catch((err) => {
    if (cache.setId !== setId) return;
    cache = { setId, state: null, error: err.message, pending: false };
  });
}

/**
 * Can the loaded set be started on start.gg, and why not if it can't?
 *
 * Synchronous by contract — the control-status tick calls it every 2 seconds.
 * The first call for a new set schedules the lookup and reports "checking";
 * the answer lands on a later tick.
 *
 * @param {object} deps — { startgg, tsh }
 * @param {object} state — TSH program state
 * @param {string|number|null} setId
 * @returns {{ canStart: boolean, reason: string|null }}
 */
function evaluateStartability({ startgg, tsh }, state, setId) {
  if (!startgg.enabled)        return { canStart: false, reason: "start.gg token not configured" };
  if (tsh.isCrewBattle(state)) return { canStart: false, reason: "Crew battles aren't start.gg sets" };
  if (setId == null)           return { canStart: false, reason: "No start.gg set loaded (manual/exhibition)" };
  // A "preview" id belongs to a set start.gg hasn't created yet (the phase isn't
  // seeded), so there is nothing to mark in progress.
  if (String(setId).includes("preview")) {
    return { canStart: false, reason: "Set doesn't exist on start.gg yet" };
  }

  const key = String(setId);
  ensureState(startgg, key);

  if (cache.pending)      return { canStart: false, reason: "Checking start.gg…" };
  if (cache.error)        return { canStart: false, reason: cache.error };
  if (cache.state == null) return { canStart: false, reason: "start.gg set state unknown" };
  if (NOT_STARTED.has(cache.state)) return { canStart: true, reason: null };

  return {
    canStart: false,
    reason: cache.state === 3 ? "Set is already finished on start.gg"
                              : "Set is already in progress on start.gg",
  };
}

function createStartSet(ctx, refreshControlStatus) {
  const { tsh, startgg } = ctx;

  /**
   * Mark the currently-loaded set in progress.
   * @returns {Promise<{ ok: boolean, state?: number, error?: string }>}
   */
  async function startCurrentSet() {
    let tshState;
    try { tshState = tsh.readState(); }
    catch { return { ok: false, error: "Cannot read TSH state" }; }

    const setId = tsh.getSetId(tshState);
    const { canStart, reason } = evaluateStartability(ctx, tshState, setId);
    if (!canStart) return { ok: false, error: reason };

    const result = await startgg.startSet(setId);
    if (!result.ok) {
      // Whatever we believed about this set was wrong, or start.gg is unhappy.
      // Drop the cached state so the next tick re-reads it rather than leaving
      // the button enabled against a set that can't be started.
      cache = { setId: null, state: null, error: null, pending: false };
      return result;
    }

    cache = { setId: String(setId), state: result.state ?? 2, error: null, pending: false };
    refreshControlStatus().catch(() => {});
    return result;
  }

  return { startCurrentSet };
}

module.exports = { createStartSet, evaluateStartability };
