/**
 * slp-file.js — what the replay bundle needs to know about a .slp on disk.
 *
 *   isFinished(file)   Slippi has closed it. A live .slp carries a zero raw
 *                      length in its header until then (game-source.js relies
 *                      on the same field), and a bundle of a file still being
 *                      written would fail LuckyStats' checksum the moment it
 *                      grew.
 *   readReplay(file)   a finished file's players, start time and length — for
 *                      a game the operator attaches by hand, and to refine the
 *                      live game's timing once the file has its metadata.
 *   recentFiles(dir)   the folder's newest .slp files, for the attach picker.
 */

const fs = require("fs");
const path = require("path");

// '{' 'U' 0x03 'r' 'a' 'w' '[' '$' 'U' '#' 'l' then the raw element's length
// as a big-endian int32 (the .slp spec, UBJSON).
const RAW_LENGTH_OFFSET = 11;

// How far a replay's own start time may sit from the PC's before the PC wins.
// A console's clock is routinely wrong — an hour off after a daylight-saving
// change, a year off after a battery dies (seen at PROTOCOL's weeklies) — and
// a wrong start puts the set on the wrong day on LuckyStats.
const CLOCK_SLACK_MS = 2 * 60000;

/**
 * A game's start time: the replay's own (`metaMs`, the metadata's startAt)
 * while it agrees with the PC's (`pcMs`: when the app saw the file appear, or
 * the file's creation time), else the PC's. Either may be missing.
 * @returns {number|null}
 */
function trustedStart(metaMs, pcMs) {
  const meta = Number.isFinite(metaMs) ? metaMs : null;
  const pc = Number.isFinite(pcMs) && pcMs > 0 ? pcMs : null;
  if (meta == null) return pc;
  if (pc == null || Math.abs(meta - pc) <= CLOCK_SLACK_MS) return meta;
  return pc;
}

/**
 * Whether Slippi has finished writing the file.
 * @param {string} file
 * @returns {boolean}
 */
function isFinished(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(RAW_LENGTH_OFFSET + 4);
    if (fs.readSync(fd, head, 0, head.length, 0) < head.length) return false;
    return head.readInt32BE(RAW_LENGTH_OFFSET) > 0;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * A finished replay's facts. slippi-js is required lazily (it's heavy, and the
 * tests that never read a file needn't load it).
 * @param {string} file
 * @returns {{ ok: true, startMs: number|null, lastFrame: number|null, stageId: number|null,
 *             players: Array<{ port: number, characterId: number, costume: number, teamId: number|null }>,
 *             isTeams: boolean, winnerPort: number|null } | { ok: false, error: string }}
 */
function readReplay(file) {
  try {
    const { SlippiGame } = require("@slippi/slippi-js");
    const game = new SlippiGame(file);
    const settings = game.getSettings();
    if (!settings?.players) return { ok: false, error: `${path.basename(file)} isn't a readable replay` };
    const meta = game.getMetadata() ?? {};
    const players = settings.players
      .filter((p) => p && p.characterId != null)
      .map((p) => ({ port: p.playerIndex, characterId: p.characterId, costume: p.characterColor ?? 0, teamId: p.teamId ?? null }))
      .sort((a, b) => a.port - b.port);
    const end = game.getGameEnd();
    const winner = end?.placements?.find((x) => x.position === 0)?.playerIndex ?? null;
    const started = meta.startAt ? Date.parse(meta.startAt) : NaN;
    // The file was created on this PC when the game started (Slippi writes it live).
    let createdMs = null;
    try { createdMs = fs.statSync(file).birthtimeMs || null; } catch (_) { /* no stat: the replay's own time stands */ }
    return {
      ok: true,
      startMs: trustedStart(started, createdMs),
      lastFrame: Number.isFinite(meta.lastFrame) ? meta.lastFrame : (game.getLatestFrame()?.frame ?? null),
      stageId: settings.stageId ?? null,
      players,
      isTeams: !!settings.isTeams,
      winnerPort: winner,
    };
  } catch (err) {
    return { ok: false, error: `Couldn't read ${path.basename(file)}: ${err.message}` };
  }
}

/**
 * The newest .slp files in a folder, newest first.
 * @param {string} dir
 * @param {number} [limit]
 * @returns {Array<{ file: string, name: string, mtimeMs: number, size: number }>}
 */
function recentFiles(dir, limit = 40) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".slp"));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ file: path.join(dir, name), name, mtimeMs: st.mtimeMs, size: st.size });
    } catch (_) { /* gone between the listing and the stat */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

module.exports = { isFinished, readReplay, recentFiles, trustedStart, CLOCK_SLACK_MS };
