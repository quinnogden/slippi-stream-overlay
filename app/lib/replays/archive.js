/**
 * archive.js — a copy of each stream set's bundle on this machine:
 *
 *   <REPLAY_ARCHIVE_FOLDER>/<tournament>/<round> - <left> vs <right> (<set id>)/
 *       context.json
 *       Game_….slp …
 *
 * The same folder Replay Reporter would write for the set, so anything that
 * reads Replay Reporter's per-set replays (Auto VODs, a TO's own uploads) can
 * read these. It COPIES: SLP_FOLDER is Slippi's, and nothing here deletes or
 * moves a file in it. A re-archive of a corrected set rewrites its folder and
 * removes what the old bundle had that the new one doesn't (only .slp files
 * and context.json — anything else in the folder is someone else's).
 */

const fs = require("fs");
const path = require("path");
const { fileData, safeName } = require("./bundle");

/**
 * @param {ReturnType<import("./bundle").buildBundle>} bundle — an ok bundle
 * @param {string} root — REPLAY_ARCHIVE_FOLDER
 * @param {string} tournamentSlug — "tournament/<slug>"
 * @returns {{ ok: true, dir: string } | { ok: false, error: string }}
 */
function archiveBundle(bundle, root, tournamentSlug) {
  try {
    const tournament = safeName(String(tournamentSlug ?? "").replace(/^tournament\//, ""), "tournament");
    const dir = path.join(root, tournament, bundle.folder);
    fs.mkdirSync(dir, { recursive: true });
    const keep = new Set();
    for (const f of bundle.files) {
      const name = f.path.slice(bundle.folder.length + 1);
      keep.add(name.toLowerCase());
      const dest = path.join(dir, name);
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, fileData(f));
      fs.renameSync(tmp, dest);
    }
    for (const name of fs.readdirSync(dir)) {
      const lower = name.toLowerCase();
      if ((lower.endsWith(".slp") || lower === "context.json") && !keep.has(lower)) fs.unlinkSync(path.join(dir, name));
    }
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, error: `Couldn't archive the set: ${err.message}` };
  }
}

module.exports = { archiveBundle };
