/**
 * Game-mode dispatch.
 *
 * The game source doesn't know what kind of set is running, so every game start
 * lands here: read TSH once, decide singles / doubles, hand off. The per-mode
 * handlers receive data rather than reading TSH themselves.
 */

const { resolveStage } = require("../char_map");
const { isDoubles }    = require("../players");
const { createSingles } = require("./singles");
const { createDoubles } = require("./doubles");

function createModes(ctx) {
  const { tsh, state, portMapper } = ctx;

  const singles = createSingles(ctx);
  const doubles = createDoubles(ctx);

  /**
   * Pick the mode for a set of players and run its game-start path.
   *
   * Split out of onGameStart so reresolvePorts() can re-run exactly the same
   * decision against corrected TSH state — a second copy of the doubles test
   * would be free to drift from this one.
   *
   * @param {Array} sorted — active players, ascending by port
   * @param {Array} rawPlayers — the unfiltered list isDoubles() needs
   * @param {object|null} tshState
   * @param {{ fromScratch?: boolean }} [opts]
   * @returns {"singles"|"doubles"}
   */
  function dispatchGameStart(sorted, rawPlayers, tshState, opts = {}) {
    const isDoublesGame = isDoubles(rawPlayers) && (!tshState || tsh.isDoubles(tshState));

    if (isDoublesGame) {
      console.log("[bridge] Doubles game detected");
      doubles.onGameStart(sorted, tshState, opts);
      return "doubles";
    }
    singles.onGameStart(sorted, tshState, opts);
    return "singles";
  }

  /**
   * Reset the per-game accumulator when the scoreboard's loaded set changes.
   * @param {object|null} tshState
   */
  function syncSetTracking(tshState) {
    const setId = tshState ? tsh.getSetId(tshState) : null;
    if (setId !== state.currentSetId) {
      state.currentSetId    = setId;
      state.currentSetGames = [];
    }
  }

  /**
   * Called by the game source when a new game starts.
   * @param {Array} rawPlayers — from slippi-js getSettings()
   * @param {number|null} stageId — Slippi stage ID, or null if unavailable
   */
  function onGameStart(rawPlayers, stageId = null) {
    // Read TSH state once; all downstream calls receive data, not file handles.
    let tshState = null;
    try {
      tshState = tsh.readState();
    } catch (e) {
      console.warn(e.message);
    }

    syncSetTracking(tshState);
    state.clipsThisGame = 0;

    const sorted = rawPlayers
      .filter((p) => p != null && p.characterId != null)
      .sort((a, b) => a.playerIndex - b.playerIndex);

    if (sorted.length < 2) {
      console.warn("[bridge] Fewer than 2 players found; skipping game start");
      return;
    }

    // Kept so a re-resolve can re-run the same handlers mid-game; the shape the
    // layouts get (currentGameState.players) drops characterId and teamId.
    state.currentRawPlayers = sorted;

    dispatchGameStart(sorted, rawPlayers, tshState);

    reportStage(stageId);
  }

  /**
   * Called by the game source when a game ends.
   * @param {{ winnerPlayerIndex: number|null, isHandwarmer: boolean }} event
   */
  function onGameEnd(event) {
    singles.onGameEndStandard(event);
  }

  /**
   * Re-derive the port→team mapping from scratch, on operator demand.
   *
   * The case: a set is loaded and game 1 is already running before the TO
   * finishes entering the new players in TSH. Every port fact the bridge holds
   * belongs to the previous set, and nothing self-corrects until the *next*
   * game start — by which time game 1's point has already been awarded, quite
   * possibly to the wrong player.
   *
   * This is the game-start path with the name/score step skipped. After the
   * reset there are no stored names to match and no earned tallies, so the chain
   * reduces to character history → positional: exactly the 0-0 route, which is
   * the right one because TSH now holds the correct registered characters for
   * the names the TO just entered. Reusing the handlers rather than
   * reimplementing means the TSH character push, syncNames, the doubles team
   * colours and the slippi_game_start re-emit all come along and cannot drift.
   *
   * Requires a live game: with no currentGameState there is nothing to re-push
   * or re-emit, and fabricating one would resurrect a dead game for the layouts.
   * Between games the next game start re-derives correctly on its own.
   *
   * @returns {{ ok: boolean, error?: string, mode?: string, method?: string,
   *             ports?: Array, summary?: string }}
   */
  function reresolvePorts() {
    const sorted = state.currentRawPlayers;
    if (!sorted || !state.currentGameState) {
      return { ok: false, error: "No game in progress — the next game start will re-derive on its own" };
    }

    let tshState;
    try {
      tshState = tsh.readState();
    } catch (e) {
      return { ok: false, error: e.message };
    }

    portMapper.reset("Operator pressed Re-detect Players");

    const mode = dispatchGameStart(sorted, sorted, tshState, { fromScratch: true });

    // syncNames() only re-seeds zeros, so without this the score fallback would
    // compare 0-0 against a mid-set scoreboard on the next game start. recordWin()
    // only ever credits the single winning port, so putting a team's whole score
    // on its lowest port matches how the tallies would have accumulated — and in
    // doubles resolveDoubles() reads the group total anyway.
    const scores  = tsh.getLiveScores(tshState);
    const players = Object.values(state.currentGameState.players);
    const seeded  = {};
    for (const p of players) seeded[p.playerIndex] = 0;
    for (const teamNum of [1, 2]) {
      const ports = players.filter((p) => p.teamNum === teamNum).map((p) => p.playerIndex);
      if (ports.length) seeded[Math.min(...ports)] = scores[`team${teamNum}`] ?? 0;
    }
    portMapper.seedScores(seeded);

    // team is null for the singles positional case, where _portToTeam stays null
    // by design — fill it from the players the handler just built so the operator
    // sees a real side either way.
    const info  = portMapper.getResolutionInfo();
    const ports = info.ports.map((p) => ({
      ...p,
      team: p.team ?? state.currentGameState.players[p.port]?.teamNum ?? null,
    }));
    const summary = ports
      .map((p) => `P${p.port + 1}→T${p.team ?? "?"}${p.name ? ` ${p.name}` : ""}`)
      .join(", ");

    console.log(`[bridge] Re-detected ports (${mode}, ${info.method}): ${summary}`);
    return { ok: true, mode, method: info.method, ports, summary };
  }

  /**
   * Push the current game's stage to TSH's Individual Game Tracker (TSH 5.972+).
   *
   * Best-effort and fire-and-forget: an unmapped stage or an unreachable TSH must
   * never interfere with scoring, which is the bridge's actual job.
   * @param {number|null} stageId
   */
  function reportStage(stageId) {
    if (stageId == null) return;

    const codename = resolveStage(stageId);
    if (!codename) {
      console.warn(`[bridge] Unknown stage id ${stageId}; skipping stage report`);
      return;
    }

    tsh.setCurrentStage(codename).catch(() => {});
  }

  return { onGameStart, onGameEnd, reresolvePorts };
}

module.exports = { createModes };
