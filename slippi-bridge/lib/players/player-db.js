/**
 * PlayerDb — the local player database, in TSH's own `local_players.json` format.
 *
 * The file stays TSH-shaped on purpose: an array of records keyed by
 * "prefix gamerTag", with Melee mains under `mains.ssbm` as
 * `[displayName, skin, variant]`. The stream PC has its own copy (the one in
 * this repo is only a fixture), so the path is configuration, the file is
 * edited in place, and it can always be handed back to TSH.
 *
 * Rules that keep it handable-back:
 *   - **Unknown fields round-trip.** A record is kept as the object it was read
 *     as and only the fields this app owns are written into it.
 *   - The app's own additions go in keys TSH ignores: `startggPlayerId`,
 *     `learnedMains` (most recent first, `[displayName, skin]`) and `pinnedMain`.
 *   - A fresh TSH ships the file as `{}` rather than `[]`; both read as empty.
 *   - TSH has written `mains` as the string "{}" and `prefix`/`name` as null;
 *     readers tolerate all of it rather than "fixing" records they don't touch.
 *
 * Writes are atomic (temp file + rename) and debounced, so a burst of upserts
 * from a set load is one write. They are **byte-identical to TSH's own** for
 * unchanged records — json.dumps(indent=2) escapes non-ASCII as \uXXXX, and
 * Python on Windows writes CRLF — so a save only diffs where something changed
 * (checked against the real 208-player file).
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const GAME = "ssbm";
const LEARNED_KEEP = 5;
const SAVE_DEBOUNCE_MS = 500;

const keyOf = (prefix, tag) => `${(prefix ?? "").trim()} ${(tag ?? "").trim()}`.trim().toLowerCase();

class PlayerDb {
  /**
   * @param {string} file — path to local_players.json
   * @param {{ debounceMs?: number }} [opts]
   */
  constructor(file, opts = {}) {
    this._file = file;
    this._debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
    this._records = [];
    this._timer = null;
    this._eol = os.EOL;
    this.load();
  }

  get file() { return this._file; }
  get size() { return this._records.length; }

  /** (Re)read the file. A missing or unreadable file is an empty DB, logged. */
  load() {
    let raw;
    try {
      const text = fs.readFileSync(this._file, "utf8");
      // Keep the file's line endings; a fresh TSH's "{}" stub has none to copy.
      if (text.includes("\n")) this._eol = text.includes("\r\n") ? "\r\n" : "\n";
      raw = JSON.parse(text);
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[players] Couldn't read ${this._file}: ${err.message}`);
      this._records = [];
      return;
    }
    this._records = Array.isArray(raw) ? raw.filter((r) => r && typeof r === "object") : [];
  }

  // ── Lookup ──────────────────────────────────────────────────────────────────

  /**
   * The record for a start.gg player, by id first (survives a tag change), then
   * by tag (with or without prefix).
   * @param {{ playerId?: string|null, tag?: string, prefix?: string }} who
   * @returns {object|null} the live record — read only; write through the methods
   */
  find({ playerId, tag, prefix } = {}) {
    if (playerId != null) {
      const byId = this._records.find((r) => String(r.startggPlayerId ?? "") === String(playerId));
      if (byId) return byId;
    }
    if (!tag) return null;
    const full = keyOf(prefix, tag);
    const bare = keyOf("", tag);
    return this._records.find((r) => keyOf(r.prefix, r.gamerTag) === full)
      ?? this._records.find((r) => keyOf("", r.gamerTag) === bare)
      ?? null;
  }

  /**
   * Records whose tag (or "prefix tag") matches `text`, case-insensitively:
   * tags starting with it first, then ones containing it — the dock's search.
   * @returns {object[]} live records — read only
   */
  search(text, limit = 25) {
    const q = String(text ?? "").trim().toLowerCase();
    if (!q) return [];
    const tag = (r) => String(r.gamerTag ?? "").toLowerCase();
    const starts = this._records.filter((r) => tag(r).startsWith(q));
    const contains = this._records.filter((r) => !tag(r).startsWith(q)
      && (tag(r).includes(q) || keyOf(r.prefix, r.gamerTag).includes(q)));
    return [...starts, ...contains].slice(0, limit);
  }

  /**
   * Every record with a tag, A–Z by tag — the dock's suggestions for an empty
   * name field.
   * @returns {object[]} live records — read only
   */
  byTag() {
    return this._records
      .filter((r) => String(r.gamerTag ?? "").trim())
      .sort((a, b) => String(a.gamerTag).localeCompare(String(b.gamerTag), undefined, { sensitivity: "base" }));
  }

  /**
   * Every distinct prefix and pronoun in the file, most used first (ties
   * alphabetical) — the dock's suggestions for those fields. Case-folded for
   * counting; each is shown as its most common spelling.
   * @returns {{ prefixes: string[], pronouns: string[] }}
   */
  values() {
    const tally = (key) => {
      const seen = new Map(); // folded → { count, spellings: Map }
      for (const r of this._records) {
        const v = typeof r[key] === "string" ? r[key].trim() : "";
        if (!v) continue;
        const k = v.toLowerCase();
        const e = seen.get(k) ?? { count: 0, spellings: new Map() };
        e.count++;
        e.spellings.set(v, (e.spellings.get(v) ?? 0) + 1);
        seen.set(k, e);
      }
      return [...seen.values()]
        .map((e) => ({ count: e.count, text: [...e.spellings].sort((a, b) => b[1] - a[1])[0][0] }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .map((e) => e.text);
    };
    return { prefixes: tally("prefix"), pronouns: tally("pronoun") };
  }

  /**
   * A record's handle for the dock: its position in the file. Stable for the
   * life of the process — records are only ever appended, and the file is
   * read once — and the dock sends the tag back with it, so a stale handle is
   * refused rather than editing someone else.
   */
  refOf(rec) { return this._records.indexOf(rec); }

  /** The record for a handle from refOf(), or null. */
  at(ref) { return Number.isInteger(ref) ? this._records[ref] ?? null : null; }

  /** The fields the app shows, from a record. */
  describe(rec) {
    if (!rec) return null;
    const pick = (e) => (Array.isArray(e) && e[0] ? { name: String(e[0]), skin: Number(e[1]) || 0 } : null);
    return {
      ref: this.refOf(rec),
      tag: rec.gamerTag ?? "",
      prefix: rec.prefix ?? "",
      pronoun: rec.pronoun ?? "",
      twitter: rec.twitter ?? "",
      startggPlayerId: rec.startggPlayerId ?? null,
      main: this.preferredMain(rec),
      pinnedMain: pick(rec.pinnedMain),
      learnedMains: (Array.isArray(rec.learnedMains) ? rec.learnedMains : []).map(pick).filter(Boolean),
    };
  }

  /**
   * The character to prefill for a player on set load: pinned beats learned
   * beats TSH's mains list.
   * @returns {{ name: string, skin: number } | null}
   */
  preferredMain(rec) {
    const pick = (e) => (Array.isArray(e) && e[0] ? { name: String(e[0]), skin: Number(e[1]) || 0 } : null);
    return pick(rec?.pinnedMain)
      ?? pick(rec?.learnedMains?.[0])
      ?? pick(this._tshMains(rec)[0])
      ?? null;
  }

  _tshMains(rec) {
    const m = rec?.mains;
    return m && typeof m === "object" && Array.isArray(m[GAME]) ? m[GAME] : [];
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  /**
   * Make sure a start.gg player has a record and it carries their start.gg id.
   * Fills only what is missing, so a hand-edited pronoun or twitter is never
   * overwritten by start.gg.
   * @param {{ playerId?: string|null, tag: string, prefix?: string }} p
   * @returns {object|null} the record
   */
  upsert(p) {
    if (!p?.tag) return null;
    let rec = this.find(p);
    let changed = false;
    if (!rec) {
      rec = { prefix: p.prefix ?? "", gamerTag: p.tag, name: "", mains: { [GAME]: [] } };
      this._records.push(rec);
      changed = true;
    }
    if (p.playerId != null && String(rec.startggPlayerId ?? "") !== String(p.playerId)) {
      rec.startggPlayerId = String(p.playerId);
      changed = true;
    }
    if (p.prefix && !rec.prefix) { rec.prefix = p.prefix; changed = true; }
    if (changed) this._scheduleSave();
    return rec;
  }

  /**
   * Set the fields the dock edits. Only listed keys are touched.
   * @param {object} rec — from find()/upsert()
   * @param {{ prefix?: string, pronoun?: string, twitter?: string }} fields
   */
  update(rec, fields) {
    if (!rec) return;
    for (const k of ["prefix", "pronoun", "twitter"]) {
      if (fields[k] !== undefined) rec[k] = String(fields[k] ?? "");
    }
    this._scheduleSave();
  }

  /** Pin (or with null, unpin) the main shown on set load. */
  pinMain(rec, main) {
    if (!rec) return;
    if (main) rec.pinnedMain = [main.name, Number(main.skin) || 0];
    else delete rec.pinnedMain;
    this._scheduleSave();
  }

  /**
   * Record that a player used a character, most recent first, de-duplicated by
   * character (the latest skin wins). Called once per set with the set's final
   * port mapping, by lib/players/mains-learning.js.
   * @param {object} rec
   * @param {{ name: string, skin: number }} main
   */
  learnMain(rec, main) {
    if (!rec || !main?.name) return;
    const list = Array.isArray(rec.learnedMains) ? rec.learnedMains : [];
    const next = [[main.name, Number(main.skin) || 0], ...list.filter((e) => e?.[0] !== main.name)];
    rec.learnedMains = next.slice(0, LEARNED_KEEP);
    this._scheduleSave();
  }

  _scheduleSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), this._debounceMs);
    this._timer.unref?.();
  }

  /**
   * Write a pending debounced save now, if there is one — on shutdown. Never
   * rewrites a file nothing changed: it's TSH's file too, and a no-op rewrite
   * would only churn it.
   */
  flush() {
    if (this._timer) this.saveNow();
  }

  /** Write now (atomic). */
  saveNow() {
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = `${this._file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(tmp, serialize(this._records, this._eol));
      fs.renameSync(tmp, this._file);
    } catch (err) {
      console.warn(`[players] Couldn't save ${this._file}: ${err.message}`);
    }
  }
}

/**
 * JSON exactly as TSH's json.dumps(obj, indent=2) writes it: the same
 * separators and indentation as JSON.stringify, plus ensure_ascii's \uXXXX
 * escapes — one per UTF-16 unit, which is also how Python escapes astral
 * characters (as a surrogate pair).
 */
function serialize(value, eol = "\n") {
  const json = JSON.stringify(value, null, 2)
    .replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return eol === "\n" ? json : json.replace(/\n/g, eol);
}

module.exports = { PlayerDb, serialize };
