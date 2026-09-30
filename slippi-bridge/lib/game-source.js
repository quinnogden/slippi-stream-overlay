/**
 * game-source.js — game events from the live .slp file Slippi is writing.
 *
 * createFolderSource returns a Node EventEmitter that fires:
 *   'game-start'  → (rawPlayers, stageId)
 *                   rawPlayers: array (same shape as slippi-js getSettings())
 *                   stageId:    Slippi stage ID (number | null when unavailable)
 *   'game-end'    → { winnerPlayerIndex, isHandwarmer }
 *   'highlight'   → one detected combo (when a detector is supplied and the
 *                   clipper is enabled)
 *
 * index.js binds to these events rather than reading .slp files itself, which
 * keeps the core handlers testable with a mock emitter.
 */

const fs           = require("fs");
const path         = require("path");
const EventEmitter = require("events");
const { SlippiGame, GameEndMethod } = require("@slippi/slippi-js");
const { wasHandwarmer } = require("./handwarmer");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fallback winner detection using last-frame stock counts.
 * Used when placements are absent or don't contain a position-0 entry
 * (can happen in doubles where the game ends via RESOLVED method).
 * Returns the playerIndex of any surviving player (port with stocks > 0),
 * or null if the last frame is unavailable.
 * @param {import("@slippi/slippi-js").SlippiGame} game
 * @returns {number | null}
 */
function winnerByStocks(game) {
  const lastFrame = game.getLatestFrame();
  if (!lastFrame?.players) return null;
  const surviving = Object.entries(lastFrame.players)
    .filter(([, pf]) => (pf?.pre?.stocksRemaining ?? 0) > 0)
    .map(([portStr]) => Number(portStr));
  return surviving[0] ?? null;
}

/**
 * Which port won, given how the game ended.
 *
 * Pure apart from the last-frame read in winnerByStocks, so it can be tested
 * against a stub game. Two cases:
 *   - A rage quit — LRAS that wasn't a handwarmer, by a known initiator — goes
 *     to someone on the OTHER team by teamId, never the quitter's doubles
 *     partner.
 *   - Everything else (a normal GAME!, or RESOLVED in doubles when a team is
 *     eliminated) takes the position-0 placement, falling back to last-frame
 *     stock counts when placements are missing.
 *
 * @param {object} gameEnd — game.getGameEnd()
 * @param {object|null} settings — game.getSettings()
 * @param {boolean} isHandwarmer
 * @param {() => number|null} byStocks — the last-frame fallback
 * @returns {number|null} winning playerIndex
 */
function pickWinner(gameEnd, settings, isHandwarmer, byStocks) {
  const quitter = gameEnd.lrasInitiatorIndex;
  const rageQuit = gameEnd.gameEndMethod !== GameEndMethod.GAME
    && !isHandwarmer && quitter != null && quitter >= 0;

  if (rageQuit) {
    const players = settings?.players ?? [];
    const quitterTeam = players.find((p) => p?.playerIndex === quitter)?.teamId;
    const other = players.find((p) =>
      p != null && p.playerIndex !== quitter && (quitterTeam == null || p.teamId !== quitterTeam));
    console.log(`[bridge] Rage quit detected — port ${quitter} quit out`);
    return other?.playerIndex ?? null;
  }

  const winner = gameEnd.placements?.find((p) => p.position === 0);
  return winner?.playerIndex ?? byStocks();
}

/**
 * The .slp files in the watched folder, as full paths.
 * @param {string} folder
 */
function listSlp(folder) {
  return fs.readdirSync(folder)
    .filter((f) => f.endsWith(".slp"))
    .map((f) => path.join(folder, f));
}

// ── Folder watcher ────────────────────────────────────────────────────────────

/**
 * Poll-based .slp file watcher. Does NOT use fs.watch (unreliable on Windows/OneDrive).
 * Scans the configured folder every 500ms for new .slp files.
 *
 * @param {{ SLP_FOLDER: string }} config
 * @param {{ isEnabled: () => boolean, reset: () => void, scan: (game: object) => object[] }} [detector]
 *        Optional combo detector (see combo-detector.js). Omitted → no highlights.
 * @returns {EventEmitter}
 */
