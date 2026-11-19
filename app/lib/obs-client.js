/**
 * ObsClient — the only module that talks to OBS (obs-websocket v5).
 *
 * Two jobs on one socket: saving the replay buffer for the combo clipper, and
 * watching OBS's health for the dock's lights (lib/obs-health.js judges it).
 *
 * Returns typed { ok, error?, ... } results rather than throwing: every caller
 * is a fire-and-forget combo hit or an Express handler, and neither may take the
 * app down when OBS simply isn't open.
 *
 * Connection policy: OBS is frequently started after the app, restarted
 * mid-event, or not running at all. So the socket connects lazily, retries with
 * backoff for as long as Watch OBS or the clipper is on, and never rejects
 * upward. With both off it holds no socket at all.
 *
 * Health is gathered, never judged, here: a 3s poll of the stream, the
 * recording and OBS's stats, the audio meters (OBS pushes them ~20 times a
 * second), each input's mute and volume, and the browser sources that point at
 * this app. `health()` hands the raw facts over synchronously — control_status
 * is rebuilt every 2s and makes no network call.
 */

const { OBSWebSocket, EventSubscription } = require("obs-websocket-js");

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 30000;
// SaveReplayBuffer returns as soon as OBS accepts the request; the file appears
// later and its path only arrives on the ReplayBufferSaved event. Long enough
// for OBS to flush a 30s buffer to disk on a slow drive.
const SAVED_EVENT_TIMEOUT_MS = 15000;

// While connected: the stream, the recording and the stats, this often.
const POLL_MS = 3000;
// The browser sources are listed at connect, after any input or scene change,
// and this often regardless.
const SOURCES_MS = 60000;
// Dropped and lagged frames are rates over this much history.
const WINDOW_MS = 60000;
// A level shows the loudest peak in this window: the dock samples it every 2s.
const PEAK_HOLD_MS = 2000;
// An input missing from the meters this long has left the mix (it was removed,
// or it isn't in the scene on air).
const METER_GONE_MS = 5000;
const LOUD_MUL = 0.001;  // -60 dBFS: anything quieter is silence
const CLIP_MUL = 0.944;  // -0.5 dBFS

/** Whether the socket should be open at all. */
const wanted = (s) => Boolean(s?.obsMonitor || s?.enabled);

const toDb = (mul) => (mul > 0 ? Math.max(-100, Math.round(200 * Math.log10(mul)) / 10) : -100);

/**
 * The page a browser source shows, when it's one of this app's overlays:
 * "/o/side-panel?panel=player-1". Anything else (a local file, another site,
 * another port) is null.
 */
