/**
 * slippi-bridge
 *
 * Watches the folder Slippi writes live .slp files into, and runs the event from
 * start.gg (lib/event/). Game events go to:
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

const fs   = require("fs");
const path = require("path");

const config                 = require("./config");
const StartggClient          = require("./lib/startgg-client");
const { createFolderSource } = require("./lib/game-source");
const { ClipperSettings }    = require("./lib/clipper-settings");
const { ComboDetector }      = require("./lib/combo-detector");
const { ObsClient }          = require("./lib/obs-client");
const { ScoreboardStore }    = require("./lib/scoreboard/store");
const { createPersist }      = require("./lib/scoreboard/persist");
const { PortMap }            = require("./lib/ports/port-map");
const { PlayerDb }           = require("./lib/players/player-db");
const { EventService }       = require("./lib/event/event-service");
const { createBracketFeed }  = require("./lib/event/bracket-feed");
const { createOverlayChannel } = require("./lib/overlay/channel");

const { createState }        = require("./lib/state");
const { createModes }        = require("./lib/modes");
const { createClipRecorder } = require("./lib/clip-recorder");
const { installHotkeys }     = require("./lib/hotkey");
const { lanControlUrls, lanDockUrls } = require("./lib/lan-urls");
const { createMainsLearning } = require("./lib/players/mains-learning");
const { activeThemePack, themePacks } = require("./lib/server/api/setup");
const { createServer }        = require("./lib/server/app");
const { createControlStatus } = require("./lib/server/control-status");
const { createReportSet }     = require("./lib/server/report-set");
const { createStartSet }      = require("./lib/server/start-set");
const { registerRoutes }      = require("./lib/server/routes");
const { registerOverlays }    = require("./lib/server/overlays");
const { createPlayerStats }   = require("./lib/stats");

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

// The player DB: TSH's local_players.json format, in data/ unless configured.
const playersFile = config.PLAYERS_FILE ?? path.join(__dirname, "data", "local_players.json");
const playersMissing = !fs.existsSync(playersFile);

// The overlays' and dock's live feed. The feature modules emit through it (as
// ctx.io): it sends each event on the default namespace as before, and on
// /overlay and /dock under the channel's names.
const channel = createOverlayChannel({ io, store });

/**
 * Everything the feature modules need, in one object. Each lib/ module takes
 * this and returns its own functions — see lib/state.js for who writes what.
 */
const ctx = {
  config,
  io:              channel,
  state:           createState(),
  store,
  portMap:         new PortMap(),
  playerDb:        new PlayerDb(playersFile),
  startgg:         new StartggClient(config),
  clipperSettings,
  comboDetector:   new ComboDetector(() => clipperSettings.get()),
  obs:             new ObsClient(() => clipperSettings.get()),
};
// The loaded start.gg event: picker, set loads, brackets. Needs the store and
// the player DB, and the stats pre-fetch from its playable sets.
ctx.event = new EventService(ctx);
// …and the bracket overlay's slice of it, published into the store.
const bracketFeed = createBracketFeed({ event: ctx.event, store, playerDb: ctx.playerDb });
// What each player played, into the player DB once their set is over.
const mainsLearning = createMainsLearning({ store, playerDb: ctx.playerDb });

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

// A reported set changes the bracket (the picker, the next sets' entrants) and
// the side panel's stats (both players' runs, their head-to-head, the event's
// finished sets), so both reload after it — once start.gg has caught up. And
// the set is over, so what its players played is learned.
async function reportCurrentSet() {
  const result = await reportSet.reportCurrentSet();
  if (result.ok) {
    mainsLearning.commit(undefined, "reported");
    playerStats.onSetReported();
    setTimeout(() => ctx.event.refresh({ background: true }), 3000).unref?.();
  }
  return result;
}
// Ctrl+Shift+S and the dock's ⇆: the ports are the wrong way round.
function swapPorts() {
  const result = modes.swapPorts();
  controlStatus.refresh();
  return result;
}

// The global hotkeys (config.HOTKEYS). They land blind — the operator is
// looking at OBS or the game — so each one says what it did in the console.
const scoreLine = () => store.scoreboard().sides.map((s) => s.score).join("–");
function hotkeyScore(side, delta) {
  store.bump(side, delta);
  console.log(`[hotkey] ${side === 0 ? "Left" : "Right"} ${delta > 0 ? "+1" : "−1"} → ${scoreLine()}`);
  controlStatus.refresh();
}
const hotkeys = installHotkeys(config.HOTKEYS, {
  swapPorts: () => {
    const r = swapPorts();
    console.log(`[hotkey] Swap ports${r.ok ? "" : ` — ${r.error}`}`);
  },
  switchSides: () => {
    store.switchSides();
    console.log(`[hotkey] Switch sides → ${scoreLine()}`);
    controlStatus.refresh();
  },
  leftPlus:   () => hotkeyScore(0, 1),
  rightPlus:  () => hotkeyScore(1, 1),
  leftMinus:  () => hotkeyScore(0, -1),
  rightMinus: () => hotkeyScore(1, -1),
  clearScore: () => {
    store.clearScore();
    console.log(`[hotkey] Clear score → ${scoreLine()}`);
    controlStatus.refresh();
  },
});
for (const err of hotkeys.errors) console.warn(`[hotkey] ${err} — left unbound`);

