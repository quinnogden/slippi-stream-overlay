/**
 * slippi-bridge
 *
 * Watches the folder Slippi writes live .slp files into, then pushes game events to:
 *   1. the scoreboard — records each game (the score is the game list)
 *   2. Socket.io     — pushes character/game data to OBS browser sources
 *   3. OBS websocket — saves a replay-buffer clip when a combo lands
 *
 * This file is the composition root: it builds the services, hands them to the
 * feature modules in lib/, and wires the game source's events to the result.
 * The behaviour itself lives in those modules.
 *
 * Config: edit config.js before running.
 * Start:  node index.js
 */

const path = require("path");

const config                 = require("./config");
const TshClient              = require("./lib/tsh-client");
const StartggClient          = require("./lib/startgg-client");
const { createFolderSource } = require("./lib/game-source");
const { resolveOrExit }      = require("./lib/tsh-root");
const { ClipperSettings }    = require("./lib/clipper-settings");
const { ComboDetector }      = require("./lib/combo-detector");
const { ObsClient }          = require("./lib/obs-client");
const { ScoreboardStore }    = require("./lib/scoreboard/store");
const { createPersist }      = require("./lib/scoreboard/persist");
const { PortMap }            = require("./lib/ports/port-map");
const { PlayerDb }           = require("./lib/players/player-db");

const { createState }        = require("./lib/state");
const { createModes }        = require("./lib/modes");
const { createClipRecorder } = require("./lib/clip-recorder");
const { installHotkey }      = require("./lib/hotkey");
const { lanControlUrls }     = require("./lib/lan-urls");
const { createServer }        = require("./lib/server/app");
const { createControlStatus } = require("./lib/server/control-status");
const { createReportSet }     = require("./lib/server/report-set");
const { createStartSet }      = require("./lib/server/start-set");
const { createBracketSwitch } = require("./lib/server/bracket-switch");
const { registerRoutes }      = require("./lib/server/routes");
const { createPlayerStats }   = require("./lib/stats");

// ── TSH root path ─────────────────────────────────────────────────────────────
// Auto-detected from the repo root unless config.TSH_ROOT pins it, so a TSH
// version bump doesn't require editing this file.
const TSH_ROOT = resolveOrExit(path.resolve(__dirname, ".."), config.TSH_ROOT, "bridge");

// ── Server ────────────────────────────────────────────────────────────────────
const { app, io, start: startListening } = createServer(config);
startListening();

// ── Services ──────────────────────────────────────────────────────────────────
// Clipper settings are read through a getter everywhere so the control panel can
// retune thresholds mid-set without restarting anything.
const clipperSettings = new ClipperSettings(config);

// The scoreboard lives here now, so it has to survive a restart mid-set.
const store   = new ScoreboardStore({ setText: config.SET_TEXT });
const persist = createPersist(store, path.join(__dirname, "data", "live-state.json"));
if (persist.restore()) console.log("[bridge] Restored the scoreboard from data/live-state.json");
persist.start();

const playersFile = config.PLAYERS_FILE ?? path.join(TSH_ROOT, "user_data", "local_players.json");

/**
 * Everything the feature modules need, in one object. Each lib/ module takes
 * this and returns its own functions — see lib/state.js for who writes what.
 */
const ctx = {
  config,
  TSH_ROOT,
  io,
  state:           createState(),
  store,
  portMap:         new PortMap(),
  playerDb:        new PlayerDb(playersFile),
  tsh:             new TshClient(config, TSH_ROOT),
  startgg:         new StartggClient(config),
  clipperSettings,
  comboDetector:   new ComboDetector(() => clipperSettings.get()),
  obs:             new ObsClient(() => clipperSettings.get()),
};

// ── Features ──────────────────────────────────────────────────────────────────
// Ordered so each only depends on what is already built.
// modes comes first: it subscribes to the store's set-loaded / sides-switched,
// and control-status shows its port map.
const modes         = createModes(ctx);
const controlStatus = createControlStatus(ctx, modes.portInfo);
const clipRecorder  = createClipRecorder(ctx, controlStatus.refresh);
const playerStats   = createPlayerStats(ctx);
const reportSet     = createReportSet(ctx, controlStatus.refresh);
const { startCurrentSet }  = createStartSet(ctx, controlStatus.refresh);

