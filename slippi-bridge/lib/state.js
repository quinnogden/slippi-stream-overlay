/**
 * The bridge's shared mutable state — the bits that aren't the scoreboard.
 *
 * The scoreboard itself (set, names, score, per-game list) lives in
 * lib/scoreboard/store.js, behind commands. What's left here is the live game
 * and per-process bookkeeping.
 *
 * Passed around as `ctx.state`. Every field is written by exactly the modules
 * noted below — if you add a writer, note it here, because the reads are spread
 * across the server and the mode handlers.
 */

/** @returns {object} a fresh state object; one per process. */
function createState() {
  return {
    // ── Live game ──────────────────────────────────────────────────────────────
    // Written by modes/{singles,doubles} at game start (and again on a re-detect
    // or port swap), adjusted by modes/index.js when the sides switch, cleared by
    // modes/game-end. Read by the io connection handler and clip-recorder. Its
    // `players` carry each port's side and slot.
    currentGameState: null,

    // The raw slippi-js player records for the live game, sorted by port.
    // Written by modes/index.js at each game start and read by its re-detect and
    // port swap, which re-run resolution from the same input — currentGameState
    // drops characterId and teamId, which the port map needs. Deliberately not
    // cleared at game end: nothing reads it without a live currentGameState.
    currentRawPlayers: null,

    // ── Combo clipper rate limiting ────────────────────────────────────────────
    // Owned by clip-recorder.js; clipsThisGame is also reset by modes/index.js
    // on each game start. recentClips is newest-first and capped — kept on the
    // bridge so a panel reopened mid-set shows what has been banked rather than
    // starting blank.
    clipsThisGame: 0,
    lastClipAtMs: 0,
    recentClips: [],

    // ── Control panel ──────────────────────────────────────────────────────────
    // lastControlStatus is written by control-status.js and read by the io
    // connection handler, so a freshly-connected panel gets a value immediately.
    // Seeded by control-status.js at construction.
    lastControlStatus: null,

    // ── Game source ────────────────────────────────────────────────────────────
    // Assigned at the entry point once the folder watcher exists; read by the
    // control-status loop for the Slippi health dot.
    source: null,
  };
}

module.exports = { createState };
