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
 * Returns true when rawPlayers represents a doubles game (4 active players
 * with teamId assigned by Slippi).
 */
function isDoubles(rawPlayers) {
  const active = rawPlayers.filter((p) => p != null && p.characterId != null);
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
 */
function resolvePorts(ctx, sorted, tshState, t1Info, t2Info) {
  ctx.portMapper.resolve(t1Info, t2Info);

  if (!ctx.portMapper.hasMapping() && tshState) {
    ctx.portMapper.tryCharacterBased(
      sorted,
      ctx.tsh.getPreloadedChars(tshState),
      resolveCharacter
    );
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
  isDoubles,
  groupByTeamId,
  buildPlayersSingles,
  buildPlayersDoubles,
  resolvePorts,
  pushCharacters,
  syncNames,
};
