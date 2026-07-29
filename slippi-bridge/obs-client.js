/**
 * ObsClient — the only module that talks to OBS (obs-websocket v5).
 *
 * Returns typed { ok, error?, ... } results like tsh-client.js and
 * startgg-client.js rather than throwing, because every caller is either a
 * fire-and-forget combo hit or an Express handler and neither should be able to
 * take the bridge down when OBS simply isn't open.
 *
 * Connection policy: OBS is frequently started after the bridge, restarted
 * mid-event, or not running at all. So the socket connects lazily, retries with
 * backoff for as long as the clipper is enabled, and never rejects upward. A
 * disabled clipper holds no socket at all.
 */

const { OBSWebSocket, EventSubscription } = require("obs-websocket-js");

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 30000;
// SaveReplayBuffer returns as soon as OBS accepts the request; the file appears
// later and its path only arrives on the ReplayBufferSaved event. Long enough
// for OBS to flush a 30s buffer to disk on a slow drive.
const SAVED_EVENT_TIMEOUT_MS = 15000;

class ObsClient {
  /**
   * @param {() => object} getSettings — live clipper settings (see clipper-settings.js)
   */
  constructor(getSettings) {
    this._getSettings = getSettings;
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

    this._obs.on("ConnectionClosed", () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._bufferActive = null;
      if (wasConnected) console.log("[clipper] OBS disconnected");
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
   * Bring the connection in line with current settings.
   * Called at startup and whenever the control panel saves.
   */
  applySettings() {
    const s = this._getSettings();

    if (!s?.enabled) {
      this._teardown();
      return;
    }

    const changed = s.obsUrl !== this._appliedUrl || s.obsPassword !== this._appliedPassword;
    if (changed && this._connected) {
      // Address or password moved — drop the old socket so the new one is used.
      this._teardown({ keepEnabled: true });
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
    if (!s?.enabled) return { ok: false, error: "Combo clipper is turned off" };

    // Collapse concurrent attempts — a burst of combos must not open N sockets.
    if (this._connecting) {
      await this._connecting;
      return this._connected ? { ok: true } : { ok: false, error: this._lastError ?? "Not connected to OBS" };
    }

    const url = s.obsUrl || "ws://127.0.0.1:4455";
    this._connecting = (async () => {
      try {
        await this._obs.connect(url, s.obsPassword || undefined, {
          eventSubscriptions: EventSubscription.All | EventSubscription.Outputs,
        });
        this._connected = true;
        this._lastError = null;
        this._retryMs = RECONNECT_MIN_MS;
        this._appliedUrl = s.obsUrl;
        this._appliedPassword = s.obsPassword;
        console.log(`[clipper] Connected to OBS at ${url}`);

        try {
          const { outputActive } = await this._obs.call("GetReplayBufferStatus");
          this._bufferActive = Boolean(outputActive);
          if (!outputActive) {
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
    if (!this._getSettings()?.enabled) return;

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
    if (this._connected) {
      this._obs.disconnect().catch(() => {});
      this._connected = false;
    }
    this._bufferActive = null;
  }
}

module.exports = { ObsClient };
