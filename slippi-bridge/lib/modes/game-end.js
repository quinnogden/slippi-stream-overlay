/**
 * Game end — shared by singles and doubles.
 *
 * The two modes differ only at game start (port resolution, team colors); by
 * the time a game ends every port already has a team, so one handler serves
 * both.
 */

const { warnIfFailed } = require("../log");
const { teamOfPort }   = require("../players");

function createGameEnd(ctx) {
  const { tsh, portMapper, io, state } = ctx;

  /**
   * At 0-0 (game 1), re-read TSH to pick up any side-swap the operator made
   * during the game. _portToName binds Slippi ports to player identities, so
   * whichever TSH column holds the winner's name now is the correct team, even
   * if the names were entered or the sides corrected mid-game.
   * @param {number} winnerPort
   * @param {number} fallbackTeam — the game-start assignment
   */
  function lateBindTeam(winnerPort, fallbackTeam) {
    const winnerName = portMapper.getPortName(winnerPort);
    if (!winnerName) return fallbackTeam;

    const read = tsh.tryReadState();
    if (!read.ok) {
      console.warn(`[bridge] 0-0 late-bind read failed (${read.error}); using game-start assignment`);
      return fallbackTeam;
    }

    const team = tsh.teamOfName(read.state, winnerName);
    if (!team) return fallbackTeam;
    console.log(`[bridge] 0-0 late-bind: "${winnerName}" → team ${team} (current TSH)`);
    return team;
  }

  /**
   * @param {{ winnerPlayerIndex: number|null, isHandwarmer: boolean }} event
   */
  function onGameEnd({ winnerPlayerIndex, isHandwarmer }) {
    if (isHandwarmer) {
      console.log("[bridge] Handwarmer detected — suppressing score increment.");
      state.currentGameState = null;
      return;
    }

    if (winnerPlayerIndex == null || winnerPlayerIndex < 0) {
      console.log("[bridge] Game ended with no winner (LRA-start or no contest).");
      io.emit("slippi_game_end", { winner: null });
      state.currentGameState = null;
      return;
    }

    let winnerTeam = teamOfPort(ctx, winnerPlayerIndex);
    if (winnerTeam && state.currentGameState?.startedAtZeroZero) {
      winnerTeam = lateBindTeam(winnerPlayerIndex, winnerTeam);
    }

    if (winnerTeam) {
      portMapper.recordWin(winnerPlayerIndex);
      // Record this game for a possible start.gg report of the whole set.
      state.currentSetGames.push({ gameNum: state.currentSetGames.length + 1, winnerTeam });
      console.log(`[bridge] Game over — team ${winnerTeam} wins (port ${winnerPlayerIndex})`);
      io.emit("slippi_game_end", { winner: winnerTeam });
      tsh.incrementScore(winnerTeam).then(warnIfFailed("incrementScore"));
    } else {
      console.warn(`[bridge] Winner port ${winnerPlayerIndex} not in port mapping`);
      io.emit("slippi_game_end", { winner: null });
    }

    state.currentGameState = null;
  }

  return { onGameEnd };
}

module.exports = { createGameEnd };