function overlayPage(url, port) {
  let u;
  try { u = new URL(String(url || "")); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const p = u.port || (u.protocol === "https:" ? "443" : "80");
  if (p !== String(port) || !u.pathname.startsWith("/o/")) return null;
  return u.pathname + u.search;
}

function freshHealth() {
  return {
    connectedAt: null,
    targetFps: null,
    stream: null,          // { active, reconnecting, congestion, kbps, dropPct, zeroSince }
    record: null,          // { active, paused }
    stats: null,           // { diskMb, fps, targetFps, renderLagPct, encodeLagPct, lowFpsSince }
    samples: [],           // the counters behind the rates, newest last
    inputs: new Map(),     // name → meter, mute and volume
    sources: [],           // [{ name, page, listedAt }]
  };
}

class ObsClient {
  /**
   * @param {() => object} getSettings — live clipper settings (see clipper-settings.js)
   * @param {{ port?: number }} [opts] — the app's port, to know its own browser sources
   */
  constructor(getSettings, { port = null } = {}) {
    this._getSettings = getSettings;
    this._port = port;
    this._obs = new OBSWebSocket();
    this._connected = false;
    this._connecting = false;
    this._bufferActive = null;   // null = not yet known
    this._lastError = null;
    this._retryMs = RECONNECT_MIN_MS;
    this._retryTimer = null;
    this._appliedUrl = null;
    this._appliedPassword = null;
    this._savedWaiters = [];
    this._health = freshHealth();
    this._downSince = Date.now();
    this._pollTimer = null;
    this._sourcesTimer = null;
    this._sourcesSoon = null;
    this._polling = false;
    this._listing = false;

    this._obs.on("ConnectionClosed", () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._bufferActive = null;
      this._stopWatching();
      if (wasConnected) {
        this._downSince = Date.now();
        console.log("[obs] Disconnected");
      }
      this._scheduleReconnect();
    });

    // The authoritative source for where a clip landed. Polling
    // GetLastReplayBufferReplay right after SaveReplayBuffer races the write and
    // can hand back the *previous* clip's path.
    this._obs.on("ReplayBufferSaved", ({ savedReplayPath }) => {
      const waiters = this._savedWaiters;
      this._savedWaiters = [];
      for (const resolve of waiters) resolve(savedReplayPath ?? null);
    });

    this._obs.on("ReplayBufferStateChanged", ({ outputActive }) => {
      this._bufferActive = Boolean(outputActive);
    });

    // The stream and the recording change at once, not on the next poll.
    this._obs.on("StreamStateChanged", ({ outputActive, outputState }) => {
      const h = this._health;
      const reconnecting = outputState === "OBS_WEBSOCKET_OUTPUT_RECONNECTING";
      h.stream = { ...(h.stream || { congestion: 0, kbps: 0, dropPct: 0, zeroSince: null }), active: Boolean(outputActive), reconnecting };
      const said = {
        OBS_WEBSOCKET_OUTPUT_STARTED: "Stream started",
        OBS_WEBSOCKET_OUTPUT_STOPPED: "Stream stopped",
        OBS_WEBSOCKET_OUTPUT_RECONNECTING: "Stream dropped — OBS is reconnecting",
        OBS_WEBSOCKET_OUTPUT_RECONNECTED: "Stream reconnected",
      }[outputState];
      if (said) console.log(`[obs] ${said}`);
    });
    this._obs.on("RecordStateChanged", ({ outputActive, outputState }) => {
      this._health.record = { active: Boolean(outputActive), paused: outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED" };
    });

    this._obs.on("InputVolumeMeters", ({ inputs }) => this._onMeters(inputs, Date.now()));
    this._obs.on("InputMuteStateChanged", ({ inputName, inputMuted }) => {
      const m = this._health.inputs.get(inputName);
      if (m) m.muted = Boolean(inputMuted);
    });
    this._obs.on("InputVolumeChanged", ({ inputName, inputVolumeMul }) => {
      const m = this._health.inputs.get(inputName);
      if (m) m.volumeMul = inputVolumeMul;
    });
    this._obs.on("InputNameChanged", ({ oldInputName, inputName }) => {
      const inputs = this._health.inputs;
      if (inputs.has(oldInputName)) {
        inputs.set(inputName, inputs.get(oldInputName));
        inputs.delete(oldInputName);
      }
      this._listSourcesSoon();
    });
    this._obs.on("InputRemoved", ({ inputName }) => {
      this._health.inputs.delete(inputName);
      this._listSourcesSoon();
    });
    // A new or edited browser source, or a scene change (a source that shuts
    // down while hidden only loads once it shows).
    for (const ev of ["InputCreated", "InputSettingsChanged", "CurrentProgramSceneChanged", "CurrentPreviewSceneChanged", "SceneItemEnableStateChanged"]) {
      this._obs.on(ev, () => this._listSourcesSoon());
    }
  }

  /** Synchronous snapshot for control_status — rebuilt every 2s, so no I/O. */
  getStatus() {
    const s = this._getSettings();
    return {
      enabled: Boolean(s?.enabled),
      connected: this._connected,
      url: s?.obsUrl ?? "",
      bufferActive: this._bufferActive,
      lastError: this._lastError,
    };
  }

  /**
   * Everything known about OBS's health, unjudged (lib/obs-health.js judges
   * it). Synchronous: read on control_status's 2s tick.
   */
  health(now = Date.now()) {
    const s = this._getSettings() || {};
    const h = this._health;
    const inputs = [];
    for (const [name, m] of h.inputs) {
      const inMix = now - m.seenAt <= METER_GONE_MS;
      inputs.push({
        name,
        inMix,
        levelDb: inMix ? toDb(m.levelMul) : -100,
        lastLoudAt: m.lastLoudAt,
        lastClipAt: m.lastClipAt,
        firstSeenAt: m.firstSeenAt,
        muted: m.muted,
        volumeMul: m.volumeMul,
      });
    }
    return {
      monitor: Boolean(s.obsMonitor),
      clipper: Boolean(s.enabled),
      expectRecording: Boolean(s.obsExpectRecording),
      gameAudio: s.obsGameAudio || "",
      url: s.obsUrl || "",
      connected: this._connected,
      connectedAt: h.connectedAt,
      downSince: this._connected ? null : this._downSince,
      lastError: this._lastError,
      bufferActive: this._bufferActive,
      stream: h.stream,
      record: h.record,
      stats: h.stats,
      inputs,
      sources: h.sources,
    };
  }

  /**
   * Bring the connection in line with current settings.
   * Called at startup and whenever the Clips tab saves.
   */
  applySettings() {
    const s = this._getSettings();

    if (!wanted(s)) {
      this._teardown();
      return;
    }

    const changed = s.obsUrl !== this._appliedUrl || s.obsPassword !== this._appliedPassword;
    if (changed && this._connected) {
      // Address or password moved — drop the old socket so the new one is used.
      this._teardown();
    }
    this._connect().catch(() => {});
  }

  /**
   * Save the replay buffer now.
   * @returns {Promise<{ ok: boolean, path?: string|null, error?: string }>}
   */
  async saveReplayBuffer() {
    const s = this._getSettings();

    const conn = await this._connect();
    if (!conn.ok) return conn;

    try {
      const { outputActive } = await this._obs.call("GetReplayBufferStatus");
      this._bufferActive = Boolean(outputActive);

      if (!outputActive) {
        if (!s.autoStartBuffer) {
          return { ok: false, error: "OBS replay buffer isn't running (enable it in OBS, or turn on Auto-start buffer)" };
        }
        await this._obs.call("StartReplayBuffer");
        this._bufferActive = true;
        console.log("[clipper] Started OBS replay buffer");
        // A buffer started this instant holds nothing worth saving. Say so
        // rather than writing a clip of the last half-second.
        return { ok: false, error: "Replay buffer was off — started it now. This combo wasn't captured; the next one will be." };
      }

      const saved = this._waitForSavedPath();
      await this._obs.call("SaveReplayBuffer");
      const savedPath = await saved;

      this._lastError = null;
      return { ok: true, path: savedPath };
    } catch (e) {
      const msg = e?.message ?? String(e);
      this._lastError = msg;
      return { ok: false, error: `OBS request failed: ${msg}` };
    }
  }

  /**
   * Press a browser source's "Refresh cache of current page" — the fix for an
   * overlay that failed to load (a browser source never retries by itself).
   */
  async refreshBrowserSource(inputName) {
    if (!this._connected) return { ok: false, error: "Not connected to OBS" };
    try {
      await this._obs.call("PressInputPropertiesButton", { inputName, propertyName: "refreshnocache" });
      console.log(`[obs] Refreshed the browser source "${inputName}"`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `OBS request failed: ${e?.message ?? e}` };
    }
  }

  /** Resolves with the saved clip's path, or null if OBS never reports one. */
  _waitForSavedPath() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._savedWaiters = this._savedWaiters.filter((w) => w !== wrapped);
        // The clip is very likely on disk regardless — a missing event is not
        // proof of a failed save, so this resolves rather than rejects.
        resolve(null);
      }, SAVED_EVENT_TIMEOUT_MS);

      const wrapped = (path) => { clearTimeout(timer); resolve(path); };
      this._savedWaiters.push(wrapped);
    });
  }

  /** Connect if not already connected. Never throws. */
  async _connect() {
    if (this._connected) return { ok: true };

    const s = this._getSettings();
    if (!wanted(s)) return { ok: false, error: "Watch OBS and the combo clipper are both off" };

    // Collapse concurrent attempts — a burst of combos must not open N sockets.
    if (this._connecting) {
      await this._connecting;
      return this._connected ? { ok: true } : { ok: false, error: this._lastError ?? "Not connected to OBS" };
    }

    const url = s.obsUrl || "ws://127.0.0.1:4455";
    this._connecting = (async () => {
      try {
        await this._obs.connect(url, s.obsPassword || undefined, {
          // The meters are a high-volume event, left out of All.
          eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
        });
        this._connected = true;
        this._lastError = null;
        this._retryMs = RECONNECT_MIN_MS;
        this._appliedUrl = s.obsUrl;
        this._appliedPassword = s.obsPassword;
        console.log(`[obs] Connected to OBS at ${url}`);
        this._startWatching();

        try {
          const { outputActive } = await this._obs.call("GetReplayBufferStatus");
          this._bufferActive = Boolean(outputActive);
          if (!outputActive && s.enabled) {
            console.warn("[clipper] OBS replay buffer is not running — clips can't be saved until it is");
          }
        } catch { /* status is cosmetic; a failure here must not fail the connect */ }
      } catch (e) {
        this._connected = false;
        this._lastError = this._describeConnectError(e, url);
        this._scheduleReconnect();
      }
    })();

    await this._connecting;
    this._connecting = null;
    return this._connected ? { ok: true } : { ok: false, error: this._lastError };
  }

  /** Turn obs-websocket's terse errors into something actionable at a venue. */
  _describeConnectError(e, url) {
    const msg = e?.message ?? String(e);
    if (/authentication/i.test(msg)) {
      return "OBS rejected the password (Tools → WebSocket Server Settings → Show Connect Info)";
    }
    if (/ECONNREFUSED|failed to connect|connect/i.test(msg)) {
      return `Can't reach OBS at ${url} — is OBS open with the WebSocket server enabled?`;
    }
    return msg;
  }

  _scheduleReconnect() {
    if (this._retryTimer) return;
    if (!wanted(this._getSettings())) return;

    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._retryMs = Math.min(RECONNECT_MAX_MS, this._retryMs * 2);
      this._connect().catch(() => {});
    }, this._retryMs);
    // Don't hold the process open just to retry a connection.
    this._retryTimer.unref?.();
  }

  _teardown() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._retryMs = RECONNECT_MIN_MS;
    this._stopWatching();
    if (this._connected) {
      this._obs.disconnect().catch(() => {});
      this._connected = false;
      this._downSince = Date.now();
    }
    this._bufferActive = null;
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  _startWatching() {
    this._stopWatching();
    this._health = freshHealth();
    this._health.connectedAt = Date.now();
    this._obs.call("GetVideoSettings")
      .then(({ fpsNumerator, fpsDenominator }) => {
        if (fpsNumerator > 0 && fpsDenominator > 0) this._health.targetFps = fpsNumerator / fpsDenominator;
      })
      .catch(() => {});
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    this._pollTimer.unref?.();
    this._sourcesTimer = setInterval(() => this._listSources(), SOURCES_MS);
    this._sourcesTimer.unref?.();
    this._poll();
    this._listSources();
  }

  _stopWatching() {
    clearInterval(this._pollTimer);
    clearInterval(this._sourcesTimer);
    clearTimeout(this._sourcesSoon);
    this._pollTimer = this._sourcesTimer = this._sourcesSoon = null;
  }

  async _poll() {
    if (!this._connected || this._polling) return;
    this._polling = true;
    try {
      const [stream, record, stats] = await Promise.all([
        this._obs.call("GetStreamStatus"),
        this._obs.call("GetRecordStatus"),
        this._obs.call("GetStats"),
      ]);
      this._sample(stream, record, stats, Date.now());
    } catch { /* the next poll asks again; a closed socket is ConnectionClosed's */ }
    finally { this._polling = false; }
  }

  /** One poll's answers → the stream, recording and stats facts, with their rates. */
  _sample(stream, record, stats, now) {
    const h = this._health;
    const cur = {
      t: now,
      bytes: stream.outputBytes || 0,
      dropped: stream.outputSkippedFrames || 0,
      sent: stream.outputTotalFrames || 0,
      renderSkipped: stats.renderSkippedFrames || 0,
      renderTotal: stats.renderTotalFrames || 0,
      encodeSkipped: stats.outputSkippedFrames || 0,
      encodeTotal: stats.outputTotalFrames || 0,
    };
    const prev = h.samples[h.samples.length - 1];
    // The stream's counters start again with each stream: a fresh history.
    if (prev && Object.keys(cur).some((k) => cur[k] < prev[k])) h.samples = [];
    h.samples.push(cur);
    while (h.samples.length > 2 && now - h.samples[0].t > WINDOW_MS) h.samples.shift();

    const first = h.samples[0];
    const before = h.samples[h.samples.length - 2] || cur;
    const pct = (part, whole) => {
      const n = cur[whole] - first[whole];
      return n >= 60 ? Math.round((1000 * (cur[part] - first[part])) / n) / 10 : 0;
    };

    const active = Boolean(stream.outputActive);
    const reconnecting = Boolean(stream.outputReconnecting);
    // Bytes per ms × 8 = kilobits per second.
    const kbps = active && cur.t > before.t ? Math.round(((cur.bytes - before.bytes) * 8) / (cur.t - before.t)) : 0;
    h.stream = {
      active,
      reconnecting,
      congestion: stream.outputCongestion || 0,
      kbps,
      dropPct: active ? pct("dropped", "sent") : 0,
      zeroSince: active && !reconnecting && kbps === 0 ? (h.stream?.zeroSince ?? now) : null,
    };
    h.record = { active: Boolean(record.outputActive), paused: Boolean(record.outputPaused) };

    const fps = Number.isFinite(stats.activeFps) ? Math.round(stats.activeFps * 10) / 10 : null;
    const low = h.targetFps != null && fps != null && fps < h.targetFps - 2;
    h.stats = {
      diskMb: Number.isFinite(stats.availableDiskSpace) ? Math.round(stats.availableDiskSpace) : null,
      fps,
      targetFps: h.targetFps,
      renderLagPct: pct("renderSkipped", "renderTotal"),
      encodeLagPct: pct("encodeSkipped", "encodeTotal"),
      lowFpsSince: low ? (h.stats?.lowFpsSince ?? now) : null,
    };
  }

  /** One InputVolumeMeters event: each input's levels, per channel [magnitude, peak, input peak]. */
  _onMeters(list, now) {
    for (const { inputName, inputLevelsMul } of list || []) {
      if (!inputName) continue;
      let peak = 0;
      let input = 0;
      for (const ch of inputLevelsMul || []) {
        peak = Math.max(peak, ch?.[1] || 0);
        input = Math.max(input, ch?.[2] || 0);
      }
      let m = this._health.inputs.get(inputName);
      if (!m) {
        m = { levelMul: 0, holdAt: 0, lastLoudAt: null, lastClipAt: null, firstSeenAt: now, seenAt: now, muted: null, volumeMul: null };
        this._health.inputs.set(inputName, m);
        this._askMix(inputName, m);
      }
      if (peak >= m.levelMul || now - m.holdAt > PEAK_HOLD_MS) {
        m.levelMul = peak;
        m.holdAt = now;
      }
      if (Math.max(peak, input) > LOUD_MUL) m.lastLoudAt = now;
      if (peak >= CLIP_MUL) m.lastClipAt = now;
      m.seenAt = now;
    }
  }

  /** An input's mute and volume, once; the events keep them current after. */
  _askMix(inputName, m) {
    Promise.all([
      this._obs.call("GetInputMute", { inputName }),
      this._obs.call("GetInputVolume", { inputName }),
    ]).then(([mute, vol]) => {
      m.muted = Boolean(mute.inputMuted);
      m.volumeMul = vol.inputVolumeMul;
    }).catch(() => {});
  }

  _listSourcesSoon() {
    if (!this._connected) return;
    clearTimeout(this._sourcesSoon);
    this._sourcesSoon = setTimeout(() => this._listSources(), 1000);
    this._sourcesSoon.unref?.();
  }

  /**
   * The browser sources that show one of this app's overlays. One that shuts
   * down while hidden counts only while it shows; `listedAt` restarts when a
   * source's page or showing changes, so each gets its time to load.
   */
  async _listSources() {
    if (!this._connected || this._listing || !this._port) return;
    this._listing = true;
    try {
      const { inputs } = await this._obs.call("GetInputList", { inputKind: "browser_source" });
      const prev = new Map(this._health.sources.map((x) => [x.name, x]));
      const out = [];
      for (const { inputName } of inputs || []) {
        const { inputSettings: st = {} } = await this._obs.call("GetInputSettings", { inputName });
        if (st.is_local_file) continue;
        const page = overlayPage(st.url, this._port);
        if (!page) continue;
        if (st.shutdown) {
          const { videoShowing } = await this._obs.call("GetSourceActive", { sourceName: inputName });
          if (!videoShowing) continue;
        }
        const was = prev.get(inputName);
        out.push({ name: inputName, page, listedAt: was && was.page === page ? was.listedAt : Date.now() });
      }
      this._health.sources = out;
    } catch { /* kept as it was; the next listing tries again */ }
    finally { this._listing = false; }
  }
}

module.exports = { ObsClient, overlayPage };
