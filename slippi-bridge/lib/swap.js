/**
 * Manual port→team swap (Ctrl+Shift+S, or the control panel's Swap button).
 *
 * Flips the bridge's internal port→team assignment and immediately re-applies
 * characters/colors to TSH so the visual result is instant. Deliberately does
 * NOT press TSH's own Swap Teams button — that would move names and scores too.
 */

const { warnIfFailed } = require("./log");
const { pushCharacters } = require("./players");

function createSwap(ctx) {
  const { tsh, portMapper, io, state } = ctx;

  return function swapTeams() {
    const result = portMapper.swap(state.currentGameState?.players);

    if (!result) {
      console.log("[bridge] Nothing to swap yet — no port mapping established");
      return;
    }

    if (!state.currentGameState?.players) return;

    // Update teamNum in currentGameState to reflect the swap
    for (const p of Object.values(state.currentGameState.players)) {
      p.teamNum = portMapper.getTeam(p.playerIndex, p.teamNum);
    }

    if (state.currentGameState.isDoubles) {
      // Doubles: swap the teamColorMap (team 1 ↔ team 2 colors) and re-push
      const old = state.currentGameState.teamColorMap ?? {};
      state.currentGameState.teamColorMap = { 1: old[2], 2: old[1] };
      for (const [tshTeamStr, color] of Object.entries(state.currentGameState.teamColorMap)) {
        if (!color) continue;
        tsh.setTeamColor(Number(tshTeamStr), color).then(warnIfFailed("setTeamColor after swap"));
      }
      io.emit("slippi_game_start", state.currentGameState);
      console.log("[bridge] Re-applied team colors after doubles swap");
    } else {
      // Singles: re-push characters
      pushCharacters(tsh, state.currentGameState.players, "setCharacter after swap");
      io.emit("slippi_game_start", state.currentGameState);
      console.log("[bridge] Re-applied characters after singles swap");
    }
  };
}

module.exports = { createSwap };
