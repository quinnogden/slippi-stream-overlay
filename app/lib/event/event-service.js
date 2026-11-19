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
 * refresh on a timer through the bracket's lane of the background budget (its
 * own queue, so a stats crawl can't hold it up, and capped short of start.gg's
 * limit, so it can never crowd out a report): every 15s, each poll asking only
 * what changed since the last change held — one request for every group — and
 * reading a group whole only when that can't be trusted (_pollOnce). What the
 * operator presses — a bracket switch, ↻, loading a set — goes straight out,
 * unbudgeted. Every read here falls back to start.gg's keyless web endpoint, so
 * the dock works without a token (reporting and starting don't).
 *
 * Emits `change` whenever the event, its graphs or its status change, and
 * `set-load-settled` when no set load is in flight any more (`loadingSet`): a
 * game that ends while one is re-read waits for it (lib/modes/index.js).
 *
 * Three things start.gg does that would otherwise reach the stream:
 *
 *   - **It goes blank when a bracket starts.** For 40–80s (measured with 7
 *     players; longer with more) a started or restarted phase group reads as
 *     no sets at all, then every set comes back under a new id. A group that
 *     had sets and reads as none keeps its last list (`rebuilding`), and the
 *     next read comes in 15s, not 90.
 *   - **It renumbers sets.** `preview_…` ids become numbers when the bracket
 *     starts, and a TO's reset renumbers them again. The set on the scoreboard
 *     follows its match (same letter, same two entrants) to the new id
 *     (`set-relinked`), keeping its games — Start, Report and the replay
 *     upload then just work, where a reload would have dropped the games.
 *   - **Its lists lag a press.** A report or a start shows in start.gg's set
 *     lists seconds later. What the dock pressed is laid over the read
 *     (afterAction) until start.gg agrees or 2 minutes pass, and the event is
 *     polled again 4s and 12s on. A report also moves its winner and
 *     loser into the sets they go to next, by start.gg's own edges — so the
 *     next set is ready in Up next the moment the report lands, not when the
 *     lists catch up — and takes the sets start.gg answered it with.
 */

const { EventEmitter } = require("events");
const { buildBracket } = require("./bracket-model");
const { loadPayload, pickerList, findSameMatch, PICK_ORDER } = require("./set-model");
const { normalizeBrackets, normalizeEventUrl, sameEvent, pickEvent } = require("./event-target");
const { characterByName } = require("../char_map");

// The timer: each poll asks start.gg only what changed in the phase groups
// (one request for all of them, see _pollOnce), and reads the event itself —
// new groups, their states — once a minute. Every 15s, slower when a poll had
// to read groups whole (paced to 8 requests a minute), never past 90s.
const MIN_POLL_MS = 15000;
const MAX_POLL_MS = 90000;
const POLL_REQUESTS_PER_MIN = 8;
const EVENT_EVERY_MS = 60000;
// A group is still read whole this often, one group a poll: a list of changes
// can't show a set start.gg deleted, or an edit that didn't touch a set's time.
const FULL_EVERY_MS = 5 * 60000;
// Changes are asked for from this long before the newest one held, so one
// start.gg's lists showed late is still caught. Sets that all changed at once
// (a bracket starting: every set at the same second) are more than a page
// until later changes move the window on, so polls read the group whole for
// those few minutes — what every poll used to do.
const CHANGED_MARGIN_S = 60;
// While start.gg is rebuilding a bracket (or about to: the dock just started
// one), read again this soon.
const FAST_POLL_MS = 15000;
// A group that read as empty after having sets keeps them this long — past
// that, it really is empty.
const HOLD_EMPTY_MS = 5 * 60000;
// A press laid over start.gg's lists, until they agree or this passes.
const PENDING_MS = 2 * 60000;
// After a press, start.gg's lists catch up over several seconds.
const AFTER_ACTION_MS = [4000, 12000];

// start.gg's ActivityState: a completed phase group's sets don't change, so it
// is read once rather than on every refresh — once its sets were read *while*
// it was completed, or the last report (the GF reset) stays live in the picker.
const COMPLETED = 3;

class EventService extends EventEmitter {
  /**
   * @param {object} ctx — { config, startgg, store, playerDb }
   * @param {{ pollMs?: number, log?: Function }} [opts] — pollMs: a fixed timer (tests)
   */
  constructor(ctx, opts = {}) {
    super();
    this._startgg  = ctx.startgg;
    this._store    = ctx.store;
    this._playerDb = ctx.playerDb ?? null;
    this._brackets = normalizeBrackets(ctx.config);
    this._pollMs   = opts.pollMs ?? null;
    this._log      = opts.log ?? ((m) => console.log(`[event] ${m}`));
    // Requests the last read took (paces the timer).
    this._readCost = 1;
    // Every group read is numbered as it starts; one that lands after a later one doesn't overwrite it.
    this._readSeq = 0;
    // When the event itself was last read (polls read it once a minute).
    this._eventReadAt = 0;
    this._polling = null;

    this._event  = null;  // getEvent()'s event
    this._groups = [];    // see groupsOf()
    this._status = { state: "none", error: null, updatedAt: null };
    // Bumped whenever a different event loads, so a refresh still in flight for
    // the previous one drops its answer instead of writing it into the new one.
    this._gen = 0;
    this._refreshing = null;
    this._switching = false;
    this._timer = null;
    this._loadingSets = 0;
    // setId → { patch, at }: what the dock just did to a set, until start.gg's lists show it.
    this._pending = new Map();
    this._soonTimers = [];
    // Until when a blank read is expected (the dock just started a preview set).
    this._expectRebuildUntil = 0;
  }

  get shortLink() { return this._brackets.shortLink; }

  /** A set load is between the operator's press and the scoreboard (re-reading the set from start.gg). */
  get loadingSet() { return this._loadingSets > 0; }

  /** { state: "none" | "ok" | "error", error, updatedAt, rebuilding } of the last read. */
  status() { return { ...this._status, rebuilding: this.rebuilding }; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Reload the event restored from the last run, then refresh on a timer —
   * which also keeps trying that reload if start.gg couldn't be reached at
   * boot (venue Wi-Fi often isn't up yet).
   */
  start() {
    if (this._store.tournament().eventSlug) {
      this.refresh().then((r) => { if (!r.ok) this._log(`Couldn't reload the saved event: ${r.error}`); });
    }
    this._schedule();
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
    for (const t of this._soonTimers) clearTimeout(t);
    this._soonTimers = [];
  }

  _schedule() {
    clearTimeout(this._timer);
    const fast = this.rebuilding || Date.now() < this._expectRebuildUntil;
    const every = this.pollMs();
    this._timer = setTimeout(async () => {
      // A saved event not read yet goes through refresh() too, as a reload.
      if (this._event || this._store.tournament().eventSlug) await this.refresh({ background: true });
      this._schedule();
    }, fast ? Math.min(FAST_POLL_MS, every) : every);
    this._timer.unref?.();
  }

  /** How long the timer waits between reads (see MIN_POLL_MS). */
  pollMs() {
    if (this._pollMs != null) return this._pollMs;
    const paced = Math.ceil((this._readCost * 60000) / POLL_REQUESTS_PER_MIN);
    return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, paced));
  }

  /** start.gg is rebuilding a bracket: a group that had sets reads as none, and its last list is shown. */
  get rebuilding() { return this._groups.some((g) => g.emptySince != null); }

  /**
   * The dock just did something to a set on start.gg (lib/event/bracket-ops.js,
   * the strip's Start and Report). Show it now, over start.gg's lists until
   * they say the same, and poll again as they catch up.
   *
   * A report also moves its winner and loser on (_advance), so the set they go
   * to next is ready in Up next the moment the report lands.
   *
   * @param {string|number} setId
   * @param {{ state?: 1|2|3|6, winnerId?: string|null, scores?: Object<string, number|null>,
   *           startedAt?: number, streamId?: string, dq?: boolean, startsBracket?: boolean }} [patch]
   * @param {Array<object>} [fresh] — the sets start.gg answered the press with
   *   (a report's: the reported set and the ones it changed), in the lists' shape
   */
  afterAction(setId, patch = null, fresh = null) {
    const id = String(setId);
    if (patch?.startsBracket) this._expectRebuildUntil = Date.now() + 3 * 60000;
    const took = this._takeFresh(fresh);
    if (patch) {
      const { startsBracket, ...rest } = patch;
      if (Object.keys(rest).length) this._press(id, rest);
      if (rest.state === 3 && rest.winnerId != null) this._advance(id, rest);
      if (rest.state === 1) this._unadvance(id);
    }
    if (patch || took.size) {
      for (const g of this._groups) if (g.graph) g.graph = this._build(g);
      this.emit("change");
    }

    // Polls as start.gg catches up — each asks only what changed, so they're
    // one request; a press that started the bracket gets its whole read there.
    for (const t of this._soonTimers) clearTimeout(t);
    this._soonTimers = AFTER_ACTION_MS.map((ms) => {
      const t = setTimeout(() => {
        this._pollAfter().catch((err) => this._log(`Re-read after a press failed: ${err.message}`));
      }, ms);
      t.unref?.();
      return t;
    });
    this._schedule();
  }

  /**
   * Lay a press over a set until a read started after it agrees. A new state
   * replaces the last press's result (a report after a reset is a new result);
   * moves into the set from different feeders add up.
   */
  _press(id, patch) {
    let old = this._pending.get(id)?.patch ?? {};
    if (patch.state != null) {
      const { state, winnerId, scores, dq, ...keep } = old;
      old = keep;
    }
    const merged = { ...old, ...patch };
    if (old.fill && patch.fill) {
      const same = (a, b) => a.from === b.from && a.placement === b.placement;
      merged.fill = [...old.fill.filter((f) => !patch.fill.some((n) => same(f, n))), ...patch.fill];
    }
    this._pending.set(id, { patch: merged, at: Date.now(), seq: this._readSeq });
  }

  /**
   * A reported set's winner and loser, into the sets they go to next: the
   * slots start.gg's own edges say this set fills (placement 1 its winner, 2
   * its loser), pressed like the report until start.gg's lists show them.
   * A DQ'd loser isn't moved (start.gg takes them out, not on), and a grand
   * final's reset is filled only when the losers side won — otherwise
   * start.gg deletes it.
   */
  _advance(id, { winnerId, dq }) {
    const found = this.findSet(id);
    const raw = this.rawSets().find((s) => String(s.id) === id);
    if (!found || !raw) return;
    const w = String(winnerId);
    const filled = (raw.slots ?? []).filter((x) => x?.entrant?.id != null);
    const won = filled.find((x) => String(x.entrant.id) === w);
    const lost = filled.find((x) => String(x.entrant.id) !== w);
    if (!won) return;
    const fromLosers = found.set.slots.find((x) => x.entrantId === w)?.fromLosers === true;
    for (const next of this.rawSets()) {
      const fed = (next.slots ?? []).filter((x) => fedBy(x, id));
      if (!fed.length || (fed.length === 2 && !fromLosers)) continue; // both from one set: the reset
      const fill = fed.flatMap((x) => {
        const placement = Number(x.prereqPlacement ?? 1);
        const who = placement === 2 ? (dq ? null : lost) : won;
        return who ? [{ from: id, placement, entrant: who.entrant, seed: who.seed ?? null }] : [];
      });
      if (fill.length) this._press(String(next.id), { fill });
    }
  }

  /** A reset takes back what its report moved on; start.gg's lists say where the players are now. */
  _unadvance(id) {
    for (const [setId, p] of this._pending) {
      const fill = (p.patch.fill ?? []).filter((f) => f.from !== id);
      if (fill.length === (p.patch.fill ?? []).length) continue;
      const { fill: _, ...rest } = p.patch;
      const patch = fill.length ? { ...rest, fill } : rest;
      if (Object.keys(patch).length) this._pending.set(setId, { ...p, patch });
      else this._pending.delete(setId);
    }
  }

  /**
   * Sets start.gg answered a press with, in place of the lists' copies (a set
   * the lists don't have yet is left to the next read). Returns their groups.
   */
  _takeFresh(fresh) {
    const touched = new Set();
    for (const s of Array.isArray(fresh) ? fresh : []) {
      if (s?.id == null) continue;
      const id = String(s.id);
      const g = this._groups.find((x) => x.raw.some((r) => String(r.id) === id));
      if (!g) continue;
      g.raw = g.raw.map((r) => (String(r.id) === id ? s : r));
      touched.add(g);
    }
    return touched;
  }

  /** A group's graph: start.gg's sets, with the dock's presses it hasn't caught up with laid over them. */
  _build(g) {
    return buildBracket(this._withPending(g.raw, g.seq ?? 0), { phaseGroupId: g.id, bracketType: g.bracketType });
  }

  /**
   * Only a list read started after the press can say start.gg has caught up
   * with it — not start.gg's own answer to the press, nor a read already out
   * when it was made, either of which a lagging read could then undo.
   */
  _withPending(raw, readSeq) {
    if (!this._pending.size) return raw;
    const now = Date.now();
    return raw.map((s) => {
      const id = String(s.id);
      const p = this._pending.get(id);
      if (!p) return s;
      if (now - p.at > PENDING_MS || (readSeq > p.seq && agrees(s, p.patch))) {
        this._pending.delete(id);
        return s;
      }
      return applyPatch(s, p.patch);
    });
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
    this._eventReadAt = Date.now();
    this._groups = groupsOf(res.event, []);
    this._pending.clear();
    for (const t of this._soonTimers) clearTimeout(t);
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
   *
   * The timer's read (`background`) is a poll: only what changed (_pollOnce).
   * The operator's ↻ re-reads every group whole.
   *
   * @param {{ background?: boolean }} [opts] — the timer passes true
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  refresh({ background = false } = {}) {
    if (background && this._event) return this._poll();
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
      this._eventReadAt = Date.now();
      this._groups = groupsOf(res.event, this._groups);
    }
    // A failed event read keeps the groups already known and still re-reads
    // their sets — the bracket is what changes during a set.
    return this._readGroups(gen, { background });
  }

  /** The timer's read; concurrent callers share one. */
  _poll() {
    if (this._polling) return this._polling;
    this._polling = this._pollOnce().finally(() => { this._polling = null; });
    return this._polling;
  }

  /** A poll that starts from now: one already out started before a press, so this waits for it and goes again. */
  _pollAfter() {
    const go = () => this.refresh({ background: true });
    return this._polling ? this._polling.then(go, go) : go();
  }

  /**
   * A timed read. Each phase group is asked only what changed since its newest
   * change (less CHANGED_MARGIN_S) — one request for every group — and those
   * sets replace the ones held: a weekly's poll is one request, not an event
   * read and three pages. A group is read whole instead when a list of changes
   * can't be the whole story:
   *
   *   - it hasn't been read whole yet, holds preview sets (they have no update
   *     time), is being rebuilt by start.gg, or has just completed (its last
   *     read is a whole one);
   *   - a change is a set it doesn't hold (start.gg renumbered it), or there
   *     were more changes than a page, or start.gg couldn't answer for it;
   *   - its grand final is done and the reset is still there, empty (start.gg
   *     deletes it when the winners side wins, and a deletion isn't a change);
   *   - FULL_EVERY_MS since its last whole read (the stalest, one a poll).
   */
  async _pollOnce() {
    const gen = this._gen;
    let cost = 0;
    if (Date.now() - this._eventReadAt >= EVENT_EVERY_MS) {
      cost++;
      const res = await this._startgg.getEvent(this._event.slug ?? this._store.tournament().eventSlug, { background: true });
      if (gen !== this._gen) return { ok: true };
      if (res.ok) {
        this._event = res.event;
        this._eventReadAt = Date.now();
        this._groups = groupsOf(res.event, this._groups);
      }
    }

    const whole = new Set();
    const asks = [];
    for (const g of this._groups) {
      if (g.graph && Number(g.readState) === COMPLETED) continue;
      const after = changedSince(g);
      if (after == null || g.emptySince != null || Number(g.state) === COMPLETED) whole.add(g.id);
      else asks.push({ g, after });
    }
    const stalest = asks.filter((a) => Date.now() - a.g.fullAt >= FULL_EVERY_MS)
      .sort((a, b) => a.g.fullAt - b.g.fullAt)[0];
    if (stalest) whole.add(stalest.g.id);

    const ask = asks.filter((a) => !whole.has(a.g.id));
    if (ask.length) {
      cost++;
      const seq = ++this._readSeq;
      const res = await this._startgg.getChangedSets(ask.map((a) => ({ id: a.g.id, after: a.after })), { background: true });
      if (gen !== this._gen) return { ok: true };
      // Too many changes for one request reads them whole; a failed request is a failed read.
      if (!res.ok && !res.complexity) {
        this._readCost = cost;
        return this._fail(res.error);
      }
      for (const { g } of ask) {
        const got = res.ok ? res.groups[g.id] : null;
        const held = new Set(g.raw.map((s) => String(s.id)));
        if (!got || got.total > got.sets.length || got.sets.some((s) => !held.has(String(s.id)))) {
          whole.add(g.id);
          continue;
        }
        if (seq < g.seq) continue; // a later read of it has landed
        if (got.sets.length) {
          const fresh = new Map(got.sets.map((s) => [String(s.id), s]));
          g.raw = g.raw.map((s) => fresh.get(String(s.id)) ?? s);
        }
        g.seq = seq;
        g.error = null;
        g.graph = this._build(g);
        const dead = deadReset(g.graph);
        if (dead && g.wholeAfter !== dead) whole.add(g.id);
      }
    }
    return this._readGroups(gen, { background: true, only: whole, cost });
  }

  /**
   * Read the sets of every group that can still change, in phase order, whole
   * — or just the groups in `only` (by id; a poll's). `cost`: requests already
   * spent on this read (the event's), for the timer's pace.
   */
  async _readGroups(gen, { background, only = null, cost = 1 }) {
    let firstError = null;
    for (const g of this._groups) {
      if (only ? !only.has(g.id) : g.graph && Number(g.readState) === COMPLETED) continue;
      const state = g.state; // what the sets about to be read are final for
      const seq = ++this._readSeq;
      const res = await this._startgg.getPhaseGroupSets(g.id, { background });
      if (gen !== this._gen) return { ok: true }; // another event loaded meanwhile
      cost += res.requests ?? 1;
      if (!res.ok) {
        g.error = res.error;
        firstError ??= `${g.label}: ${res.error}`;
        continue;
      }
      // A read of this group started after this one has landed already: that's the newer list.
      if (seq < (g.seq ?? 0)) continue;
      g.error = null;
      // start.gg is rebuilding the bracket (see the header): keep the last list.
      if (!res.sets.length && g.raw.length) {
        if (g.emptySince == null) {
          g.emptySince = Date.now();
          this._log(`${g.label || "The bracket"} read as empty — start.gg is rebuilding it; showing the last list`);
        }
        if (Date.now() - g.emptySince < HOLD_EMPTY_MS) continue;
      }
      if (g.emptySince != null) this._log(`${g.label || "The bracket"} is back from start.gg (${res.sets.length} sets)`);
      g.emptySince = null;
      g.raw = res.sets;
      g.readState = state;
      g.seq = seq;
      g.fullAt = Date.now();
      g.graph = this._build(g);
      // A reset still there after this read waits for the next whole one (start.gg may be slow to drop it).
      g.wholeAfter = deadReset(g.graph);
    }
    this._readCost = cost;
    if (firstError) return this._fail(firstError);
    this._followOnAir();
    this._status = { state: "ok", error: null, updatedAt: Date.now() };
    this.emit("change");
    return { ok: true };
  }

  /**
   * The set on the scoreboard has a new id on start.gg (see the header): move
   * the link, keep everything else. Only after a whole, clean read — a group
   * still held or failed has the old ids, and the set is found as it was.
   */
  _followOnAir() {
    const sb = this._store.scoreboard();
    if (sb.setId == null || sb.crew) return;
    const id = String(sb.setId);
    const entrantIds = sb.sides.map((s) => s.entrantId);
    const now = this._groups.find((g) => g.graph?.sets[id])?.graph.sets[id];
    const pairOf = (ids) => ids.map((x) => String(x ?? "")).sort().join("|");
    if (now && pairOf(now.slots.map((s) => s.entrantId)) === pairOf(entrantIds)) return;
    const want = { identifier: sb.identifier, entrantIds, phaseGroupId: sb.phaseGroupId, excludeId: id };
    const hit = findSameMatch(this._groups, want)
      ?? (id.startsWith("preview") ? findSameMatch(this._groups, { ...want, loose: true }) : null);
    if (!hit) return;
    const p = loadPayload(this.graph(hit.groupId), hit.set.id);
    const moved = this._store.relinkSet({
      setId: p.setId, phaseGroupId: p.phaseGroupId, identifier: p.identifier, roundName: p.roundName,
      lPlacement: p.lPlacement, isGrandFinal: p.isGrandFinal, isReset: p.isReset,
    });
    if (!moved) return;
    const names = sb.sides.map((s) => s.teamName || s.players.map((x) => x.tag).join(" / ")).join(" vs ");
    this._log(`${names}: start.gg moved the set to a new id (${id} → ${p.setId})${id.startsWith("preview") ? " — the bracket has started" : ""}; games kept`);
    this.emit("set-relinked", { from: id, to: p.setId });
  }

  /** The tournament's streams on start.gg: [{ id, name, source }] (enabled ones). */
  streams() {
    return (this._event?.tournament?.streams ?? [])
      .filter((s) => s && s.id != null && s.enabled !== false)
      .map((s) => ({ id: String(s.id), name: s.streamName ?? "", source: s.streamSource ?? "" }));
  }

  /** A set of the loaded event, wherever it is: { groupId, label, set } (the graph's node), or null. */
  findSet(setId) {
    const id = String(setId);
    const g = this._groups.find((x) => x.graph?.sets[id]);
    return g ? { groupId: g.id, label: g.label, set: g.graph.sets[id] } : null;
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
    this._loadingSets++;
    try {
      return await this._loadSet(id, group);
    } finally {
      if (--this._loadingSets === 0) this.emit("set-load-settled");
    }
  }

  async _loadSet(id, group) {
    let warning;
    if (!id.startsWith("preview")) {
      const fresh = await this._startgg.getSet(id);
      if (fresh.ok) {
        group.raw = group.raw.map((s) => (String(s.id) === id ? fresh.set : s));
        group.graph = this._build(group);
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
 * A group still present is the same object, so a read of it still in flight
 * (the re-reads after a press) lands in the group shown.
 */
function groupsOf(event, previous) {
  const prev = new Map(previous.map((g) => [g.id, g]));
  const phases = [...(event?.phases ?? [])].sort((a, b) => (a.phaseOrder ?? 0) - (b.phaseOrder ?? 0));
  return phases.flatMap((phase) => {
    const nodes = phase.phaseGroups?.nodes ?? [];
    return nodes.map((pg) => {
      const id = String(pg.id);
      const fields = {
        id,
        phaseName: phase.name ?? "",
        label: nodes.length > 1 ? `${phase.name ?? ""} ${pg.displayIdentifier ?? ""}`.trim() : phase.name ?? "",
        bracketType: pg.bracketType ?? phase.bracketType ?? null,
        state: pg.state ?? null,
      };
      const old = prev.get(id);
      return old
        ? Object.assign(old, fields)
        : { ...fields, raw: [], graph: null, readState: null, error: null, emptySince: null,
            seq: 0, fullAt: 0, wholeAfter: null };
    });
  });
}

/**
 * The start.gg time a poll asks a group's changes from: its newest set's
 * update, less CHANGED_MARGIN_S (start.gg's clock, never this PC's — a venue
 * PC's clock can be off). 0 for a group read whole and empty (anything at
 * all is news). Null when it has to be read whole: never read, or preview
 * sets, which have no update time.
 */
function changedSince(g) {
  if (!g.graph) return null;
  let newest = 0;
  for (const s of g.raw) {
    const t = Number(s.updatedAt);
    if (String(s.id).startsWith("preview") || !(t > 0)) return null;
    if (t > newest) newest = t;
  }
  return Math.max(0, newest - CHANGED_MARGIN_S);
}

/** The grand final's id when it's done and its reset is still there with nobody in it, else null. */
function deadReset(graph) {
  for (const s of Object.values(graph?.sets ?? {})) {
    if (s.side !== "GFR") continue;
    const gf = graph.sets[s.slots[0].from.setId];
    if (gf?.state === "done" && s.slots.every((x) => !x.entrantId)) return gf.id;
  }
  return null;
}

/** The slot of a set that `setId`'s result fills (its winner with placement 1, loser with 2). */
function fedBy(slot, setId, placement = null) {
  return slot?.prereqType === "set" && String(slot.prereqId) === String(setId)
    && (placement == null || Number(slot.prereqPlacement ?? 1) === placement);
}

/** Whether start.gg's copy of a set already shows what the dock pressed. */
function agrees(raw, patch) {
  const state = Number(raw.state);
  if (patch.state != null) {
    // A reset is "not finished" — start.gg may put it back as created or called.
    if (patch.state === 1 ? state === 3 : state !== patch.state) return false;
  }
  if (patch.streamId != null && String(raw.stream?.id ?? "") !== String(patch.streamId)) return false;
  for (const f of patch.fill ?? []) {
    const slot = (raw.slots ?? []).find((x) => fedBy(x, f.from, f.placement));
    if (String(slot?.entrant?.id ?? "") !== String(f.entrant.id)) return false;
  }
  return true;
}

/** A start.gg set node with the dock's press laid over it (agrees() says when to stop). */
function applyPatch(raw, patch) {
  const out = { ...raw };
  if (patch.state != null) out.state = patch.state;
  if (patch.startedAt != null && !out.startedAt) out.startedAt = patch.startedAt;
  if (patch.streamId != null) out.stream = { id: patch.streamId };
  if (patch.state === 3) {
    out.winnerId = patch.winnerId ?? out.winnerId;
    out.completedAt = out.completedAt ?? Math.floor(Date.now() / 1000);
    out.displayScore = patch.dq ? "DQ" : out.displayScore;
  }
  if (patch.state === 1) Object.assign(out, { winnerId: null, completedAt: null, displayScore: null });
  if (patch.scores || patch.state === 1) {
    out.slots = (raw.slots ?? []).map((slot) => {
      const id = slot?.entrant?.id == null ? null : String(slot.entrant.id);
      const value = patch.state === 1 ? null : patch.scores?.[id];
      if (value === undefined) return slot;
      return { ...slot, standing: { ...(slot.standing ?? {}), stats: { score: { value } } } };
    });
  }
  if (patch.fill) {
    out.slots = (out.slots ?? []).map((slot) => {
      const f = patch.fill.find((x) => fedBy(slot, x.from, x.placement));
      return f ? { ...slot, entrant: f.entrant, seed: f.seed ?? slot.seed ?? null } : slot;
    });
  }
  return out;
}

module.exports = { EventService, agrees, applyPatch };
