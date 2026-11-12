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
 * `style: "random"` (picked, or saved in a combo) is a style picked by the
 * show's seed, so every source draws the same one. The stage pictures are the
 * first installed set's, or none with no set installed.
 * `mode: "random"` reads the last game or the set, picked at each show
 * (director.js); with one game counted the two are the same game, so it reads
 * the game.
 * `layout: "auto"` draws a layout from a pool at each show (director.js picks
 * it, `statsShot.layout`), never the last one twice running when the pool has
 * another: `pools.mid` while the set is on, `pools.over` once it's won (both
 * every layout by default, so Auto alone is a different layout each time).
 * Each draws in its best fit unless a style and pack are picked by hand. A
 * layout picked by hand takes Auto off; picking Auto again puts it back. The
 * old `layout: "random"` reads as "auto".
 */

const LAYOUTS = [
  { id: "spotlight", name: "Spotlight",  style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],     note: "Trail card: the summary in a lit strip, frosted ledger, three callouts" },
  { id: "players",   name: "Players",    style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],      note: "Trail card: each player's portrait card with their callouts, ledger with share bars between" },
  { id: "margins",   name: "Margins",    style: "cream", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],  note: "Field notes: the page fills the window, portraits printed in the margins under handwritten notes" },
  { id: "rangerlog", name: "Ranger log", style: "silSketch", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"], note: "Field notes: a cream form on a clipboard, the characters sketched on the paper" },
  { id: "tape",      name: "Tale of the tape", style: "riso", packs: ["CSProject_MeleeFull", "CSProject_AltFull", "full", "portrait"], note: "A boxing poster: one narrow column of big numbers with tug-of-war bars, the portraits filling each half, a rotating highlight band" },
  { id: "polaroids", name: "Polaroids",  style: "plain", packs: ["CSProject_MeleeFull", "portrait", "CSProject_AltFull", "full"],     note: "Field notes: each player's portrait as a taped instant photo, their best callout as the caption" },
  { id: "lowerthird", name: "Lower third", style: "riso", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],    note: "Only the bottom third of the screen: the game or the players' cam stays in view above it" },
  { id: "condensed", name: "Condensed", style: "plain", packs: ["CSProject_AltFull", "CSProject_MeleeFull", "full", "portrait"],     note: "Round the Players bar, the middle clear for the cam: a column out of the round card, each player's numbers and callouts on their card, the title and summary along the top" },
];

const STYLES = [
  { id: "auto",      name: "Best fit" },
  { id: "random",    name: "Random" },
  { id: "cream",     name: "Cream duotone" },
  { id: "scan",      name: "Scanlines" },
  { id: "riso",      name: "Riso" },
  { id: "silRim",    name: "Rim light" },
  { id: "silSketch", name: "Ink sketch" },
  { id: "plain",     name: "Plain" },
];

const MODES = ["auto", "game", "set", "random"];

/** `layout: AUTO` = a layout from the phase's pool at each show ("random" is its old name). */
const AUTO = "auto";
const isLayout = (id) => LAYOUTS.some((l) => l.id === id);
const layoutOk = (id) => id === AUTO || id === "random" || isLayout(id);

/** The layouts Auto draws from in each phase of the set: known ids, each once; none = every layout. */
function poolOf(list) {
  const ids = Array.isArray(list) ? LAYOUTS.map((l) => l.id).filter((id) => list.includes(id)) : [];
  return ids.length ? ids : LAYOUTS.map((l) => l.id);
}
const poolsOf = (p = {}) => ({ mid: poolOf(p && p.mid), over: poolOf(p && p.over) });

/**
 * The layout one show draws: the config's, or for "auto" one from the pool for
 * where the set is (`over`), not the last one drawn unless the pool has no other.
 * @param {{ layout: string, pools?: object }} cfg @param {string|null} last
 * @param {boolean} over — the set is won @param {() => number} [rand]
 */
