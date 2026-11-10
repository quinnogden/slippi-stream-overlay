/**
 * uploader.js — stream sets' replay bundles to LuckyStats.gg ("App uploads").
 *
 * The only module that sends uploads to luckystats.gg; lib/stats/luckystats.js
 * reads ratings with a different key and shares nothing but the host.
 *
 *   Base   https://luckystats.gg/api/integrations/v1
 *   Auth   Authorization: Bearer <LUCKYSTATS_UPLOAD_KEY>   (an l7u_… key)
 *          X-App-Id: replay-reporter                         (the app id upload
 *          keys are issued for — Replay Reporter for Slippi's; agreed by the
 *          operator, since the bundles are in its format)
 *
 * One set, one revision:
 *   1. POST /uploads (Idempotency-Key) with the tournament, set id and every
 *      file's path, size and SHA-256 → an upload id and a signed PUT per file
 *   2. PUT each file to its signed link with the returned headers EXACTLY —
 *      storage refuses a changed size, type, checksum or an overwrite. A 412 on
 *      a retried PUT means the object is already there.
 *   3. POST /uploads/:id/complete → `staged`. Nothing is imported until the
 *      tournament is finished (finish(), or LuckyStats' own auto-finish).
 *
 * The journal is the stream-set record's `upload` (stream-sets.js): the
 * idempotency key and the bundle digest are saved BEFORE step 1, so a restart
 * mid-upload repeats the same request and gets the same upload back. Same
 * contents → same key; changed contents (a corrected game) → a new key, which
 * LuckyStats treats as a new revision that replaces the old one atomically.
 *
 * Sets go one at a time — never more than one unfinished transfer of ours
 * against LuckyStats' three. 429 waits for Retry-After; a 5xx or a network
 * error backs off with jitter and tries again; any other refusal stops that
 * set with LuckyStats' message for the dock. Nothing here is ever awaited by
 * Report or Start.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { fileData } = require("./bundle");

const BASE_URL = "https://luckystats.gg/api/integrations/v1";
const APP_ID = "replay-reporter";
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 10 * 60 * 1000;
const BUSY_RETRY_MS = 20000;      // a file still being written, start.gg's meta still loading
const POLL_MS = 15000;            // LuckyStats asks for tournament status every 15s while connected
const POLL_RECENT_MS = 12 * 3600 * 1000;
const TIMEOUT_MS = 30000;

/** A failed request, with what the queue needs to decide what to do next. */
class UploadError extends Error {
  constructor(message, { status = null, code = null, retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
  get transient() { return this.status == null || this.status === 429 || this.status >= 500; }
}

/** PUT a buffer with exactly these headers (no fetch: it adds its own). */
function putFile(url, headers, data) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = (u.protocol === "http:" ? http : https).request(u, { method: "PUT", headers, timeout: TIMEOUT_MS * 4 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ status: null, body: err.message }));
    req.end(data);
  });
}

class LuckyStatsUploads {
  /**
   * @param {{
   *   key?: string, sets: import("./stream-sets").StreamSets,
   *   bundleFor: (record: object) => object,   — bundle.js buildBundle, with the meta loaded
   *   onChange?: () => void, baseUrl?: string, fetch?: Function, put?: Function, now?: () => number,
   * }} opts
   */
  constructor(opts) {
    this._key = String(opts.key ?? "").trim();
    this._sets = opts.sets;
    this._bundleFor = opts.bundleFor;
    this._onChange = opts.onChange ?? (() => {});
    this._base = opts.baseUrl ?? BASE_URL;
    this._fetch = opts.fetch ?? globalThis.fetch;
    this._put = opts.put ?? putFile;
    this._now = opts.now ?? Date.now;
    this._running = null;
    this._timer = null;
    this._lastPoll = 0;
    this.connection = null; // GET /connection's last answer
  }

  get enabled() { return this._key.length > 0; }

