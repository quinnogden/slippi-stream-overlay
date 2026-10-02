/**
 * clipper-settings.js — tunables for the combo clipper.
 *
 * Three layers, lowest priority first, each merged per key:
 *   1. DEFAULTS below          — always complete, so nothing downstream needs `??`
 *   2. config.CLIPPER          — optional, from config.local.js
 *   3. clipper-settings.json   — the dock's Clips tab (gitignored)
 *
 * The write is atomic (temp file + rename), so a crash mid-save can't leave JSON
 * that stops the app starting; every field is validated and clamped, because
 * the values arrive from a browser form and a bad number means either no clips
 * or a clip every exchange.
 */

const fs   = require("fs");
const path = require("path");

// Lives at the app folder root (one level up from lib/), not beside
// this module: .gitignore pins that exact path, and the file holds the OBS
// password. Moving it risks committing a secret.
const SETTINGS_FILE = path.join(__dirname, "..", "clipper-settings.json");

/** Complete, valid settings. Any layer above may override individual keys. */
const DEFAULTS = {
  enabled: false,                // master toggle — off costs nothing per poll tick
  obsUrl: "ws://127.0.0.1:4455", // obs-websocket v5 address
  obsPassword: "",               // "" when OBS's auth is off
  autoStartBuffer: true,         // start OBS's replay buffer if it isn't running
  minMoves: 4,                   // moves that must land (within comboWindowSec, if set)
  minDamage: 30,                 // percent they must deal (within comboWindowSec, if set)
  requireKill: true,             // only clip conversions that took a stock
  comboWindowSec: 0,             // 0 = judge the whole conversion; else the last N seconds only
  maxComboDurationSec: 0,        // 0 = no cap
  cooldownSec: 8,                // minimum gap between saves
  saveDelayMs: 2500,             // wait after detection so the kill lands in the buffer
  maxClipsPerGame: 0,            // 0 = unlimited
  clipFolder: "",                // OBS replay output folder (display + OBS script)
  notifySidePanel: true,         // show the "clip saved" toast on the overlay
};

/**
 * Per-field coercion. Ranges are deliberately generous — the operator is meant
 * to experiment (a 0-damage, 1-move threshold is a valid way to prove the OBS
 * chain works) — but bounded, so a typo can't wedge the app.
 */
const FIELDS = {
  enabled:             { type: "bool" },
  obsUrl:              { type: "string", max: 200 },
  obsPassword:         { type: "string", max: 200 },
  autoStartBuffer:     { type: "bool" },
  minMoves:            { type: "int",    min: 1,  max: 50 },
  minDamage:           { type: "number", min: 0,  max: 999 },
  requireKill:         { type: "bool" },
  comboWindowSec:      { type: "number", min: 0,  max: 120 },
  maxComboDurationSec: { type: "number", min: 0,  max: 480 },
  cooldownSec:         { type: "number", min: 0,  max: 600 },
  saveDelayMs:         { type: "int",    min: 0,  max: 60000 },
  maxClipsPerGame:     { type: "int",    min: 0,  max: 100 },
  clipFolder:          { type: "string", max: 400 },
  notifySidePanel:     { type: "bool" },
};

/**
 * Coerce one field. Returns `undefined` when the value can't be interpreted,
 * which the caller treats as "leave the existing value alone" — a half-filled
 * form should not blank out settings that are working.
 */
function coerce(key, raw) {
  const spec = FIELDS[key];
  if (!spec || raw == null) return undefined;

  if (spec.type === "bool") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true"  || raw === 1 || raw === "1") return true;
    if (raw === "false" || raw === 0 || raw === "0") return false;
    return undefined;
  }

  if (spec.type === "string") {
    if (typeof raw !== "string") return undefined;
    return raw.trim().slice(0, spec.max);
  }

  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  const clamped = Math.min(spec.max, Math.max(spec.min, num));
  return spec.type === "int" ? Math.round(clamped) : clamped;
}

/** Merge a raw object over a base, keeping only known, coercible fields. */
function mergeValidated(base, raw) {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(FIELDS)) {
    const value = coerce(key, raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

class ClipperSettings {
  /**
   * @param {object} config — only config.CLIPPER is read
   */
  constructor(config) {
    this._base    = mergeValidated(DEFAULTS, config?.CLIPPER);
    this._current = { ...this._base };
    this.load();
  }

  /** Current effective settings (always complete). */
  get() {
    return { ...this._current };
  }

  /**
   * Re-read clipper-settings.json over the committed defaults.
   * A missing file is the normal first-run case. A corrupt one is logged and
   * ignored rather than fatal — losing tuning is recoverable, an app that
   * won't start mid-event is not.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    } catch (_e) {
      this._current = { ...this._base };
      return this._current;
    }

    try {
      this._current = mergeValidated(this._base, JSON.parse(raw));
    } catch (e) {
      console.warn(`[clipper] clipper-settings.json is not valid JSON (${e.message}) — using defaults`);
      this._current = { ...this._base };
    }
    return this._current;
  }

  /**
   * Validate a patch, apply it, and persist the result.
   * @param {object} patch — partial settings from the Clips tab
   * @returns {{ ok: boolean, settings?: object, error?: string }}
   */
  save(patch) {
    const next = mergeValidated(this._current, patch);

    const tmp = `${SETTINGS_FILE}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      fs.renameSync(tmp, SETTINGS_FILE);
    } catch (e) {
      // Keep the in-memory value: the operator's change still takes effect for
      // this session even if the disk write failed (read-only folder, OneDrive
      // holding the file). They just lose it on restart, and are told so.
      this._current = next;
      return { ok: false, settings: this.get(), error: `Applied, but couldn't save to disk: ${e.message}` };
    }

    this._current = next;
    return { ok: true, settings: this.get() };
  }
}

module.exports = { ClipperSettings, DEFAULTS, FIELDS };
