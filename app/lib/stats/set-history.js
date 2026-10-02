/**
 * SetHistoryStore — every start.gg set a player has ever played, kept on disk.
 *
 * A head-to-head is only right if it covers the whole rivalry, and the only
 * start.gg source that does is Player.sets (see queries.js). That is ~30
 * requests for a long-time regular, which is fine once and wasteful every time
 * they go on stream — and the same people attend week after week. So each
 * player's history is crawled once, saved, and afterwards only topped up:
 *
 *   - **Top-up:** pages are newest first, so a re-sync walks from page 1 and
 *     stops at the first page it already holds unchanged. Normally one request.
 *   - **Full re-crawl** once a copy is older than FULL_RECRAWL_MS. A top-up only
 *     sees *new* sets; this is what picks up start.gg editing old ones (a
 *     corrected result, two player records merged).
 *
 * One JSON file per player under `cacheDir` (gitignored). Deleting the folder
 * is always safe — it just means the next load crawls again.
 *
 * Never throws: every public method resolves to `{ ok, ... }`.
 */

const fs   = require("fs");
const path = require("path");
const { PLAYER_SETS_PAGE } = require("./queries");

const FILE_VERSION    = 1;
const FULL_RECRAWL_MS = 30 * 24 * 60 * 60 * 1000;

// Halved on a complexity refusal. Each size divides the one before, so page N
// at the old size maps exactly onto pages at the new one.
const PAGE_SIZES = [60, 30, 15];

// A loop guard, not a coverage limit: 150 × 60 = 9,000 sets.
const MAX_PAGES = 150;

/**
 * The part of a Player.sets node worth keeping. ~170 bytes as JSON.
 * @param {object} node
 */
function compactSet(node) {
  return {
    id:           String(node.id),
    winnerId:     node.winnerId != null ? String(node.winnerId) : null,
    completedAt:  node.completedAt || null,
    state:        node.state ?? null,
    dq:           node.displayScore === "DQ",
    videogameId:  node.event?.videogame?.id != null ? String(node.event.videogame.id) : null,
    eventId:      node.event?.id != null ? String(node.event.id) : null,
    eventStartAt: node.event?.startAt ?? null,
    slots: (node.slots ?? []).map((slot) => slot?.entrant
      ? {
          entrantId: String(slot.entrant.id),
          players: (slot.entrant.participants ?? []).map((p) => (p?.player?.id != null ? String(p.player.id) : null)),
        }
      : null),
  };
}

/** Same set, same result? A top-up only stops on pages that are unchanged. */
function sameSet(a, b) {
  return a && b && a.state === b.state && a.winnerId === b.winnerId && a.dq === b.dq;
}

class SetHistoryStore {
  /**
   * @param {{ backgroundQuery: Function }} startgg
   * @param {string|null} cacheDir — null keeps everything in memory (tests)
   * @param {{ log?: Function }} [opts]
   */
  constructor(startgg, cacheDir, opts = {}) {
    this._gg = startgg;
    this._dir = cacheDir;
    this._log = opts.log ?? ((m) => console.log(`[stats] ${m}`));
    /** @type {Map<string, { playerId: string, syncedAt: number, crawledAt: number, sets: object[] }>} */
    this._mem = new Map();
    /** One sync per player at a time; a second caller shares it. */
    this._inFlight = new Map();
  }

  /** Is anything held for this player, on disk or in memory? Cheap. */
  has(playerId) {
    return this._mem.has(String(playerId)) || (this._dir !== null && fs.existsSync(this._file(playerId)));
  }

  /**
   * Bring a player's history up to date and return it.
   *
   * @param {string} playerId
   * @param {{ maxAgeMs?: number }} [opts] — skip the network entirely when the
   *   copy was synced this recently. 0 forces a top-up.
   * @returns {Promise<{ ok: true, sets: object[], crawled: boolean } | { ok: false, error: string }>}
   */
  sync(playerId, { maxAgeMs = 0 } = {}) {
    const id = String(playerId);
    if (this._inFlight.has(id)) return this._inFlight.get(id);
    const p = this._sync(id, maxAgeMs)
      .catch((e) => ({ ok: false, error: e.message }))
      .finally(() => this._inFlight.delete(id));
    this._inFlight.set(id, p);
    return p;
  }

