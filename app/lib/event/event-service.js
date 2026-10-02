/**
 * EventService — the start.gg event the dock works from: which event is loaded,
 * its phase groups' brackets, the set picker, and loading a set onto the
 * scoreboard.
 *
 *   short link → this week's tournament → its singles/doubles event   (switchEvent)
 *   or a pasted start.gg URL → that event                            (loadEventUrl)
 *   event → phases → phase groups → every set, as bracket graphs     (loadEvent, refresh)
 *   graphs → the picker, playable sets first                          (openSets)
 *   one set, re-read fresh → enriched from the player DB → the store  (loadSet)
 *
 * The loaded event is part of the store (`store.tournament()`), so it survives
 * a restart and the overlays see its name; this service holds the data behind it.
 *
 * **Reads only, and never on the operator's critical path twice.** The graphs
 * refresh every 90s through the stats' background budget, so the picker and
 * the bracket can never crowd out a report. What the operator presses — a
 * bracket switch, ↻, loading a set — goes straight out, unbudgeted. Every read
 * here falls back to start.gg's keyless web endpoint, so the dock works without
 * a token (reporting and starting don't).
 *
 * Emits `change` whenever the event, its graphs or its status change.
 */

const { EventEmitter } = require("events");
const { buildBracket } = require("./bracket-model");
const { loadPayload, pickerList, PICK_ORDER } = require("./set-model");
const { normalizeBrackets, normalizeEventUrl, sameEvent, pickEvent } = require("./event-target");
const { characterByName } = require("../char_map");

const POLL_MS = 90000;

// start.gg's ActivityState: a completed phase group's sets don't change, so it
// is read once rather than on every refresh — once its sets were read *while*
// it was completed, or the last report (the GF reset) stays live in the picker.
const COMPLETED = 3;

class EventService extends EventEmitter {
  /**
   * @param {object} ctx — { config, startgg, store, playerDb }
   * @param {{ pollMs?: number, log?: Function }} [opts]
   */
  constructor(ctx, opts = {}) {
    super();
    this._startgg  = ctx.startgg;
    this._store    = ctx.store;
    this._playerDb = ctx.playerDb ?? null;
    this._brackets = normalizeBrackets(ctx.config);
    this._pollMs   = opts.pollMs ?? POLL_MS;
    this._log      = opts.log ?? ((m) => console.log(`[event] ${m}`));

    this._event  = null;  // getEvent()'s event
    this._groups = [];    // see groupsOf()
    this._status = { state: "none", error: null, updatedAt: null };
    // Bumped whenever a different event loads, so a refresh still in flight for
    // the previous one drops its answer instead of writing it into the new one.
    this._gen = 0;
    this._refreshing = null;
    this._switching = false;
    this._timer = null;
  }

  get shortLink() { return this._brackets.shortLink; }

