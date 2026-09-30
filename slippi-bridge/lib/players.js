/**
 * Turning raw Slippi player entries into the bridge's per-player records, plus
 * the port-resolution and TSH-push steps the mode handlers run verbatim.
 *
 * The build* functions are pure apart from the PortMapper they consult; the
 * push/sync helpers exist because the same three-to-five-line block appeared
 * once per game mode and drifted between copies.
 */

const { resolveCharacter } = require("./char_map");
const { warnIfFailed }     = require("./log");

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
 * Resolve character + team for each player in a singles game.
 * Uses first and last port (outer ports) as the two players.
 * @param {object} portMapper
 * @param {Array} sorted — players sorted ascending by playerIndex
 * @returns {Object} players keyed by playerIndex
 */
function buildPlayersSingles(portMapper, sorted) {
  const players = {};
  [sorted[0], sorted[sorted.length - 1]].forEach((raw, i) => {
    const teamNum      = portMapper.getTeam(raw.playerIndex, i + 1);
    const costumeIndex = raw.characterColor ?? 0;
    const charInfo     = resolveCharacter(raw.characterId, costumeIndex);
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
    };
    console.log(`[bridge] P${teamNum} (port ${raw.playerIndex}): ${charInfo.display} costume ${costumeIndex}`);
  });
  return players;
}

/**
 * Assign team numbers to all 4 ports in a doubles game.
 * @param {object} portMapper
 * @param {Array} sorted — all 4 players sorted ascending by playerIndex
 * @returns {Object} players keyed by playerIndex
 */
function buildPlayersDoubles(portMapper, sorted) {
  const players = {};
  for (let i = 0; i < sorted.length; i++) {
    const raw     = sorted[i];
    const teamNum = portMapper.getTeam(raw.playerIndex, i < 2 ? 1 : 2);
    players[raw.playerIndex] = { playerIndex: raw.playerIndex, teamNum };
    console.log(`[bridge] Doubles P${teamNum} (port ${raw.playerIndex})`);
  }
  return players;
}

/**
 * Name-based port resolution, falling back to TSH's preloaded character history.
 *
 * @param {object} ctx — { portMapper, tsh }
 * @param {Array} sorted
 * @param {object|null} tshState
 * @param {{ name: string, score: number }} t1Info
 * @param {{ name: string, score: number }} t2Info
 * @param {object} [opts]
 * @param {boolean} [opts.fromScratch=false] — skip the name/score step entirely.
 *   Set by an operator re-resolve, which has just cleared the mapper: there are
 *   no stored names left to match and the tallies are reseeded rather than
 *   earned, so character history is the only signal worth consulting.
 */
function resolvePorts(ctx, sorted, tshState, t1Info, t2Info, { fromScratch = false } = {}) {
  if (!fromScratch) ctx.portMapper.resolve(t1Info, t2Info);

  if (!ctx.portMapper.hasMapping() && tshState) {
    ctx.portMapper.tryCharacterBased(
      sorted,
      ctx.tsh.getPreloadedChars(tshState),
      resolveCharacter
    );
  }
}

/**
 * The TSH column a port is playing for right now.
 *
 * The live game's players are the authority: they carry a team even when the
 * mapper's _portToTeam is null (the singles positional default is applied
 * locally, not persisted). The mapper covers the gap after the live game has
 * been cleared.
 * @param {object} ctx — { state, portMapper }
 * @param {number} port
 * @returns {number|null}
 */
function teamOfPort(ctx, port) {
  return ctx.state.currentGameState?.players?.[port]?.teamNum
    ?? ctx.portMapper.getTeam(port, null);
}

/**
 * Re-read every live player's team from the mapper after it changed under a
 * running game (a manual swap). Keeps the player's current team where the
 * mapper has no opinion.
 * @param {object} ctx — { state, portMapper }
 */
function reapplyMapping(ctx) {
  for (const p of Object.values(ctx.state.currentGameState?.players ?? {})) {
    p.teamNum = ctx.portMapper.getTeam(p.playerIndex, p.teamNum);
  }
}

/**
 * Push a { [tshTeam]: hexColor } map to TSH. Fire-and-forget; missing colors
 * are skipped.
 */
function pushTeamColors(tsh, colorMap, label = "setTeamColor") {
  for (const [team, color] of Object.entries(colorMap ?? {})) {
    if (color) tsh.setTeamColor(Number(team), color).then(warnIfFailed(label));
  }
}

/** Push every player's character + costume to TSH. Fire-and-forget. */
function pushCharacters(tsh, players, label = "setCharacter") {
  for (const p of Object.values(players)) {
    tsh.setCharacter(p.teamNum, p.display, p.costumeIndex).then(warnIfFailed(label));
  }
}

/**
 * Bind each mapped port to the player name TSH currently shows on that side, so
 * a later swap can be detected by name rather than by position.
 */
function syncNames(ctx, players, tshState, names = null) {
  if (!tshState) return;
  ctx.portMapper.syncNames(players, names ?? {
    1: ctx.tsh.getTeamPlayerNames(tshState, 1),
    2: ctx.tsh.getTeamPlayerNames(tshState, 2),
  });
}

module.exports = {
  activePlayers,
  isDoubles,
  groupByTeamId,
  buildPlayersSingles,
  buildPlayersDoubles,
  resolvePorts,
  pushCharacters,
  pushTeamColors,
  syncNames,
  teamOfPort,
  reapplyMapping,
};
