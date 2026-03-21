/**
 * slippi-bridge
 *
 * Connects to a Slippi console mirror (TCP via slp-realtime) or live .slp file folder,
 * then pushes game events to:
 *   1. TSH via HTTP  — auto-increments score when a game ends
 *   2. Socket.io     — pushes character/game data to OBS browser sources
 *
 * Config: edit config.js before running.
 * Start:  node index.js
 */

const http    = require("http");
const express = require("express");
const { Server } = require("socket.io");

const { resolveCharacter }               = require("./char_map");
const config                             = require("./config");
const PortMapper                         = require("./port-mapper");
const TshClient                          = require("./tsh-client");
const { createFolderSource, createTcpSource } = require("./game-source");

// ── TSH root path ─────────────────────────────────────────────────────────────
const path    = require("path");
const TSH_ROOT = path.resolve(__dirname, "../TournamentStreamHelper-5.967");

// ── Express + Socket.io server ────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log(`[bridge] Layout connected: ${socket.id}`);
  if (currentGameState) {
    socket.emit("slippi_game_start", currentGameState);
  }
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] ERROR: Port ${config.BRIDGE_PORT} is already in use.`);
    console.error(`         Another instance of slippi-bridge is probably still running.`);
    console.error(`         Run this to find and kill it:`);
    console.error(`           netstat -ano | findstr :${config.BRIDGE_PORT}`);
    console.error(`         then: taskkill /PID <pid> /F`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(config.BRIDGE_PORT, () => {
  console.log(`[bridge] Socket.io server listening on port ${config.BRIDGE_PORT}`);
});

// ── Core services ─────────────────────────────────────────────────────────────
const portMapper = new PortMapper();
const tsh        = new TshClient(config, TSH_ROOT);

// ── Game state ────────────────────────────────────────────────────────────────
let currentGameState = null;

// ── Game event handlers ───────────────────────────────────────────────────────

/**
 * Pure: resolve character + team for each player, return players map.
 * No side effects — all decisions come from portMapper.
 *
 * @param {Array} sorted  — players sorted ascending by playerIndex
 * @returns {Object}  players keyed as "p1", "p2"
 */
function buildPlayers(sorted) {
  const players = {};
  [sorted[0], sorted[sorted.length - 1]].forEach((raw, i) => {
    const teamNum     = portMapper.getTeam(raw.playerIndex, i + 1);
    const costumeIndex = raw.characterColor ?? 0;
    const charInfo    = resolveCharacter(raw.characterId, costumeIndex, TSH_ROOT);
    if (!charInfo) {
      console.warn(`[bridge] Unknown character ID: ${raw.characterId}`);
      return;
    }
    players[`p${teamNum}`] = {
      playerIndex: raw.playerIndex,
      teamNum,
      costumeIndex,
      codename:  charInfo.codename,
      display:   charInfo.display,
      iconPath:  charInfo.iconPath,
    };
    console.log(`[bridge] P${teamNum} (port ${raw.playerIndex}): ${charInfo.display} costume ${costumeIndex}`);
  });
  return players;
}

/**
 * Called by the game source when a new game starts.
 * @param {Array} rawPlayers — from slippi-js or slp-realtime
 */
function onGameStart(rawPlayers) {
  // Read TSH state once; all downstream calls receive data, not file handles.
  let tshState = null;
  try {
    tshState = tsh.readState();
  } catch (e) {
    console.warn(e.message);
  }

  // Update port→team mapping from TSH state (handles resets, name/score matching)
  if (tshState) {
    portMapper.resolve(
      tsh.getTeamInfo(tshState, 1),
      tsh.getTeamInfo(tshState, 2)
    );
  }

  const sorted = rawPlayers
    .filter((p) => p != null && p.characterId != null)
    .sort((a, b) => a.playerIndex - b.playerIndex);

  if (sorted.length < 2) {
    console.warn("[bridge] Fewer than 2 players found; skipping game start");
    return;
  }

  // At 0-0 (no active mapping), try TSH character history before positional default
  if (!portMapper.hasMapping() && tshState) {
    portMapper.tryCharacterBased(
      sorted,
      tsh.getPreloadedChars(tshState),
      resolveCharacter,
      TSH_ROOT
    );
  }

  const players = buildPlayers(sorted);
  currentGameState = { players };

  // Push character + costume to TSH (fire-and-forget; log on failure)
  for (const p of Object.values(players)) {
    tsh.setCharacter(p.teamNum, p.display, p.costumeIndex).then((r) => {
      if (!r.ok) console.warn(`[bridge] setCharacter failed: ${r.error}`);
    });
  }

  // Sync port→name for future game detection, initialise portScore if needed
  if (tshState) {
    const teamInfo = {
      1: tsh.getTeamInfo(tshState, 1),
      2: tsh.getTeamInfo(tshState, 2),
    };
    portMapper.syncNames(players, teamInfo);
  }

  io.emit("slippi_game_start", currentGameState);
  console.log("[bridge] Emitted slippi_game_start");
}

/**
 * Called by the game source when a game ends.
 * @param {{ winnerPlayerIndex: number|null, isHandwarmer: boolean }} event
 */
function onGameEnd({ winnerPlayerIndex, isHandwarmer }) {
  if (isHandwarmer) {
    console.log("[bridge] Handwarmer detected — suppressing score increment.");
    currentGameState = null;
    return;
  }

  if (winnerPlayerIndex == null || winnerPlayerIndex < 0) {
    console.log("[bridge] Game ended with no winner (LRA-start or no contest).");
    io.emit("slippi_game_end", { winner: null });
    currentGameState = null;
    return;
  }

  const winnerEntry =
    currentGameState &&
    Object.values(currentGameState.players).find((p) => p.playerIndex === winnerPlayerIndex);

  if (winnerEntry) {
    portMapper.recordWin(winnerPlayerIndex);
    console.log(`[bridge] Game over — team ${winnerEntry.teamNum} wins (port ${winnerPlayerIndex})`);
    io.emit("slippi_game_end", { winner: winnerEntry.teamNum });
    tsh.incrementScore(winnerEntry.teamNum).then((r) => {
      if (!r.ok) console.warn(`[bridge] incrementScore failed: ${r.error}`);
    });
  } else {
    console.warn(`[bridge] Winner port ${winnerPlayerIndex} not found in current game state`);
    io.emit("slippi_game_end", { winner: null });
  }

  currentGameState = null;
}

// ── Manual port-team swap (keyboard shortcut) ─────────────────────────────────
// Ctrl+Shift+S flips the port→team assignment and immediately re-applies
// characters to TSH so the visual result is instant.
function swapTeams() {
  const result = portMapper.swap(currentGameState?.players);

  if (!result) {
    console.log("[bridge] Nothing to swap yet — no port mapping established");
    return;
  }

  // Update teamNum in currentGameState and re-push to TSH mid-game
  if (currentGameState?.players) {
    for (const p of Object.values(currentGameState.players)) {
      p.teamNum = portMapper.getTeam(p.playerIndex, p.teamNum);
    }
    for (const p of Object.values(currentGameState.players)) {
      tsh.setCharacter(p.teamNum, p.display, p.costumeIndex).then((r) => {
        if (!r.ok) console.warn(`[bridge] setCharacter failed after swap: ${r.error}`);
      });
    }
    io.emit("slippi_game_start", currentGameState);
    console.log("[bridge] Re-applied characters after swap");
  }
}

// ── Global keyboard listener ──────────────────────────────────────────────────
// Ctrl+Shift+S fires swapTeams() regardless of which window is focused.
try {
  const { UiohookKey, uIOhook } = require("uiohook-napi");
  uIOhook.on("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.keycode === UiohookKey.S) {
      swapTeams();
    }
  });
  uIOhook.start();
} catch (_err) {
  // uiohook-napi unavailable — fall back to terminal keypresses
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      if (key === "\u0003") process.exit();
      if (key === "s" || key === "S") swapTeams();
    });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
console.log("[bridge] Starting slippi-bridge...");
console.log(`[bridge] TSH URL:        ${config.TSH_URL}`);
console.log(`[bridge] Scoreboard:     ${config.SCOREBOARD_NUM}`);
console.log(`[bridge] Bridge port:    ${config.BRIDGE_PORT}`);
console.log(`[bridge] Keyboard:       Ctrl+Shift+S = swap teams`);
console.log();

const source = config.CONNECTION_MODE === "folder"
  ? createFolderSource(config)
  : createTcpSource(config);

source.on("game-start", onGameStart);
source.on("game-end",   onGameEnd);
