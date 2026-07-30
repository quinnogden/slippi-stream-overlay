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
    // Written by modes/{singles,doubles,crew}, swap.js and control-status.js
    // (on a TSH-side swap). Read by the io connection handler and clip-recorder.
    currentGameState: null,

    // ── Set tracking for start.gg reporting (singles/doubles only) ─────────────
    // currentSetGames accumulates one { gameNum, winnerTeam } per completed game
    // so the report can include per-game detail. It resets whenever the loaded
    // set_id changes (new set on the scoreboard). Never populated in crew mode.
    //
    // winnerTeam is a TSH column number, so it only means anything alongside the
    // scoreboard's *current* orientation — handleTshSwap() flips these entries
    // when the sides move, exactly as TSH flips its own scores and game tracker.
    currentSetId: null,
    currentSetGames: [],

    // ── Crew battle ────────────────────────────────────────────────────────────
    // null when not in a crew battle. Owned entirely by modes/crew.js. Shape:
    // {
    //   teamSize: number,
    //   totalStocks:     { 1: number, 2: number },
    //   carryOverStocks: { 1: number, 2: number },
    //   playerStats: {
    //     [playerName]: {
    //       teamNum: 1|2, stocksTaken: number, hasPlayed: boolean,
    //       eliminated: boolean, isActive: boolean,
    //       character: { codename, display, skin, iconAsset } | null
    //     }
    //   }
    // }
    crewBattleState: null,

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