  /** { state: "none" | "ok" | "error", error, updatedAt } of the last read. */
  status() { return { ...this._status }; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Reload the event restored from the last run, then refresh on a timer. */
  start() {
    if (this._store.tournament().eventSlug) {
      this.refresh().then((r) => { if (!r.ok) this._log(`Couldn't reload the saved event: ${r.error}`); });
    }
    this._schedule();
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      if (this._event) await this.refresh({ background: true });
      this._schedule();
    }, this._pollMs);
    this._timer.unref?.();
  }

  // ── Which event ─────────────────────────────────────────────────────────────

  /**
   * The dock's Singles / Doubles buttons: load this week's event of that kind.
   * A press for the event already loaded re-reads it instead.
   *
   * Concurrent presses are refused, not shared — the dock can be open in OBS
   * and on a phone at once, and a press on the other button must not be
   * answered with the first one's result.
   *
   * @param {string} kind — a key of config.BRACKETS.events ("singles" | "doubles")
   * @returns {Promise<{ ok: boolean, refreshed?: boolean, eventName?: string, tournamentName?: string, warning?: string, error?: string }>}
   */
  async switchEvent(kind) {
    const spec = this._brackets.events[kind];
    if (!spec) {
      return { ok: false, error: `Unknown bracket "${kind}" — configured: ${Object.keys(this._brackets.events).join(", ")}` };
    }
    return this._exclusive(async () => {
      const target = await this._resolveTarget(kind, spec);
      return target.ok ? this._open(target, kind) : target;
    });
  }

  /**
   * The Bracket tab's URL box: load whatever event a pasted start.gg link names, for when the short link points elsewhere or the
   * keywords can't pick it. An event URL loads that event; a tournament URL (or
   * short link) loads its event only when it has exactly one — with several,
   * picking one would be a guess, so they are listed instead.
   *
   * Shares switchEvent's one-at-a-time rule and its reply.
   *
   * @param {string} url
   */
  async loadEventUrl(url) {
    const text = String(url ?? "").trim();
    if (!text) return { ok: false, error: "Paste a start.gg event URL first" };
    return this._exclusive(async () => {
      const target = await this._targetFromUrl(text);
      return target.ok ? this._open(target, null) : target;
    });
  }

  /** Refuse a second switch while one is running (see switchEvent). */
  async _exclusive(fn) {
    if (this._switching) return { ok: false, error: "Still switching brackets — wait for that to finish" };
    this._switching = true;
    try {
      return await fn();
    } finally {
      this._switching = false;
    }
  }

  /** Load the target event, or re-read it if it's the one already loaded. */
  async _open(target, kind) {
    if (this._event && sameEvent(this._store.tournament().eventSlug, target.slug)) {
      const r = await this.refresh();
      if (!r.ok) return r;
      return { ok: true, refreshed: true, ...this._names(), warning: target.warning };
    }
    const r = await this.loadEvent(target.slug, { kind });
    if (!r.ok) return r;
    return { ok: true, refreshed: false, ...this._names(), warning: target.warning };
  }

  /** A pasted link → an event slug: directly, or via its tournament's one event. */
  async _targetFromUrl(text) {
    const slug = normalizeEventUrl(text);
    if (slug) return { ok: true, slug };

    const link = await this._startgg.resolveShortLink(text);
    if (!link.ok) {
      return { ok: false, error: `Couldn't find "${text}" on start.gg — paste an event URL like start.gg/tournament/<name>/event/<event>` };
    }
    const list = await this._startgg.listEvents(link.slug);
    if (!list.ok) return list;
    if (list.events.length === 1) return { ok: true, slug: list.events[0].slug };
    return {
      ok: false,
      error: `${list.name} has ${list.events.length} events (${list.events.map((e) => e.name).join(", ")}) — paste the one event's URL`,
    };
  }

  /** Short link → tournament → the one event matching the kind's keywords. */
  async _resolveTarget(kind, spec) {
    const link = await this._startgg.resolveShortLink(this._brackets.shortLink);
    if (!link.ok) return link;

    const list = await this._startgg.listEvents(link.slug);
    if (!list.ok) {
      if (!spec.fallbackSlug) return list;
      this._log(`Event lookup failed (${list.error}) — falling back to "${spec.fallbackSlug}"`);
      return {
        ok: true,
        slug: `tournament/${link.slug}/event/${spec.fallbackSlug}`,
        warning: `Couldn't read ${link.slug}'s events (${list.error}) — used the configured slug instead.`,
      };
    }
    const hit = pickEvent(list.events, spec, kind);
    return hit.ok ? { ok: true, slug: hit.event.slug } : hit;
  }

  /**
   * Load an event by slug and read every phase group's sets. Leaves the
   * scoreboard alone (see store.setTournament).
   * @param {string} slug — "tournament/<t>/event/<e>" (a pasted URL is fine)
   * @param {{ kind?: string|null }} [opts] — omitted keeps the saved kind; null
   *   (a pasted URL) clears it
   */
  async loadEvent(slug, { kind } = {}) {
    const clean = normalizeEventUrl(slug) ?? String(slug);
    const res = await this._startgg.getEvent(clean);
    if (!res.ok) return this._fail(res.error);

    const gen = ++this._gen;
    this._event = res.event;
    this._groups = groupsOf(res.event, []);
    const ev = res.event;
    this._store.setTournament({
      name: ev.tournament?.name ?? "",
      slug: ev.tournament?.slug ?? "",
      eventName: ev.name ?? "",
      eventSlug: normalizeEventUrl(ev.slug) ?? clean,
      kind: kind === undefined ? this._store.tournament().kind ?? null : kind,
    });
    this._log(`Loaded ${this._names().tournamentName} — ${ev.name} (${this._groups.length} phase group${this._groups.length === 1 ? "" : "s"})`);

    const r = await this._readGroups(gen, { background: false });
    this._schedule();
    return r;
  }

  /**
   * Re-read the loaded event: its phase groups (a pool finishing, top 8 being
   * created) and their sets. Concurrent callers share one read. With nothing
   * loaded yet but an event saved in the store (a restart), loads that.
   * @param {{ background?: boolean }} [opts] — the timer passes true
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  refresh({ background = false } = {}) {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._refresh(background).finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _refresh(background) {
    const saved = this._store.tournament().eventSlug;
    if (!this._event) {
      if (!saved) return { ok: false, error: "No event loaded — press Singles or Doubles" };
      return this.loadEvent(saved);
    }
    const gen = this._gen;
    const res = await this._startgg.getEvent(this._event.slug ?? saved, { background });
    if (gen !== this._gen) return { ok: true };
    if (res.ok) {
      this._event = res.event;
      this._groups = groupsOf(res.event, this._groups);
    }
    // A failed event read keeps the groups already known and still re-reads
    // their sets — the bracket is what changes during a set.
    return this._readGroups(gen, { background });
  }

  /** Read the sets of every group that can still change, in phase order. */
  async _readGroups(gen, { background }) {
    let firstError = null;
    for (const g of this._groups) {
      if (g.graph && Number(g.readState) === COMPLETED) continue;
      const state = g.state; // what the sets about to be read are final for
      const res = await this._startgg.getPhaseGroupSets(g.id, { background });
      if (gen !== this._gen) return { ok: true }; // another event loaded meanwhile
      if (!res.ok) {
        g.error = res.error;
        firstError ??= `${g.label}: ${res.error}`;
        continue;
      }
      g.error = null;
      g.raw = res.sets;
      g.readState = state;
      g.graph = buildBracket(res.sets, { phaseGroupId: g.id, bracketType: g.bracketType });
    }
    if (firstError) return this._fail(firstError);
    this._status = { state: "ok", error: null, updatedAt: Date.now() };
    this.emit("change");
    return { ok: true };
  }

  _fail(error) {
    this._status = { state: "error", error, updatedAt: Date.now() };
    this.emit("change");
    return { ok: false, error };
  }

  _names() {
    return {
      tournamentName: this._event?.tournament?.name ?? this._store.tournament().name,
      eventName: this._event?.name ?? this._store.tournament().eventName,
    };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  /**
   * The picker: every group's sets, playable first, then live, then waiting
   * (finished only on request). Within a status, earlier phases first and each
   * group's own order (set-model.pickerList).
   * @param {{ includeDone?: boolean }} [opts]
   */
  openSets(opts = {}) {
    const labelled = this._groups.length > 1;
    return this._groups
      .flatMap((g) => (g.graph ? pickerList(g.graph, opts) : [])
        .map((row) => ({ ...row, phaseGroupId: g.id, phase: labelled ? g.label : "" })))
      .sort((a, b) => PICK_ORDER[a.status] - PICK_ORDER[b.status]); // stable: keeps the rest
  }

  /**
   * start.gg player ids in the first `limitSets` playable sets — the players
   * likely to be on stream next, whose histories the stats pre-fetch.
   */
  playablePlayerIds(limitSets) {
    const ids = [];
    for (const row of this.openSets().filter((r) => r.status === "playable").slice(0, limitSets)) {
      const graph = this.graph(row.phaseGroupId);
      for (const slot of graph.sets[row.setId].slots) {
        for (const p of graph.entrants[slot.entrantId]?.players ?? []) {
          if (p.playerId && !ids.includes(p.playerId)) ids.push(p.playerId);
        }
      }
    }
    return ids;
  }

  /**
   * Every player entered in the loaded event, once each — the dock's player
   * autocomplete while an event is loaded. Read from the bracket graphs, so it
   * is everyone in a set read so far (an unstarted bracket's preview sets
   * carry the seeded entrants); `team` is the entrant's name in doubles.
   * @returns {Array<{ playerId: string|null, tag: string, prefix: string, team: string, seed: number|null }>}
   */
  players() {
    const out = new Map();
    for (const g of this._groups) {
      for (const ent of Object.values(g.graph?.entrants ?? {})) {
        const team = (ent.players?.length ?? 0) > 1 ? ent.name ?? "" : "";
        for (const p of ent.players ?? []) {
          if (!p.tag) continue;
          const key = p.playerId ?? `tag:${p.tag.toLowerCase()}`;
          if (!out.has(key)) out.set(key, { playerId: p.playerId ?? null, tag: p.tag, prefix: p.prefix ?? "", team, seed: ent.seed ?? null });
        }
      }
    }
    return [...out.values()];
  }

  /** One phase group's bracket graph (bracket-model.buildBracket), or null. */
  graph(phaseGroupId) {
    return this._groups.find((g) => g.id === String(phaseGroupId))?.graph ?? null;
  }

  /**
   * Every phase group in bracket order, with its graph once read. The graphs
   * are this service's own objects — read them, don't change them.
   * @returns {Array<{ id, label, phaseName, state, bracketType, graph }>}
   */
  groups() {
    return this._groups.map(({ id, label, phaseName, state, bracketType, graph }) =>
      ({ id, label, phaseName, state, bracketType, graph }));
  }

  /** The loaded event: { id, slug, name, singles, tournamentName }, or null. */
  eventInfo() {
    if (!this._event) return null;
    return {
      id: String(this._event.id ?? ""),
      slug: this._store.tournament().eventSlug,
      name: this._event.name ?? "",
      singles: Number(this._event.type) === 1,
      tournamentName: this._event.tournament?.name ?? "",
    };
  }

  /** Every set read from start.gg, across all phase groups, as start.gg returned them. */
  rawSets() {
    return this._groups.flatMap((g) => g.raw);
  }

  /** What GET /api/event shows. */
  snapshot() {
    const t = this._store.tournament();
    return {
      status: this.status(),
      event: this._event ? {
        name: this._event.name ?? "",
        slug: t.eventSlug,
        state: this._event.state ?? null,
        kind: t.kind,
        tournament: { name: this._event.tournament?.name ?? "", slug: this._event.tournament?.slug ?? "" },
      } : null,
      phaseGroups: this._groups.map((g) => ({
        id: g.id, label: g.label, state: g.state, bracketType: g.bracketType,
        sets: g.graph ? Object.keys(g.graph.sets).length : null, error: g.error,
      })),
    };
  }

  // ── Loading a set ───────────────────────────────────────────────────────────

  /**
   * Put a set from the loaded event on the scoreboard.
   *
   * The set is re-read first: the picker can be 90s old, and in that time
   * another setup may have started it or an entrant may have been filled in.
   * A failed re-read loads what the picker had and says so. Preview sets (an
   * unstarted bracket) have nothing on start.gg to re-read.
   *
   * Each player is matched in (and if new, added to) the player DB, which
   * supplies the pronoun and the character shown until Slippi says otherwise.
   *
   * @param {string|number} setId
   * @returns {Promise<{ ok: boolean, setId?: string, roundName?: string, names?: string[], warning?: string, error?: string }>}
   */
  async loadSet(setId) {
    const id = String(setId);
    const group = this._groups.find((g) => g.graph?.sets[id]);
    if (!group) return { ok: false, error: `Set ${id} isn't in the loaded event — refresh the list` };

    let warning;
    if (!id.startsWith("preview")) {
      const fresh = await this._startgg.getSet(id);
      if (fresh.ok) {
        group.raw = group.raw.map((s) => (String(s.id) === id ? fresh.set : s));
        group.graph = buildBracket(group.raw, { phaseGroupId: group.id, bracketType: group.bracketType });
      } else {
        warning = `Couldn't re-read the set (${fresh.error}) — loaded it as the list last saw it.`;
        this._log(warning);
      }
    }

    // The outgoing set's mains are learned first, so a player who was just in
    // it opens this one on what they played.
    this._store.closeSet();
    const payload = loadPayload(group.graph, id);
    this._enrich(payload);
    this._store.loadSet(payload);
    this.emit("change");
    return {
      ok: true, setId: id, roundName: payload.roundName,
      names: payload.sides.map((s) => s.name), warning,
    };
  }

  /** Pronoun and main from the player DB; new players are added to it. */
  _enrich(payload) {
    const db = this._playerDb;
    if (!db) return;
    for (const side of payload.sides) {
      for (const p of side.players) {
        const rec = db.upsert({ playerId: p.playerId, tag: p.tag, prefix: p.prefix });
        if (!rec) continue;
        p.pronoun = rec.pronoun ?? "";
        if (!p.prefix && rec.prefix) p.prefix = rec.prefix;
        const main = db.preferredMain(rec);
        p.main = main ? characterByName(main.name, main.skin) : null;
      }
    }
  }
}

/**
 * The event's phase groups in bracket order, keeping what was already read for
 * a group still present (a refresh re-reads it; a completed one is kept as is).
 */
function groupsOf(event, previous) {
  const prev = new Map(previous.map((g) => [g.id, g]));
  const phases = [...(event?.phases ?? [])].sort((a, b) => (a.phaseOrder ?? 0) - (b.phaseOrder ?? 0));
  return phases.flatMap((phase) => {
    const nodes = phase.phaseGroups?.nodes ?? [];
    return nodes.map((pg) => {
      const id = String(pg.id);
      const old = prev.get(id);
      return {
        id,
        phaseName: phase.name ?? "",
        label: nodes.length > 1 ? `${phase.name ?? ""} ${pg.displayIdentifier ?? ""}`.trim() : phase.name ?? "",
        bracketType: pg.bracketType ?? phase.bracketType ?? null,
        state: pg.state ?? null,
        raw: old?.raw ?? [],
        graph: old?.graph ?? null,
        readState: old?.readState ?? null,
        error: old?.error ?? null,
      };
    });
  });
}

module.exports = { EventService };