// A reported set changes the side panel's stats (both players' runs, their
// head-to-head, the event's finished sets), so the stats reload after it.
async function reportCurrentSet() {
  const result = await reportSet.reportCurrentSet();
  if (result.ok) playerStats.onSetReported();
  return result;
}
const bracketSwitch = createBracketSwitch(ctx, controlStatus.refresh);
// Ctrl+Shift+S and the dock's ⇆: the ports are the wrong way round.
function swapPorts() {
  const result = modes.swapPorts();
  controlStatus.refresh();
  return result;
}

registerRoutes(app, {
  publicDir: path.join(__dirname, "public"),
  tsh: ctx.tsh,
  clipperSettings,
  obs: ctx.obs,
  refreshControlStatus: controlStatus.refresh,
  clipperSnapshot: controlStatus.clipperSnapshot,
  reportCurrentSet,
  startCurrentSet,
  switchBracket: bracketSwitch.switchBracket,
  swapPorts,
  switchSides: () => store.switchSides(),
  reresolvePorts: modes.reresolvePorts,
  recordClip: clipRecorder.recordClip,
  playerStatsSnapshot: playerStats.snapshot,
});

io.on("connection", (socket) => {
  console.log(`[bridge] Layout connected: ${socket.id}`);
  if (ctx.state.currentGameState) {
    socket.emit("slippi_game_start", ctx.state.currentGameState);
  }
  // Give a freshly-connected control panel the latest status immediately.
  socket.emit("control_status", ctx.state.lastControlStatus);
  // And a freshly-connected side panel its stats, so it never falls back to
  // TSH's while waiting for the next change.
  socket.emit("player_stats", playerStats.snapshot());
});

// Push status to any connected control panel every 2s.
setInterval(controlStatus.refresh, 2000);

const hotkeyMode = installHotkey(swapPorts);

// ── Entry point ───────────────────────────────────────────────────────────────
const clipper = clipperSettings.get();

console.log("[bridge] Starting slippi-bridge...");
console.log(`[bridge] TSH URL:        ${config.TSH_URL}`);
console.log(`[bridge] Scoreboard:     ${config.SCOREBOARD_NUM}`);
console.log(`[bridge] Bridge port:    ${config.BRIDGE_PORT}`);
console.log(`[bridge] Control panel:  http://localhost:${config.BRIDGE_PORT}/control`);
for (const url of lanControlUrls(config)) {
  console.log(`[bridge]   on phone:    ${url}`);
}
console.log(`[bridge] Players:        ${playersFile} (${ctx.playerDb.size} players)`);
console.log(`[bridge] start.gg report: ${ctx.startgg.enabled ? "enabled" : "disabled (no token in config.local.js)"}`);
console.log(`[bridge] Player stats:   ${ctx.startgg.enabled
  ? "from start.gg (histories saved in stats-cache/)"
  : "TSH's own (no start.gg token)"}`);
console.log(`[bridge] Brackets:       ${bracketSwitch.shortLink
  ? `start.gg/${bracketSwitch.shortLink}${ctx.startgg.enabled ? "" : " (no token — configured event slugs only)"}`
  : "no short link configured (config.BRACKETS.shortLink)"}`);
console.log(`[bridge] Combo clipper:  ${clipper.enabled
  ? `enabled → OBS at ${clipper.obsUrl}`
  : "disabled (turn it on in the control panel)"}`);
console.log(`[bridge] Keyboard:       ${hotkeyMode === "global"
  ? "Ctrl+Shift+S = swap ports"
  : hotkeyMode === "terminal"
    ? "press S in this terminal = swap ports (uiohook-napi unavailable)"
    : "no swap hotkey available (uiohook-napi unavailable, not a TTY)"}`);
console.log();

ctx.state.source = createFolderSource(config, ctx.comboDetector);

ctx.state.source.on("game-start", modes.onGameStart);
ctx.state.source.on("game-end",   modes.onGameEnd);
ctx.state.source.on("highlight",  clipRecorder.onHighlight);

// Connect to OBS up front when the clipper is already on, so the control panel
// shows a real OBS status before the first combo rather than after it.
ctx.obs.applySettings();

playerStats.start();

// Flush pending debounced writes on the way out, so the last score and the last
// player-DB edit aren't lost to the debounce window. "exit" covers Ctrl+C in
// both forms — the SIGINT below, and hotkey.js's raw-mode terminal fallback,
// which calls process.exit() itself. Both writes are synchronous, as "exit"
// requires.
process.on("exit", () => {
  if (persist.pending) persist.saveNow();
  ctx.playerDb.flush();
});
process.on("SIGINT", () => process.exit(0));
