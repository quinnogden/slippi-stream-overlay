/**
 * Singles game start: the two outer ports' characters onto their sides.
 * Games end through the shared handler in game-end.js.
 */

const { resolveCharacter } = require("../char_map");
const { outerPorts } = require("../ports/port-map");

function createSingles(ctx) {
  const { store, portMap, io, state } = ctx;

  /**
   * Write the live characters to the store and announce the game. Also how a
   * port swap re-applies them, so the two can't drift.
   * @param {Array} sorted — active players, ascending by port, already resolved by the port map
   */
  function apply(sorted) {
    const players = {};
    outerPorts(sorted).forEach((raw, i) => {
      const skin = raw.characterColor ?? 0;
      const ch = resolveCharacter(raw.characterId, skin);
      if (!ch) {
        console.warn(`[bridge] Unknown character ID: ${raw.characterId}`);
        return;
      }
      const side = portMap.sideOf(raw.playerIndex) ?? i;
      store.setCharacter(side, 0, { codename: ch.codename, name: ch.display, skin });
      players[raw.playerIndex] = {
        playerIndex: raw.playerIndex,
        side,
        slot: 0,
        teamNum: side + 1, // legacy Socket.io field, until the overlay channel (M4)
        costumeIndex: skin,
        codename: ch.codename,
        display: ch.display,
      };
      console.log(`[bridge] ${side === 0 ? "Left" : "Right"} (port ${raw.playerIndex + 1}): ${ch.display} costume ${skin}`);
    });

    state.currentGameState = { players, isDoubles: false };
    io.emit("slippi_game_start", state.currentGameState);
  }

  return { apply };
}

module.exports = { createSingles };
