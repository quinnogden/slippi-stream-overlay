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
const StartggClient                      = require("./startgg-client");
const { createFolderSource, createTcpSource } = require("./game-source");
const { resolveTshRoot }                 = require("./tsh-root");

// ── TSH root path ─────────────────────────────────────────────────────────────
// Auto-detected from the repo root unless config.TSH_ROOT pins it, so a TSH
// version bump doesn't require editing this file.
const path = require("path");

let TSH_ROOT;
try {
  TSH_ROOT = resolveTshRoot(path.resolve(__dirname, ".."), config.TSH_ROOT);
  console.log(`[bridge] TSH root: ${TSH_ROOT}`);
} catch (e) {
  console.error(`[bridge] ERROR: ${e.message}`);
  process.exit(1);
}

// ── Express + Socket.io server ────────────────────────────────────────────────
const app        = express();
app.use(express.json());
const httpServer = http.createServer(app);
const io         = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log(`[bridge] Layout connected: ${socket.id}`);
  if (currentGameState) {
    socket.emit("slippi_game_start", currentGameState);
  }
  // Give a freshly-connected control panel the latest status immediately.
  socket.emit("control_status", lastControlStatus);
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
const startgg    = new StartggClient(config);

// Assigned at the entry point; declared here so the control-status loop can
// read its connection health without a temporal-dead-zone reference.
let source = null;

// ── Melee in-game team colors (red / blue / green) ────────────────────────────
const MELEE_TEAM_COLORS = {
  0: "#D32F2F", // Red team
  1: "#1565C0", // Blue team
  2: "#2E7D32", // Green team (rare in competitive)
};

// ── Game state ────────────────────────────────────────────────────────────────
let currentGameState = null;

// ── Set tracking for start.gg reporting (singles/doubles only) ─────────────────
// currentSetGames accumulates one { gameNum, winnerTeam } per completed game so
// the report can include per-game detail. It resets whenever the loaded set_id
// changes (new set on the scoreboard). Never populated in crew mode.
let currentSetId    = null;
let currentSetGames = [];

/**
 * Reset the per-game accumulator when the scoreboard's loaded set changes.
 * @param {object|null} tshState
 */
function syncSetTracking(tshState) {
  const setId = tshState ? tsh.getSetId(tshState) : null;
  if (setId !== currentSetId) {
    currentSetId    = setId;
    currentSetGames = [];
  }
}

// ── Crew battle state (persists across games within a crew battle) ─────────────
// null when not in a crew battle.
let crewBattleState = null;
// Shape: {
//   teamSize: number,
//   totalStocks: { 1: number, 2: number },
//   carryOverStocks: { 1: number, 2: number },
//   playerStats: {
//     [playerName]: {
//       teamNum: 1|2, stocksTaken: number, hasPlayed: boolean,
//       eliminated: boolean, isActive: boolean,
//       character: { codename, display, skin, iconAsset } | null
//     }
//   }
// }

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

  syncSetTracking(tshState);

  const sorted = rawPlayers
    .filter((p) => p != null && p.characterId != null)
    .sort((a, b) => a.playerIndex - b.playerIndex);

  if (sorted.length < 2) {
    console.warn("[bridge] Fewer than 2 players found; skipping game start");
    return;
  }

  const doubles = isDoubles(rawPlayers) && (!tshState || tsh.isDoubles(tshState));
  const crew    = !doubles && tshState && tsh.isCrewBattle(tshState);

  if (doubles) {
    console.log("[bridge] Doubles game detected");
    onGameStartDoubles(sorted, tshState);
  } else if (crew) {
    console.log("[bridge] Crew battle game detected");
    onGameStartCrew(sorted, tshState);
  } else {
    onGameStartSingles(sorted, tshState);
  }
}

