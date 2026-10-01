/**
 * Game-mode dispatch, and the port map's link to the scoreboard.
 *
 * Every game start lands here: decide singles / doubles, resolve which side
 * each port plays for (lib/ports/port-map.js), and write the live characters
 * into the store. Game end (game-end.js) reads the winner's side from the same
 * map — at game end, not at game start, so a correction made during the game
 * (a port swap, a set loaded late) decides who gets the point.
 *
 * The store tells this module when the scoreboard moves under a live game:
 *   set-loaded     → the port map belongs to the previous set: clear it, and
 *                    re-detect now if a game is running (this replaces the old
 *                    0-0 late-bind and most uses of the Re-detect button)
 *   sides-switched → flip the map; the store already moved the characters
 */

const { resolveCharacter } = require("../char_map");
const { activePlayers, isDoubles } = require("../players");
const { createSingles } = require("./singles");
const { createDoubles } = require("./doubles");
const { createGameEnd } = require("./game-end");

function createModes(ctx) {
  const { store, portMap, io, state } = ctx;

  const singles = createSingles(ctx);
  const doubles = createDoubles(ctx);
  const { onGameEnd } = createGameEnd(ctx);

  /**
   * What each side's players are expected to be playing.
   *
   * Mid-set, the last game that recorded characters — a port change between
   * games is matched against what each side just played. At the start of a set
   * (or on a re-detect, `mainsOnly`) the players' DB mains, prefilled on load.
   * @returns {Array<Array<{ name: string, skin?: number }|null>>}
   */
  function referenceChars({ mainsOnly = false } = {}) {
    const sb = store.scoreboard();
    if (!mainsOnly) {
      const last = [...sb.games].reverse().find((g) => Array.isArray(g.characters));
      if (last) return [0, 1].map((i) => (last.characters[i] ?? []).map((c) => (c ? { name: c.name, skin: c.skin } : null)));
    }
    return sb.sides.map((side) => side.players.map((p) => p.main ?? null));
  }

  /** Doubles needs 4 Slippi teams-mode players and a doubles set (or no set at all). */
  function isDoublesGame(rawPlayers) {
    if (!isDoubles(rawPlayers)) return false;
    const sb = store.scoreboard();
    return sb.isDoubles || !sb.setId;
  }

  /**
   * Resolve the ports for a game and push it to the store + overlays.
   * @param {Array} sorted — active players, ascending by port
   * @param {{ mainsOnly?: boolean }} [opts]
   * @returns {{ mode: "singles"|"doubles", method: string }}
   */
  function applyGame(sorted, opts = {}) {
    const doublesGame = isDoublesGame(sorted);
    const { method } = portMap.resolve({
      players: sorted,
      doubles: doublesGame,
      refs: referenceChars(opts),
      resolveChar: resolveCharacter,
    });
    if (doublesGame) {
      console.log("[bridge] Doubles game detected");
      doubles.apply(sorted);
    } else {
      singles.apply(sorted);
    }
    return { mode: doublesGame ? "doubles" : "singles", method };
  }

  /**
   * Called by the game source when a new game starts.
   * @param {Array} rawPlayers — from slippi-js getSettings()
   */
  function onGameStart(rawPlayers) {
    state.clipsThisGame = 0;

    const sorted = activePlayers(rawPlayers).sort((a, b) => a.playerIndex - b.playerIndex);
    if (sorted.length < 2) {
      console.warn("[bridge] Fewer than 2 players found; skipping game start");
      return;
    }
    // Kept so a re-detect or port swap can re-run against the same input;
    // currentGameState.players drops characterId and teamId.
    state.currentRawPlayers = sorted;
    applyGame(sorted);
  }

  /** The live game's ports in the dock's terms. */
  function portSummary() {
    const sb = store.scoreboard();
    return portMap.info().ports.map((p) => {
      const pl = sb.sides[p.side]?.players[p.slot];
      return { ...p, name: pl ? [pl.prefix, pl.tag].filter(Boolean).join(" ") || null : null };
    });
  }

  /** For control_status: the mapping and the heuristic that chose it. */
  function portInfo() {
    return { method: portMap.method ?? "positional", ports: portSummary() };
  }

  /**
   * Re-derive the mapping from scratch against the players' mains, on operator
   * demand (↻ Re-detect) or because a new set was loaded mid-game.
   *
   * Requires a live game: with none there is nothing to re-apply, and the next
   * game start resolves from a clear map on its own.
   * @param {string} [reason]
   */
  function reresolvePorts(reason = "Operator pressed Re-detect Players") {
    const sorted = state.currentRawPlayers;
    if (!sorted || !state.currentGameState) {
      return { ok: false, error: "No game in progress — the next game start will re-derive on its own" };
    }
    portMap.reset(reason);
    const { mode, method } = applyGame(sorted, { mainsOnly: true });
    const ports = portSummary();
    const summary = ports.map((p) => `P${p.port + 1}→${p.side === 0 ? "L" : "R"}${p.name ? ` ${p.name}` : ""}`).join(", ");
    console.log(`[bridge] Re-detected ports (${mode}, ${method}): ${summary}`);
    return { ok: true, mode, method, ports, summary };
  }

  /**
   * The operator says the ports are the wrong way round (Ctrl+Shift+S, ⇆).
   * The scoreboard stays put; the live characters and colours move, and the
   * rest of the set keeps the corrected mapping.
   */
  function swapPorts() {
    if (!portMap.flip("manual")) {
      console.log("[bridge] Nothing to swap yet — no port mapping established");
      return { ok: false, error: "No port mapping yet" };
    }
    if (state.currentRawPlayers && state.currentGameState) {
      const sorted = state.currentRawPlayers;
      if (state.currentGameState.isDoubles) doubles.apply(sorted);
      else singles.apply(sorted);
    }
    return { ok: true };
  }

  store.on("set-loaded", () => {
    portMap.reset("A new set was loaded");
    if (state.currentGameState) reresolvePorts("A new set was loaded mid-game");
  });

  store.on("sides-switched", () => {
    portMap.flip();
    const game = state.currentGameState;
    if (!game) return;
    for (const p of Object.values(game.players)) {
      p.side = portMap.sideOf(p.playerIndex) ?? 1 - p.side;
      p.teamNum = p.side + 1;
    }
    if (game.teamColorMap) game.teamColorMap = { 1: game.teamColorMap[2], 2: game.teamColorMap[1] };
    io.emit("slippi_game_start", game);
  });

  return { onGameStart, onGameEnd, reresolvePorts, swapPorts, portInfo };
}

module.exports = { createModes };
