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
          const isHandwarmer = wasHandwarmer(game);
          let winnerPlayerIndex = null;

          if (gameEnd.gameEndMethod === GameEndMethod.GAME) {
            const winner = gameEnd.placements?.find((p) => p.position === 0);
            winnerPlayerIndex = winner?.playerIndex ?? winnerByStocks(game);
          } else if (!isHandwarmer && gameEnd.lrasInitiatorIndex >= 0) {
            // Rage quit: LRAS but not a handwarmer (real damage was dealt).
            // In doubles, avoid awarding the point to the quitter's own partner —
            // find someone on the OTHER team by teamId.
            const settings = game.getSettings();
            const initiatorTeamId = settings?.players?.find(
              (p) => p.playerIndex === gameEnd.lrasInitiatorIndex
            )?.teamId;
            const otherPlayer = settings?.players?.find(
              (p) =>
                p.playerIndex !== gameEnd.lrasInitiatorIndex &&
                (initiatorTeamId == null || p.teamId !== initiatorTeamId)
            );
            console.log(`[bridge] Rage quit detected — port ${gameEnd.lrasInitiatorIndex} quit out`);
            winnerPlayerIndex = otherPlayer?.playerIndex ?? null;
          } else {
            // Non-GAME, non-LRAS end (e.g. RESOLVED in doubles when a team is eliminated
            // without a traditional per-stock GAME! sequence). Try placements first,
            // then fall back to last-frame stock counts.
            const winner = gameEnd.placements?.find((p) => p.position === 0);
            winnerPlayerIndex = winner?.playerIndex ?? winnerByStocks(game);
          }

          // Read winner's remaining stocks for crew battle carry-over tracking
          const latestFrame = game.getLatestFrame();
          const winnerEndStocks = (winnerPlayerIndex != null && winnerPlayerIndex >= 0)
            ? (latestFrame?.players?.[winnerPlayerIndex]?.post?.stocksRemaining ?? null)
            : null;

          emitter.emit("game-end", { winnerPlayerIndex, isHandwarmer, winnerEndStocks });
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
      emitter.emit("game-end", { winnerPlayerIndex: end.winnerPlayerIndex ?? null, isHandwarmer: false, winnerEndStocks: null });
    } else {
      emitter.emit("game-end", { winnerPlayerIndex: null, isHandwarmer: false, winnerEndStocks: null });
    }
  });

  livestream
    .start(config.CONSOLE_IP, config.CONSOLE_PORT)
    .then(() => console.log("[bridge] Connected to Slippi relay"))
    .catch((err) => console.error("[bridge] TCP connection failed:", err.message));

  return emitter;
}

module.exports = { createFolderSource, createTcpSource };
