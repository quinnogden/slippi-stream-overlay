/**
 * set-text.js — the scoreboard's derived set text: the best-of label and the
 * grand-finals [L] marks.
 *
 * Pure. The store calls these when a set loads; the operator can override
 * either from the dock's live strip, and an override always wins.
 *
 * The series runs **flex**: a Bo3 that becomes a Bo5 if it reaches 1-1, so it
 * is shown as "Flex" for the whole set rather than flipping mid-set. Top 8 is
 * always Bo5. "Top 8" is decided by start.gg's `lPlacement` — the placement the
 * set's loser is guaranteed — so it holds whether top 8 is its own phase or part
 * of one bracket, and works on unstarted (preview) sets too.
 */

const DEFAULTS = Object.freeze({
  topN: 8,            // sets whose loser places this or better are "top N"
  topLabel: "Bo5",
  defaultLabel: "Flex",
});

/** The override that shows no best-of at all: the overlays hide the label. */
const NO_BEST_OF = "None";

/**
 * @param {{ lPlacement?: number|null }} set
 * @param {{ topN?: number, topLabel?: string, defaultLabel?: string, override?: string|null }} [opts]
 * @returns {string} "" for the NO_BEST_OF override
 */
function bestOfLabel(set, opts = {}) {
  if (opts.override === NO_BEST_OF) return "";
  if (opts.override) return opts.override;
  const o = { ...DEFAULTS, ...stripUndefined(opts) };
  const lp = set?.lPlacement;
  return lp != null && lp <= o.topN ? o.topLabel : o.defaultLabel;
}

/**
 * Which sides carry [L]. In grand finals, the player who came up through
 * losers; in the reset both players have a loss, so both.
 *
 * @param {{ isGrandFinal?: boolean, isReset?: boolean, sides?: Array<{ fromLosers?: boolean }> }} set
 * @param {Array<boolean|null>} [override] — per side; null/undefined = no override
 * @returns {[boolean, boolean]}
 */
function losersMarks(set, override = []) {
  let marks = [false, false];
  if (set?.isReset) marks = [true, true];
  else if (set?.isGrandFinal) marks = [0, 1].map((i) => !!set.sides?.[i]?.fromLosers);
  return marks.map((m, i) => (override[i] == null ? m : !!override[i]));
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

module.exports = { bestOfLabel, losersMarks, DEFAULTS, NO_BEST_OF };
