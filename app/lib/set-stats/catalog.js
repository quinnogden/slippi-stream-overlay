/**
 * catalog.js — the stats popup's layouts and picture styles, by id, and its
 * settings' rules. The overlay draws each id (overlays/set-stats/layouts.js);
 * the dock lists them; tests/set-stats.test.js checks the two agree.
 *
 * Each layout has a best fit: the picture style and portrait packs (best
 * first) that show the characters best in it and match its look — picked by
 * comparing every layout × style × pack (.scratch/portrait-lab/). `style:
 * "auto"` and `pack: "auto"` follow it: the layout's saved combo (`combos`,
 * the dock's ★) if the operator saved one, else the recommended one; anything
 * else overrides it for every layout — so any layout mixes with any style and
 * pack, live. A pack that isn't downloaded falls back to one that is.
 * `pack: "random"` (picked, or saved in a combo) is random poses: a pack per
 * side at each show, full-body renders only, the two from one family of
 * renders, in whatever style "auto" or the pick gives (layouts.js randomPair).
 * `stages` likewise for the stage pictures, plus "none": no stage pictures.
 * `layout: "random"` draws a different layout each time the popup goes up
 * (director.js picks it, `statsShot.layout`), each in its best fit unless a
 * style and pack are picked by hand.
 */

const LAYOUTS = [
  { id: "spotlight", name: "Spotlight",  style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],     note: "Trail card: the summary in a lit strip, frosted ledger, three callouts" },
  { id: "players",   name: "Players",    style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],      note: "Trail card: each player's portrait card with their callouts, ledger with share bars between" },
  { id: "margins",   name: "Margins",    style: "cream", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],  note: "Field notes: the page fills the window, portraits printed in the margins under handwritten notes" },
  { id: "rangerlog", name: "Ranger log", style: "silSketch", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"], note: "Field notes: a cream form on a clipboard, the characters sketched on the paper" },
  { id: "tape",      name: "Tale of the tape", style: "riso", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"], note: "A boxing poster: one narrow column of big numbers with tug-of-war bars, the portraits filling each half, a rotating highlight band" },
  { id: "polaroids", name: "Polaroids",  style: "plain", packs: ["CSProject_MeleeFull", "portrait", "CSProject_AltFull", "full"],     note: "Field notes: each player's portrait as a taped instant photo, their best callout as the caption" },
  { id: "lowerthird", name: "Lower third", style: "riso", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],    note: "Only the bottom third of the screen: the game or the players' cam stays in view above it" },
];

const STYLES = [
  { id: "auto",      name: "Best fit" },
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

/** `layout: RANDOM` = a different layout at each show. */
const RANDOM = "random";
const layoutOk = (id) => id === RANDOM || LAYOUTS.some((l) => l.id === id);

/**
 * The layout one show draws: the config's, or for "random" any layout but the last one drawn.
 * @param {string} layout — the config's @param {string|null} last @param {() => number} [rand]
 */
function layoutFor(layout, last, rand = Math.random) {
  if (layout !== RANDOM) return LAYOUTS.some((l) => l.id === layout) ? layout : LAYOUTS[0].id;
  const pool = LAYOUTS.filter((l) => l.id !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))].id;
}

/** A portrait pack's id (art-packs.js): which packs exist is whatever's downloaded, so only its shape is checked here. */
const PACK_ID = /^[A-Za-z0-9_-]{1,64}$/;

const defaultStatsConfig = () => ({ layout: "spotlight", style: "auto", pack: "auto", stages: "stage_icon", auto: true, delaySec: 8, holdSec: 0, mode: "auto", combos: {} });

/** A saved combo for one layout: { style (not "auto"), pack (not "auto") }, or null if it isn't one. */
function comboOf(c) {
  if (!c || typeof c !== "object") return null;
  const style = STYLES.some((s) => s.id === c.style && s.id !== "auto") ? c.style : null;
  const pack = typeof c.pack === "string" && PACK_ID.test(c.pack) && c.pack !== "auto" ? c.pack : null;
  return style && pack ? { style, pack } : null;
}
/** The saved combos, by layout: only known layouts, only whole combos. */
function combosOf(m) {
  const out = {};
  if (m && typeof m === "object") for (const l of LAYOUTS) { const c = comboOf(m[l.id]); if (c) out[l.id] = c; }
  return out;
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Any settings object → a valid one (unknown values fall back to the defaults). */
function normalizeStatsConfig(c = {}) {
  const d = defaultStatsConfig();
  return {
    layout: layoutOk(c.layout) ? c.layout : d.layout,
    style: STYLES.some((s) => s.id === c.style) ? c.style : d.style,
    pack: typeof c.pack === "string" && PACK_ID.test(c.pack) ? c.pack : d.pack,
    stages: typeof c.stages === "string" && PACK_ID.test(c.stages) ? c.stages : d.stages,
    auto: c.auto === undefined ? d.auto : !!c.auto,
    delaySec: clampInt(c.delaySec, 0, 120, d.delaySec),
    holdSec: clampInt(c.holdSec, 0, 600, d.holdSec),
    mode: MODES.includes(c.mode) ? c.mode : d.mode,
    combos: combosOf(c.combos),
  };
}

/**
 * Check a settings change from the dock: the error for the first bad field, or null.
 * @param {object} body
 */
function configError(body) {
  if (!body || typeof body !== "object") return "a settings object is required";
  if (body.layout !== undefined && !layoutOk(body.layout)) return `layout must be one of ${LAYOUTS.map((l) => l.id).join(", ")}, ${RANDOM}`;
  if (body.style !== undefined && !STYLES.some((s) => s.id === body.style)) return `style must be one of ${STYLES.map((s) => s.id).join(", ")}`;
  if (body.pack !== undefined && !(typeof body.pack === "string" && PACK_ID.test(body.pack))) return "pack must be a portrait pack's id, auto or random";
  if (body.stages !== undefined && !(typeof body.stages === "string" && PACK_ID.test(body.stages))) return "stages must be a stage picture set's id, or none";
  if (body.mode !== undefined && !MODES.includes(body.mode)) return `mode must be one of ${MODES.join(", ")}`;
  if (body.auto !== undefined && typeof body.auto !== "boolean") return "auto must be true or false";
  if (body.combos !== undefined) {
    if (!body.combos || typeof body.combos !== "object" || Array.isArray(body.combos)) return "combos must be an object of layout → { style, pack }";
    for (const [k, v] of Object.entries(body.combos)) {
      if (!LAYOUTS.some((l) => l.id === k)) return `combos: no layout ${k}`;
      if (!comboOf(v)) return `combos.${k} must be { style, pack } (not auto)`;
    }
  }
  for (const [k, hi] of [["delaySec", 120], ["holdSec", 600]]) {
    if (body[k] !== undefined && !(Number.isFinite(Number(body[k])) && Number(body[k]) >= 0 && Number(body[k]) <= hi)) return `${k} must be 0–${hi} seconds`;
  }
  return null;
}

module.exports = { LAYOUTS, STYLES, MODES, RANDOM, layoutFor, defaultStatsConfig, normalizeStatsConfig, configError };