function onGameStartSingles(sorted, tshState) {
  const t1Info = tshState ? tsh.getTeamInfo(tshState, 1) : { name: "", score: 0 };
  const t2Info = tshState ? tsh.getTeamInfo(tshState, 2) : { name: "", score: 0 };
  const startedAtZeroZero = t1Info.score === 0 && t2Info.score === 0;

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
  currentGameState = { players, isDoubles: false, startedAtZeroZero };

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

function onGameStartCrew(sorted, tshState) {
  const sb      = String(config.SCOREBOARD_NUM);
  const t1Score = tshState?.score?.[sb]?.team?.["1"]?.score ?? 0;
  const t2Score = tshState?.score?.[sb]?.team?.["2"]?.score ?? 0;
  const isInit  = (t1Score === 16 && t2Score === 16) || (t1Score === 20 && t2Score === 20);

  if (isInit || crewBattleState == null) {
    crewBattleState = {
      teamSize:       t1Score === 20 ? 5 : 4,
      totalStocks:    { 1: t1Score, 2: t2Score },
      carryOverStocks: { 1: 4, 2: 4 },
      playerStats:    {},
    };
    console.log(`[bridge] Crew battle initialized — ${t1Score} vs ${t2Score} stocks`);
  }

  // Port mapping: same as singles (name + positional, skip score matching)
  const t1Info = tsh.getTeamInfo(tshState, 1);
  const t2Info = tsh.getTeamInfo(tshState, 2);
  portMapper.resolve(t1Info, t2Info);
  if (!portMapper.hasMapping()) {
    portMapper.tryCharacterBased(
      sorted,
      tsh.getPreloadedChars(tshState),
      resolveCharacter,
      TSH_ROOT
    );
  }

  const players = buildPlayersSingles(sorted);
  currentGameState = { players, isDoubles: false, isCrew: true };

  // Push character to TSH for scoreboard overlay
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

  // Update isActive flags and register new players in crewBattleState
  for (const p of Object.values(players)) {
    const activeName = tsh.getActivePlayerName(tshState, p.teamNum);
    if (!activeName) continue;

    // Clear isActive for all existing players on this team
    for (const stats of Object.values(crewBattleState.playerStats)) {
      if (stats.teamNum === p.teamNum) stats.isActive = false;
    }

    if (!crewBattleState.playerStats[activeName]) {
      // First time seeing this player — build from TSH preloaded character
      const tshPlayer = tshState?.score?.[sb]?.team?.[String(p.teamNum)]?.player?.["1"];
      const charEntry  = tshPlayer?.character?.["1"];
      crewBattleState.playerStats[activeName] = {
        teamNum:    p.teamNum,
        stocksTaken: 0,
        hasPlayed:  false,
        eliminated: false,
        isActive:   true,
        character:  charEntry ? {
          codename:  charEntry.codename  ?? "",
          display:   charEntry.name      ?? "",
          skin:      charEntry.skin      ?? 0,
          iconAsset: charEntry.assets?.["base_files/icon"]?.asset ?? null,
        } : null,
      };
    } else {
      // Returning winner — update isActive and refresh character from Slippi
      crewBattleState.playerStats[activeName].isActive  = true;
      crewBattleState.playerStats[activeName].eliminated = false;
      crewBattleState.playerStats[activeName].character = {
        codename:  p.codename,
        display:   p.display,
        skin:      p.costumeIndex,
        iconAsset: null,
      };
    }
  }

  io.emit("slippi_game_start", currentGameState);
  io.emit("slippi_crew_update", buildCrewUpdatePayload());
  console.log("[bridge] Emitted slippi_game_start + slippi_crew_update (crew)");
}

function onGameEndCrew({ winnerPlayerIndex, winnerEndStocks }) {
  if (winnerPlayerIndex == null || winnerPlayerIndex < 0) {
    console.log("[bridge] Crew game ended with no winner.");
    io.emit("slippi_game_end", { winner: null });
    currentGameState = null;
    return;
  }

  const winnerTeam =
    currentGameState?.players?.[winnerPlayerIndex]?.teamNum ??
    portMapper.getTeam(winnerPlayerIndex, null);

  if (!winnerTeam) {
    console.warn(`[bridge] Crew: winner port ${winnerPlayerIndex} not mapped`);
    io.emit("slippi_game_end", { winner: null });
    currentGameState = null;
    return;
  }

  const loserTeam          = winnerTeam === 1 ? 2 : 1;
  const loserCarryOver     = crewBattleState.carryOverStocks[loserTeam];
  const winnerEndStocksFinal = winnerEndStocks ?? crewBattleState.carryOverStocks[winnerTeam];

  // Decrement loser team stocks (carry-over is how many the loser actually had)
  crewBattleState.totalStocks[loserTeam] =
    Math.max(0, crewBattleState.totalStocks[loserTeam] - loserCarryOver);

  // Update carry-over for next game
  crewBattleState.carryOverStocks[winnerTeam] = winnerEndStocksFinal;
  crewBattleState.carryOverStocks[loserTeam]  = 4;

  // Update per-player stats
  const activePlayers = Object.entries(crewBattleState.playerStats)
    .filter(([, s]) => s.isActive);
  const winnerEntry = activePlayers.find(([, s]) => s.teamNum === winnerTeam);
  const loserEntry  = activePlayers.find(([, s]) => s.teamNum === loserTeam);

  if (winnerEntry) {
    winnerEntry[1].stocksTaken += loserCarryOver;
    winnerEntry[1].hasPlayed    = true;
    winnerEntry[1].eliminated   = false;
  }
  if (loserEntry) {
    loserEntry[1].hasPlayed  = true;
    loserEntry[1].eliminated = true;
    loserEntry[1].isActive   = false;
  }

  console.log(
    `[bridge] Crew: team ${winnerTeam} wins. ` +
    `Stocks: ${crewBattleState.totalStocks[1]} vs ${crewBattleState.totalStocks[2]} ` +
    `(loser had ${loserCarryOver} carry-over, winner carries ${winnerEndStocksFinal})`
  );

  // Push new stock counts to TSH score
  tsh.setScore(crewBattleState.totalStocks[1], crewBattleState.totalStocks[2]).then((r) => {
    if (!r.ok) console.warn(`[bridge] setScore failed: ${r.error}`);
  });

  portMapper.recordWin(winnerPlayerIndex);

  const battleEnded = crewBattleState.totalStocks[loserTeam] <= 0;
  io.emit("slippi_game_end", { winner: winnerTeam });
  io.emit("slippi_crew_update", buildCrewUpdatePayload());
  if (battleEnded) {
    io.emit("slippi_crew_end", { winner: winnerTeam });
    console.log(`[bridge] Crew battle over — team ${winnerTeam} wins`);
  }

  currentGameState = null;
}

function buildCrewUpdatePayload() {
  return {
    totalStocks:     { ...crewBattleState.totalStocks },
    carryOverStocks: { ...crewBattleState.carryOverStocks },
    playerStats:     { ...crewBattleState.playerStats },
  };
}

/**
 * Called by the game source when a game ends.
 * @param {{ winnerPlayerIndex: number|null, isHandwarmer: boolean, winnerEndStocks: number|null }} event
 */
function onGameEnd({ winnerPlayerIndex, isHandwarmer, winnerEndStocks }) {
  // Crew battle mode: no handwarmer check, route to dedicated handler
  if (currentGameState?.isCrew) {
    onGameEndCrew({ winnerPlayerIndex, winnerEndStocks });
    return;
  }

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
  let winnerTeam =
    currentGameState?.players?.[winnerPlayerIndex]?.teamNum ??
    portMapper.getTeam(winnerPlayerIndex, null);

  // At 0-0 (game 1), re-read TSH to pick up any side-swap the user made during the game.
  // _portToName binds Slippi ports to player identities; checking which TSH team currently
  // holds that name gives the correct assignment even if the user swapped mid-game.
  if (winnerTeam && currentGameState?.startedAtZeroZero) {
    try {
      const freshState = tsh.readState();
      const winnerName = portMapper.getPortName(winnerPlayerIndex);
      if (winnerName) {
        const t1Names = tsh.getTeamPlayerNames(freshState, 1);
        const t2Names = tsh.getTeamPlayerNames(freshState, 2);
        if (t1Names.includes(winnerName)) {
          console.log(`[bridge] 0-0 late-bind: "${winnerName}" → team 1 (current TSH)`);
          winnerTeam = 1;
        } else if (t2Names.includes(winnerName)) {
          console.log(`[bridge] 0-0 late-bind: "${winnerName}" → team 2 (current TSH)`);
          winnerTeam = 2;
        }
      }
    } catch (e) {
      console.warn(`[bridge] 0-0 late-bind read failed (${e.message}); using game-start assignment`);
    }
  }

  if (winnerTeam) {
    portMapper.recordWin(winnerPlayerIndex);
    // Record this game for a possible start.gg report of the whole set.
    currentSetGames.push({ gameNum: currentSetGames.length + 1, winnerTeam });
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

// ── Control panel: status, bracket actions, start.gg reporting ────────────────
// Served to an OBS custom browser dock. Browser→bridge calls are same-origin
// (bridge port); the bridge makes the TSH/start.gg calls server-side, so there
// is no browser-CORS surface against TSH.

let lastControlStatus = {
  tsh: false,
  slippi: false,
  slippiDetail: { mode: config.CONNECTION_MODE, connected: false },
  portMapping: { method: "positional", ports: [] },
  currentSet: {
    setId: null,
    scores: { team1: 0, team2: 0 },
    teamNames: { team1: "", team2: "" },
    canReport: false,
    reason: "starting up",
  },
  startggEnabled: startgg.enabled,
  ts: 0,
};

/** Determine whether the current set can be reported, and why not if it can't. */
function evaluateReportability(state, setId) {
  if (!startgg.enabled)             return { canReport: false, reason: "start.gg token not configured" };
  if (tsh.isCrewBattle(state))      return { canReport: false, reason: "Crew battles can't be reported" };
  if (setId == null)                return { canReport: false, reason: "No start.gg set loaded (manual/exhibition)" };
  if (String(setId).includes("preview")) return { canReport: false, reason: "Set hasn't started on start.gg yet" };
  return { canReport: true, reason: null };
}

/** Rebuild lastControlStatus from live TSH + Slippi state and broadcast it. */
async function refreshControlStatus() {
  const tshUp = await tsh.ping();
  let currentSet = {
    setId: null,
    scores: { team1: 0, team2: 0 },
    teamNames: { team1: "", team2: "" },
    canReport: false,
    reason: tshUp ? null : "TSH not reachable",
  };

  if (tshUp) {
    try {
      const state  = tsh.readState();
      const setId  = tsh.getSetId(state);
      const scores = tsh.getLiveScores(state);
      const { canReport, reason } = evaluateReportability(state, setId);
      currentSet = {
        setId,
        scores,
        teamNames: {
          team1: tsh.getTeamInfo(state, 1).name,
          team2: tsh.getTeamInfo(state, 2).name,
        },
        canReport,
        reason,
      };
    } catch {
      currentSet.reason = "TSH state unreadable";
    }
  }

  const src = source?.getStatus?.() ?? { mode: config.CONNECTION_MODE, connected: false };
  lastControlStatus = {
    tsh: tshUp,
    slippi: Boolean(src.connected),
    slippiDetail: src,
    portMapping: portMapper.getResolutionInfo(),
    currentSet,
    startggEnabled: startgg.enabled,
    ts: Date.now(),
  };
  io.emit("control_status", lastControlStatus);
  return lastControlStatus;
}

/**
 * Translate the accumulated per-game winners into BracketSetGameDataInput[].
 * Returns undefined when the log is empty or inconsistent with the final score,
 * so the report falls back to set winner + score only.
 */
function buildGameData(entrants) {
  if (!entrants[1] || !entrants[2] || currentSetGames.length === 0) return undefined;
  return currentSetGames.map((g) => ({
    gameNum:  g.gameNum,
    winnerId: entrants[g.winnerTeam]?.id,
  }));
}

/**
 * Report the currently-loaded set to start.gg using the live score as the
 * result. Manual-trigger only; the panel confirms with the operator first.
 * @returns {Promise<{ ok: boolean, winnerName?: string, score?: string, error?: string }>}
 */
async function reportCurrentSet() {
  let state;
  try { state = tsh.readState(); }
  catch { return { ok: false, error: "Cannot read TSH state" }; }

  const setId = tsh.getSetId(state);
  const { canReport, reason } = evaluateReportability(state, setId);
  if (!canReport) return { ok: false, error: reason };

  const scores = tsh.getLiveScores(state);
  if (scores.team1 === scores.team2) {
    return { ok: false, error: `Score is tied ${scores.team1}-${scores.team2}; play out a winner first` };
  }
  const winnerTeam = scores.team1 > scores.team2 ? 1 : 2;

  const ent = await startgg.getSetEntrants(setId);
  if (!ent.ok) return { ok: false, error: ent.error };
  const winner = ent.entrants[winnerTeam];
  if (!winner) return { ok: false, error: "Could not resolve the winning team's start.gg entrant" };

  const result = await startgg.reportSet(setId, winner.id, buildGameData(ent.entrants));
  if (result.ok) {
    // Refresh so the panel reflects the reported state on its next tick.
    refreshControlStatus().catch(() => {});
    return { ok: true, winnerName: winner.name, score: `${scores.team1}-${scores.team2}` };
  }
  return result;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/control", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "control-panel.html"));
});

app.get("/api/status", async (req, res) => {
  res.json(await refreshControlStatus());
});

app.post("/api/swap", (req, res) => {
  swapTeams();
  refreshControlStatus().catch(() => {});
  res.json({ ok: true });
});

app.post("/api/pull-stream", async (req, res) => {
  res.json(await tsh.pullStreamSet());
});

app.get("/api/sets", async (req, res) => {
  res.json(await tsh.getOpenSets());
});

app.post("/api/load-set", async (req, res) => {
  const setId = req.body?.setId;
  if (setId == null) return res.status(400).json({ ok: false, error: "setId required" });
  res.json(await tsh.loadSet(setId));
});

app.post("/api/report", async (req, res) => {
  res.json(await reportCurrentSet());
});

// Push status to any connected control panel every 2s.
setInterval(() => { refreshControlStatus().catch(() => {}); }, 2000);

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
console.log(`[bridge] Control panel:  http://localhost:${config.BRIDGE_PORT}/control`);
console.log(`[bridge] start.gg report: ${startgg.enabled ? "enabled" : "disabled (no token in config.local.js)"}`);
console.log(`[bridge] Keyboard:       Ctrl+Shift+S = swap teams`);
console.log();

source = config.CONNECTION_MODE === "folder"
  ? createFolderSource(config)
  : createTcpSource(config);

source.on("game-start", onGameStart);
source.on("game-end",   onGameEnd);