  async _sync(id, maxAgeMs) {
    const now = Date.now();
    let rec = this._load(id);

    if (rec && now - rec.syncedAt < maxAgeMs) return { ok: true, sets: rec.sets, crawled: false };

    const full = !rec || now - rec.crawledAt > FULL_RECRAWL_MS;
    const known = full ? new Map() : new Map(rec.sets.map((s) => [s.id, s]));

    const res = await this._crawl(id, known, full);
    if (!res.ok) {
      // A stale copy is still a correct record of everything up to its sync —
      // better than nothing, and the next load tries again.
      if (rec) {
        this._log(`couldn't refresh player ${id} (${res.error}); using the copy from ${new Date(rec.syncedAt).toLocaleString()}`);
        return { ok: true, sets: rec.sets, crawled: false, stale: true };
      }
      return res;
    }

    // Newest first, as start.gg returns them, so a top-up's new sets lead.
    const merged = new Map();
    for (const s of res.sets) merged.set(s.id, s);
    if (!full) for (const s of rec.sets) if (!merged.has(s.id)) merged.set(s.id, s);

    rec = {
      playerId: id,
      syncedAt: now,
      crawledAt: full ? now : rec.crawledAt,
      sets: [...merged.values()],
    };
    this._save(rec);
    if (full) this._log(`saved player ${id}'s history: ${rec.sets.length} sets in ${res.requests} request(s)`);
    return { ok: true, sets: rec.sets, crawled: full };
  }

  /**
   * Walk Player.sets from the newest page. A full crawl reads every page; a
   * top-up stops at the first page holding nothing new or changed.
   */
  async _crawl(id, known, full) {
    const out = [];
    let sizeIdx = 0;
    let page = 1;
    let totalPages = 1;
    let requests = 0;

    while (page <= totalPages && page <= MAX_PAGES) {
      const perPage = PAGE_SIZES[sizeIdx];
      const res = await this._gg.backgroundQuery(PLAYER_SETS_PAGE, { id, page, perPage });
      requests++;

      if (!res.ok) {
        if (res.complexity && sizeIdx < PAGE_SIZES.length - 1) {
          // Everything already read is the first (page-1)*perPage sets, so the
          // same offset at half the page size starts at page (page-1)*2+1.
          sizeIdx++;
          page = (page - 1) * 2 + 1;
          continue;
        }
        return { ok: false, error: res.error };
      }

      const conn = res.data?.player?.sets;
      if (!res.data?.player) return { ok: false, error: `start.gg has no player ${id}` };
      totalPages = conn?.pageInfo?.totalPages ?? 0;

      const nodes = (conn?.nodes ?? []).filter(Boolean).map(compactSet);
      out.push(...nodes);

      if (!full && nodes.length > 0 && nodes.every((s) => sameSet(known.get(s.id), s))) break;
      page++;
    }
    return { ok: true, sets: out, requests };
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  _file(id) {
    return path.join(this._dir, `player-${id}.json`);
  }

  _load(id) {
    if (this._mem.has(id)) return this._mem.get(id);
    if (this._dir === null) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(this._file(id), "utf8"));
      // A different format version is simply a cache miss — re-crawled, not migrated.
      if (rec?.version !== FILE_VERSION || !Array.isArray(rec.sets)) return null;
      this._mem.set(id, rec);
      return rec;
    } catch {
      return null;
    }
  }

  _save(rec) {
    this._mem.set(rec.playerId, rec);
    if (this._dir === null) return;
    try {
      fs.mkdirSync(this._dir, { recursive: true });
      // Write-then-rename, so an app killed mid-write can't leave half a file
      // that would read as a corrupt (and therefore empty) history.
      const file = this._file(rec.playerId);
      fs.writeFileSync(file + ".tmp", JSON.stringify({ version: FILE_VERSION, ...rec }));
      fs.renameSync(file + ".tmp", file);
    } catch (e) {
      this._log(`couldn't save player ${rec.playerId}'s history (${e.message}) — kept in memory only`);
    }
  }
}

module.exports = { SetHistoryStore };
