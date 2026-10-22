/**
 * Saved crews — a crew's name and roster, kept so the dock's Crew tab can load
 * it again at the next event instead of retyping ten tags.
 *
 * `app/data/crews.json` (gitignored with the rest of data/). Saved only when
 * the operator presses Save, never as a side effect of starting a battle: a
 * one-off roster shouldn't overwrite the regular one. A crew is keyed by its
 * name, case-insensitively, so saving "ACRES" over "Acres" replaces it.
 *
 * Only what was typed is kept (tag, prefix, pronoun) — the main is the player
 * DB's, looked up when the battle starts, so it's never stale.
 *
 * Writes are synchronous and atomic (temp file + rename, as persist.js): a
 * save is one tap, and a kill mid-write leaves the previous file. A file that
 * can't be read is moved aside to `crews.json.bad` rather than overwritten by
 * the next save.
 */

const fs   = require("fs");
const path = require("path");
const Crew = require("./crew-model");

const FILE_VERSION = 1;
const FIELD_MAX = 40;

const text = (v) => (typeof v === "string" ? v.trim().slice(0, FIELD_MAX) : "");
const key = (name) => text(name).toLowerCase();

/** The saved form of a crew: name and typed member fields only. */
function savedForm({ name, members }) {
  return {
    name: text(name),
    members: members.map((m) => ({ tag: text(m.tag), prefix: text(m.prefix), pronoun: text(m.pronoun) })),
  };
}

class SavedCrews {
  /** @param {string} file — e.g. <app>/data/crews.json */
  constructor(file) {
    this.file = file;
    this._crews = this._read();
  }

  /** Every saved crew, A–Z by name. */
  list() {
    return [...this._crews]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((c) => savedForm(c));
  }

  /**
   * Save a crew, replacing one with the same name.
   * @param {{ name: string, members: Array<{ tag: string, prefix?: string, pronoun?: string }> }} crew
   * @returns {{ ok: true, replaced: boolean } | { ok: false, error: string }}
   */
  save(crew) {
    const err = Crew.teamError(crew);
    if (err) return { ok: false, error: err };
    const next = savedForm(crew);
    const at = this._crews.findIndex((c) => key(c.name) === key(next.name));
    const crews = [...this._crews];
    if (at >= 0) crews[at] = next;
    else crews.push(next);
    const written = this._write(crews);
    if (!written.ok) return written;
    this._crews = crews;
    return { ok: true, replaced: at >= 0 };
  }

  /**
   * @param {string} name
   * @returns {{ ok: true, removed: boolean } | { ok: false, error: string }}
   */
  remove(name) {
    const crews = this._crews.filter((c) => key(c.name) !== key(name));
    if (crews.length === this._crews.length) return { ok: true, removed: false };
    const written = this._write(crews);
    if (!written.ok) return written;
    this._crews = crews;
    return { ok: true, removed: true };
  }

  _read() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      console.warn(`[crew] Couldn't read ${this.file} (${err.message}) — moved aside to crews.json.bad`);
      try { fs.renameSync(this.file, `${this.file}.bad`); } catch { /* left where it is */ }
      return [];
    }
    const list = Array.isArray(raw?.crews) ? raw.crews : [];
    return list.filter((c) => !Crew.teamError(c)).map((c) => savedForm(c));
  }

  _write(crews) {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, crews }, null, 2));
      fs.renameSync(tmp, this.file);
      return { ok: true };
    } catch (err) {
      console.warn(`[crew] Couldn't save ${this.file}: ${err.message}`);
      return { ok: false, error: `Couldn't save the crews file: ${err.message}` };
    }
  }
}

module.exports = { SavedCrews };
