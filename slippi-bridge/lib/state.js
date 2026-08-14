/**
 * The bridge's shared mutable state.
 *
 * This used to be a dozen module-level `let` bindings in index.js, which is why
 * everything that touched them had to live in index.js too. Collecting them into
 * one object lets the game-mode handlers, the control-status loop and the routes
 * move into their own modules while still coordinating.
 *
 * Passed around as `ctx.state`. Every field is written by exactly the modules
 * noted below — if you add a writer, note it here, because the reads are spread
 * across the server and the mode handlers.
 */

/** @returns {object} a fresh state object; one per process. */
function createState() {
  return {
    // ── Live game ──────────────────────────────────────────────────────────────
    // Written by modes/{singles,doubles}, swap.js and control-status.js
    // (on a TSH-side swap). Read by the io connection handler and clip-recorder.
    currentGameState: null,

    // The raw slippi-js player records for the live game, sorted by port.
    // Written by modes/index.js at each game start and read by its
    // reresolvePorts(), which re-runs resolution from the same input the game
    // start used — currentGameState.players drops characterId and teamId, which
    // the character and doubles-grouping heuristics both need. Deliberately not
    // cleared at game end: nothing reads it without a live currentGameState.
    currentRawPlayers: null,

    // ── Set tracking for start.gg reporting ────────────────────────────────────
    // currentSetGames accumulates one { gameNum, winnerTeam } per completed game
    // so the report can include per-game detail. It resets whenever the loaded
    // set_id changes (new set on the scoreboard).
    //
    // winnerTeam is a TSH column number, so it only means anything alongside the
    // scoreboard's *current* orientation — handleTshSwap() flips these entries
    // when the sides move, exactly as TSH flips its own scores and game tracker.
    currentSetId: null,
    currentSetGames: [],

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

    // Last value of TSH's own teamsSwapped flag. null = not yet observed, so the
    // first poll only seeds the baseline instead of firing a phantom change.
    tshSwapped: null,

    // ── Game source ────────────────────────────────────────────────────────────
    // Assigned at the entry point once the folder watcher exists; read by the
    // control-status loop for the Slippi health dot.
    source: null,
  };
}

module.exports = { createState };
