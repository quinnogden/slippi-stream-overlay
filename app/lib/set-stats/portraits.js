/**
 * portraits.js — the character art and stage pictures the stats popup draws.
 *
 * The art is a TSH asset pack: a folder of `<character>_<costume>.png` with a
 * config.json giving each character's `eyesights` (where the face is, in the
 * image's pixels) and `image_sizes`. The popup places every character by its
 * face, so one layout fits all 26. The default is TSH's "full" pack (the VS
 * screen renders from Classic Mode, drawn facing right), found in an old TSH
 * install beside the app; `config.PORTRAITS_FOLDER` points anywhere else.
 * Stage pictures are TSH's `stage_icon` pack, beside it (or
 * `config.STAGE_ICONS_FOLDER`).
 *
 * Neither ships in the repo (the art isn't ours to commit). Without them the
 * popup simply has no portraits or stage pictures; nothing else changes.
 *
 * Served at /assets/portraits/ and /assets/stages/ (server/overlays.js).
 */

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..", "..");
/** Every pack is drawn as if its images were this tall, so the characters come out the same size. */
const NORMAL_HEIGHT = 940;
/** TSH's file names where they differ from char_map's codenames. */
const TSH_NAMES = { game_and_watch: "game_&_watch" };

/** The first folder that exists of: the configured one, overlays/assets/<sub>, an old TSH install's pack. */
function findFolder(configured, sub, tshPack) {
  const candidates = [];
  if (configured) candidates.push(path.resolve(configured));
  candidates.push(path.join(REPO, "overlays", "assets", sub));
  try {
    for (const d of fs.readdirSync(REPO)) {
      if (d.startsWith("TournamentStreamHelper")) candidates.push(path.join(REPO, d, "user_data", "games", "ssbm", tshPack));
    }
  } catch { /* no repo listing: only the configured folder */ }
  return candidates.find((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  }) ?? null;
}

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

/**
 * @param {{ PORTRAITS_FOLDER?: string|null, STAGE_ICONS_FOLDER?: string|null }} [config]
 */
function createPortraits(config = {}) {
  const dir = findFolder(config.PORTRAITS_FOLDER, "portraits", "full");
  const stagesDir = findFolder(config.STAGE_ICONS_FOLDER, "stages", "stage_icon");
  let pack = {};
  if (dir) {
    try { pack = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); } catch { pack = {}; }
  }
  const cache = new Map();

  /**
   * A character's portrait, or null when the pack has none.
   * @param {{ codename: string, skin?: number }|null} character
   * @returns {{ url: string, w: number, h: number, eye: [number, number], k: number, faces: "right" }|null}
   */
  function portraitOf(character) {
    if (!dir || !character?.codename) return null;
    const name = TSH_NAMES[character.codename] ?? character.codename;
    const skin = Number(character.skin) || 0;
    const key = `${name}:${skin}`;
    if (cache.has(key)) return cache.get(key);
    let file = `${name}_${skin}.png`;
    if (!fs.existsSync(path.join(dir, file))) file = `${name}_0.png`;
    let out = null;
    const size = fs.existsSync(path.join(dir, file)) ? pngSize(path.join(dir, file)) : null;
    if (size) {
      const eyes = pack.eyesights?.[name] ?? {};
      const e = eyes[String(skin)] ?? eyes["0"] ?? { x: size.w * 0.55, y: size.h * 0.35 };
      out = {
        url: `/assets/portraits/${encodeURIComponent(file)}`,
        w: size.w, h: size.h, eye: [e.x, e.y],
        k: Math.round((NORMAL_HEIGHT / size.h) * 1000) / 1000,
        faces: "right",
      };
    }
    cache.set(key, out);
    return out;
  }

  /** A stage picture's url, or null. */
  function stageIcon(icon) {
    if (!stagesDir || !icon) return null;
    return fs.existsSync(path.join(stagesDir, `${icon}.png`)) ? `/assets/stages/${icon}.png` : null;
  }

  return { dir, stagesDir, portraitOf, stageIcon, credits: pack.credits ?? null };
}

module.exports = { createPortraits, pngSize };
