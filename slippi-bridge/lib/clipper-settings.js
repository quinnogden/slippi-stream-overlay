/**
 * clipper-settings.js — tunables for the combo clipper.
 *
 * Three layers, lowest priority first:
 *   1. DEFAULTS below      — always complete, so nothing downstream needs `??`
 *   2. config.CLIPPER      — committed starting values (config.js)
 *   3. clipper-settings.json — operator edits from the control panel (gitignored)
 *
 * config.js merges config.local.js with a SHALLOW Object.assign, so a local
 * override of CLIPPER replaces the whole object. Every layer is therefore
 * merged per-key against DEFAULTS rather than assumed complete.
 *
 * Detection thresholds get retuned mid-event, on a laptop, between sets. So the
 * write is atomic (temp file + rename) — a crash mid-save must not leave
 * unparseable JSON that stops the bridge starting next time — and every field is
 * validated and clamped on the way in, because the values arrive from a browser
 * form and a bad number here means either no clips or a clip every exchange.
 */

const fs   = require("fs");
const path = require("path");

// Lives at the slippi-bridge folder root (one level up from lib/), not beside
// this module: .gitignore pins that exact path, and the file holds the OBS
// password. Moving it risks committing a secret.
const SETTINGS_FILE = path.join(__dirname, "..", "clipper-settings.json");

/** Complete, valid settings. Any layer above may override individual keys. */
const DEFAULTS = {
  enabled: false,
  obsUrl: "ws://127.0.0.1:4455",
  obsPassword: "",
  autoStartBuffer: true,
  minMoves: 4,
  minDamage: 30,
  requireKill: true,
  maxComboDurationSec: 0,
  cooldownSec: 8,
  saveDelayMs: 2500,
  maxClipsPerGame: 0,
  clipFolder: "",
  notifySidePanel: true,
};

/**
 * Per-field coercion. Ranges are deliberately generous — the operator is meant
 * to experiment (a 0-damage, 1-move threshold is a valid way to prove the OBS
 * chain works) — but bounded, so a typo can't wedge the bridge.
 */
const FIELDS = {
  enabled:             { type: "bool" },
  obsUrl:              { type: "string", max: 200 },
  obsPassword:         { type: "string", max: 200 },
  autoStartBuffer:     { type: "bool" },
  minMoves:            { type: "int",    min: 1,  max: 50 },
  minDamage:           { type: "number", min: 0,  max: 999 },
  requireKill:         { type: "bool" },
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
   * @param {object} config — the bridge config; only config.CLIPPER is read
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
   * ignored rather than fatal — losing tuning is recoverable, a bridge that
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
   * @param {object} patch — partial settings from the control panel
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
