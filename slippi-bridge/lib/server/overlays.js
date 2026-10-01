/**
 * Serves the OBS browser sources: the pages under `/o/`, their scripts and
 * styles, the theme packs and the character icons.
 *
 * Every url a page uses is absolute (`/o/shared/overlay.css`, not
 * `../shared/…`), so a source works whether OBS was given `/o/scoreboard` or
 * `/o/scoreboard/`. The one relative url left is inside a theme pack's custom
 * properties (`--logo-url: url("../themes/<pack>/logo.png")`), which Chrome
 * resolves against the stylesheet that *uses* the var() — so every overlay
 * stylesheet sits exactly one level under `/o/`.
 *
 * The theme switch and the packs are plain files under overlays/
 * (`/o/theme.css`, `/o/themes/<pack>/`), so the `/o/` mount serves them.
 *
 * tests/overlays-static.test.js resolves every page's urls through
 * resolveOverlayPath(), i.e. through these same tables.
 */

const fs      = require("fs");
const path    = require("path");
const express = require("express");

/** Page url → file under overlays/. */
const PAGES = {
  "/o/scoreboard":         "scoreboard/index.html",
  "/o/scoreboard/players": "scoreboard/players.html",
  "/o/casters":            "casters/index.html",
  "/o/side-panel":         "side-panel/index.html",
  "/o/highlights":         "highlights/index.html",
  "/o/bracket":            "bracket/index.html",
};

/**
 * Url prefix → directory, most specific first.
 * @param {{ overlaysDir: string }} roots
 */
function mounts({ overlaysDir }) {
  return [
    { url: "/assets/", dir: path.join(overlaysDir, "assets") },
    { url: "/o/",      dir: overlaysDir },
  ];
}

/**
 * The file a url would be served from, or null. Pure apart from the
 * existence check; the query string is ignored.
 */
function resolveOverlayPath(url, roots) {
  const clean = decodeURIComponent(String(url).split(/[?#]/)[0]);
  const page = PAGES[clean.replace(/\/$/, "")];
  if (page) return existing(path.join(roots.overlaysDir, page));

  for (const m of mounts(roots)) {
    if (!clean.startsWith(m.url)) continue;
    const file = path.resolve(m.dir, "." + clean.slice(m.url.length - 1));
    if (!file.startsWith(path.resolve(m.dir) + path.sep)) return null; // ../ escape
    const found = existing(file);
    if (found) return found;
  }
  return null;
}

function existing(file) {
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * @param {import("express").Express} app
 * @param {{ overlaysDir: string }} roots
 */
function registerOverlays(app, roots) {
  for (const [url, file] of Object.entries(PAGES)) {
    app.get([url, `${url}/`], (req, res) => res.sendFile(path.join(roots.overlaysDir, file)));
  }
  for (const m of mounts(roots)) {
    app.use(m.url.replace(/\/$/, ""), express.static(m.dir, { index: false, redirect: false }));
  }
}

module.exports = { registerOverlays, resolveOverlayPath, PAGES };
