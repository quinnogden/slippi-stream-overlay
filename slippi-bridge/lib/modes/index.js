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
  const { tsh, state } = ctx;

  const singles = createSingles(ctx);
  const doubles = createDoubles(ctx);

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

    const isDoublesGame = isDoubles(rawPlayers) && (!tshState || tsh.isDoubles(tshState));

    if (isDoublesGame) {
      console.log("[bridge] Doubles game detected");
      doubles.onGameStart(sorted, tshState);
    } else {
      singles.onGameStart(sorted, tshState);
    }

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

  return { onGameStart, onGameEnd };
}

module.exports = { createModes };
