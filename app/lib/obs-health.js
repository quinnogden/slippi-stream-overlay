/**
 * obs-health.js — pure. OBS's raw facts (ObsClient.health()) and the app's
 * (a set loaded, a game on, the overlays connected) → the dock's four lights
 * and the list of problems, each with what to do about it.
 *
 *   evaluate(facts, app, now) → { lights: { obs, live, rec, audio }, issues, gameAudio, gameAudioAuto, gameAudioGuess }
 *
 * A light is "up", "warn", "down", "idle" (shown, grey) or "off" (hidden). An
 * issue is { id, light, level: "error" | "warn" | "note", text, fix? }; the id is
 * stable while the problem lasts, so the dock can hide one it was told about.
 *
 * Every timed rule waits out a grace first (GRACE), because each of these
 * conditions is normal for a moment: OBS starting, a stream starting, a quiet
 * second between stocks, a page loading.
 */

const GRACE = {
  down: 5000,        // OBS unreachable this long before it's a problem
  zeroKbps: 10000,   // "streaming" and sending nothing
  lowFps: 10000,     // below the target frame rate
  silentGame: 10000, // no game audio while a game is on
  silentAll: 20000,  // nothing audible on the stream at all
  clip: 5000,        // an input clipped this recently
  offAir: 5000,      // the game's audio input not in the mix, into a game
  source: 15000,     // a browser source's page to connect
};

// What a game-audio input is usually called, for the guess when none is picked.
const GAME_AUDIO = /game|capture|elgato|avermedia|hdmi|melee|slippi|dolphin|\bgc\b|wii|usb video|cam ?link/i;

const LEVELS = { error: 3, warn: 2, note: 1 };

/** The input picked as the game's audio, else the first whose name looks like one. */
function pickGameAudio(inputs, setting) {
  if (setting) return { name: setting, auto: false, input: inputs.find((i) => i.name === setting) || null };
  const input = inputs.find((i) => GAME_AUDIO.test(i.name)) || null;
  return { name: input ? input.name : null, auto: true, input };
}

/** "/o/scoreboard/?x=1" → { path: "/o/scoreboard", full: "/o/scoreboard?x=1" } */
function pageKey(page) {
  const s = String(page || "");
  const q = s.indexOf("?");
  const path = (q < 0 ? s : s.slice(0, q)).replace(/\/+$/, "");
  return { path, full: path + (q < 0 ? "" : s.slice(q)) };
}

/**
 * Whether a source's page has a socket on /overlay. The url must match, query
 * included — unless no other source shows that page, when the path is enough
 * (a query OBS and the browser encode differently shouldn't read as a failure).
 */
function sourceLoaded(source, sources, pages) {
  const want = pageKey(source.page);
  const have = pages.map(pageKey);
  if (have.some((p) => p.full === want.full)) return true;
  const samePath = sources.filter((s) => pageKey(s.page).path === want.path);
  return samePath.length === 1 && have.some((p) => p.path === want.path);
}

const pct = (n) => `${Number(n).toFixed(n >= 10 ? 0 : 1)}%`;

/**
 * @param {object|null} f — ObsClient.health()
 * @param {{ setLoaded?: boolean, gameLive?: boolean, gameSince?: number|null, pages?: string[] }} app
 * @param {number} now
 */
