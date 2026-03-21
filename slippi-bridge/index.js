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

// ── Melee in-game team colors (red / blue / green) ────────────────────────────
const MELEE_TEAM_COLORS = {
  0: "#D32F2F", // Red team
  1: "#1565C0", // Blue team
  2: "#2E7D32", // Green team (rare in competitive)
};

// ── Game state ────────────────────────────────────────────────────────────────
let currentGameState = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when rawPlayers represents a doubles game (4 active players
 * with teamId assigned by Slippi).
 */
function isDoubles(rawPlayers) {
  const active = rawPlayers.filter((p) => p != null && p.characterId != null);
  return active.length === 4 && active.some((p) => p.teamId != null);
}

/**
 * Groups sorted players by Slippi teamId.
 * @returns {{ [teamId: number]: Array }}
 */
function groupByTeamId(sorted) {
  const groups = {};
  for (const raw of sorted) {
    const tid = raw.teamId ?? 0;
    (groups[tid] = groups[tid] ?? []).push(raw);
  }
  return groups;
}

/**
 * Pure: resolve character + team for each player in a singles game.
 * Uses first and last port (outer ports) as the two players.
 * @param {Array} sorted  — players sorted ascending by playerIndex
 * @returns {Object}  players keyed by playerIndex
 */
function buildPlayersSingles(sorted) {
  const players = {};
  [sorted[0], sorted[sorted.length - 1]].forEach((raw, i) => {
    const teamNum      = portMapper.getTeam(raw.playerIndex, i + 1);
    const costumeIndex = raw.characterColor ?? 0;
    const charInfo     = resolveCharacter(raw.characterId, costumeIndex, TSH_ROOT);
    if (!charInfo) {
      console.warn(`[bridge] Unknown character ID: ${raw.characterId}`);
      return;
    }
    players[raw.playerIndex] = {
      playerIndex: raw.playerIndex,
      teamNum,
      costumeIndex,
      codename: charInfo.codename,
      display:  charInfo.display,
      iconPath: charInfo.iconPath,
    };
    console.log(`[bridge] P${teamNum} (port ${raw.playerIndex}): ${charInfo.display} costume ${costumeIndex}`);
  });
  return players;
}

/**
 * Pure: assign team numbers to all 4 ports in a doubles game.
 * @param {Array} sorted  — all 4 players sorted ascending by playerIndex
 * @returns {Object}  players keyed by playerIndex
 */
function buildPlayersDoubles(sorted) {
  const players = {};
  for (let i = 0; i < sorted.length; i++) {
    const raw     = sorted[i];
    const teamNum = portMapper.getTeam(raw.playerIndex, i < 2 ? 1 : 2);
    players[raw.playerIndex] = { playerIndex: raw.playerIndex, teamNum };
    console.log(`[bridge] Doubles P${teamNum} (port ${raw.playerIndex})`);
  }
  return players;
}

// ── Game event handlers ───────────────────────────────────────────────────────

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

  const sorted = rawPlayers
    .filter((p) => p != null && p.characterId != null)
    .sort((a, b) => a.playerIndex - b.playerIndex);

  if (sorted.length < 2) {
    console.warn("[bridge] Fewer than 2 players found; skipping game start");
    return;
  }

  const doubles = isDoubles(rawPlayers) && (!tshState || tsh.isDoubles(tshState));

  if (doubles) {
    console.log("[bridge] Doubles game detected");
    onGameStartDoubles(sorted, tshState);
  } else {
    onGameStartSingles(sorted, tshState);
  }
}

function onGameStartSingles(sorted, tshState) {
  const t1Info = tshState ? tsh.getTeamInfo(tshState, 1) : { name: "", score: 0 };
  const t2Info = tshState ? tsh.getTeamInfo(tshState, 2) : { name: "", score: 0 };

  portMapper.resolve(t1Info, t2Info);

  if (!portMapper.hasMapping() && tshState) {
    portMapper.tryCharacterBased(
      sorted,
      tsh.getPreloadedChars(tshState),
      resolveCharacter,
      TSH_ROOT
    );
  }

  const players = buildPlayersSingles(sorted);
  currentGameState = { players, isDoubles: false };

  for (const p of Object.values(players)) {
    tsh.setCharacter(p.teamNum, p.display, p.costumeIndex).then((r) => {
      if (!r.ok) console.warn(`[bridge] setCharacter failed: ${r.error}`);
    });
  }

  if (tshState) {
    portMapper.syncNames(players, {
      1: tsh.getTeamPlayerNames(tshState, 1),
      2: tsh.getTeamPlayerNames(tshState, 2),
    });
  }

  io.emit("slippi_game_start", currentGameState);
  console.log("[bridge] Emitted slippi_game_start (singles)");
}

