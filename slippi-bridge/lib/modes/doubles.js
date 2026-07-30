/**
 * Doubles game start.
 *
 * Auto-detected when a game has 4 active players with teamId assigned in the
 * .slp and TSH team 1 has more than one player slot. Games end through the
 * shared singles path — see modes/singles.js#onGameEndStandard.
 */

const { warnIfFailed } = require("../log");
const { resolveCharacter } = require("../char_map");
const {
  groupByTeamId,
  buildPlayersDoubles,
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

  function onGameStart(sorted, tshState) {
    const groups     = groupByTeamId(sorted);
    const { t1, t2 } = tsh.getTeamInfos(tshState);
    const t1Names    = tshState ? tsh.getTeamPlayerNames(tshState, 1) : [];
    const t2Names    = tshState ? tsh.getTeamPlayerNames(tshState, 2) : [];

    portMapper.resolveDoubles(groups, t1, t2, t1Names, t2Names);

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

    for (const [tshTeamStr, color] of Object.entries(state.currentGameState.teamColorMap)) {
      tsh.setTeamColor(Number(tshTeamStr), color).then(warnIfFailed("setTeamColor"));
    }

    syncNames(ctx, players, tshState, { 1: t1Names, 2: t2Names });

    io.emit("slippi_game_start", state.currentGameState);
    console.log("[bridge] Emitted slippi_game_start (doubles)");
  }

  /**
   * Build { [tshTeamNum]: hexColor } — used now and again by swapTeams.
   *
   * When a resolved mapping exists (_portToTeam is set), resolveDoubles() assigned all
   * ports in a Slippi group atomically, so the min-port player's teamNum is the group's.
   *
   * When no mapping exists (0-0 start + inconclusive character history), buildPlayersDoubles
   * used index-based positional default (first 2 sorted ports → team 1). This does NOT align
   * with Slippi groups when teamIds are interleaved (e.g. tid 0,1,0,1 across ports 0-3) —
   * both groups' min ports land on team 1. In that case, replicate resolveDoubles' positional
   * rule directly: the Slippi group with the lower minimum port → TSH team 1.
   */
  function buildTeamColorMap(groups, players) {
    const teamColorMap = {};
    const colorGroupEntries = Object.entries(groups)
      .filter(([tidStr]) => MELEE_TEAM_COLORS[Number(tidStr)]);

    if (portMapper.hasMapping()) {
      // Resolved mapping: all ports in a group share the same TSH team — use min-port player.
      for (const [tidStr, groupPlayers] of colorGroupEntries) {
        const tid = Number(tidStr);
        const minPortPlayer = groupPlayers.reduce((a, b) => a.playerIndex < b.playerIndex ? a : b);
        const tshTeam = players[minPortPlayer.playerIndex]?.teamNum;
        if (tshTeam) teamColorMap[tshTeam] = MELEE_TEAM_COLORS[tid];
      }
    } else if (colorGroupEntries.length >= 2) {
      // No resolved mapping: positional default — lower min-port Slippi group → TSH team 1.
      const ranked = colorGroupEntries
        .map(([tidStr, gp]) => ({ tid: Number(tidStr), minPort: Math.min(...gp.map((r) => r.playerIndex)) }))
        .sort((a, b) => a.minPort - b.minPort);
      teamColorMap[1] = MELEE_TEAM_COLORS[ranked[0].tid];
      teamColorMap[2] = MELEE_TEAM_COLORS[ranked[1].tid];
    }

    return teamColorMap;
  }

  return { onGameStart };
}

module.exports = { createDoubles, MELEE_TEAM_COLORS };
