/**
 * Singles game start. Games end through the shared handler in game-end.js.
 */

const {
  buildPlayersSingles,
  resolvePorts,
  pushCharacters,
  syncNames,
} = require("../players");

function createSingles(ctx) {
  const { tsh, portMapper, io, state } = ctx;

  /**
   * @param {Array} sorted — raw slippi-js players, ascending by port
   * @param {object|null} tshState
   * @param {{ fromScratch?: boolean }} [opts] — forwarded to resolvePorts; set by
   *   an operator re-resolve, which runs this same path against corrected names.
   */
  function onGameStart(sorted, tshState, opts = {}) {
    const { t1, t2 } = tsh.getTeamInfos(tshState);
    const startedAtZeroZero = t1.score === 0 && t2.score === 0;

    resolvePorts(ctx, sorted, tshState, t1, t2, opts);

    const players = buildPlayersSingles(portMapper, sorted);
    state.currentGameState = { players, isDoubles: false, startedAtZeroZero };

    pushCharacters(tsh, players);
    syncNames(ctx, players, tshState);

    io.emit("slippi_game_start", state.currentGameState);
    console.log("[bridge] Emitted slippi_game_start (singles)");
  }

  return { onGameStart };
}

module.exports = { createSingles };
