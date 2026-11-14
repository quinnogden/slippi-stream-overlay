/**
 * StreamSets — every start.gg set played on stream, as the scoreboard had it
 * when it was reported or closed, with its replay bundle's state.
 *
 * `app/data/stream-sets.json` (gitignored with the rest of data/). One record
 * per start.gg set id. It is also the uploader's journal: a record's `upload`
 * holds the idempotency key, the manifest digest and the LuckyStats upload id
 * BEFORE each request goes out, so a crash mid-upload resumes the same upload
 * instead of starting a second one (uploader.js).
 *
 * Captured from the store (`capture`) on a successful report and on
 * `set-closing`. Two rules keep a capture from undoing something:
 *   - an `edited` record (the Replays tab fixed a game) keeps its games — the
 *     scoreboard no longer has the better answer;
 *   - a capture with no Slippi game (a set reloaded later opens on start.gg's
 *     score as manual games) never replaces one that has them.
 * Only real start.gg sets are kept: no manual set, preview set or crew battle
 * has a set id LuckyStats could file it under.
 *
 * Writes are atomic (temp + rename), debounced; flush() on exit. An
 * unreadable file is moved to `stream-sets.json.bad`, not overwritten.
 */

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 250;
const ZELDA = 18;
const SHEIK = 19;

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Whether a set id is one start.gg would recognise (not a preview or a manual set). */
function isRealSetId(setId) {
  return setId != null && setId !== "" && !String(setId).includes("preview");
}

/** The scoreboard's sides, cut down to what a bundle uses. */
function sidesOf(sb) {
  return sb.sides.map((s) => ({
    entrantId: s.entrantId ?? null,
    teamName: s.teamName ?? "",
    fromLosers: !!s.fromLosers,
    players: s.players.map((p) => ({ tag: p.tag ?? "", prefix: p.prefix ?? "", pronoun: p.pronoun ?? "", playerId: p.playerId ?? null })),
  }));
}

/** The game list, as the store keeps it. */
function gamesOf(sb) {
  return (sb.games ?? []).map((g) => ({
    winnerSide: g.winnerSide,
    manual: !!g.manual,
    characters: clone(g.characters ?? null),
    replay: clone(g.replay ?? null),
  }));
}

class StreamSets extends EventEmitter {
  /** @param {string} file — e.g. <app>/data/stream-sets.json */
  constructor(file) {
    super();
    this.file = file;
    this._timer = null;
    const saved = this._read();
    this._sets = new Map((saved.sets ?? []).map((r) => [String(r.setId), r]));
    // LuckyStats' tournament collections, by tournamentUploadId (uploader.js).
    this.collections = saved.collections ?? {};
  }

