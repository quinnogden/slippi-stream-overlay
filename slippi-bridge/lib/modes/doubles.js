/**
 * Doubles game start.
 *
 * Auto-detected when a game has 4 active players with teamId assigned in the
 * .slp and the loaded set is a doubles set (or nothing is loaded). Games end
 * through the shared handler in game-end.js.
 */

const { resolveCharacter } = require("../char_map");

// ── Melee in-game team colors (red / blue / green) ──────────────────────────────
// Each side shows the colour its players see in game.
const MELEE_TEAM_COLORS = {
  0: "#D32F2F", // Red team
  1: "#1565C0", // Blue team
  2: "#2E7D32", // Green team (rare in competitive)
};

function createDoubles(ctx) {
  const { store, portMap, io, state } = ctx;

  /**
   * Write every port's character to its side + slot, and each side's in-game
   * colour. Also how a port swap re-applies them.
   * @param {Array} sorted — all active players, ascending by port, already resolved
   */
  function apply(sorted) {
    const players = {};
    const teamColorMap = {};
    sorted.forEach((raw, i) => {
      const side = portMap.sideOf(raw.playerIndex) ?? (i < 2 ? 0 : 1);
      const slot = portMap.slotOf(raw.playerIndex);
      const skin = raw.characterColor ?? 0;
      const ch = resolveCharacter(raw.characterId, skin);
      if (ch) store.setCharacter(side, slot, { codename: ch.codename, name: ch.display, skin });
      const color = MELEE_TEAM_COLORS[raw.teamId];
      if (color) teamColorMap[side + 1] = color;
      players[raw.playerIndex] = {
        playerIndex: raw.playerIndex,
        side,
        slot,
        teamNum: side + 1, // legacy Socket.io field, until the overlay channel (M4)
        costumeIndex: skin,
        codename: ch?.codename ?? null,
        display: ch?.display ?? null,
      };
      console.log(`[bridge] Doubles ${side === 0 ? "left" : "right"} #${slot + 1} (port ${raw.playerIndex + 1}): ${ch?.display ?? "?"}`);
    });
    for (const side of [0, 1]) store.setSideColor(side, teamColorMap[side + 1] ?? null);

    state.currentGameState = { players, isDoubles: true, teamColorMap };
    io.emit("slippi_game_start", state.currentGameState);
  }

  return { apply };
}

module.exports = { createDoubles, MELEE_TEAM_COLORS };