function onGameStartDoubles(sorted, tshState) {
  const groups = groupByTeamId(sorted);
  const t1Info = tshState ? tsh.getTeamInfo(tshState, 1) : { name: "", score: 0 };
  const t2Info = tshState ? tsh.getTeamInfo(tshState, 2) : { name: "", score: 0 };
  const t1Names = tshState ? tsh.getTeamPlayerNames(tshState, 1) : [];
  const t2Names = tshState ? tsh.getTeamPlayerNames(tshState, 2) : [];

  portMapper.resolveDoubles(groups, t1Info, t2Info, t1Names, t2Names);

  if (!portMapper.hasMapping() && tshState) {
    portMapper.tryCharacterBasedDoubles(
      groups,
      tsh.getPreloadedChars(tshState),
      resolveCharacter,
      TSH_ROOT
    );
  }

  // If both resolveDoubles (which returns early at 0-0) and tryCharacterBased
  // left _portToTeam null, apply the group-based positional default explicitly.
  // Without this, buildPlayersDoubles falls back to index-based positional
  // (first 2 sorted ports = team 1) which is wrong when Slippi groups are
  // non-consecutive (e.g. ports {0,3} vs {1,2}).
  if (!portMapper.hasMapping()) {
    portMapper.applyDoublesPositional(groups);
  }

  const players = buildPlayersDoubles(sorted);

  // Build teamColorMap: { [tshTeamNum]: hexColor } — used now and by swapTeams.
  //
  // When a resolved mapping exists (_portToTeam is set), resolveDoubles() assigned all
  // ports in a Slippi group atomically, so the min-port player's teamNum is the group's.
  //
  // When no mapping exists (0-0 start + inconclusive character history), buildPlayersDoubles
  // used index-based positional default (first 2 sorted ports → team 1). This does NOT align
  // with Slippi groups when teamIds are interleaved (e.g. tid 0,1,0,1 across ports 0-3) —
  // both groups' min ports land on team 1. In that case, replicate resolveDoubles' positional
  // rule directly: the Slippi group with the lower minimum port → TSH team 1.
  const teamColorMap = {};
  const colorGroupEntries = Object.entries(groups).filter(([tidStr]) => MELEE_TEAM_COLORS[Number(tidStr)]);

  if (portMapper.hasMapping()) {
    // Resolved mapping: all ports in a group share the same TSH team — use min-port player.
    for (const [tidStr, groupPlayers] of colorGroupEntries) {
      const tid = Number(tidStr);
      const minPortPlayer = groupPlayers.reduce((a, b) => a.playerIndex < b.playerIndex ? a : b);
      const tshTeam = players[minPortPlayer.playerIndex]?.teamNum;
      if (tshTeam) teamColorMap[tshTeam] = MELEE_TEAM_COLORS[tid];
    }
  } else if (colorGroupEntries.length >= 2) {
    // No resolved mapping: positional default — lower min-port Slippi group → TSH team 1.
    const ranked = colorGroupEntries
      .map(([tidStr, gp]) => ({ tid: Number(tidStr), minPort: Math.min(...gp.map((r) => r.playerIndex)) }))
      .sort((a, b) => a.minPort - b.minPort);
    teamColorMap[1] = MELEE_TEAM_COLORS[ranked[0].tid];
    teamColorMap[2] = MELEE_TEAM_COLORS[ranked[1].tid];
  }

  currentGameState = { players, isDoubles: true, teamColorMap };

  // Push colors to TSH
  for (const [tshTeamStr, color] of Object.entries(teamColorMap)) {
    tsh.setTeamColor(Number(tshTeamStr), color).then((r) => {
      if (!r.ok) console.warn(`[bridge] setTeamColor failed: ${r.error}`);
    });
  }

  if (tshState) {
    portMapper.syncNames(players, {
      1: t1Names,
      2: t2Names,
    });
  }

  io.emit("slippi_game_start", currentGameState);
  console.log("[bridge] Emitted slippi_game_start (doubles)");
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

  // currentGameState.players has the correct teamNum even when _portToTeam is null
  // (e.g. 0-0 start where positional default was used locally but not persisted).
  // Fall back to portMapper.getTeam() for games where currentGameState was cleared early.
  const winnerTeam =
    currentGameState?.players?.[winnerPlayerIndex]?.teamNum ??
    portMapper.getTeam(winnerPlayerIndex, null);

  if (winnerTeam) {
    portMapper.recordWin(winnerPlayerIndex);
    console.log(`[bridge] Game over — team ${winnerTeam} wins (port ${winnerPlayerIndex})`);
    io.emit("slippi_game_end", { winner: winnerTeam });
    tsh.incrementScore(winnerTeam).then((r) => {
      if (!r.ok) console.warn(`[bridge] incrementScore failed: ${r.error}`);
    });
  } else {
    console.warn(`[bridge] Winner port ${winnerPlayerIndex} not in port mapping`);
    io.emit("slippi_game_end", { winner: null });
  }

  currentGameState = null;
}

// ── Manual port-team swap (keyboard shortcut) ─────────────────────────────────
// Ctrl+Shift+S flips the port→team assignment and immediately re-applies
// characters/colors to TSH so the visual result is instant.
function swapTeams() {
  const result = portMapper.swap(currentGameState?.players);

  if (!result) {
    console.log("[bridge] Nothing to swap yet — no port mapping established");
    return;
  }

  if (!currentGameState?.players) return;

  // Update teamNum in currentGameState to reflect the swap
  for (const p of Object.values(currentGameState.players)) {
    p.teamNum = portMapper.getTeam(p.playerIndex, p.teamNum);
  }

  if (currentGameState.isDoubles) {
    // Doubles: swap the teamColorMap (team 1 ↔ team 2 colors) and re-push
    const old = currentGameState.teamColorMap ?? {};
    currentGameState.teamColorMap = { 1: old[2], 2: old[1] };
    for (const [tshTeamStr, color] of Object.entries(currentGameState.teamColorMap)) {
      if (!color) continue;
      tsh.setTeamColor(Number(tshTeamStr), color).then((r) => {
        if (!r.ok) console.warn(`[bridge] setTeamColor failed after swap: ${r.error}`);
      });
    }
    io.emit("slippi_game_start", currentGameState);
    console.log("[bridge] Re-applied team colors after doubles swap");
  } else {
    // Singles: re-push characters
    for (const p of Object.values(currentGameState.players)) {
      tsh.setCharacter(p.teamNum, p.display, p.costumeIndex).then((r) => {
        if (!r.ok) console.warn(`[bridge] setCharacter failed after swap: ${r.error}`);
      });
    }
    io.emit("slippi_game_start", currentGameState);
    console.log("[bridge] Re-applied characters after singles swap");
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