function evaluate(f, app = {}, now = Date.now()) {
  const issues = [];
  const add = (light, level, id, text, fix) => issues.push(fix ? { id, light, level, text, fix } : { id, light, level, text });
  const lights = { obs: "off", live: "off", rec: "off", audio: "off" };
  const done = (game = { name: null, auto: true }) => {
    for (const i of issues) {
      const was = lights[i.light];
      if (i.level === "error") lights[i.light] = "down";
      else if (i.level === "warn" && was !== "down") lights[i.light] = "warn";
    }
    issues.sort((a, b) => LEVELS[b.level] - LEVELS[a.level]);
    // The guess by name, picked or not: the dock's Auto option names it.
    const guess = pickGameAudio((f && f.inputs) || [], "").name;
    return { lights, issues, gameAudio: game.name, gameAudioAuto: game.auto, gameAudioGuess: guess };
  };

  if (!f || (!f.monitor && !f.clipper)) return done();

  if (!f.connected) {
    lights.obs = "down";
    if (f.monitor && now - (f.downSince ?? now) >= GRACE.down) {
      add("obs", "error", "obs-down", f.lastError || "Can't reach OBS");
    }
    return done();
  }
  lights.obs = "up";
  // The clipper alone holds the socket: no checks, just whether it's up.
  if (!f.monitor) return done();

  const gameLive = Boolean(app.gameLive);
  const gameFor = gameLive && app.gameSince != null ? now - app.gameSince : 0;

  // ── The stream ──────────────────────────────────────────────────────────────
  const st = f.stream;
  const streaming = Boolean(st && st.active);
  lights.live = streaming ? "up" : "idle";
  if (st && !streaming) {
    if (gameLive) add("live", "error", "not-streaming", "A game is on and OBS isn't streaming");
    else if (app.setLoaded) add("live", "warn", "not-streaming", "A set is loaded and OBS isn't streaming");
  }
  if (streaming) {
    if (st.reconnecting) add("live", "error", "stream-reconnecting", "The stream dropped: OBS is reconnecting");
    else if (st.zeroSince != null && now - st.zeroSince >= GRACE.zeroKbps) {
      add("live", "error", "stream-empty", "OBS says it's streaming but is sending nothing");
    }
    if (st.dropPct > 5) add("live", "error", "stream-drops", `Dropping ${pct(st.dropPct)} of frames: the connection can't keep up (lower the bitrate)`);
    else if (st.dropPct > 1) add("live", "warn", "stream-drops", `Dropping ${pct(st.dropPct)} of frames (network)`);
    else if (st.congestion > 0.5) add("live", "warn", "stream-congested", "The connection is congested; frames may start dropping");
  }

  // ── The recording ───────────────────────────────────────────────────────────
  const rec = f.record;
  const recording = Boolean(rec && rec.active);
  if (f.expectRecording || recording) lights.rec = recording && !rec.paused ? "up" : "idle";
  if (recording && rec.paused) add("rec", "warn", "rec-paused", "The recording is paused");
  if (f.expectRecording && rec && !recording && (streaming || gameLive)) add("rec", "warn", "not-recording", "OBS isn't recording");

  // ── OBS itself ──────────────────────────────────────────────────────────────
  const stats = f.stats;
  if (stats) {
    const disk = stats.diskMb;
    if (disk != null && (recording || f.bufferActive)) {
      const light = recording ? "rec" : "obs";
      if (disk < 1024) add(light, "error", "disk-low", "Under 1 GB of disk left for OBS's recording");
      else if (disk < 5120) add(light, "warn", "disk-low", `${(disk / 1024).toFixed(1)} GB of disk left for OBS's recording`);
    }
    if (stats.renderLagPct > 1) add("obs", "warn", "render-lag", `OBS is missing ${pct(stats.renderLagPct)} of frames rendering: the GPU is overloaded`);
    if (stats.encodeLagPct > 1) add("obs", "warn", "encode-lag", `The encoder is skipping ${pct(stats.encodeLagPct)} of frames: lower the encoder preset or the bitrate`);
    if (stats.lowFpsSince != null && now - stats.lowFpsSince >= GRACE.lowFps) {
      add("obs", "warn", "low-fps", `OBS is running at ${stats.fps} of ${Math.round(stats.targetFps)} fps`);
    }
  }

  // ── The overlays ────────────────────────────────────────────────────────────
  const pages = app.pages || [];
  for (const src of f.sources || []) {
    if (now - src.listedAt < GRACE.source) continue;
    if (!sourceLoaded(src, f.sources, pages)) {
      add("obs", "warn", `source:${src.name}`, `The overlay "${src.name}" didn't load`, { label: "Refresh", action: "refresh-source", input: src.name });
    }
  }

  // ── The audio ───────────────────────────────────────────────────────────────
  const inputs = f.inputs || [];
  const inMix = inputs.filter((i) => i.inMix);
  const game = pickGameAudio(inputs, f.gameAudio);
  lights.audio = inMix.length ? "up" : "idle";
  const quietFor = (i, since = 0) => now - Math.max(i.lastLoudAt || 0, i.firstSeenAt || 0, since);

  if (!game.name) {
    add("audio", "note", "game-audio-unknown", "Pick which OBS input is the game's sound (Clips → OBS)");
  } else if (game.input && game.input.inMix) {
    const gi = game.input;
    const level = gameLive ? "error" : "warn";
    if (gi.muted) add("audio", level, "game-muted", `The game's sound (${gi.name}) is muted in OBS`);
    else if (gi.volumeMul === 0) add("audio", level, "game-volume", `The game's sound (${gi.name}) is turned all the way down`);
    else if (gameLive && quietFor(gi, app.gameSince) >= GRACE.silentGame) {
      add("audio", "error", "game-silent", `No sound from ${gi.name} during the game`);
    }
  } else if (gameLive && gameFor >= GRACE.offAir) {
    add("audio", "error", "game-off-air", `The game's sound (${game.name}) isn't in the scene on air`);
  }

  const connectedFor = now - (f.connectedAt ?? now);
  if (streaming && connectedFor >= GRACE.silentAll) {
    if (!inMix.length) add("audio", "warn", "no-audio", "Nothing on the stream has sound: no audio input is in the scene");
    else if (inMix.every((i) => i.muted || quietFor(i) >= GRACE.silentAll)) add("audio", "warn", "all-silent", "The stream has been silent for 20 seconds");
  }
  for (const i of inMix) {
    if (!i.muted && i.lastClipAt != null && now - i.lastClipAt < GRACE.clip) {
      add("audio", "warn", `clipping:${i.name}`, `${i.name} is clipping: turn it down`);
    }
  }

  return done(game);
}

module.exports = { evaluate, pickGameAudio, sourceLoaded, GRACE };
