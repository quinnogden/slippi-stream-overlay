/**
 * Singles game handling.
 *
 * onGameEndStandard also serves doubles — the two modes differ at game start
 * (port resolution, team colors) but end identically.
 */

const { warnIfFailed } = require("../log");
const {
  buildPlayersSingles,
  resolvePorts,
  pushCharacters,
  syncNames,
} = require("../players");

function createSingles(ctx) {
  const { tsh, portMapper, io, state } = ctx;

  function onGameStart(sorted, tshState) {
    const t1Info = tshState ? tsh.getTeamInfo(tshState, 1) : { name: "", score: 0 };
    const t2Info = tshState ? tsh.getTeamInfo(tshState, 2) : { name: "", score: 0 };
    const startedAtZeroZero = t1Info.score === 0 && t2Info.score === 0;

    resolvePorts(ctx, sorted, tshState, t1Info, t2Info);

    const players = buildPlayersSingles(portMapper, sorted, ctx.TSH_ROOT);
    state.currentGameState = { players, isDoubles: false, startedAtZeroZero };

    pushCharacters(tsh, players);
    syncNames(ctx, players, tshState);

    io.emit("slippi_game_start", state.currentGameState);
    console.log("[bridge] Emitted slippi_game_start (singles)");
  }

  /**
   * Game end for singles and doubles alike.
   * @param {{ winnerPlayerIndex: number|null, isHandwarmer: boolean }} event
   */
  function onGameEndStandard({ winnerPlayerIndex, isHandwarmer }) {
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

    // currentGameState.players has the correct teamNum even when _portToTeam is null
    // (e.g. 0-0 start where positional default was used locally but not persisted).
    // Fall back to portMapper.getTeam() for games where currentGameState was cleared early.
    let winnerTeam =
      state.currentGameState?.players?.[winnerPlayerIndex]?.teamNum ??
      portMapper.getTeam(winnerPlayerIndex, null);

    // At 0-0 (game 1), re-read TSH to pick up any side-swap the user made during the game.
    // _portToName binds Slippi ports to player identities; checking which TSH team currently
    // holds that name gives the correct assignment even if the user swapped mid-game.
    if (winnerTeam && state.currentGameState?.startedAtZeroZero) {
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

  return { onGameStart, onGameEndStandard };
}

module.exports = { createSingles };
