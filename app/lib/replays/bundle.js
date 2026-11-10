/**
 * bundle.js — one stream set's replay bundle: its .slp files and its
 * context.json in one folder, with each file's size and SHA-256.
 *
 * The same bundle is archived (archive.js) and uploaded (uploader.js); its
 * `digest` (over every path, size and checksum) is how both tell "already
 * done" from "changed since": a game fixed in the Replays tab is a new digest,
 * so a new upload revision and a fresh archive copy.
 *
 * LuckyStats' rules for a bundle: exactly one context.json, sharing one folder
 * with the set's game files, and context.json ≤ 1 MiB.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildContext, contextProblem } = require("./context");
const { isFinished, readReplay } = require("./slp-file");

const CONTEXT_MAX_BYTES = 1024 * 1024;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** A file or folder name Windows and S3 both accept. */
function safeName(text, fallback = "set") {
  const s = String(text ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 100);
  return s || fallback;
}

/** A side's name: the team name in doubles, else its players' tags. */
function sideName(side) {
  return side.teamName || side.players.map((p) => p.tag).filter(Boolean).join(" + ") || "?";
}

/**
 * The folder a set's bundle lives in: "<round> - <left> vs <right> (<set id>)".
 * The id keeps two sets between the same players apart.
 */
function folderName(record) {
  const round = record.meta?.set?.fullRoundText || record.roundName || "Set";
  return safeName(`${round} - ${sideName(record.sides[0])} vs ${sideName(record.sides[1])} (${record.setId})`);
}

/**
 * Read the set's files and build its bundle.
 * @param {object} record — a stream-sets.js record
 * @param {{ requireMeta?: boolean }} [opts] — requireMeta: refuse without start.gg's meta (uploads need it)
 * @returns {{ ok: true, folder: string, digest: string, context: object,
 *             files: Array<{ path: string, size: number, sha256: string, contentType: string, data?: Buffer, source?: string }> }
 *          | { ok: false, error: string, waiting?: boolean }}
 *   waiting: a file is still being written — try again shortly, it isn't broken
 */
function buildBundle(record, opts = {}) {
  const problem = contextProblem(record);
  if (problem) return { ok: false, error: problem };
  if (opts.requireMeta && !record.meta) return { ok: false, error: "start.gg's details for this set haven't loaded", waiting: true };

  // Refine each game's timing from its finished file (the live read stopped
  // at GAME!, and the metadata's startAt is Slippi's own clock).
  const games = [];
  const slp = [];
  for (const [i, g] of record.games.entries()) {
    const file = g.replay.file;
    if (!fs.existsSync(file)) return { ok: false, error: `Game ${i + 1}'s replay is gone: ${file}` };
    if (!isFinished(file)) return { ok: false, error: `Game ${i + 1}'s replay is still being written`, waiting: true };
    const info = readReplay(file);
    const replay = { ...g.replay };
    if (info.ok) {
      if (Number.isFinite(info.lastFrame)) replay.lastFrame = info.lastFrame;
      if (Number.isFinite(info.startMs)) replay.startMs = info.startMs;
    }
    games.push({ ...g, replay });
    slp.push(file);
  }

  let context;
  try {
    context = buildContext({ ...record, games }, record.meta ?? null, { startMs: games[0].replay.startMs ?? undefined });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const contextData = Buffer.from(JSON.stringify(context));
  if (contextData.length > CONTEXT_MAX_BYTES) return { ok: false, error: "context.json is over LuckyStats' 1 MiB limit" };

  const folder = folderName(record);
  const files = [{ path: `${folder}/context.json`, size: contextData.length, sha256: sha256(contextData), contentType: "application/json", data: contextData }];
  const used = new Set();
  for (const file of slp) {
    let name = safeName(path.basename(file), "game.slp");
    while (used.has(name.toLowerCase())) name = name.replace(/(\.slp)?$/i, "_2.slp");
    used.add(name.toLowerCase());
    const data = fs.readFileSync(file);
    files.push({ path: `${folder}/${name}`, size: data.length, sha256: sha256(data), contentType: "application/octet-stream", source: file });
  }

  const digest = sha256(Buffer.from(JSON.stringify(files.map((f) => [f.path, f.size, f.sha256]))));
  return { ok: true, folder, digest, context, files };
}

/** A bundle file's bytes (context.json is held in memory, games are read again). */
function fileData(f) {
  return f.data ?? fs.readFileSync(f.source);
}

module.exports = { buildBundle, fileData, folderName, safeName, sha256 };
