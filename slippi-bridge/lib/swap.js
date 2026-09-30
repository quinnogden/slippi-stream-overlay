/**
 * Manual port→team swap (Ctrl+Shift+S, or the control panel's Swap button).
 *
 * Flips the bridge's internal port→team assignment and immediately re-applies
 * characters/colors to TSH so the visual result is instant. Deliberately does
 * NOT press TSH's own Swap Teams button — that would move names and scores too.
 */

const { pushCharacters, pushTeamColors, reapplyMapping } = require("./players");

function createSwap(ctx) {
  const { tsh, portMapper, io, state } = ctx;

  return function swapTeams() {
    const result = portMapper.swap(state.currentGameState?.players);

    if (!result) {
      console.log("[bridge] Nothing to swap yet — no port mapping established");
      return;
    }

    const game = state.currentGameState;
    if (!game?.players) return;

    reapplyMapping(ctx);

    if (game.isDoubles) {
      // Doubles: swap the teamColorMap (team 1 ↔ team 2 colors) and re-push
      const old = game.teamColorMap ?? {};
      game.teamColorMap = { 1: old[2], 2: old[1] };
      pushTeamColors(tsh, game.teamColorMap, "setTeamColor after swap");
    } else {
      pushCharacters(tsh, game.players, "setCharacter after swap");
    }

    io.emit("slippi_game_start", game);
    console.log(`[bridge] Re-applied ${game.isDoubles ? "team colors" : "characters"} after swap`);
  };
}

module.exports = { createSwap };
