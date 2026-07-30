/**
 * Crew battle mode — stock-tracking battles for 4- or 5-person teams.
 *
 * The TO configures 4+ players per team in TSH and sets the initial score to the
 * total starting stocks (16 for 4-person, 20 for 5-person) before game 1. The
 * active player is read from TSH's first player slot at each game start, which
 * the TO updates between games.
 *
 * No handwarmer check here: in a crew battle every completed game counts.
 */

const { warnIfFailed } = require("../log");
const {
  buildPlayersSingles,
  resolvePorts,
  pushCharacters,
  syncNames,
} = require("../players");

/** Stocks a fresh player enters with. */
const STOCKS_PER_PLAYER = 4;

function createCrew(ctx) {
  const { tsh, portMapper, io, state } = ctx;

  function onGameStart(sorted, tshState) {
    const { team1: t1Score, team2: t2Score } = tsh.getLiveScores(tshState);
    const isInit = (t1Score === 16 && t2Score === 16) || (t1Score === 20 && t2Score === 20);

    if (isInit || state.crewBattleState == null) {
      state.crewBattleState = {
        teamSize:        t1Score === 20 ? 5 : 4,
        totalStocks:     { 1: t1Score, 2: t2Score },
        carryOverStocks: { 1: STOCKS_PER_PLAYER, 2: STOCKS_PER_PLAYER },
        playerStats:     {},
      };
      console.log(`[bridge] Crew battle initialized — ${t1Score} vs ${t2Score} stocks`);
    }

    // Port mapping: same as singles (name + character history, skip score matching)
    const { t1, t2 } = tsh.getTeamInfos(tshState);
    resolvePorts(ctx, sorted, tshState, t1, t2);

    const players = buildPlayersSingles(portMapper, sorted);
    state.currentGameState = { players, isDoubles: false, isCrew: true };

    pushCharacters(tsh, players);
    syncNames(ctx, players, tshState);
    registerActivePlayers(players, tshState);

    io.emit("slippi_game_start", state.currentGameState);
    io.emit("slippi_crew_update", buildUpdatePayload());
    console.log("[bridge] Emitted slippi_game_start + slippi_crew_update (crew)");
  }

  /** Mark this game's players active, registering any seen for the first time. */
  function registerActivePlayers(players, tshState) {
    for (const p of Object.values(players)) {
      const activeName = tsh.getActivePlayerName(tshState, p.teamNum);
      if (!activeName) continue;

      // Clear isActive for all existing players on this team
      for (const stats of Object.values(state.crewBattleState.playerStats)) {
        if (stats.teamNum === p.teamNum) stats.isActive = false;
      }

      const existing = state.crewBattleState.playerStats[activeName];
      if (!existing) {
        // First time seeing this player — build from TSH's preloaded character
        const charEntry = tsh.getActivePlayerCharacter(tshState, p.teamNum);
        state.crewBattleState.playerStats[activeName] = {
          teamNum:     p.teamNum,
          stocksTaken: 0,
          hasPlayed:   false,
          eliminated:  false,
          isActive:    true,
          character:   charEntry ? {
            codename:  charEntry.codename ?? "",
            display:   charEntry.name     ?? "",
            skin:      charEntry.skin     ?? 0,
            iconAsset: charEntry.assets?.["base_files/icon"]?.asset ?? null,
          } : null,
        };
      } else {
        // Returning winner — reactivate and refresh the character from Slippi
        existing.isActive   = true;
        existing.eliminated = false;
        existing.character  = {
          codename:  p.codename,
          display:   p.display,
          skin:      p.costumeIndex,
          iconAsset: null,
        };
      }
    }
  }

  function onGameEnd({ winnerPlayerIndex, winnerEndStocks }) {
    if (winnerPlayerIndex == null || winnerPlayerIndex < 0) {
      console.log("[bridge] Crew game ended with no winner.");
      io.emit("slippi_game_end", { winner: null });
      state.currentGameState = null;
      return;
    }

    const winnerTeam =
      state.currentGameState?.players?.[winnerPlayerIndex]?.teamNum ??
      portMapper.getTeam(winnerPlayerIndex, null);

    if (!winnerTeam) {
      console.warn(`[bridge] Crew: winner port ${winnerPlayerIndex} not mapped`);
      io.emit("slippi_game_end", { winner: null });
      state.currentGameState = null;
      return;
    }

    const crew                 = state.crewBattleState;
    const loserTeam            = winnerTeam === 1 ? 2 : 1;
    const loserCarryOver       = crew.carryOverStocks[loserTeam];
    const winnerEndStocksFinal = winnerEndStocks ?? crew.carryOverStocks[winnerTeam];

    // Decrement loser team stocks (carry-over is how many the loser actually had)
    crew.totalStocks[loserTeam] = Math.max(0, crew.totalStocks[loserTeam] - loserCarryOver);

    // Update carry-over for next game
    crew.carryOverStocks[winnerTeam] = winnerEndStocksFinal;
    crew.carryOverStocks[loserTeam]  = STOCKS_PER_PLAYER;

    // Update per-player stats
    const activePlayers = Object.entries(crew.playerStats).filter(([, s]) => s.isActive);
    const winnerEntry   = activePlayers.find(([, s]) => s.teamNum === winnerTeam);
    const loserEntry    = activePlayers.find(([, s]) => s.teamNum === loserTeam);

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
      `Stocks: ${crew.totalStocks[1]} vs ${crew.totalStocks[2]} ` +
      `(loser had ${loserCarryOver} carry-over, winner carries ${winnerEndStocksFinal})`
    );

    tsh.setScore(crew.totalStocks[1], crew.totalStocks[2]).then(warnIfFailed("setScore"));

    portMapper.recordWin(winnerPlayerIndex);

    const battleEnded = crew.totalStocks[loserTeam] <= 0;
    io.emit("slippi_game_end", { winner: winnerTeam });
    io.emit("slippi_crew_update", buildUpdatePayload());
    if (battleEnded) {
      io.emit("slippi_crew_end", { winner: winnerTeam });
      console.log(`[bridge] Crew battle over — team ${winnerTeam} wins`);
    }

    state.currentGameState = null;
  }

  function buildUpdatePayload() {
    return {
      totalStocks:     { ...state.crewBattleState.totalStocks },
      carryOverStocks: { ...state.crewBattleState.carryOverStocks },
      playerStats:     { ...state.crewBattleState.playerStats },
    };
  }

  return { onGameStart, onGameEnd, buildUpdatePayload };
}

module.exports = { createCrew };
