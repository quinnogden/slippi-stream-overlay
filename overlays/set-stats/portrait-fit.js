/**
 * portrait-fit.js — the stats popup's per-portrait tweaks: for each art pack,
 * each character's pose nudged so the face lands in the open, about the same
 * size as everyone else's, looking inward. Edit a value, refresh the source:
 * nothing else to rebuild. Loaded by the page and by Node (tests), like
 * layouts.js. Tuned in .scratch/portrait-lab/ (every character at once in any
 * layout × pack × style; arrows, +/−, f, [ ] edit live and print the map).
 *
 * Every portrait is already placed by its face (the pack's eyesight point on
 * the layout's fx/fy) at a common height; these are what's left over.
 *
 *   f  1 = mirror the art: the pose looks outward (every portrait looks inward).
 *      Never on lettering (Luigi's L, a DK tie): mirrored text reads backwards.
 *   z  zoom about the face: >1 a close-up (a pose standing straight, a small
 *      head), <1 a pose whose head is its body (Kirby, Jigglypuff)
 *   x  move the face toward the middle (+) or the window's edge (−)
 *   y  move the face down (+) or up (−)
 *      x/y are px at portrait scale 1: each layout's own scale multiplies them,
 *      so one value means the same in a big window portrait and a polaroid.
 *   r  extra tilt about the face, degrees (+ = clockwise on the left side)
 *   e  [x, y] the face in the image's own pixels, where the pack's is off
 *   l  1 = a rim of light round the figure: a dark one (Game & Watch) on a dark window
 *
 * Per character, a key per slot kind overrides its values there:
 *   edge  the big window portraits (Spotlight, Margins, Ranger log, Tale of the tape, Lower third)
 *   card  a portrait inside a card (Players' rails, the Polaroids)
 * and a layout id overrides both (`polaroids: { z: 1.3 }`).
 *
 * "*" in a pack is every character's: its z multiplies theirs, its x/y/r add
 * to theirs (and it may have slot and layout keys too) — the pack's own size
 * against the others, so a pack switch keeps the composition.
 *
 * Keys are TSH's file names (game_&_watch, not game_and_watch).
 *
 * Quick reference — what each pack needs and why:
 *   full                 VS-screen action poses, all already looking inward;
 *                        sizes evened out (small heads up, round ones down).
 *   CSProject_MeleeFull  Melee's select-screen poses, mostly facing the camera;
 *                        Bowser and Ganondorf look outward.
 *   CSProject_AltFull    CSProject's own poses, bigger in frame;
 *                        Bowser, Yoshi, Falco, Young Link, Marth, Mewtwo, Sheik look outward.
 *   portrait             the select screen's busts, cut at their frame (the
 *                        popup feathers the cut); best in a card.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SetStatsFit = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FIT = {
    full: {
      bowser: { z: 0.8 },
      captain_falcon: { z: 1.12 },
      donkey_kong: { z: 0.82 },
      dr_mario: { z: 0.9 },
      "game_&_watch": { z: 0.9, l: 1 },
      ganondorf: { z: 1.1 },
      jigglypuff: { z: 0.55, card: { z: 0.9 } },
      kirby: { z: 0.58, card: { z: 0.9 } },
      link: { z: 1.15 },
      luigi: { z: 0.9 },
      mario: { z: 0.9 },
      marth: { z: 1.22 },
      mewtwo: { z: 1.1 },
      ness: { z: 0.95 },
      peach: { z: 1.1 },
      pichu: { z: 0.62 },
      pikachu: { z: 0.76 },
      roy: { z: 1.16 },
      samus: { z: 1.15 },
      sheik: { z: 1.22 },
      young_link: { z: 1.1 },
      zelda: { z: 1.22 },
    },
    CSProject_MeleeFull: {
      "*": { z: 1.2, card: { z: 1.4 }, polaroids: { z: 1.2 } },
      bowser: { f: 1, z: 0.8 },
      captain_falcon: { z: 1.3 },
      donkey_kong: { z: 0.65 },
      dr_mario: { z: 0.62 },
      falco: { z: 0.94 },
      "game_&_watch": { l: 1 },
      ganondorf: { f: 1, z: 1.5 },
      ice_climbers: { z: 1.12, edge: { x: -35 } },
      jigglypuff: { z: 0.56, card: { z: 0.8 } },
      kirby: { z: 0.62, card: { z: 0.9 } },
      link: { z: 1.22 },
      luigi: { z: 0.69 },
      mario: { z: 0.65 },
      marth: { z: 1.45 },
      mewtwo: { z: 1.32 },
      ness: { z: 0.58 },
      peach: { z: 1.2 },
      pichu: { z: 0.58 },
      pikachu: { z: 0.58, edge: { x: -15 } },
      roy: { z: 1.45 },
      samus: { z: 1.35 },
      sheik: { z: 1.3 },
      yoshi: { z: 0.93 },
      young_link: { z: 1.18 },
      zelda: { z: 1.45 },
    },
    CSProject_AltFull: {
      "*": { card: { z: 1.4 } },
      bowser: { f: 1, z: 0.63 },
      captain_falcon: { z: 1.3 },
      donkey_kong: { z: 0.77 },
      dr_mario: { z: 0.7 },
      falco: { f: 1, z: 0.84 },
      fox: { z: 0.84 },
      "game_&_watch": { z: 0.9, l: 1 },
      ganondorf: { z: 1.5 },
      ice_climbers: { edge: { x: -35 } },
      jigglypuff: { z: 1, card: { z: 1.1 } },
      kirby: { z: 0.7, card: { z: 0.9 } },
      link: { z: 1.3 },
      luigi: { z: 0.76 },
      mario: { z: 0.7 },
      marth: { f: 1, z: 1.4 },
      mewtwo: { f: 1, z: 1.4 },
      ness: { z: 0.68 },
      peach: { z: 1.08 },
      pichu: { z: 0.8 },
      pikachu: { z: 0.71 },
      roy: { z: 1.3 },
      samus: { z: 1.3 },
      sheik: { f: 1, z: 1.4 },
      yoshi: { f: 1, z: 0.79 },
      young_link: { f: 1, z: 0.9 },
      zelda: { z: 1.4 },
    },
    portrait: {
      "*": { z: 1.3, card: { z: 1.6 } },
      bowser: { f: 1, z: 0.8 },
      captain_falcon: { z: 1.3 },
      donkey_kong: { z: 0.65, e: [104, 78] },
      dr_mario: { z: 0.62 },
      falco: { z: 0.94 },
      "game_&_watch": { l: 1 },
      ganondorf: { f: 1, z: 1.5, e: [41, 43] },
      ice_climbers: { z: 1.12 },
      jigglypuff: { z: 0.56, e: [72, 92], card: { z: 0.65 } },
      kirby: { z: 0.62, card: { z: 0.7 } },
      link: { z: 1.22 },
      luigi: { z: 0.69 },
      mario: { z: 0.65 },
      marth: { z: 1.45 },
      mewtwo: { z: 1.32 },
      ness: { z: 0.58 },
      peach: { z: 1.2 },
      pichu: { z: 0.58, e: [96, 68] },
      pikachu: { z: 0.58 },
      roy: { z: 1.45 },
      samus: { z: 1.35 },
      sheik: { z: 1.3 },
      yoshi: { z: 0.93 },
      young_link: { z: 1.18 },
      zelda: { z: 1.45 },
    },
  };

  const SLOT_KEYS = ["edge", "card"];
  const VALUE_KEYS = ["f", "z", "x", "y", "r", "e", "l"];
  const own = (o) => { const out = {}; if (o) for (const k of VALUE_KEYS) if (o[k] != null) out[k] = o[k]; return out; };
  /** A character's values in a slot: theirs, then the slot kind's, then the layout's. */
  const level = (c, layout, slot) => (c ? Object.assign(own(c), own(c[slot]), own(c[layout])) : {});

  /**
   * One portrait's tweak in one slot: the pack's "*" combined with the
   * character's own. {} when there's nothing to change.
   * @param {string} pack @param {string} char — TSH's name @param {string} layout @param {"edge"|"card"} slot
   * @param {object} [map] — instead of FIT (the tuning page)
   */
  function tweak(pack, char, layout, slot, map) {
    map = map || FIT;
    const p = map[pack];
    if (!p) return {};
    const all = level(p["*"], layout, slot), c = level(p[char], layout, slot);
    const out = Object.assign({}, all, c);
    if (all.z != null || c.z != null) out.z = Math.round((all.z || 1) * (c.z || 1) * 1000) / 1000;
    for (const k of ["x", "y", "r"]) if (all[k] != null || c[k] != null) out[k] = (all[k] || 0) + (c[k] || 0);
    return out;
  }

  return { FIT, tweak, SLOT_KEYS, VALUE_KEYS };
});