  /** Every record, newest first. */
  list() {
    return [...this._sets.values()]
      .sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))
      .map(clone);
  }

  /** One record (a copy), or null. */
  get(setId) {
    const r = this._sets.get(String(setId));
    return r ? clone(r) : null;
  }

  /**
   * Keep the scoreboard's set.
   * @param {object} sb — store.scoreboard()
   * @param {object} tournament — store.tournament()
   * @param {{ reported?: boolean, now?: number }} [opts]
   * @returns {{ ok: true, record: object, changed: boolean } | { ok: false, reason: string }}
   */
  capture(sb, tournament, { reported = false, now = Date.now() } = {}) {
    if (!sb || sb.crew) return { ok: false, reason: "crew battle" };
    if (!isRealSetId(sb.setId)) return { ok: false, reason: "not a start.gg set" };
    const games = gamesOf(sb);
    if (!games.length) return { ok: false, reason: "no games" };

    const id = String(sb.setId);
    const old = this._sets.get(id);
    const hasSlippi = games.some((g) => g.replay);
    const keepGames = old && (old.edited || (!hasSlippi && old.games.some((g) => g.replay)));

    const next = {
      ...(old ?? { upload: null, archive: null, meta: null, edited: false, reported: false }),
      setId: id,
      capturedAt: old?.capturedAt ?? now,
      updatedAt: now,
      tournament: {
        name: tournament?.name ?? "", slug: tournament?.slug ?? "",
        eventName: tournament?.eventName ?? "", eventSlug: tournament?.eventSlug ?? "",
      },
      roundName: sb.round ?? "",
      identifier: sb.identifier ?? "",
      doubles: !!sb.isDoubles,
      sides: keepGames ? old.sides : sidesOf(sb),
      games: keepGames ? old.games : games,
      reported: !!(old?.reported || reported),
    };
    const changed = !old || JSON.stringify({ ...old, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 });
    if (!changed) return { ok: true, record: clone(old), changed: false };
    this._sets.set(id, next);
    this._changed();
    return { ok: true, record: clone(next), changed: true };
  }

  /**
   * Merge fields into a record (the uploader's journal, the meta, the archive).
   * @param {string} setId
   * @param {object|((r: object) => object)} patch
   */
  update(setId, patch) {
    const r = this._sets.get(String(setId));
    if (!r) return null;
    Object.assign(r, typeof patch === "function" ? patch(clone(r)) : clone(patch));
    this._changed();
    return clone(r);
  }

  /**
   * A correction to one game of a set that's off the scoreboard (the Replays
   * tab). The record is `edited` from then on, so a later capture of the same
   * set can't put the uncorrected games back.
   * @param {string} setId
   * @param {number} index — the game, 0-based
   * @param {{ op: "winner"|"ports"|"remove"|"zelda-sheik"|"attach", side?: number, slot?: number, replay?: object, characters?: Array }} edit
   * @returns {{ ok: true, record: object } | { ok: false, error: string }}
   */
  editGame(setId, index, edit) {
    const r = this._sets.get(String(setId));
    if (!r) return { ok: false, error: "That set isn't in the list" };
    const g = r.games[index];
    if (!g) return { ok: false, error: `There's no game ${Number(index) + 1}` };
    switch (edit?.op) {
      case "winner":
        g.winnerSide = 1 - g.winnerSide;
        break;
      case "remove":
        r.games.splice(index, 1);
        break;
      case "ports": {
        // The port map put this game's ports on the wrong names: each side
        // takes the other's ports and characters. The winner stays (⇄ W is
        // its own fix) — the player who won still won.
        if (!g.replay?.players && !g.characters) return { ok: false, error: "That game has no ports to swap" };
        g.replay?.players?.reverse();
        g.replay?.teamIds?.reverse();
        g.characters?.reverse();
        break;
      }
      case "zelda-sheik": {
        const p = g.replay?.players?.[edit.side]?.[edit.slot];
        if (!p || (p.characterId !== ZELDA && p.characterId !== SHEIK)) {
          return { ok: false, error: "That player isn't Zelda or Sheik" };
        }
        p.characterId = p.characterId === ZELDA ? SHEIK : ZELDA;
        const c = g.characters?.[edit.side]?.[edit.slot];
        if (c) Object.assign(c, p.characterId === ZELDA
          ? { codename: "zelda", name: "Zelda" } : { codename: "sheik", name: "Sheik" });
        break;
      }
      case "attach":
        if (!edit.replay?.file) return { ok: false, error: "No replay to attach" };
        g.replay = clone(edit.replay);
        if (edit.characters) g.characters = clone(edit.characters);
        g.manual = false;
        break;
      default:
        return { ok: false, error: `Unknown edit "${edit?.op}"` };
    }
    r.edited = true;
    r.updatedAt = Date.now();
    this._changed();
    return { ok: true, record: clone(r) };
  }

  /** Drop a record (the Replays tab's Forget). */
  remove(setId) {
    const had = this._sets.delete(String(setId));
    if (had) this._changed();
    return had;
  }

  /** Keep one LuckyStats tournament collection's last status. */
  setCollection(id, status) {
    this.collections[String(id)] = clone(status);
    this._changed();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  _changed() {
    this.emit("change");
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    this._timer.unref?.();
  }

  /** Write now (atomic). */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, sets: [...this._sets.values()], collections: this.collections }, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[replays] Couldn't save ${path.basename(this.file)}: ${err.message}`);
    }
  }

  _read() {
    if (!fs.existsSync(this.file)) return {};
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved?.v !== FILE_VERSION || !Array.isArray(saved.sets)) throw new Error("unknown format");
      return saved;
    } catch (err) {
      console.warn(`[replays] ${path.basename(this.file)} is unreadable (${err.message}) — moved to .bad, starting empty`);
      try { fs.renameSync(this.file, `${this.file}.bad`); } catch { /* left where it is */ }
      return {};
    }
  }
}

module.exports = { StreamSets };