  /** Retry what's due and poll the tournament status, until stop(). */
  start() {
    if (!this.enabled || this._timer) return;
    this._timer = setInterval(() => { this.kick(); this._poll(); }, 5000);
    this._timer.unref?.();
    this.checkConnection();
    this.kick();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  // ── API ─────────────────────────────────────────────────────────────────────

  /**
   * One JSON request. Resolves with the body, or throws an UploadError.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {object} [headers]
   */
  async _api(method, path, body, headers = {}) {
    let res;
    try {
      res = await this._fetch(this._base + path, {
        method,
        headers: {
          Authorization: `Bearer ${this._key}`,
          "X-App-Id": APP_ID,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new UploadError(`LuckyStats couldn't be reached (${err.message})`);
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (_) { /* not JSON */ }
    if (res.ok) return json ?? {};
    const code = json?.code ?? json?.error?.code ?? (typeof json?.error === "string" ? json.error : null);
    const message = json?.message ?? json?.error?.message ?? (typeof json?.error === "string" ? json.error : null) ?? text.slice(0, 200);
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    throw new UploadError(`LuckyStats refused (${res.status}${code && code !== message ? ` ${code}` : ""}): ${message || res.statusText || "no message"}`, {
      status: res.status, code, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
    });
  }

  /** GET /connection — whether the key works, and its limits. */
  async checkConnection() {
    if (!this.enabled) {
      this.connection = { ok: false, error: "No LUCKYSTATS_UPLOAD_KEY in config.local.js" };
      return this.connection;
    }
    try {
      this.connection = { ok: true, checkedAt: this._now(), ...(await this._api("GET", "/connection")) };
    } catch (err) {
      this.connection = { ok: false, checkedAt: this._now(), error: err.message, status: err.status };
    }
    this._onChange();
    return this.connection;
  }

  // ── The queue ───────────────────────────────────────────────────────────────

  /**
   * Upload a set (again). Same contents as its last upload: nothing to do.
   * @param {string} setId
   * @returns {{ ok: boolean, error?: string }}
   */
  enqueue(setId) {
    if (!this.enabled) return { ok: false, error: "No LUCKYSTATS_UPLOAD_KEY in config.local.js" };
    const r = this._sets.get(setId);
    if (!r) return { ok: false, error: "That set isn't in the list" };
    this._journal(setId, { state: "queued", error: null, attempts: 0, nextTryAt: 0 });
    this.kick();
    return { ok: true };
  }

  /** Work through what's due, one set at a time. Never rejects. */
  kick() {
    if (!this.enabled || this._running) return this._running ?? Promise.resolve();
    this._running = (async () => {
      for (;;) {
        const due = this._sets.list().reverse().find((r) => this._due(r));
        if (!due) break;
        // Anything unexpected stops this set (failed), never the loop on it.
        await this._process(due.setId).catch((err) => this._failed(due.setId, err));
      }
    })().catch((err) => console.warn(`[replays] Upload queue stopped: ${err.message}`))
      .finally(() => { this._running = null; });
    return this._running;
  }

  _due(r) {
    const u = r.upload;
    if (!u) return false;
    if (u.state === "queued" || u.state === "uploading") return true;
    return u.state === "retry" && (u.nextTryAt ?? 0) <= this._now();
  }

  /** Merge into a record's upload journal. */
  _journal(setId, patch) {
    const r = this._sets.update(setId, (rec) => ({ upload: { ...(rec.upload ?? {}), ...patch } }));
    this._onChange();
    return r?.upload ?? null;
  }

  async _process(setId) {
    const record = this._sets.get(setId);
    const bundle = this._bundleFor(record);
    if (!bundle.ok) {
      if (bundle.waiting) {
        this._journal(setId, { state: "retry", error: bundle.error, nextTryAt: this._now() + BUSY_RETRY_MS });
      } else {
        this._journal(setId, { state: "blocked", error: bundle.error });
        console.warn(`[replays] Set ${setId} can't be uploaded: ${bundle.error}`);
      }
      return;
    }

    let u = record.upload ?? {};
    if (u.digest !== bundle.digest || !u.idempotencyKey) {
      // New contents: a new revision. An unfinished transfer of the old
      // contents is cancelled first — it would hold one of the three slots.
      if (u.uploadId && u.digest && u.state !== "staged") await this._api("DELETE", `/uploads/${u.uploadId}`).catch(() => {});
      u = this._journal(setId, {
        digest: bundle.digest, idempotencyKey: crypto.randomUUID(),
        uploadId: null, revision: null, staged: false, stagedAt: null, remote: null,
      });
    }

    const tournament = record.meta?.tournament?.slug || record.tournament?.slug;
    const totalBytes = bundle.files.reduce((n, f) => n + f.size, 0);
    this._journal(setId, { state: "uploading", error: null, sentBytes: 0, totalBytes });

    try {
      // 1. Approval. Repeating it with the same key returns the same upload.
      let approval;
      try {
        approval = await this._approve(tournament, record.setId, bundle, u.idempotencyKey);
      } catch (err) {
        // The key was used for other contents (a crash between a fix and its
        // journal write): a new key is a new revision.
        if (err.status !== 409 || /tournament_finalized|uploads_closed/i.test(err.code ?? err.message)) throw err;
        u = this._journal(setId, { idempotencyKey: crypto.randomUUID(), uploadId: null });
        approval = await this._approve(tournament, record.setId, bundle, u.idempotencyKey);
      }
      this._journal(setId, {
        uploadId: approval.uploadId, tournamentUploadId: approval.tournamentUploadId ?? null,
        revision: approval.revision ?? null,
      });

      if (approval.status !== "staged") {
        // 2. The files, straight to storage.
        await this._sendFiles(setId, approval, bundle);
        // 3. Verify and stage.
        const done = await this._api("POST", `/uploads/${approval.uploadId}/complete`);
        if (done.status !== "staged" || done.handoffAccepted === false) {
          throw new UploadError(`LuckyStats didn't stage the set (status ${done.status ?? "?"})`, { status: 422 });
        }
        if (done.tournamentUploadId) this._journal(setId, { tournamentUploadId: done.tournamentUploadId });
      }
      this._journal(setId, { state: "staged", staged: true, stagedAt: this._now(), error: null, attempts: 0, sentBytes: totalBytes });
      console.log(`[replays] Set ${setId} uploaded to LuckyStats (revision ${approval.revision ?? "?"}) — staged until the tournament is finished`);
      this._poll(true);
    } catch (err) {
      this._failed(setId, err);
    }
  }

  async _approve(tournament, setId, bundle, key) {
    return this._api("POST", "/uploads", {
      tournament,
      setId: String(setId),
      files: bundle.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    }, { "Idempotency-Key": key });
  }

  /** PUT every approved file. An expired link is refreshed once. */
  async _sendFiles(setId, approval, bundle) {
    let links = approval.files ?? [];
    let sent = 0;
    for (const f of bundle.files) {
      let link = links.find((l) => l.path === f.path);
      if (!link) throw new UploadError(`LuckyStats didn't approve ${f.path}`, { status: 422 });
      let res = await this._put(link.url, link.headers ?? { "Content-Type": f.contentType }, fileData(f));
      if (res.status === 403 || res.status === 400) {
        // Signed links last 15 minutes; a slow or resumed transfer outlives them.
        const fresh = await this._api("POST", `/uploads/${approval.uploadId}/links`);
        links = fresh.files ?? links;
        link = links.find((l) => l.path === f.path) ?? link;
        res = await this._put(link.url, link.headers ?? { "Content-Type": f.contentType }, fileData(f));
      }
      // 412: the object is already there (a PUT whose answer was lost) —
      // completion still checks its exact size and checksum.
      if (res.status !== 412 && !(res.status >= 200 && res.status < 300)) {
        throw new UploadError(`Storage refused ${f.path} (${res.status ?? "network"}: ${String(res.body).slice(0, 160)})`,
          { status: res.status == null || res.status >= 500 ? res.status : 400 });
      }
      sent += f.size;
      this._journal(setId, { sentBytes: sent });
    }
  }

  _failed(setId, err) {
    const r = this._sets.get(setId);
    const attempts = (r?.upload?.attempts ?? 0) + 1;
    if (err instanceof UploadError && err.transient) {
      const wait = err.retryAfterMs ?? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)) * (0.75 + Math.random() / 2);
      this._journal(setId, { state: "retry", attempts, error: err.message, nextTryAt: this._now() + wait });
      console.warn(`[replays] Upload of set ${setId} failed (${err.message}) — trying again in ${Math.round(wait / 1000)}s`);
    } else {
      this._journal(setId, { state: "failed", attempts, error: err.message });
      console.warn(`[replays] Upload of set ${setId} failed: ${err.message}`);
    }
  }

  // ── After the upload ────────────────────────────────────────────────────────

  /**
   * Cancel a set's upload (DELETE /uploads/:id) — before the tournament is
   * finished. A set never sent just leaves the queue.
   */
  async cancel(setId) {
    const r = this._sets.get(setId);
    if (!r) return { ok: false, error: "That set isn't in the list" };
    const id = r.upload?.uploadId;
    if (id) {
      try {
        await this._api("DELETE", `/uploads/${id}`);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    // A new key next time: the cancelled upload can't be resumed.
    this._journal(setId, { state: "cancelled", error: null, uploadId: null, idempotencyKey: null, staged: false });
    return { ok: true };
  }

  /** GET /uploads/:id — its handoff, revision, import and analytics state. */
  async refresh(setId) {
    const r = this._sets.get(setId);
    const id = r?.upload?.uploadId;
    if (!id) return { ok: false, error: "That set hasn't been uploaded" };
    try {
      const remote = await this._api("GET", `/uploads/${id}`);
      this._journal(setId, { remote: summarise(remote) });
      return { ok: true, remote };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** The tournament collection the most recent upload went to, or null. */
  currentCollection() {
    const r = this._sets.list().find((x) => x.upload?.tournamentUploadId);
    return r ? String(r.upload.tournamentUploadId) : null;
  }

  /** GET /tournaments/:id, kept with the sets. */
  async tournamentStatus(id = this.currentCollection()) {
    if (!id) return { ok: false, error: "Nothing has been uploaded yet" };
    try {
      const status = await this._api("GET", `/tournaments/${id}`);
      this._sets.setCollection(id, { ...status, checkedAt: this._now() });
      this._onChange();
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Finish (or reopen) the tournament collection: LuckyStats imports the
   * latest revision of every set any contributor uploaded. Sent with the
   * collectionVersion of a fresh status read — a stale one is refused
   * (`collection_changed`), never applied to a collection that moved on.
   * @param {"complete"|"reopen"} action
   */
  async collectionAction(action, id = this.currentCollection()) {
    if (!id) return { ok: false, error: "Nothing has been uploaded yet" };
    const st = await this.tournamentStatus(id);
    if (!st.ok) return st;
    const collectionVersion = st.status.collectionVersion ?? 1;
    try {
      const result = await this._api("POST", `/tournaments/${id}/${action}`, { collectionVersion });
      await this.tournamentStatus(id);
      return { ok: true, result };
    } catch (err) {
      if (err.code === "uploads_in_progress" || /uploads_in_progress/.test(err.message)) {
        return { ok: false, error: "Uploads are still in flight — wait for every set to finish uploading (or cancel it), then finish" };
      }
      return { ok: false, error: err.message };
    }
  }

  /** Every 15s while this tournament's uploads are recent. */
  _poll(force = false) {
    if (!this.enabled) return;
    const now = this._now();
    if (!force && now - this._lastPoll < POLL_MS) return;
    const recent = this._sets.list().find((r) => r.upload?.tournamentUploadId && now - (r.upload.stagedAt ?? r.capturedAt ?? 0) < POLL_RECENT_MS);
    if (!recent) return;
    this._lastPoll = now;
    this.tournamentStatus(String(recent.upload.tournamentUploadId)).catch(() => {});
  }
}

/** The parts of GET /uploads/:id the dock shows. */
function summarise(remote) {
  return {
    status: remote.status ?? null,
    revision: remote.revision ?? null,
    current: remote.current ?? remote.isCurrent ?? null,
    handoff: remote.handoff ? { accepted: !!remote.handoff.accepted, verifiedFiles: remote.handoff.verifiedFiles ?? null } : null,
    import: remote.import ? { phase: remote.import.phase ?? null, percent: remote.import.percent ?? null, importedSets: remote.import.importedSets ?? null } : null,
    analytics: remote.analytics ? { state: remote.analytics.state ?? null, percent: remote.analytics.percent ?? null } : null,
    skipped: Array.isArray(remote.skipped) ? remote.skipped.slice(0, 5) : null,
  };
}

module.exports = { LuckyStatsUploads, UploadError, putFile, BASE_URL, APP_ID };
