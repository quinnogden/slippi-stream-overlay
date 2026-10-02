/**
 * Game end — shared by singles and doubles.
 *
 * The winner's side is read from the port map *now*, not from game start, so
 * anything corrected during the game (a port swap, a set loaded late and
 * re-detected) decides who gets the point.
 *
 * The game goes into the store's game list with the characters each side
 * played: the score is derived from that list, the report sends it, and the
 * next game's port resolution matches against it.
 */

function createGameEnd(ctx) {
  const { store, portMap, io, state } = ctx;

  /** [[left players' characters], [right players' characters]], by slot. */
  function charactersBySide(game) {
    const out = [[], []];
    for (const p of Object.values(game?.players ?? {})) {
      const side = portMap.sideOf(p.playerIndex) ?? p.side;
      if ((side !== 0 && side !== 1) || !p.codename) continue;
      out[side][portMap.slotOf(p.playerIndex)] = { codename: p.codename, name: p.display, skin: p.costumeIndex };
    }
    return out.map((list) => Array.from(list, (c) => c ?? null));
  }

  /**
   * @param {{ winnerPlayerIndex: number|null, isHandwarmer: boolean }} event
   */
  function onGameEnd({ winnerPlayerIndex, isHandwarmer }) {
    const game = state.currentGameState;
    state.currentGameState = null;

    if (isHandwarmer) {
      console.log("[bridge] Handwarmer detected — no game recorded.");
      // Still announced: the game is over, and the overlay channel stops
      // replaying it to sources that connect later.
      io.emit("slippi_game_end", { winner: null, handwarmer: true });
      return;
    }
    if (winnerPlayerIndex == null || winnerPlayerIndex < 0) {
      console.log("[bridge] Game ended with no winner (LRA-start or no contest).");
      io.emit("slippi_game_end", { winner: null });
      return;
    }

    const winnerSide = portMap.sideOf(winnerPlayerIndex) ?? game?.players?.[winnerPlayerIndex]?.side ?? null;
    if (winnerSide !== 0 && winnerSide !== 1) {
      console.warn(`[bridge] Winner port ${winnerPlayerIndex + 1} isn't mapped to a side; no game recorded`);
      io.emit("slippi_game_end", { winner: null });
      return;
    }

    store.recordGame({ winnerSide, characters: charactersBySide(game) });
    console.log(`[bridge] Game over — ${winnerSide === 0 ? "left" : "right"} side wins (port ${winnerPlayerIndex + 1})`);
    io.emit("slippi_game_end", { winner: winnerSide + 1 });
  }

  return { onGameEnd };
}

module.exports = { createGameEnd };
