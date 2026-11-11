/**
 * portraits.js — the character art and stage pictures the stats popup draws,
 * from the packs art-packs.js downloads into overlays/assets/packs/.
 *
 * A pack is a TSH asset pack: a folder of `<character>_<costume>.png` with a
 * config.json giving each character's `eyesights` (where the face is, in the
 * image's pixels) and, in some, a `rescaling_factor` per character (how big
 * they stand next to the others). The popup places every character by its
 * face, so one layout fits all 26 — whichever pack draws them. Each side
 * carries a portrait from every installed pack, and each game its stage's
 * picture from every installed stage set (`type: ["stage_icon"]`), so the
 * dock's picks (or a source's `?pack=` / `?stages=`) switch without a re-read.
 *
 * No pack installed: the popup has no portraits or stage pictures; nothing
 * else changes. Served at /assets/packs/ (the /assets/ mount, server/overlays.js).
 */

const fs = require("fs");
const path = require("path");
const { KNOWN } = require("./art-packs");

/** Every pack is drawn as if its frame were this tall (times its `fill`), so the characters come out the same size. */
const NORMAL_HEIGHT = 940;
/** TSH's file names where they differ from char_map's codenames. */
const TSH_NAMES = { game_and_watch: "game_&_watch" };

/** A PNG's size from its header, or null. */
function pngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    return b.readUInt32BE(12) === 0x49484452 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null; // "IHDR"
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const isPortraitPack = (conf) => !!conf?.eyesights && [].concat(conf.type ?? []).some((t) => t === "full" || t === "portrait");
const isStagePack = (conf) => [].concat(conf?.type ?? []).includes("stage_icon");
const listed = (p) => ({ id: p.id, name: p.name, credits: typeof p.conf.credits === "string" ? p.conf.credits : null });

/**
 * @param {{ dir: string }} opts — the packs folder (overlays/assets/packs)
 */
function createPortraits({ dir }) {
  let packs = [];   // [{ id, name, conf, fill }] — the installed portrait packs, in the dock's order
  let stagePacks = []; // [{ id, name, conf }] — the installed stage picture sets, likewise
  const cache = new Map();

  /** Read what's installed again (after a download). */
  function reload() {
    cache.clear();
    let found = [];
    try {
      found = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
    } catch { /* no folder yet: nothing downloaded */ }
    const order = (id) => { const i = KNOWN.findIndex((k) => k.id === id); return i < 0 ? KNOWN.length : i; };
    packs = [];
    stagePacks = [];
    for (const id of found.sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
      let conf = null;
      try { conf = JSON.parse(fs.readFileSync(path.join(dir, id, "config.json"), "utf8")); } catch { continue; }
      if (!conf || typeof conf !== "object" || Array.isArray(conf)) continue; // not a pack's config
      const known = KNOWN.find((k) => k.id === id);
      const name = known?.name ?? (typeof conf.name === "string" ? conf.name : id);
      if (isPortraitPack(conf)) packs.push({ id, name, conf, fill: known?.fill ?? 1, family: known?.family ?? id, cut: [].concat(conf.type ?? []).includes("portrait") });
      else if (isStagePack(conf)) stagePacks.push({ id, name, conf });
    }
  }
  reload();

  /** One pack's portrait of a character, or null. */
  function portraitIn(pack, name, skin) {
    let file = `${name}_${skin}.png`;
    const at = (f) => path.join(dir, pack.id, f);
    if (!fs.existsSync(at(file))) file = `${name}_0.png`;
    const size = fs.existsSync(at(file)) ? pngSize(at(file)) : null;
    if (!size || !(size.w > 0 && size.h > 0)) return null;
    const eyes = pack.conf.eyesights?.[name] ?? {};
    // A face point that isn't two numbers inside the picture would place the portrait off the page.
    const okEye = (p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
      && Number(p.x) >= 0 && Number(p.x) <= size.w && Number(p.y) >= 0 && Number(p.y) <= size.h;
    const found = [eyes[String(skin)], eyes["0"]].find(okEye);
    const e = found ? { x: Number(found.x), y: Number(found.y) } : { x: size.w * 0.55, y: size.h * 0.35 };
    const rs = pack.conf.rescaling_factor?.[name] ?? {};
    const given = Number(rs[String(skin)] ?? rs["0"]);
    const scale = Number.isFinite(given) && given > 0.1 && given < 10 ? given : 1;
    return {
      url: `/assets/packs/${encodeURIComponent(pack.id)}/${encodeURIComponent(file)}`,
      char: name, // TSH's name: the overlay's per-pose tweaks (portrait-fit.js) are keyed by it
      ...(pack.cut ? { cut: true } : {}), // cut at its frame (a bust): the overlay feathers the cut
      family: pack.family, // renders of one look (art-packs.js KNOWN): random poses pair within one
      w: size.w, h: size.h, eye: [e.x, e.y],
      k: Math.round(((NORMAL_HEIGHT * pack.fill * scale) / size.h) * 1000) / 1000,
      faces: "right",
    };
  }

  /**
   * A character's portrait from every installed pack, by pack id (the dock's
   * order), or null when none has one.
   * @param {{ codename: string, skin?: number }|null} character
   * @returns {Record<string, { url, w, h, eye: [number, number], k, faces: "right" }>|null}
   */
  function portraitsOf(character) {
    if (!packs.length || !character?.codename) return null;
    const name = TSH_NAMES[character.codename] ?? character.codename;
    const skin = Number(character.skin) || 0;
    const key = `${name}:${skin}`;
    if (!cache.has(key)) {
      const out = {};
      for (const pack of packs) {
        const p = portraitIn(pack, name, skin);
        if (p) out[pack.id] = p;
      }
      cache.set(key, Object.keys(out).length ? out : null);
    }
    return cache.get(key);
  }

  /**
   * A stage's picture from every installed stage set, by set id (the dock's
   * order), or null when none has one — like a character's portraits.
   * @param {string} icon — stages.js's file name
   * @returns {Record<string, string>|null}
   */
  function stagePicsOf(icon) {
    if (!stagePacks.length || !icon) return null;
    const out = {};
    for (const p of stagePacks) {
      if (fs.existsSync(path.join(dir, p.id, `${icon}.png`))) out[p.id] = `/assets/packs/${encodeURIComponent(p.id)}/${encodeURIComponent(icon)}.png`;
    }
    return Object.keys(out).length ? out : null;
  }

  return {
    dir,
    reload,
    portraitsOf,
    stagePicsOf,
    /** The installed portrait packs, for the dock: [{ id, name, credits }]. */
    packs: () => packs.map(listed),
    /** The installed stage picture sets, likewise. */
    stagePacks: () => stagePacks.map(listed),
  };
}

module.exports = { createPortraits, pngSize, NORMAL_HEIGHT };