function layoutFor(cfg, last, over, rand = Math.random) {
  const layout = cfg && cfg.layout;
  if (layout !== AUTO && layout !== "random") return isLayout(layout) ? layout : LAYOUTS[0].id;
  const all = poolsOf(cfg.pools)[over ? "over" : "mid"];
  const pool = all.length > 1 ? all.filter((id) => id !== last) : all;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

/** A portrait pack's id (art-packs.js): which packs exist is whatever's downloaded, so only its shape is checked here. */
const PACK_ID = /^[A-Za-z0-9_-]{1,64}$/;

const defaultStatsConfig = () => ({ layout: "spotlight", style: "auto", pack: "auto", auto: true, delaySec: 8, holdSec: 0, mode: "auto", combos: {}, pools: poolsOf() });

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
    layout: c.layout === "random" ? AUTO : layoutOk(c.layout) ? c.layout : d.layout,
    style: STYLES.some((s) => s.id === c.style) ? c.style : d.style,
    pack: typeof c.pack === "string" && PACK_ID.test(c.pack) ? c.pack : d.pack,
    auto: c.auto === undefined ? d.auto : !!c.auto,
    delaySec: clampInt(c.delaySec, 0, 120, d.delaySec),
    holdSec: clampInt(c.holdSec, 0, 600, d.holdSec),
    mode: MODES.includes(c.mode) ? c.mode : d.mode,
    combos: combosOf(c.combos),
    pools: poolsOf(c.pools),
  };
}

/**
 * Check a settings change from the dock: the error for the first bad field, or null.
 * @param {object} body
 */
function configError(body) {
  if (!body || typeof body !== "object") return "a settings object is required";
  if (body.layout !== undefined && !layoutOk(body.layout)) return `layout must be one of ${AUTO}, ${LAYOUTS.map((l) => l.id).join(", ")}`;
  if (body.style !== undefined && !STYLES.some((s) => s.id === body.style)) return `style must be one of ${STYLES.map((s) => s.id).join(", ")}`;
  if (body.pack !== undefined && !(typeof body.pack === "string" && PACK_ID.test(body.pack))) return "pack must be a portrait pack's id, auto or random";
  if (body.mode !== undefined && !MODES.includes(body.mode)) return `mode must be one of ${MODES.join(", ")}`;
  if (body.auto !== undefined && typeof body.auto !== "boolean") return "auto must be true or false";
  if (body.combos !== undefined) {
    if (!body.combos || typeof body.combos !== "object" || Array.isArray(body.combos)) return "combos must be an object of layout → { style, pack }";
    for (const [k, v] of Object.entries(body.combos)) {
      if (!LAYOUTS.some((l) => l.id === k)) return `combos: no layout ${k}`;
      if (!comboOf(v)) return `combos.${k} must be { style, pack } (not auto)`;
    }
  }
  if (body.pools !== undefined) {
    if (!body.pools || typeof body.pools !== "object" || Array.isArray(body.pools)) return "pools must be { mid, over }: lists of layouts";
    for (const [k, v] of Object.entries(body.pools)) {
      if (k !== "mid" && k !== "over") return `pools: no phase ${k} (mid or over)`;
      if (!Array.isArray(v) || !v.length) return `pools.${k} needs at least one layout`;
      const bad = v.find((id) => !isLayout(id));
      if (bad !== undefined) return `pools.${k}: no layout ${bad}`;
    }
  }
  for (const [k, hi] of [["delaySec", 120], ["holdSec", 600]]) {
    if (body[k] !== undefined && !(Number.isFinite(Number(body[k])) && Number(body[k]) >= 0 && Number(body[k]) <= hi)) return `${k} must be 0–${hi} seconds`;
  }
  return null;
}

module.exports = { LAYOUTS, STYLES, MODES, AUTO, layoutFor, poolsOf, defaultStatsConfig, normalizeStatsConfig, configError };