function createFolderSource(config, detector) {
  const emitter = new EventEmitter();

  console.log(`[bridge] Folder mode — watching: ${config.SLP_FOLDER}`);

  if (!fs.existsSync(config.SLP_FOLDER)) {
    console.error(`[bridge] SLP_FOLDER does not exist: ${config.SLP_FOLDER}`);
    console.error("         Update SLP_FOLDER in config.js and restart.");
    process.exit(1);
  }

  // Snapshot pre-existing files so we ignore them on startup
  const knownFiles = new Set(listSlp(config.SLP_FOLDER));
  console.log(`[bridge] Ignoring ${knownFiles.size} pre-existing .slp file(s)`);

  let currentFile = null;
  let lastSize    = 0;
  let gameStarted = false;
  let gameEnded   = false;
  // ONE SlippiGame per file, not one per tick. processOnTheFly + the instance's
  // internal readPosition means each getStats() only parses the bytes appended
  // since the last call — which is what makes a 500ms live conversion scan
  // affordable. Rebuilding it every tick (as this did before combo detection)
  // would re-parse the whole file each time.
  let game        = null;
  let errorStreak = 0;

  setInterval(() => {
    try {
      // If no active game file, scan the folder for a new one
      if (!currentFile) {
        const newFile = listSlp(config.SLP_FOLDER).find((f) => !knownFiles.has(f));

        if (newFile) {
          currentFile = newFile;
          lastSize    = 0;
          gameStarted = false;
          gameEnded   = false;
          game        = null;
          errorStreak = 0;
          detector?.reset();
          console.log(`[bridge] New game file: ${path.basename(newFile)}`);
        }
      }

      if (!currentFile) return;

      const stat = fs.statSync(currentFile);
      if (stat.size === lastSize) return;
      lastSize = stat.size;

      if (!game) game = new SlippiGame(currentFile, { processOnTheFly: true });

      // Game start: fire once when settings become readable
      if (!gameStarted) {
        const settings = game.getSettings();
        if (settings?.players) {
          gameStarted = true;
          emitter.emit("game-start", settings.players, settings.stageId ?? null);
        }
      }

      // Guard against a poisoned parser. A live .slp carries rawDataLength = 0 in
      // its header until Slippi closes it, so the parser stops at the last
      // complete command. But a file whose header already declares the FULL
      // length while its bytes are still arriving — a finished replay landing in
      // the folder via OneDrive sync, which this setup is wide open to — makes
      // iterateEvents run off the end of the real data and leave readPosition
      // past EOF. It never recovers: game-end would never fire and the rest of
      // the set would go unscored. Rebuilding from scratch re-reads what's
      // actually there, which is exactly how this behaved before the parser
      // became persistent.
      if (typeof game.readPosition === "number" && game.readPosition > stat.size) {
        console.warn(`[bridge] Parser read past EOF on ${path.basename(currentFile)} ` +
                     `(pos ${game.readPosition} > size ${stat.size}) — rebuilding`);
        game = null;
        return;
      }

      // Live combo detection. Deliberately before the game-end block so the last
      // combo of a game — usually the best one — is caught on the same tick the
      // game ends. Isolated from scoring: a detector fault must never stop a
      // point being awarded, so it can't reach the catch below.
      if (gameStarted && detector?.isEnabled()) {
        try {
          for (const hit of detector.scan(game)) emitter.emit("highlight", hit);
        } catch (e) {
          console.warn(`[clipper] Combo scan failed: ${e.message}`);
        }
      }

      // Game end: check for completion
      if (!gameEnded) {
        const gameEnd = game.getGameEnd();
        if (gameEnd) {
          gameEnded = true;
          const isHandwarmer = wasHandwarmer(game);
          const winnerPlayerIndex = pickWinner(
            gameEnd, game.getSettings(), isHandwarmer, () => winnerByStocks(game));

          emitter.emit("game-end", { winnerPlayerIndex, isHandwarmer });
          knownFiles.add(currentFile);
          currentFile = null;
          game        = null;
        }
      }

      errorStreak = 0;
    } catch (_e) {
      // File may be mid-write; ignore transient errors.
      //
      // The parser resumes from a byte offset and only consumes fully-written
      // commands, so a partial write is normal and self-corrects. But the game
      // instance now lives for the whole game rather than one tick, so a parser
      // that somehow does get stuck would stay stuck and silently cost the rest
      // of the set. Rebuild it after ~5s of continuous failure; re-parsing from
      // scratch re-emits nothing (game-start is latched, the detector remembers
      // which conversions it has seen).
      if (++errorStreak >= 10) {
        console.warn(`[bridge] Repeated read errors on ${path.basename(currentFile ?? "")} — rebuilding parser`);
        game        = null;
        errorStreak = 0;
      }
    }
  }, 500);

  // Health probe for the control panel: "connected" as long as the watched
  // folder is still readable (OneDrive paths can vanish mid-session).
  emitter.getStatus = () => ({
    connected: fs.existsSync(config.SLP_FOLDER),
    detail: config.SLP_FOLDER,
  });

  return emitter;
}

module.exports = { createFolderSource, pickWinner };
