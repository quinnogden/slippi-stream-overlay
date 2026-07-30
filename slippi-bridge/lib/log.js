/**
 * Shared logging shapes.
 *
 * TshClient returns `{ ok, error? }` rather than throwing, so nearly every call
 * site ended up writing the same `.then(r => { if (!r.ok) console.warn(...) })`
 * tail. That shape appeared seven times across index.js.
 */

/**
 * Warn if a TshClient-style result reports failure.
 *
 * Intended as a `.then()` argument:
 *   tsh.setCharacter(...).then(warnIfFailed("setCharacter"));
 *
 * @param {string} what — the operation name, used as the log prefix
 * @returns {(result: { ok: boolean, error?: string }) => void}
 */
function warnIfFailed(what) {
  return (result) => {
    if (result && !result.ok) console.warn(`[bridge] ${what} failed: ${result.error}`);
  };
}

module.exports = { warnIfFailed };
