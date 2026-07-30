/**
 * slippi-bridge
 *
 * Watches the folder Slippi writes live .slp files into, then pushes game events to:
 *   1. TSH via HTTP  — auto-increments score when a game ends
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
const PortMapper             = require("./lib/port-mapper");
const TshClient              = require("./lib/tsh-client");
const StartggClient          = require("./lib/startgg-client");
const { createFolderSource } = require("./lib/game-source");
const { resolveOrExit }      = require("./lib/tsh-root");
const { ClipperSettings }    = require("./lib/clipper-settings");
const { ComboDetector }      = require("./lib/combo-detector");
const { ObsClient }          = require("./lib/obs-client");

const { createState }        = require("./lib/state");
const { createModes }        = require("./lib/modes");
const { createSwap }         = require("./lib/swap");
const { createClipRecorder } = require("./lib/clip-recorder");
const { installHotkey }      = require("./lib/hotkey");
const { lanControlUrls }     = require("./lib/lan-urls");
const { createServer }        = require("./lib/server/app");
const { createControlStatus } = require("./lib/server/control-status");
const { createReportSet }     = require("./lib/server/report-set");
const { createBracketSwitch } = require("./lib/server/bracket-switch");
const { registerRoutes }      = require("./lib/server/routes");

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

/**
 * Everything the feature modules need, in one object. Each lib/ module takes
 * this and returns its own functions — see lib/state.js for who writes what.
 */
const ctx = {
  config,
  TSH_ROOT,
  io,
  state:           createState(),
  portMapper:      new PortMapper(),
  tsh:             new TshClient(config, TSH_ROOT),
  startgg:         new StartggClient(config),
  clipperSettings,
  comboDetector:   new ComboDetector(() => clipperSettings.get()),
  obs:             new ObsClient(() => clipperSettings.get()),
};

// ── Features ──────────────────────────────────────────────────────────────────
// Ordered so each only depends on what is already built.
const controlStatus = createControlStatus(ctx);
const clipRecorder  = createClipRecorder(ctx, controlStatus.refresh);
const { reportCurrentSet } = createReportSet(ctx, controlStatus.refresh);
const bracketSwitch = createBracketSwitch(ctx, controlStatus.refresh);
const modes         = createModes(ctx);
const swapTeams     = createSwap(ctx);

registerRoutes(app, {
  publicDir: path.join(__dirname, "public"),
  tsh: ctx.tsh,
  clipperSettings,
  obs: ctx.obs,
  state: ctx.state,
  refreshControlStatus: controlStatus.refresh,
  reportCurrentSet,
  switchBracket: bracketSwitch.switchBracket,
  swapTeams,
  recordClip: clipRecorder.recordClip,
});

io.on("connection", (socket) => {
  console.log(`[bridge] Layout connected: ${socket.id}`);
  if (ctx.state.currentGameState) {
    socket.emit("slippi_game_start", ctx.state.currentGameState);
  }
  // Give a freshly-connected control panel the latest status immediately.
  socket.emit("control_status", ctx.state.lastControlStatus);
});

// Push status to any connected control panel every 2s.
setInterval(() => { controlStatus.refresh().catch(() => {}); }, 2000);

const hotkeyMode = installHotkey(swapTeams);

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
console.log(`[bridge] start.gg report: ${ctx.startgg.enabled ? "enabled" : "disabled (no token in config.local.js)"}`);
console.log(`[bridge] Brackets:       ${bracketSwitch.shortLink
  ? `start.gg/${bracketSwitch.shortLink}${ctx.startgg.enabled ? "" : " (no token — configured event slugs only)"}`
  : "no short link configured (config.BRACKETS.shortLink)"}`);
console.log(`[bridge] Combo clipper:  ${clipper.enabled
  ? `enabled → OBS at ${clipper.obsUrl}`
  : "disabled (turn it on in the control panel)"}`);
console.log(`[bridge] Keyboard:       ${hotkeyMode === "global"
  ? "Ctrl+Shift+S = swap teams"
  : hotkeyMode === "terminal"
    ? "press S in this terminal = swap teams (uiohook-napi unavailable)"
    : "no swap hotkey available (uiohook-napi unavailable, not a TTY)"}`);
console.log();

ctx.state.source = createFolderSource(config, ctx.comboDetector);

ctx.state.source.on("game-start", modes.onGameStart);
ctx.state.source.on("game-end",   modes.onGameEnd);
ctx.state.source.on("highlight",  clipRecorder.onHighlight);

// Connect to OBS up front when the clipper is already on, so the control panel
// shows a real OBS status before the first combo rather than after it.
ctx.obs.applySettings();
