/**
 * game-source.js — mode-agnostic game event emitters.
 *
 * Both factories return a Node EventEmitter that fires:
 *   'game-start'  → rawPlayers array (same shape as slippi-js / slp-realtime)
 *   'game-end'    → winnerPlayerIndex (number | null)
 *
 * index.js binds to these events and never calls mode-specific code directly.
 * This makes each mode independently replaceable and the core handlers testable
 * with a mock emitter.
 */

const fs           = require("fs");
const path         = require("path");
const EventEmitter = require("events");
const { SlippiGame, GameEndMethod } = require("@slippi/slippi-js");

// ── Folder mode ───────────────────────────────────────────────────────────────

/**
 * Poll-based .slp file watcher. Does NOT use fs.watch (unreliable on Windows/OneDrive).
 * Scans the configured folder every 500ms for new .slp files.
 *
 * @param {{ SLP_FOLDER: string }} config
 * @returns {EventEmitter}
 */
function createFolderSource(config) {
  const emitter = new EventEmitter();

  console.log(`[bridge] Folder mode — watching: ${config.SLP_FOLDER}`);

  if (!fs.existsSync(config.SLP_FOLDER)) {
    console.error(`[bridge] SLP_FOLDER does not exist: ${config.SLP_FOLDER}`);
    console.error("         Update SLP_FOLDER in config.js and restart.");
    process.exit(1);
  }

  // Snapshot pre-existing files so we ignore them on startup
  const knownFiles = new Set(
    fs.readdirSync(config.SLP_FOLDER)
      .filter((f) => f.endsWith(".slp"))
      .map((f) => path.join(config.SLP_FOLDER, f))
  );
  console.log(`[bridge] Ignoring ${knownFiles.size} pre-existing .slp file(s)`);

  let currentFile = null;
  let lastSize    = 0;
  let gameStarted = false;
  let gameEnded   = false;

  setInterval(() => {
    try {
      // If no active game file, scan the folder for a new one
      if (!currentFile) {
        const newFile = fs
          .readdirSync(config.SLP_FOLDER)
          .filter((f) => f.endsWith(".slp"))
          .map((f) => path.join(config.SLP_FOLDER, f))
          .find((f) => !knownFiles.has(f));

        if (newFile) {
          currentFile = newFile;
          lastSize    = 0;
          gameStarted = false;
          gameEnded   = false;
          console.log(`[bridge] New game file: ${path.basename(newFile)}`);
        }
      }

      if (!currentFile) return;

      const stat = fs.statSync(currentFile);
      if (stat.size === lastSize) return;
      lastSize = stat.size;

      const game = new SlippiGame(currentFile, { processOnTheFly: true });

      // Game start: fire once when settings become readable
      if (!gameStarted) {
        const settings = game.getSettings();
        if (settings?.players) {
          gameStarted = true;
          emitter.emit("game-start", settings.players);
        }
      }

      // Game end: check for completion
      if (!gameEnded) {
        const gameEnd = game.getGameEnd();
        if (gameEnd) {
          gameEnded = true;
          if (gameEnd.gameEndMethod === GameEndMethod.GAME) {
            const winner = gameEnd.placements?.find((p) => p.position === 0);
            emitter.emit("game-end", winner?.playerIndex ?? null);
          } else {
            emitter.emit("game-end", null);
          }
          knownFiles.add(currentFile);
          currentFile = null;
        }
      }
    } catch (_e) {
      // File may be mid-write; ignore transient errors
    }
  }, 500);

  return emitter;
}

// ── TCP mode ──────────────────────────────────────────────────────────────────

/**
 * Connect directly to a Slippi Wii via slp-realtime observables.
 *
 * @param {{ CONSOLE_IP: string, CONSOLE_PORT: number }} config
 * @returns {EventEmitter}
 */
function createTcpSource(config) {
  const emitter = new EventEmitter();

  console.log(`[bridge] TCP mode — connecting to ${config.CONSOLE_IP}:${config.CONSOLE_PORT}`);

  const { SlpLiveStream, SlpRealTime } = require("@vinceau/slp-realtime");
  const { GameEndMethod: GEM } = require("@slippi/slippi-js");

  const livestream = new SlpLiveStream("console");
  const realtime   = new SlpRealTime();
  realtime.setStream(livestream);

  realtime.game.start$.subscribe((start) => {
    console.log("[bridge] Game start detected (TCP)");
    emitter.emit("game-start", start.players ?? []);
  });

  realtime.game.end$.subscribe((end) => {
    console.log("[bridge] Game end detected (TCP)");
    if (end.gameEndMethod === GEM.GAME) {
      emitter.emit("game-end", end.winnerPlayerIndex ?? null);
    } else {
      emitter.emit("game-end", null);
    }
  });

  livestream
    .start(config.CONSOLE_IP, config.CONSOLE_PORT)
    .then(() => console.log("[bridge] Connected to Slippi relay"))
    .catch((err) => console.error("[bridge] TCP connection failed:", err.message));

  return emitter;
}

module.exports = { createFolderSource, createTcpSource };