const overlaysDir = path.resolve(__dirname, "..", "overlays");
registerOverlays(app, { overlaysDir });

registerRoutes(app, {
  publicDir: path.join(__dirname, "public"),
  iconsDir: path.join(overlaysDir, "assets", "icons"),
  store,
  event: ctx.event,
  playerDb: ctx.playerDb,
  clipperSettings,
  obs: ctx.obs,
  refreshControlStatus: controlStatus.refresh,
  clipperSnapshot: controlStatus.clipperSnapshot,
  reportCurrentSet,
  startCurrentSet,
  swapPorts,
  switchSides: () => store.switchSides(),
  reresolvePorts: modes.reresolvePorts,
  gameLive: () => !!ctx.state.currentGameState,
  recordClip: clipRecorder.recordClip,
  playerStatsSnapshot: playerStats.snapshot,
  overlaysDir,
  emit: channel.emit,
  setupInfo: () => ({
    base: `http://localhost:${config.BRIDGE_PORT}`,
    lan: lanDockUrls(config),
    hotkeys,
    players: { file: playersFile, count: ctx.playerDb.size },
    slippiFolder: config.SLP_FOLDER,
    startgg: { token: ctx.startgg.enabled, shortLink: ctx.event.shortLink ?? null },
    theme: activeThemePack(overlaysDir),
    themes: themePacks(overlaysDir),
  }),
});

// Rebuild the dock's status every 2s; it goes out when it changed, and every
// 5s regardless (control-status.js).
setInterval(controlStatus.refresh, 2000);

// ── Entry point ───────────────────────────────────────────────────────────────
const clipper = clipperSettings.get();

console.log("[bridge] Starting slippi-bridge...");
console.log(`[bridge] Bridge port:    ${config.BRIDGE_PORT}`);
console.log(`[bridge] Dock:           http://localhost:${config.BRIDGE_PORT}/dock`);
console.log(`[bridge] Overlays:       http://localhost:${config.BRIDGE_PORT}/o/scoreboard  (also /o/scoreboard/players, /o/casters, /o/side-panel, /o/bracket, /o/highlights)`);
for (const url of lanControlUrls(config)) {
  console.log(`[bridge]   on phone:    ${url}`);
}
console.log(`[bridge] Players:        ${playersFile} (${ctx.playerDb.size} players)`);
if (playersMissing) {
  // Not fatal — new start.gg players are added as sets load — but every regular
  // would open on no main and lose their pronoun until the file is copied over.
  console.warn("[bridge]   ⚠ no player file there yet: copy local_players.json from your old TSH install's");
  console.warn("[bridge]     user_data/ to that path, or set PLAYERS_FILE in config.local.js");
}
console.log(`[bridge] start.gg report: ${ctx.startgg.enabled ? "enabled" : "disabled (no token in config.local.js)"}`);
console.log(`[bridge] Player stats:   ${ctx.startgg.enabled
  ? "from start.gg (histories saved in stats-cache/)"
  : "off (no start.gg token)"}`);
const loadedEvent = store.tournament();
console.log(`[bridge] Brackets:       ${ctx.event.shortLink
  ? `start.gg/${ctx.event.shortLink}${ctx.startgg.enabled ? "" : " (no token — reads via start.gg's web endpoint)"}`
  : "no short link configured (config.BRACKETS.shortLink)"}`);
console.log(`[bridge] Event:          ${loadedEvent.eventSlug
  ? `${loadedEvent.name} — ${loadedEvent.eventName} (reloading from start.gg)`
  : "none yet — press Singles or Doubles in the dock's Bracket tab"}`);
console.log(`[bridge] Combo clipper:  ${clipper.enabled
  ? `enabled → OBS at ${clipper.obsUrl}`
  : "disabled (turn it on in the dock's Clips tab)"}`);
const keyList = hotkeys.bindings.map((b) => `${b.chord} ${b.label.toLowerCase()}`).join(" · ");
console.log(`[bridge] Keyboard:       ${hotkeys.mode === "global"
  ? keyList || "no hotkeys bound (config.HOTKEYS)"
  : hotkeys.mode === "terminal"
    ? `keys in this terminal (uiohook-napi unavailable): ${keyList}`
    : "no hotkeys (uiohook-napi unavailable, not a TTY)"}`);
console.log();

ctx.state.source = createFolderSource(config, ctx.comboDetector);

ctx.state.source.on("game-start", modes.onGameStart);
ctx.state.source.on("game-end",   modes.onGameEnd);
ctx.state.source.on("highlight",  clipRecorder.onHighlight);

// Connect to OBS up front when the clipper is already on, so the control panel
// shows a real OBS status before the first combo rather than after it.
ctx.obs.applySettings();

ctx.event.start();
bracketFeed.start();
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
