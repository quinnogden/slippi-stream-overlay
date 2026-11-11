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
 *   f  1 = the art looks left: it's mirrored, so every pose looks inward — the
 *      left side's to the right, and the right side's box is mirrored again.
 *      Judged by the face, then the body. Never on lettering (Luigi's L, a DK
 *      tie): mirrored text reads backwards — that's `o`.
 *   o  1 = looks left but carries lettering, so it can't be mirrored: that
 *      side takes the next pack whose pose doesn't (layouts.js withPack).
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
 * The layout ids are where a pose's hands and props are fitted to that
 * layout's space: the face first (the whole head in the open, near where the
 * layout puts it), then the gesture the pose is about (Peach's heart, Mario's
 * peace sign, a raised fist, a sword) out from under the glass and the cards
 * and off the portrait box's inner edge. The outer side may run off the
 * window; a small figure (Kirby, Pikachu) is brought up toward the others'
 * size. The comment on a character names the gestures that were fitted.
 * Chosen by .scratch/portrait-lab/opt.js (keys.js holds each pose's points).
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
 *                        mirrored: Bowser, Falcon, Doc, Fox, G&W, Ganondorf,
 *                        Mewtwo, Ness, Pikachu, Yoshi, Young Link.
 *   CSProject_AltFull    CSProject's own poses, bigger in frame; mirrored: Bowser,
 *                        Falcon, Falco, G&W, Jigglypuff, Marth, Mewtwo, Ness,
 *                        Pikachu, Roy, Samus, Sheik, Yoshi, Young Link. DK's
 *                        tie says DK, so his side takes the next pack (o).
 *   portrait             the select screen's busts (Melee's poses, judged by
 *                        the face), cut at their frame (the popup feathers the
 *                        cut); best in a card.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SetStatsFit = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FIT = {
    full: {
      bowser: { z: 0.8,
        spotlight: { z: 0.72 }, margins: { z: 0.72, x: -15 },
      },
      captain_falcon: { z: 1.12, // hand
        spotlight: { z: 0.78, x: -15, y: -10 }, margins: { z: 0.81, y: -70 },
        rangerlog: { z: 0.9, x: 15, y: -30 }, tape: { z: 0.84 }, lowerthird: { z: 0.67, y: -40 },
      },
      donkey_kong: { z: 0.82, // fist
        spotlight: { x: -15, y: -10 }, players: { z: 0.7, x: 60, y: -40 }, margins: { z: 0.74, x: -30 },
        polaroids: { z: 0.66, x: 45 }, lowerthird: { z: 0.49, x: 15, y: -20 },
      },
      dr_mario: { z: 0.9, // pill
        spotlight: { z: 0.86, x: -15 }, margins: { z: 0.72, x: -15, y: -50 },
      },
      falco: {
        spotlight: { z: 0.8, x: 15, y: -40 }, margins: { z: 0.71, x: -15, y: 10 }, rangerlog: { x: 30, y: -10 },
        tape: { z: 0.85 }, polaroids: { x: 45, y: -30 }, lowerthird: { z: 0.9, y: -10 },
      },
      fox: { // gun
        spotlight: { z: 0.85, x: -15 }, margins: { z: 0.74, x: -15, y: -30 }, rangerlog: { z: 0.75, y: -50 },
        tape: { z: 0.75, x: -45, y: -20 }, polaroids: { z: 0.8, y: -30 },
        lowerthird: { z: 0.85, x: -15, y: 10 },
      },
      "game_&_watch": { z: 0.9, l: 1,
        spotlight: { x: -15, y: -30 }, players: { x: 45, y: -40 }, margins: { z: 0.72, x: -15, y: -10 },
        tape: { z: 0.99, x: -15, y: -10 }, polaroids: { x: 30, y: -40 }, lowerthird: { x: -15, y: -10 },
      },
      ganondorf: { z: 1.1,
        spotlight: { z: 0.83, y: -40 }, margins: { z: 0.74, y: -70 }, rangerlog: { z: 1.05, x: 15, y: -10 },
        tape: { z: 1.05, x: -15 }, lowerthird: { z: 0.88, y: -20 },
      },
      ice_climbers: {
        spotlight: { z: 0.85, x: -15 }, margins: { z: 0.71, x: -15 }, rangerlog: { x: 15, y: -10 },
        tape: { z: 0.85 }, lowerthird: { z: 0.9 },
      },
      jigglypuff: { z: 0.55, card: { z: 0.9 },
        margins: { z: 0.71, x: -15 }, rangerlog: { z: 0.83, x: 45, y: 10 }, tape: { z: 0.74 },
        lowerthird: { z: 0.61, x: 30 },
      },
      kirby: { z: 0.58, card: { z: 0.9 },
        margins: { z: 0.84, x: 0, y: -70 }, rangerlog: { z: 0.73, x: 60 }, tape: { z: 0.7, x: 15 },
        lowerthird: { z: 0.75, x: 15 },
      },
      link: { z: 1.15, // sword
        spotlight: { z: 0.86, x: -15 }, players: { z: 0.92, x: 60 }, margins: { z: 0.82, y: -70 },
        rangerlog: { z: 0.92 }, tape: { z: 0.69, y: -30 }, polaroids: { z: 0.92, x: 45, y: -10 },
        lowerthird: { z: 0.69, x: 15, y: -20 },
      },
      luigi: { z: 0.9, // wave, hand
        spotlight: { z: 0.86, x: -15, y: -20 }, margins: { z: 0.72, x: -15, y: -20 }, tape: { z: 0.81, x: -15 },
        lowerthird: { z: 0.86, y: -10 },
      },
      mario: { z: 0.9, // fist, hand
        spotlight: { z: 0.72, x: -15, y: -20 }, players: { z: 0.81, x: 60, y: -40 },
        margins: { z: 0.72, x: -15, y: -10 }, tape: { z: 0.81, x: -30, y: -10 },
        polaroids: { z: 0.77, x: 45, y: -30 }, lowerthird: { z: 0.63, x: 15, y: -30 },
      },
      marth: { z: 1.22, // sword, hand
        spotlight: { z: 0.85, x: -15, y: 30 }, margins: { z: 0.74, x: -15, y: -50 }, rangerlog: { z: 0.92 },
        tape: { z: 0.92 }, lowerthird: { z: 0.98, x: -15 },
      },
      mewtwo: { z: 1.1, // hand
        spotlight: { z: 0.72, x: -30, y: -40 }, players: { z: 0.88, x: 45, y: -50 },
        margins: { z: 0.75, x: -15, y: -50 }, rangerlog: { z: 0.88, y: -10 }, tape: { z: 0.83, x: -30, y: -10 },
        polaroids: { z: 0.77, x: 30 }, lowerthird: { z: 1.05, x: -15, y: 40 },
      },
      ness: { z: 0.95, // bat, hand
        spotlight: { z: 0.81, y: -40 }, players: { z: 0.9, x: 60, y: -30 }, margins: { z: 0.71, x: -15 },
        rangerlog: { x: 15, y: -10 }, tape: { z: 0.81, x: -30, y: -10 },
        lowerthird: { z: 0.76, x: -15, y: -30 },
      },
      peach: { z: 1.1, // hand
        spotlight: { z: 0.88, x: -15, y: -10 }, margins: { z: 0.75, x: -15, y: -50 },
        rangerlog: { z: 1.05, x: 15, y: -10 }, tape: { z: 0.88, y: -20 }, lowerthird: { z: 0.88, y: -20 },
      },
      pichu: { z: 0.62,
        players: { z: 0.78, x: 30 }, margins: { z: 0.7, x: -15 }, rangerlog: { z: 0.87, x: 30 },
        tape: { z: 0.74 }, polaroids: { z: 0.71, x: 30 },
      },
      pikachu: { z: 0.76,
        spotlight: { x: 15, y: -40 }, players: { x: 45, y: -10 }, margins: { z: 0.71, x: -15 },
        rangerlog: { x: 60 }, polaroids: { x: 15, y: -20 }, lowerthird: { x: 15, y: -20 },
      },
      roy: { z: 1.16, // sword, hilt
        spotlight: { z: 0.87, x: -15, y: 10 }, players: { z: 0.87, x: 45, y: 20 }, margins: { z: 0.75, x: -30 },
        rangerlog: { z: 0.93, y: 40 }, tape: { z: 0.87, y: 40 }, polaroids: { z: 0.75, x: 15, y: 40 },
        lowerthird: { z: 0.75, x: 15, y: -10 },
      },
      samus: { z: 1.15, // cannon
        spotlight: { z: 0.86, x: -15, y: 20 }, margins: { z: 0.74, x: -15, y: -20 },
        rangerlog: { z: 1.03, x: 30, y: -10 }, tape: { z: 0.98, x: -15 }, polaroids: { y: 50 },
        lowerthird: { z: 0.86 },
      },
      sheik: { z: 1.22,
        spotlight: { z: 0.85, x: -15 }, margins: { z: 0.83, y: -70 }, rangerlog: { z: 1.1, x: 15, y: 20 },
        tape: { z: 1.04, x: -15 }, lowerthird: { z: 0.98, x: -15, y: -10 },
      },
      yoshi: {
        spotlight: { z: 0.9, x: -15, y: -30 }, players: { z: 1.05, y: -20 },
        margins: { z: 0.85, x: -15, y: -70 }, rangerlog: { x: 15, y: -20 }, tape: { z: 1.05, x: -15 },
        polaroids: { z: 1.05, y: -20 }, lowerthird: { x: -15 },
      },
      young_link: { z: 1.1,
        spotlight: { z: 0.83, x: 15, y: -40 }, margins: { z: 0.71, x: -15 }, rangerlog: { x: 15, y: 20 },
        tape: { z: 1.05, x: -15 }, lowerthird: { z: 0.88, y: -20 },
      },
      zelda: { z: 1.22,
        spotlight: { z: 0.85, x: -15, y: -20 }, margins: { z: 0.83, y: -80 },
        rangerlog: { z: 1.04, x: 15, y: -10 }, tape: { z: 1.04, x: -15, y: 10 },
        lowerthird: { z: 1.04, x: -15 },
      },
    },
    CSProject_MeleeFull: {
      "*": { z: 1.2, card: { z: 1.4 },
        polaroids: { z: 1.2 },
      },
      bowser: { f: 1, z: 0.8,
        margins: { z: 0.76, x: 0, y: -30 }, rangerlog: { x: 60 },
      },
      captain_falcon: { f: 1, z: 1.3, // salute
        spotlight: { z: 0.85, x: -45 }, margins: { z: 0.77, y: -10 }, rangerlog: { z: 0.98 },
        tape: { z: 0.78, x: -15 }, lowerthird: { z: 0.98, x: -45 },
      },
      donkey_kong: { z: 0.65, // hand, fist
        spotlight: { z: 0.62, x: 45, y: -40 }, players: { z: 0.55, x: 30, y: -10 }, margins: { z: 0.47, x: 15 },
        rangerlog: { z: 0.45, x: 30, y: -20 }, tape: { z: 0.45, x: -15 },
        lowerthird: { z: 0.42, x: -15, y: 20 },
      },
      dr_mario: { f: 1, z: 0.62, // pill
        spotlight: { z: 0.56, x: -60, y: -30 }, margins: { z: 0.59, x: -30, y: -10 }, rangerlog: { x: -30 },
        tape: { z: 0.59, x: -60, y: -20 }, polaroids: { y: -50 }, lowerthird: { x: -30, y: 10 },
      },
      falco: { z: 0.94, // fist
        spotlight: { z: 0.75, x: -45, y: -50 }, margins: { z: 0.75, y: -20 }, tape: { z: 0.75, x: -30, y: -20 },
      },
      fox: { f: 1, // gun, hand
        spotlight: { z: 1.25, x: -15, y: 50 }, margins: { z: 0.85, x: -30, y: -20 },
        rangerlog: { z: 0.8, x: -15 }, tape: { z: 0.7, x: -45 }, polaroids: { z: 0.65, x: 45, y: -40 },
        lowerthird: { z: 0.9, x: -30, y: 10 },
      },
      "game_&_watch": { f: 1, l: 1,
        players: { x: 15, y: -10 }, margins: { z: 0.95, y: -10 }, polaroids: { x: 15, y: -40 },
      },
      ganondorf: { f: 1, z: 1.5,
        spotlight: { z: 1.35, x: 15, y: -40 }, players: { x: 45 }, margins: { z: 0.98, x: 0, y: -20 },
        rangerlog: { x: 30 }, polaroids: { x: 30 },
      },
      ice_climbers: { z: 1.12, edge: { x: -35 }, // hammer
        players: { z: 0.67, x: -30, y: -20 }, margins: { z: 0.67, x: -65 }, rangerlog: { z: 0.67, x: -50 },
        tape: { z: 1.06 }, polaroids: { z: 0.84, x: -75, y: -10 }, lowerthird: { z: 0.84 },
      },
      jigglypuff: { z: 0.56, card: { z: 0.8 },
        spotlight: { z: 0.84 }, margins: { z: 0.92 }, rangerlog: { z: 0.84, x: 15 }, tape: { z: 0.81 },
        lowerthird: { z: 0.73 },
      },
      kirby: { z: 0.62, card: { z: 0.9 },
        margins: { z: 0.93 }, rangerlog: { z: 0.93, y: -10 }, tape: { z: 0.78, x: -15 },
      },
      link: { z: 1.22, // sword, shield
        spotlight: { z: 0.92 }, margins: { z: 0.73, y: -40 }, rangerlog: { x: 30 }, tape: { z: 1.16 },
        lowerthird: { z: 1.16 },
      },
      luigi: { z: 0.69, // cap, hand
        spotlight: { x: -15 }, players: { x: 45, y: -50 }, tape: { z: 0.62, x: 15, y: -50 },
        polaroids: { z: 0.72, x: 30, y: -40 }, lowerthird: { z: 0.62, x: 15, y: -30 },
      },
      mario: { z: 0.65, // fist, hand
        spotlight: { x: 15, y: 30 }, players: { x: 15, y: -40 }, margins: { z: 0.62, x: 15, y: -10 },
        rangerlog: { z: 0.62, x: 30, y: -20 }, tape: { z: 0.59, x: -15, y: -40 },
        polaroids: { z: 0.72, y: -40 }, lowerthird: { x: 15, y: -30 },
      },
      marth: { z: 1.45, // sword, hand
        spotlight: { z: 1.31, x: -15, y: -10 }, margins: { z: 1.03, x: -15 }, rangerlog: { z: 1.38 },
        tape: { z: 1.31 }, lowerthird: { x: -15 },
      },
      mewtwo: { f: 1, z: 1.32, // hand
        spotlight: { x: -30, y: 50 }, players: { z: 0.92, x: -45 }, margins: { z: 0.79, x: -45, y: -20 },
        rangerlog: { z: 0.79, x: -30 }, tape: { z: 0.79, x: 45 }, polaroids: { z: 0.92, x: -30 },
        lowerthird: { y: 40 },
      },
      ness: { f: 1, z: 0.58, // thumb
        spotlight: { z: 0.67, x: -60 }, players: { z: 0.67, y: -50 }, margins: { z: 0.73, x: -15, y: -10 },
        rangerlog: { z: 0.73, x: -15 }, tape: { z: 0.64, x: -30, y: -40 }, polaroids: { z: 0.7, y: -50 },
        lowerthird: { x: -30, y: -30 },
      },
      peach: { z: 1.2,
        spotlight: { x: -15 }, margins: { z: 1.02, x: -15 },
      },
      pichu: { z: 0.58,
        spotlight: { z: 0.84 }, players: { z: 0.7, y: -30 }, margins: { z: 0.81, x: 15 },
        rangerlog: { z: 0.78, x: 30 }, tape: { z: 0.7 }, polaroids: { z: 0.75 },
      },
      pikachu: { f: 1, z: 0.58, edge: { x: -15 },
        spotlight: { z: 0.7 }, players: { z: 0.61, y: -50 }, margins: { z: 0.73 }, rangerlog: { z: 0.73 },
        tape: { z: 0.61, y: -50 }, polaroids: { z: 0.64, y: -50 },
      },
      roy: { z: 1.45, // sword
        spotlight: { z: 0.87, x: -15 }, margins: { z: 1.1, x: -30, y: 50 }, rangerlog: { z: 1.38 },
        tape: { x: -15, y: -10 }, lowerthird: { z: 1.38, y: -10 },
      },
      samus: { z: 1.35, // cannon
        spotlight: { z: 0.81 }, players: { x: 45 }, margins: { z: 0.76, x: 15 }, rangerlog: { z: 0.95, x: 30 },
        tape: { z: 0.95, y: -10 }, polaroids: { x: 45 }, lowerthird: { z: 1.15, x: 30 },
      },
      sheik: { z: 1.3, // needles
        spotlight: { z: 1.17, y: 50 }, players: { z: 1.17, y: 50 }, margins: { z: 0.96, x: 0, y: 20 },
        rangerlog: { x: 60, y: -10 }, tape: { z: 1.17, y: 40 }, polaroids: { z: 0.98, x: 15, y: 40 },
        lowerthird: { x: 15 },
      },
      yoshi: { f: 1, z: 0.93 },
      young_link: { f: 1, z: 1.18, // sword
        spotlight: { z: 0.94 }, margins: { z: 1.06, x: -15, y: -10 },
      },
      zelda: { z: 1.45,
        spotlight: { z: 1.31, x: -15, y: -10 }, margins: { z: 1.03, x: -15 }, rangerlog: { z: 1.38 },
        tape: { z: 1.31 }, lowerthird: { x: -15 },
      },
    },
    CSProject_AltFull: {
      "*": { card: { z: 1.4 } },
      bowser: { f: 1, z: 0.63,
        margins: { z: 0.66, x: 15 }, rangerlog: { x: 45 },
      },
      captain_falcon: { f: 1, z: 1.3, // fist, point
        spotlight: { z: 0.78, x: -45, y: -20 }, players: { z: 1.04, x: -30, y: -20 }, margins: { z: 0.78 },
        rangerlog: { z: 0.85, y: -10 }, tape: { z: 0.85, x: -45, y: -10 }, polaroids: { z: 1.04, x: -60 },
        lowerthird: { z: 0.91, x: -45, y: -20 },
      },
      donkey_kong: { o: 1, z: 0.77, // fist, hand
        spotlight: { z: 0.73, x: 45 }, players: { z: 0.69, x: 45 }, margins: { z: 0.41, x: 15 },
        rangerlog: { z: 0.54, x: 45, y: -10 }, tape: { z: 0.54 }, lowerthird: { z: 0.54, y: 30 },
      },
      dr_mario: { z: 0.7, // salute, scope
        spotlight: { x: -15 },
      },
      falco: { f: 1, z: 0.84, // head, hand
        spotlight: { x: -45 }, tape: { x: -30 }, lowerthird: { z: 0.76, y: -50 },
      },
      fox: { z: 0.84 }, // thumb
      "game_&_watch": { f: 1, z: 0.9, l: 1 },
      ganondorf: { z: 1.5,
        spotlight: { z: 1.42 }, margins: { z: 1.42, x: -15 },
      },
      ice_climbers: { edge: { x: -35 }, // hammer
        spotlight: { z: 0.65, x: -65 }, players: { z: 0.65 }, margins: { z: 0.8, y: 10 },
        rangerlog: { z: 0.8, y: 10 }, tape: { z: 0.7, x: -80 }, polaroids: { z: 0.6, x: -15, y: 50 },
        lowerthird: { z: 0.6, y: 30 },
      },
      jigglypuff: { f: 1, z: 1, card: { z: 1.1 },
        spotlight: { z: 1.25 }, margins: { z: 1.3 }, rangerlog: { z: 1.3, x: 15 },
      },
      kirby: { z: 0.7, card: { z: 0.9 },
        spotlight: { z: 0.98, x: -15 }, margins: { z: 0.98 }, rangerlog: { z: 1.01 }, tape: { z: 0.88 },
      },
      link: { z: 1.3, // sword, shield
        spotlight: { z: 1.11 }, margins: { z: 0.85 },
      },
      luigi: { z: 0.76, // salute
        players: { z: 0.91 }, margins: { z: 0.84 }, rangerlog: { z: 0.87 }, tape: { z: 0.99 },
        polaroids: { z: 0.8, y: -30 }, lowerthird: { z: 0.8, y: -50 },
      },
      mario: { z: 0.7, // peace, fist
        spotlight: { x: -45 }, tape: { x: -30, y: -30 }, lowerthird: { x: -15, y: -10 },
      },
      marth: { f: 1, z: 1.4, // sword, hand
        spotlight: { z: 0.98 }, margins: { z: 1.26, x: -15 },
      },
      mewtwo: { f: 1, z: 1.4, // hand
        spotlight: { z: 1.33, x: -15, y: 50 }, margins: { z: 0.98, x: -60, y: -20 },
        rangerlog: { z: 0.91, x: -45 }, tape: { z: 1.26 }, polaroids: { z: 1.33, y: -50 },
        lowerthird: { z: 0.98, x: -60 },
      },
      ness: { f: 1, z: 0.68, // palm
        spotlight: { x: 15 }, players: { x: 30, y: -40 }, margins: { z: 0.78, x: 30 },
        rangerlog: { z: 0.78, x: 45 }, polaroids: { x: 30 },
      },
      peach: { z: 1.08, // heart
        players: { x: 30 }, margins: { z: 0.93, x: 0 }, rangerlog: { x: 30 },
        polaroids: { z: 0.97, x: 15, y: -20 }, lowerthird: { z: 1.03 },
      },
      pichu: { z: 0.8,
        spotlight: { z: 1.08, x: -45 }, players: { z: 0.92 }, margins: { z: 1.12 }, rangerlog: { z: 1.12 },
        tape: { z: 0.96, x: -15 }, lowerthird: { z: 0.92 },
      },
      pikachu: { f: 1, z: 0.71,
        players: { z: 0.85, x: 30 }, margins: { z: 1.18, x: 0 }, rangerlog: { z: 1.07, x: 30, y: -10 },
        tape: { z: 0.92 }, lowerthird: { z: 0.82 },
      },
      roy: { f: 1, z: 1.3, // sword, fist
        spotlight: { z: 0.85 }, players: { z: 0.98, x: 60 }, margins: { z: 0.77, x: 15 },
        rangerlog: { z: 0.98, x: 45 }, tape: { z: 0.78, x: -15, y: -20 }, polaroids: { z: 0.98, x: 60, y: -10 },
        lowerthird: { z: 1.04, x: 30, y: -40 },
      },
      samus: { f: 1, z: 1.3, // cannon
        players: { z: 1.23, y: 30 }, margins: { z: 1.23, x: -15 }, polaroids: { z: 0.91, y: 30 },
        lowerthird: { z: 0.98, x: -15, y: 20 },
      },
      sheik: { f: 1, z: 1.4, // hand
        spotlight: { z: 1.26, x: -30 }, margins: { x: -15 }, tape: { z: 1.33, x: -15, y: -30 },
      },
      yoshi: { f: 1, z: 0.79, // boot, hand
        spotlight: { z: 0.83, y: 50 }, players: { x: 30, y: -50 }, tape: { z: 0.71, x: -15, y: -50 },
        polaroids: { z: 0.75, x: 15, y: -50 }, lowerthird: { y: -20 },
      },
      young_link: { f: 1, z: 0.9, // sword, shield
        spotlight: { z: 0.68, x: -15 }, players: { z: 0.68 }, margins: { z: 0.77, x: 15 },
        rangerlog: { z: 0.77, x: 30, y: 10 }, tape: { z: 0.77, x: -15 }, lowerthird: { z: 0.59, y: 20 },
      },
      zelda: { z: 1.4, // hands
        spotlight: { z: 1.33, x: -15 }, players: { y: -50 }, margins: { z: 1.26, x: -15 },
        tape: { z: 1.33, y: -20 }, polaroids: { z: 1.12, y: -40 }, lowerthird: { z: 1.33, y: -30 },
      },
    },
    portrait: {
      "*": { z: 1.3, card: { z: 1.6 } },
      bowser: { f: 1, z: 0.8,
        spotlight: { z: 0.84, x: 30 }, margins: { z: 0.76, x: 30, y: -20 }, rangerlog: { x: 45 },
      },
      captain_falcon: { f: 1, z: 1.3, // salute
        spotlight: { z: 0.78, x: -75, y: -10 }, players: { z: 1.17, x: -75, y: -10 },
        margins: { z: 0.98, x: -60 }, rangerlog: { z: 0.91, x: -45 }, polaroids: { z: 0.98, x: -60, y: -50 },
        lowerthird: { z: 0.85, x: -60, y: -50 },
      },
      donkey_kong: { z: 0.65, e: [104, 78], // hand
        spotlight: { z: 0.78 }, players: { x: 45, y: -30 }, margins: { z: 0.68, x: 30 }, rangerlog: { x: 60 },
        tape: { x: 30 }, polaroids: { x: 45 }, lowerthird: { x: 30 },
      },
      dr_mario: { z: 0.62, // pill
        spotlight: { z: 0.74 }, players: { z: 0.65, x: 45, y: -50 }, margins: { z: 0.74 },
        rangerlog: { z: 0.74 }, tape: { z: 0.81 }, polaroids: { z: 0.68, x: 60, y: -40 },
        lowerthird: { z: 0.68, x: 30, y: -10 },
      },
      falco: { z: 0.94,
        polaroids: { y: -40 },
      },
      fox: { f: 1, // gun
        spotlight: { z: 1.2, y: 40 }, players: { x: -30, y: -30 }, margins: { z: 0.95, x: -45, y: -10 },
        rangerlog: { z: 0.9, x: -30 }, tape: { z: 0.8, x: -60 }, polaroids: { z: 0.85, x: -15, y: -10 },
        lowerthird: { z: 0.8 },
      },
      "game_&_watch": { f: 1, l: 1,
        players: { x: 15, y: -50 }, polaroids: { y: -50 }, lowerthird: { y: -50 },
      },
      ganondorf: { f: 1, z: 1.5, e: [41, 43],
        margins: { z: 1.42 },
      },
      ice_climbers: { z: 1.12 },
      jigglypuff: { z: 0.56, e: [72, 92], card: { z: 0.65 },
        spotlight: { z: 0.73, x: -45 }, margins: { z: 0.7 }, rangerlog: { z: 0.7 },
      },
      kirby: { z: 0.62, card: { z: 0.7 },
        spotlight: { z: 0.84 }, margins: { z: 0.81 }, rangerlog: { z: 0.74, x: 30 },
      },
      link: { z: 1.22 },
      luigi: { z: 0.69, // hand
        spotlight: { z: 0.79 }, players: { x: 45, y: -50 }, margins: { z: 0.79 }, rangerlog: { z: 0.79 },
        tape: { z: 0.86 }, polaroids: { z: 0.72, x: 60, y: -40 }, lowerthird: { x: 30, y: -30 },
      },
      mario: { z: 0.65, // fist
        players: { z: 0.78, x: 15, y: -20 }, margins: { z: 0.75, x: 30, y: -10 }, rangerlog: { z: 0.75, x: 30 },
        tape: { z: 0.78, y: -30 }, polaroids: { z: 0.72, x: 15, y: -50 }, lowerthird: { z: 0.72, y: -30 },
      },
      marth: { z: 1.45 },
      mewtwo: { f: 1, z: 1.32, // hand
        spotlight: { z: 1.39, y: 50 }, players: { z: 1.12, x: -60 }, margins: { z: 0.92, x: -30, y: -20 },
        rangerlog: { z: 0.86, x: -15 }, polaroids: { z: 0.86, x: -15 }, lowerthird: { z: 0.86, x: -15, y: 20 },
      },
      ness: { f: 1, z: 0.58, // thumb
        spotlight: { z: 0.78, x: -15 }, players: { z: 0.64, y: -50 }, margins: { z: 0.7, x: -15 },
        rangerlog: { z: 0.7, x: -15 }, tape: { z: 0.67, x: -45, y: -40 }, polaroids: { z: 0.67, y: -20 },
        lowerthird: { z: 0.61, x: -30, y: -30 },
      },
      peach: { z: 1.2 },
      pichu: { z: 0.58, e: [96, 68],
        spotlight: { z: 0.75 }, margins: { z: 0.75 }, rangerlog: { z: 0.73, x: 15 },
      },
      pikachu: { f: 1, z: 0.58,
        spotlight: { z: 0.75, x: -30 }, players: { z: 0.67, y: -50 }, margins: { z: 0.75 },
        rangerlog: { z: 0.75 }, tape: { z: 0.64, y: -50 }, polaroids: { z: 0.73, y: -20 },
        lowerthird: { z: 0.73, y: -10 },
      },
      roy: { z: 1.45 },
      samus: { z: 1.35 },
      sheik: { z: 1.3 },
      yoshi: { f: 1, z: 0.93,
        players: { z: 1.16 }, polaroids: { x: 15, y: -50 },
      },
      young_link: { f: 1, z: 1.18, // sword
        spotlight: { z: 1.3, x: -30, y: 50 }, players: { z: 1.06, x: -90, y: -50 },
        margins: { z: 0.85, x: -60, y: -30 }, rangerlog: { z: 0.83, x: -45 },
        polaroids: { z: 0.83, x: -60, y: -20 }, lowerthird: { z: 0.89, x: -60, y: 10 },
      },
      zelda: { z: 1.45 },
    },
  };

  const SLOT_KEYS = ["edge", "card"];
  const VALUE_KEYS = ["f", "o", "z", "x", "y", "r", "e", "l"];
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
