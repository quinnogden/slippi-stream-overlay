/**
 * The checks every start.gg action on the loaded set shares.
 *
 * Reporting and starting both act on "whatever TSH has loaded", and both refuse
 * for the same three reasons before anything set-specific applies. Kept in one
 * place so the two buttons can't disagree about what counts as a real set.
 */

/**
 * @param {{ enabled: boolean }} startgg
 * @param {string|number|null} setId
 * @returns {string|null} — why no start.gg action applies, or null if one might
 */
function startggSetGate(startgg, setId) {
  if (!startgg.enabled) return "start.gg token not configured";
  if (setId == null)    return "No start.gg set loaded (manual/exhibition)";
  // An event start.gg hasn't started yet has no real sets, so TSH reports
  // preview_<phase>_<round>_<n> ids — there is nothing on start.gg to act on.
  if (String(setId).includes("preview")) return "Bracket hasn't started on start.gg — this set doesn't exist there yet";
  return null;
}

/**
 * The set id TSH has loaded right now, read fresh, with the state it came from.
 * @param {object} tsh — TshClient
 * @returns {{ ok: true, setId: string|number|null, state: object } | { ok: false, error: string }}
 */
function loadedSetId(tsh) {
  const read = tsh.tryReadState();
  if (!read.ok) return { ok: false, error: "Cannot read TSH state" };
  return { ok: true, setId: tsh.getSetId(read.state), state: read.state };
}

module.exports = { startggSetGate, loadedSetId };
