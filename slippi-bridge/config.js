const config = {
  // ── Slippi Connection ──────────────────────────────────────────────────────
  // Path to the directory the Slippi desktop app writes the live game file into
  // (usually the "CurrentGame" or Spectate subfolder of your replays folder).
  SLP_FOLDER: "C:/Users/ogden/OneDrive/Documents/Slippi/Spectate/quinn",

  // ── TSH Integration ────────────────────────────────────────────────────────
  // URL of the running TSH web server (default port 5000)
  TSH_URL: "http://localhost:5000",

  // Which TSH scoreboard number to control (1 for the default scoreboard)
  SCOREBOARD_NUM: 1,

  // Absolute path to the TSH install directory. Leave null to auto-detect the
  // newest TournamentStreamHelper-* folder sitting next to slippi-bridge/, so a
  // TSH update needs no code changes. Set it explicitly (in config.local.js if
  // it's machine-specific) when TSH lives somewhere else.
  TSH_ROOT: null,

  // ── Bridge Server ──────────────────────────────────────────────────────────
  // Port the bridge's Socket.io server listens on for layout connections
  BRIDGE_PORT: 5001,

  // Port→team assignment has no config: PortMapper derives it per game from
  // names, then scores, then TSH's character history, then port order.

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
    minMoves: 4,                  // moves in the conversion
    minDamage: 30,                // percent dealt across the conversion
    requireKill: true,            // only clip conversions that took a stock
    maxComboDurationSec: 0,       // 0 = no cap
    cooldownSec: 8,               // minimum gap between saves
    saveDelayMs: 2500,            // wait after detection so the kill lands in the buffer
    maxClipsPerGame: 0,           // 0 = unlimited
    clipFolder: "",               // OBS replay output folder (display + OBS script)
    notifySidePanel: true,        // show the "clip saved" toast on the overlay
  },

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
