const config = {
  // ── Slippi Connection ──────────────────────────────────────────────────────
  // Path to the directory the Slippi desktop app writes the live game file into
  // (usually the "CurrentGame" or Spectate subfolder of your replays folder).
  SLP_FOLDER: "C:/Users/ogden/OneDrive/Documents/Slippi/Spectate/quinn",

  // ── Server ─────────────────────────────────────────────────────────────────
  // The one port: the dock (/dock), every overlay (/o/…), the API and Socket.io.
  // Every OBS browser source names it, so change it only with them.
  BRIDGE_PORT: 5001,

  // ── Defaults that live with their modules ──────────────────────────────────
  // Overridable from config.local.js, each merged per key over the module's own
  // defaults (where every key is documented):
  //   HOTKEYS  — global chords per action; null turns one off   lib/hotkey.js
  //   CLIPPER  — combo clipper starting values; the Clips tab's   lib/clipper-settings.js
  //              saved clipper-settings.json wins over both
  //   SET_TEXT — the Flex / Bo5 best-of rule                       lib/scoreboard/set-text.js

  // ── Bracket switcher ───────────────────────────────────────────────────────
  // The dock's Singles/Doubles buttons. `shortLink` is the series'
  // stable start.gg short link; the TO re-points it at each week's tournament,
  // so nothing here changes week to week. It is HYPHENATED — start.gg/100acres
  // is a hard 404 with no redirect.
  //
  // `match` keywords must ALL appear (case-insensitively) in an event's name +
  // slug. `fallbackSlug` is a bare event slug used only when the event list
  // can't be read — no token, start.gg down — so a button never dead-ends
  // mid-stream. config.local.js merges with a SHALLOW Object.assign, so a local
  // BRACKETS replaces this whole object (lib/event/event-target.js fills gaps).
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

  // ── Secrets (do NOT put real values here — this file is committed to git) ────
  // The start.gg personal access token lives in config.local.js (gitignored),
  // which is merged over this object below. See config.local.example.js.
  STARTGG_TOKEN: "",
};

// Merge machine-local overrides (secrets, per-machine paths). A missing file is
// harmless; a broken one throws, rather than silently dropping the token.
try {
  Object.assign(config, require("./config.local.js"));
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND" || !e.message.includes("config.local.js")) throw e;
}

module.exports = config;
