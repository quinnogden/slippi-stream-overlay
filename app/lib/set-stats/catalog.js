/**
 * catalog.js — the stats popup's layouts and picture styles, by id, and its
 * settings' rules. The overlay draws each id (overlays/set-stats/layouts.js);
 * the dock lists them; tests/set-stats.test.js checks the two agree.
 *
 * A layout carries its own picture style; `style: "auto"` means "the layout's
 * own", anything else overrides it for every layout — so the operator can mix
 * any layout with any style, live.
 */

const LAYOUTS = [
  { id: "spotlight", name: "Spotlight",  style: "cream",     note: "Trail card: the summary in a lit strip, frosted ledger, three callouts" },
  { id: "players",   name: "Players",    style: "riso",      note: "Trail card: each player's portrait card with their callouts, ledger with share bars between" },
  { id: "margins",   name: "Margins",    style: "halftone",  note: "Field notes: the page fills the window, portraits printed in the margins under handwritten notes" },
  { id: "rangerlog", name: "Ranger log", style: "silSketch", note: "Field notes: a cream form on a clipboard, the characters sketched on the paper" },
  { id: "tape",      name: "Tale of the tape", style: "scan", note: "A boxing poster: one narrow column of big numbers with tug-of-war bars, the portraits filling each half, a rotating highlight band" },
  { id: "polaroids", name: "Polaroids",  style: "cream",     note: "Field notes: each player's portrait as a taped instant photo, their best callout as the caption" },
  { id: "lowerthird", name: "Lower third", style: "riso",    note: "Only the bottom third of the screen: the game or the players' cam stays in view above it" },
];

const STYLES = [
  { id: "auto",      name: "Layout's own" },
  { id: "cream",     name: "Cream duotone" },
  { id: "scan",      name: "Scanlines" },
  { id: "halftone",  name: "Halftone" },
  { id: "riso",      name: "Riso" },
  { id: "silRim",    name: "Rim light" },
  { id: "silLine",   name: "Outline" },
  { id: "silCream",  name: "Cut-out" },
  { id: "silSketch", name: "Ink sketch" },
  { id: "plain",     name: "Plain" },
];

const MODES = ["auto", "game", "set"];

const defaultStatsConfig = () => ({ layout: "spotlight", style: "auto", auto: true, delaySec: 8, holdSec: 0, mode: "auto" });

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Any settings object → a valid one (unknown values fall back to the defaults). */
function normalizeStatsConfig(c = {}) {
  const d = defaultStatsConfig();
  return {
    layout: LAYOUTS.some((l) => l.id === c.layout) ? c.layout : d.layout,
    style: STYLES.some((s) => s.id === c.style) ? c.style : d.style,
    auto: c.auto === undefined ? d.auto : !!c.auto,
    delaySec: clampInt(c.delaySec, 0, 120, d.delaySec),
    holdSec: clampInt(c.holdSec, 0, 600, d.holdSec),
    mode: MODES.includes(c.mode) ? c.mode : d.mode,
  };
}

/**
 * Check a settings change from the dock: the error for the first bad field, or null.
 * @param {object} body
 */
function configError(body) {
  if (!body || typeof body !== "object") return "a settings object is required";
  if (body.layout !== undefined && !LAYOUTS.some((l) => l.id === body.layout)) return `layout must be one of ${LAYOUTS.map((l) => l.id).join(", ")}`;
  if (body.style !== undefined && !STYLES.some((s) => s.id === body.style)) return `style must be one of ${STYLES.map((s) => s.id).join(", ")}`;
  if (body.mode !== undefined && !MODES.includes(body.mode)) return `mode must be one of ${MODES.join(", ")}`;
  if (body.auto !== undefined && typeof body.auto !== "boolean") return "auto must be true or false";
  for (const [k, hi] of [["delaySec", 120], ["holdSec", 600]]) {
    if (body[k] !== undefined && !(Number.isFinite(Number(body[k])) && Number(body[k]) >= 0 && Number(body[k]) <= hi)) return `${k} must be 0–${hi} seconds`;
  }
  return null;
}

module.exports = { LAYOUTS, STYLES, MODES, defaultStatsConfig, normalizeStatsConfig, configError };
