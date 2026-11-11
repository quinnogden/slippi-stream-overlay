/**
 * set-text.js — the scoreboard's derived set text: the best-of label and the
 * grand-finals [L] marks.
 *
 * Pure. The store calls these when a set loads; the operator can override
 * either from the dock's live strip, and an override always wins.
 *
 * The series runs **flex**: a Bo3 that becomes a Bo5 if it reaches 1-1, so it
 * is shown as "Flex" for the whole set rather than flipping mid-set. Top 6 is
 * always Bo5 (by default: the switch point and both formats are settings). "Top 6" is decided by start.gg's `lPlacement` — the placement the
 * set's loser is guaranteed — so it holds whether top 8 is its own phase or part
 * of one bracket, and works on unstarted (preview) sets too. Double-elim
 * placements run 1, 2, 3, 4, 5, 7, 9…, so top 6 is winners semis and losers
 * quarters on; losers top 8 (7th) is still Flex.
 */

const DEFAULTS = Object.freeze({
  topN: 6,            // sets whose loser places this or better are "top N"; 0 = never
  topLabel: "Bo5",
  defaultLabel: "Flex",
});

/**
 * The rule is the operator's to change (the dock's Set tab → Best-of): where
 * the switch is moves with the bracket, and some events run Bo3 into Bo5
 * rather than Flex. config.SET_TEXT gives the starting values; what the dock
 * saved wins after that.
 */
const FORMATS = Object.freeze(["Flex", "Bo3", "Bo5"]);
/** Where the switch can sit: lPlacement ≤ N (double-elim placements run 1, 2, 3, 4, 5, 7, 9, 13, 17…). 0 = never. */
const SWITCH_POINTS = Object.freeze([0, 3, 4, 6, 8, 12, 16]);

/** Any rules object → a valid one (unknown values fall back to the defaults). */
function normalizeSetRules(r = {}) {
  return {
    topN: SWITCH_POINTS.includes(Number(r.topN)) ? Number(r.topN) : DEFAULTS.topN,
    topLabel: FORMATS.includes(r.topLabel) ? r.topLabel : DEFAULTS.topLabel,
    defaultLabel: FORMATS.includes(r.defaultLabel) ? r.defaultLabel : DEFAULTS.defaultLabel,
  };
}

/** A rules change from the dock: the error for the first bad field, or null. */
function setRulesError(body) {
  if (!body || typeof body !== "object") return "a rules object is required";
  if (body.topN !== undefined && !SWITCH_POINTS.includes(Number(body.topN))) return `topN must be one of ${SWITCH_POINTS.join(", ")}`;
  for (const k of ["topLabel", "defaultLabel"]) {
    if (body[k] !== undefined && !FORMATS.includes(body[k])) return `${k} must be one of ${FORMATS.join(", ")}`;
  }
  return null;
}

/**
 * Whether a set with this best-of label has been won at `score`.
 *   BoN   first to ceil(N/2): Bo3 at 2, Bo5 at 3.
 *   Flex  2–0 (the Bo3 swept), else first to 3 (it reached 1–1 and became a
 *         Bo5): over at 2–0, 3–1, 3–2; not at 2–1.
 * Anything else (None, a hand-typed label) has no rule: never won.
 * @param {string} label
 * @param {[number, number]} score
 */
function setIsWon(label, score) {
  const [a, b] = [Number(score?.[0]) || 0, Number(score?.[1]) || 0];
  const hi = Math.max(a, b), lo = Math.min(a, b);
  const l = String(label ?? "").trim();
  if (/^flex$/i.test(l)) return (hi === 2 && lo === 0) || hi >= 3;
  const m = /^bo\s*(\d+)$/i.exec(l);
  return m ? hi >= Math.ceil(Number(m[1]) / 2) : false;
}

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
  return lp != null && o.topN > 0 && lp <= o.topN ? o.topLabel : o.defaultLabel;
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

module.exports = { bestOfLabel, losersMarks, setIsWon, normalizeSetRules, setRulesError, DEFAULTS, FORMATS, SWITCH_POINTS, NO_BEST_OF };
