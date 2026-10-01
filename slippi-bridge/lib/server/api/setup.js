/**
 * The dock's Setup tab: what OBS and the operator need to know about this
 * machine's app — the overlay urls to paste into browser sources, the dock's
 * addresses for a phone, the hotkeys actually bound, and where the app's files
 * are. Read only.
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

/**
 * The pack overlays/theme.css @imports — the one line that re-skins the
 * broadcast. Null when it can't be read.
 * @param {string} overlaysDir
 */
function activeThemePack(overlaysDir) {
  try {
    const css = fs.readFileSync(path.join(overlaysDir, "theme.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return /@import\s+url\(\s*["']?\.\/themes\/([^/"')]+)\//.exec(css)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {import("express").Express} app
 * @param {object} deps — { setupInfo: () => object }, built in index.js from
 *   what only the composition root knows (config, the hotkeys it installed)
 */
function register(app, { setupInfo }) {
  app.get("/api/setup", (req, res) => {
    res.json({ ok: true, overlays: OVERLAYS, ...setupInfo() });
  });
}

module.exports = { register, OVERLAYS, activeThemePack };
