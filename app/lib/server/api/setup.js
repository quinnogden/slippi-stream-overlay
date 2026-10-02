/**
 * The dock's Setup tab: what OBS and the operator need to know about this
 * machine's app — the overlay urls to paste into browser sources, the dock's
 * addresses for a phone, the hotkeys actually bound, and where the app's files
 * are. Read only, apart from the theme switch.
 */

const fs   = require("fs");
const path = require("path");

/** Every OBS browser source, in the order a scene collection is built. */
const OVERLAYS = [
  { name: "Scoreboard",  path: "/o/scoreboard",         size: "1920×1080" },
  { name: "Players bar", path: "/o/scoreboard/players", size: "1920×1080" },
  { name: "Side panel",  path: "/o/side-panel",         size: "611×1080" },
  { name: "Bracket",     path: "/o/bracket",            size: "1920×1080", note: "Follows the Bracket tab's view; add ?view=top8 to pin one" },
  { name: "Highlights",  path: "/o/highlights",         size: "1920×1080", note: "Add ?guides=1 to line it up with the clip and cams" },
  { name: "Casters",     path: "/o/casters",            size: "any",       note: "Every caster in one row; ?i=0, ?i=1 … for one per cam" },
];

/** The live @import in overlays/theme.css — at the start of a line, so the
 *  header comment's mentions of "@import" never match. */
const IMPORT_LINE = /^@import\s+url\(\s*["']?\.\/themes\/([^/"')]+)\/theme\.css["']?\s*\)\s*;/m;

/**
 * The pack overlays/theme.css @imports — the one line that re-skins the
 * broadcast. Null when it can't be read.
 * @param {string} overlaysDir
 */
function activeThemePack(overlaysDir) {
  try {
    return IMPORT_LINE.exec(fs.readFileSync(path.join(overlaysDir, "theme.css"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Every pack under overlays/themes/ — a folder with a theme.css in it.
 * @param {string} overlaysDir
 * @returns {string[]}
 */
function themePacks(overlaysDir) {
  const dir = path.join(overlaysDir, "themes");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "theme.css")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * theme.css with its @import pointed at `pack`, everything else (the header
 * comment) untouched. Null when there's no @import line to point — rewriting
 * a file we don't recognise could put the @import after another rule, where
 * the browser silently drops it and every overlay goes unstyled.
 * @param {string} css
 * @param {string} pack
 */
function withThemePack(css, pack) {
  if (!IMPORT_LINE.test(css)) return null;
  return css.replace(IMPORT_LINE, `@import url("./themes/${pack}/theme.css");`);
}

/**
 * Point overlays/theme.css at `pack`. Atomic (temp + rename), so a crash
 * mid-write can't leave every overlay without a theme.
 * @returns {{ ok: true, pack: string, changed: boolean } | { ok: false, error: string }}
 */
function setThemePack(overlaysDir, pack) {
  if (!themePacks(overlaysDir).includes(pack)) return { ok: false, error: `No theme pack "${pack}" in overlays/themes/` };
  const file = path.join(overlaysDir, "theme.css");
  let css;
  try {
    css = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, error: `Couldn't read overlays/theme.css: ${err.message}` };
  }
  const next = withThemePack(css, pack);
  if (next === null) return { ok: false, error: "overlays/theme.css has no @import line to switch" };
  if (next === css) return { ok: true, pack, changed: false };
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    return { ok: false, error: `Couldn't write overlays/theme.css: ${err.message}` };
  }
  return { ok: true, pack, changed: true };
}

/**
 * @param {import("express").Express} app
 * @param {object} deps — { setupInfo: () => object, overlaysDir, emit }:
 *   setupInfo is built in index.js from what only the composition root knows
 *   (config, the hotkeys it installed); emit is the overlay channel's.
 */
function register(app, { setupInfo, overlaysDir, emit }) {
  app.get("/api/setup", (req, res) => {
    res.json({ ok: true, overlays: OVERLAYS, ...setupInfo() });
  });

  // Every overlay reloads into the new pack on the `theme` event; the dock
  // follows it too, so a second dock (a phone) shows the switch.
  app.post("/api/theme", (req, res) => {
    const r = setThemePack(overlaysDir, String(req.body?.pack ?? ""));
    if (!r.ok) return res.status(400).json(r);
    if (r.changed) {
      console.log(`[theme] Switched to ${r.pack}`);
      emit("theme_changed", { pack: r.pack });
    }
    res.json(r);
  });
}

module.exports = { register, OVERLAYS, activeThemePack, themePacks };
