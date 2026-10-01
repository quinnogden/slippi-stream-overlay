const config = {
  // ── Slippi Connection ──────────────────────────────────────────────────────
  // Path to the directory the Slippi desktop app writes the live game file into
  // (usually the "CurrentGame" or Spectate subfolder of your replays folder).
  SLP_FOLDER: "C:/Users/ogden/OneDrive/Documents/Slippi/Spectate/quinn",

  // ── Server ─────────────────────────────────────────────────────────────────
  // The one port: the dock (/dock), every overlay (/o/…), the API and Socket.io.
  // Every OBS browser source names it, so change it only with them.
  BRIDGE_PORT: 5001,

  // Port→side assignment has no config: lib/ports/port-map.js derives it per
  // game from the last game's characters or the players' mains, then port order.

  // ── Global hotkeys ─────────────────────────────────────────────────────────
  // Work whichever window has focus — and still reach that window too, so pick
  // chords nothing on the stream PC uses. Each needs Ctrl, Alt or Win; null
  // turns one off. Merged per key over these defaults (lib/hotkey.js), so a
  // config.local.js HOTKEYS can move one key without restating the rest. The
  // dock's Setup tab lists what actually got bound.
  HOTKEYS: {
    swapPorts:   "Ctrl+Shift+S",      // the ports are the wrong way round
    switchSides: "Ctrl+Shift+X",      // the two sides trade columns on stream
    leftPlus:    "Ctrl+Shift+1",      // a game to the left side
    rightPlus:   "Ctrl+Shift+2",
    leftMinus:   "Ctrl+Shift+Alt+1",  // take the left side's last game away
    rightMinus:  "Ctrl+Shift+Alt+2",
  },

  // ── Combo Clipper ──────────────────────────────────────────────────────────
  // Starting values for live combo detection → OBS replay-buffer saves. These
  // are only DEFAULTS: the control panel writes operator edits to the gitignored
  // clipper-settings.json, which wins over anything here. See clipper-settings.js
  // for the authoritative field list and validation.
  //
  // Note config.local.js is merged with a SHALLOW Object.assign below, so an
  // override here replaces the whole object — clipper-settings.js fills any
  // missing key from its own DEFAULTS rather than trusting this to be complete.
  CLIPPER: {
    enabled: false,               // master toggle — off costs nothing per poll tick
    obsUrl: "ws://127.0.0.1:4455", // obs-websocket v5 address
    obsPassword: "",              // obs-websocket password ("" when auth is off)
    autoStartBuffer: true,        // start OBS's replay buffer if it isn't running
    minMoves: 4,                  // moves that must land (within comboWindowSec, if set)
    minDamage: 30,                // percent they must deal (within comboWindowSec, if set)
    requireKill: true,            // only clip conversions that took a stock
    comboWindowSec: 0,            // 0 = judge the whole conversion; else the last N seconds only
    maxComboDurationSec: 0,       // 0 = no cap
    cooldownSec: 8,               // minimum gap between saves
    saveDelayMs: 2500,            // wait after detection so the kill lands in the buffer
    maxClipsPerGame: 0,           // 0 = unlimited
    clipFolder: "",               // OBS replay output folder (display + OBS script)
    notifySidePanel: true,        // show the "clip saved" toast on the overlay
  },

  // ── Bracket switcher ───────────────────────────────────────────────────────
  // The control panel's Singles/Doubles buttons. `shortLink` is the series'
  // stable start.gg short link; the TO re-points it at each week's tournament,
  // so nothing here changes week to week. It is HYPHENATED — start.gg/100acres
  // is a hard 404 with no redirect.
  //
  // `match` keywords must ALL appear (case-insensitively) in an event's name +
  // slug. `fallbackSlug` is a bare event slug used only when the event list
  // can't be read — no token, start.gg down — so a button never dead-ends
  // mid-stream. Same shallow-merge caveat as CLIPPER above.
  BRACKETS: {
    shortLink: "100-acres",
    events: {
      singles: { match: ["melee", "singles"], fallbackSlug: "melee-singles-flex-bo5" },
      doubles: { match: ["melee", "doubles"], fallbackSlug: "melee-doubles" },
    },
  },

  // ── Player database ──────────────────────────────────────────────────────────
  // TSH-format local_players.json, read and updated in place (new start.gg
  // players, learned mains, the dock's Players tab). null = data/local_players.json
  // beside this file (gitignored) — copy the one from your old TSH install's
  // user_data/ there. Each machine has its own file, so a different path goes
  // in config.local.js rather than here. Never point TSH and this app at the
  // same file while both run.
  PLAYERS_FILE: null,

  // ── Scoreboard set text ──────────────────────────────────────────────────────
  // Best-of label: `topLabel` once the set's loser is guaranteed `topN`th or
  // better (start.gg lPlacement), `defaultLabel` before that. The dock can
  // override per set.
  SET_TEXT: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" },

  // ── Secrets (do NOT put real values here — this file is committed to git) ────
  // The start.gg personal access token lives in config.local.js (gitignored),
  // which is merged over this object below. See config.local.example.js.
  STARTGG_TOKEN: "",
};

// Merge machine-local overrides (secrets, per-machine paths) if present.
// config.local.js is gitignored; a missing file is harmless.
try {
  Object.assign(config, require("./config.local.js"));
} catch (_e) {
  // No local overrides — run with committed defaults.
}

module.exports = config;
