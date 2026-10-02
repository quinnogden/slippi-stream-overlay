/** Which Slippi player entries are real players, and whether a game is doubles. */

/**
 * The ports actually in the game. slippi-js getSettings().players keeps an
 * entry per port, with null / characterless placeholders for empty ones.
 * @param {Array|null|undefined} rawPlayers
 * @returns {Array}
 */
function activePlayers(rawPlayers) {
  return (rawPlayers ?? []).filter((p) => p != null && p.characterId != null);
}

/**
 * Returns true when rawPlayers represents a doubles game (4 active players
 * with teamId assigned by Slippi).
 */
function isDoubles(rawPlayers) {
  const active = activePlayers(rawPlayers);
  return active.length === 4 && active.some((p) => p.teamId != null);
}

module.exports = { activePlayers, isDoubles };
