/**
 * Doubles game start.
 *
 * Auto-detected when a game has 4 active players with teamId assigned in the
 * .slp and TSH team 1 has more than one player slot. Games end through the
 * shared handler in game-end.js.
 */

const { resolveCharacter } = require("../char_map");
const {
  groupByTeamId,
  buildPlayersDoubles,
  pushTeamColors,
  syncNames,
} = require("../players");

// ── Melee in-game team colors (red / blue / green) ──────────────────────────────
// Overrides whatever color the TO configured in TSH, so the scoreboard matches
// what the players actually see in game.
const MELEE_TEAM_COLORS = {
  0: "#D32F2F", // Red team
  1: "#1565C0", // Blue team
  2: "#2E7D32", // Green team (rare in competitive)
};

function createDoubles(ctx) {
  const { tsh, portMapper, io, state } = ctx;

  /**
   * @param {Array} sorted — raw slippi-js players, ascending by port
   * @param {object|null} tshState
   * @param {object} [opts]
   * @param {boolean} [opts.fromScratch=false] — skip the name/score step. This
   *   guard is load-bearing, not cosmetic: after a reset at a non-0-0 score
   *   resolveDoubles finds no names and no matching score sums, falls through to
   *   applyDoublesPositional() and thereby SETS _portToTeam — which makes the
   *   !hasMapping() guard below skip tryCharacterBasedDoubles entirely, i.e. skip
   *   the one heuristic a re-resolve exists to run.
   */
  function onGameStart(sorted, tshState, { fromScratch = false } = {}) {
    const groups     = groupByTeamId(sorted);
    const { t1, t2 } = tsh.getTeamInfos(tshState);
    const t1Names    = tsh.getTeamPlayerNames(tshState, 1);
    const t2Names    = tsh.getTeamPlayerNames(tshState, 2);

    if (!fromScratch) portMapper.resolveDoubles(groups, t1, t2, t1Names, t2Names);

    if (!portMapper.hasMapping() && tshState) {
      portMapper.tryCharacterBasedDoubles(
        groups,
        tsh.getPreloadedChars(tshState),
        resolveCharacter
      );
    }

    // If both resolveDoubles (which returns early at 0-0) and tryCharacterBased
    // left _portToTeam null, apply the group-based positional default explicitly.
    // Without this, buildPlayersDoubles falls back to index-based positional
    // (first 2 sorted ports = team 1) which is wrong when Slippi groups are
    // non-consecutive (e.g. ports {0,3} vs {1,2}).
    if (!portMapper.hasMapping()) {
      portMapper.applyDoublesPositional(groups);
    }

    const players = buildPlayersDoubles(portMapper, sorted);

    state.currentGameState = {
      players,
      isDoubles: true,
      teamColorMap: buildTeamColorMap(groups, players),
    };

    pushTeamColors(tsh, state.currentGameState.teamColorMap);

    syncNames(ctx, players, tshState, { 1: t1Names, 2: t2Names });

    io.emit("slippi_game_start", state.currentGameState);
    console.log("[bridge] Emitted slippi_game_start (doubles)");
  }

  /**
   * Build { [tshTeamNum]: hexColor } — used now and again by swapTeams.
   *
   * By the time this runs a group mapping always exists (onGameStart falls back
   * to applyDoublesPositional), and every mapper path assigns a Slippi group's
   * ports atomically — so any one player's teamNum is the whole group's. Empty
   * only when Slippi didn't report exactly two teams, which isn't a 2v2.
   */
  function buildTeamColorMap(groups, players) {
    const teamColorMap = {};
    for (const [tidStr, groupPlayers] of Object.entries(groups)) {
      const color   = MELEE_TEAM_COLORS[Number(tidStr)];
      const tshTeam = players[groupPlayers[0].playerIndex]?.teamNum;
      if (color && tshTeam && portMapper.hasMapping()) teamColorMap[tshTeam] = color;
    }
    return teamColorMap;
  }

  return { onGameStart };
}

module.exports = { createDoubles, MELEE_TEAM_COLORS };
