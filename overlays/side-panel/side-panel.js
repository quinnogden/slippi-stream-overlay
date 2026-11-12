/**
 * side-panel.js — the 611 × 1080 panel beside the webcam.
 *
 * The header card carries the tournament name; the bottom card rotates
 * through the logos, both players' cards, their head-to-head and the event's
 * just-finished sets, skipping any slot with nothing to show.
 *
 * Everything comes from the app: the scoreboard and tournament sections of
 * the state, and the `stats` event (lib/stats/ — start.gg histories fetched
 * by the app, plus luckystats.gg's ratings, all keyed by start.gg player id).
 * There is no second source to fall back to: a pair the stats haven't
 * finished shows no card rather than someone else's numbers. luckystats adds
 * Rank, Class and Region to the player cards and the win probability and Elo
 * to the head-to-head, and every card showing it says so ("Powered by
 * LuckyStats.gg").
 *
 * Two more cards come from the stats popup's numbers (the `setStats`
 * section, lib/set-stats/): Last Game, in three looks that take turns — the
 * next one each time the card comes on screen — and Set Recap, once a second
 * game is counted. Neither shows while the popup is up.
 *
 * A crew battle (the scoreboard's `crew` section) swaps the stats cards for
 * the two crews' rosters, each after a logo: every member with what they last
 * played and their stocks left, the one playing now lit, the eliminated greyed.
 *
 *   ?panel=<id>       hold one panel instead of rotating (for styling)
 *   ?look=<id>        with ?panel=last-game: hold one look (story, reel, box)
 *   ?animate=false    still the theme pack's background flair
 *
 * tests/side-panel.test.js runs this file against the real store, channel
 * mirror and overlay client.
 */
(function (root) {
  "use strict";

  const { h, fitText, fitGroup, icon, param, swap, draw, reel } = Overlay;
  const { ease, ms, restOf, pose, TEXT } = Overlay.motion;

  // Animation durations are at tempo 1; Overlay.motion.ms() scales them by
  // overlay.css's --motion-tempo. The interval is a dwell, and doesn't.
  const PANEL_INTERVAL = 20000;   // ms per slot, logos included
  const H2H_SHOWN      = 7;       // the pair's newest sets on the head-to-head (the app sends 7)
  const HOLD_PANEL     = param("panel");

  // A crew battle has only the logos and the crews; a set never has the crews.
  // The two stats cards sit either side of the sponsor's logo, never back to back.
  const PANEL_ORDER = [
    "logo-primary", "crew-1",
    "player-1", "player-2", "recent-sets", "last-game",
    "logo-sponsor", "crew-2", "set-recap", "completed-sets",
  ];

  // Resting states, as inline style. Motion lives in the keyframes below.
  const HIDDEN = { opacity: "0", transform: "", filter: "" };
  const SHOWN  = { opacity: "1", transform: "", filter: "" };

  // A logo comes and goes whole: it focuses in from slightly small and leaves
  // drifting forward — artwork reads better growing than sliding.
  const LOGO_IN_MS  = 760;
  const LOGO_OUT_MS = 300;
  const LOGO_IN     = { scale: 0.92, blur: 12 };
  const LOGO_OUT    = { scale: 1.04, blur: 8 };

  // An info panel itself never moves. Its rows — "beats": the identity, each
  // header, each pill, the projection, the credit — come in one after another,
  // top to bottom, each rising a little out of a soft focus.
  const BEAT_IN_MS   = TEXT.inMs;   // the overlays' one text motion (overlay-client.js)
  const BEAT_IN      = TEXT.in;
  const BAR_MS       = 900;     // the projection bar filling from even to the odds
  const EDGE_MS      = 420;     // a result pill's W/L edges wiping down (and a stats card's lead edge)
  const EDGED        = ["win", "loss", "p1win", "p2win", "lead-l", "lead-r"];
  const RULE_MS      = 560;     // a header's hairlines drawing out from its label
  // The stagger speeds up: each gap is GAP_DECAY of the last, down to a
  // floor, and a long panel's cascade is squeezed to fit its cap — a wave,
  // not a metronome, and about as long on every panel.
  const CASCADE_IN = { gap: 70, min: 28, max: 480 };
  const GAP_DECAY  = 0.85;

  // They leave the same way, top first, quicker: each drifts up and away.
  const BEAT_OUT_MS = TEXT.outMs;
  const BEAT_OUT    = TEXT.out;
  const CASCADE_OUT = { gap: 36, min: 14, max: 240 };

  // The panels' shared tint (.panel-surface).
  const SURFACE_IN_MS  = 440;
  const SURFACE_OUT_MS = 300;

  let sb = null;         // state.scoreboard
  let stats = null;      // the last `stats` event
  let setStats = null;   // state.setStats — the stats popup's numbers
  let statsShot = null;  // state.statsShot — whether the popup is up

  // ── Views ───────────────────────────────────────────────────────────────────
  //
  // Each panel reads a view — display-ready rows — so the renderers, the slot
  // predicates and the change detection all agree on what "has content" means.
  // Columns are sides[0] (left) and sides[1] (right) as the scoreboard has them
  // now; stats are keyed by start.gg player id and oriented against those
  // columns on every render, so Switch Sides needs nothing from the stats.

  const playerOf = (i) => sb?.sides?.[i]?.players?.[0] ?? null;
  const isDoubles = () => Boolean(sb?.isDoubles);
  const isCrew = () => Boolean(sb?.crew);

  /**
   * A column's crew in a crew battle: { name, total, members: [{ id, tag,
   * icon, stocks, status: "active"|"in"|"out" }] }, or null outside one.
   */
  function crewView(i) { return sb?.crew?.teams?.[i] ?? null; }

  function playerIdOf(i) {
    const id = playerOf(i)?.playerId;
    return id ? String(id) : null;
  }

  function statsPlayer(i) {
    if (!stats?.enabled) return null;
    const pid = playerIdOf(i);
    const p = pid ? stats.players?.[pid] : null;
    return p && p.state === "done" ? p : null;
  }

  /** Past placements: [{ tournament, event, placement, entrants }], newest first. */
  function historyView(i) { return statsPlayer(i)?.history ?? []; }

  /** This event's finished sets: [{ opponent, round, myScore, oppScore, won }], newest first. */
  function runView(i) { return statsPlayer(i)?.run ?? []; }

  /**
   * The head-to-head, oriented to the columns as they are now:
   * { wins: [left, right], sets: [{ tournament, round, timestamp, score: [l, r], winner: 0|1 }] },
   * or null when there is none to show.
   */
  function h2hView() {
    const h2h = stats?.enabled ? stats.h2h : null;
    const p1 = playerIdOf(0);
    const p2 = playerIdOf(1);
    if (!h2h || h2h.state !== "done" || !h2h.total || !p1 || !p2 || p1 === p2) return null;
    // A record for any other pair — the previous set's, answered late — is
    // not this pair's, whatever the names say.
    const ids = (h2h.players ?? []).map(String);
    if (!ids.includes(p1) || !ids.includes(p2)) return null;
    return {
      wins: [h2h.wins?.[p1] ?? 0, h2h.wins?.[p2] ?? 0],
      sets: (h2h.recent ?? []).map((s) => ({
        tournament: s.tournament,
        round: s.round,
        timestamp: s.completedAt,
        score: [s.scores?.[p1], s.scores?.[p2]],
        winner: String(s.winner) === p1 ? 0 : 1,
      })),
    };
  }

  /** Just finished in this event: [{ names: [a, b], scores: [a, b], winner: 0|1, round }]. */
  function completedView() {
    const c = stats?.completedSets;
    return c && Array.isArray(c.sets) ? c.sets.slice(0, 8) : [];
  }

  /**
   * luckystats' numbers for a column's player: { rank, className, badge,
   * region, regionIcon, regionRank }, or null. Keyed by player id, so a player
   * carried over from the previous set keeps theirs.
   */
  function luckyPlayer(i) {
    const lucky = stats?.enabled ? stats.lucky : null;
    const pid = playerIdOf(i);
    if (!lucky || lucky.state !== "done" || !pid) return null;
    return lucky.ratings?.[pid] ?? null;
  }

  /** What the player card shows right of the tag; null when there's nothing. */
  function luckyLine(i) {
    const r = luckyPlayer(i);
    if (!r || !(r.rank || r.className || r.region)) return null;
    return {
      rank: r.rank ?? null,
      className: r.className ?? null, badge: r.badge ?? null,
      region: r.region ?? null, regionIcon: r.regionIcon ?? null, regionRank: r.regionRank ?? null,
    };
  }

  /**
   * luckystats' win probability, oriented to the columns: [left, right], or
   * null. Like the head-to-head, a projection for another pair isn't this one's.
   */
  function projectionView() {
    if (isDoubles()) return null;
    const lucky = stats?.enabled ? stats.lucky : null;
    const ids = [playerIdOf(0), playerIdOf(1)];
    if (!lucky || lucky.state !== "done" || !lucky.matchup || !ids[0] || !ids[1] || ids[0] === ids[1]) return null;
    const pair = (lucky.players ?? []).map(String);
    if (!ids.every((id) => pair.includes(id))) return null;
    const prob = ids.map((id) => lucky.matchup.winProbability?.[id]);
    return prob.every((p) => typeof p === "number" && Number.isFinite(p)) ? prob : null;
  }

  /**
   * The head-to-head card: start.gg's record and, when luckystats has one for
   * this pair, the win probability. Null without a record — two players who
   * have never met get no card, probability or not.
   */
  function h2hCardView() {
    const record = h2hView();
    if (!record) return null;
    const prob = projectionView();
    // Each player's Elo, beside their chance; a side luckystats has none for is blank.
    const elo = prob ? [0, 1].map((i) => luckyPlayer(i)?.elo ?? null) : null;
    return { record, prob, elo };
  }

  function hasPlayerCard(i) {
    if (!playerOf(i)?.tag) return false;
    return historyView(i).length > 0 || runView(i).length > 0;
  }

  /** The popup up — with stats, as the players bar reads it — has the same numbers on screen already. */
  const popupUp = () => Boolean(statsShot?.shown && setStats?.available);

  /**
   * What a stats card reads, for one reading — "game" (Last Game) or "set"
   * (Set Recap, from the second counted game: with one, it's the game again)
   * — or null. Left and right are the scoreboard's columns now: set-view.js
   * builds them from each game's ports, which Switch Sides reverses.
   */
  function statsView(mode) {
    const d = setStats;
    if (!d?.available || isDoubles() || isCrew() || !d.games?.length) return null;
    if (mode === "set" && d.counted < 2) return null;
    const last = d.games[d.games.length - 1];
    const v = {
      mode, key: d.key, round: d.round, format: d.format, bestOf: d.bestOf, over: !!d.over,
      total: d.total, counted: d.counted, last: mode === "game" ? last : { n: last.n },
      stats: d.stats ?? {}, rows: d.rows ?? {},
      ins: d.insights?.[mode] ?? [], stories: d.stories?.[mode] ?? [], facts: d.facts?.[mode] ?? [],
    };
    // A title over nothing isn't a card: it needs a stat to show, a callout or a summary.
    if (!keysFor(v, FALLBACK_KEYS).length && !v.ins.length && !v.stories.length) return null;
    return v;
  }

  /**
   * A panel whose data couldn't be read or drawn (data of a shape the code
   * didn't expect, a bug): emptied, and out of the rotation until its data
   * changes and draws. Never half a card on stream, never a stalled rotation.
   */
  const broken = {};

  function slotHasContent(id) {
    if (broken[id]) return false;
    try {
      return hasContent(id);
    } catch (err) {
      console.error(`[side-panel] ${id}: couldn't read its data`, err);
      return false;
    }
  }

  function hasContent(id) {
    switch (id) {
      case "logo-primary":
      case "logo-sponsor":   return true;
      case "crew-1":         return crewView(0) !== null;
      case "crew-2":         return crewView(1) !== null;
      case "player-1":       return !isDoubles() && !isCrew() && hasPlayerCard(0);
      case "player-2":       return !isDoubles() && !isCrew() && hasPlayerCard(1);
      case "recent-sets":    return !isDoubles() && !isCrew() && h2hCardView() !== null;
      case "completed-sets": return !isCrew() && completedView().length > 0;
      case "last-game":      return !popupUp() && statsView("game") !== null;
      case "set-recap":      return !popupUp() && statsView("set") !== null;
      default:               return false;
    }
  }

  /**
   * The two score labels for a set. A set reported as a bare winner has no
   * game counts, so those always read W/L from the winner.
   */
  function scoreLabels(score, winner) {
    const num = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
    if (score && num(score[0]) && num(score[1])) return [String(score[0]), String(score[1])];
    return winner === 0 ? ["W", "L"] : ["L", "W"];
  }

  // ── Animation ───────────────────────────────────────────────────────────────
  //
  // Web Animations, with the resting state committed to inline style when they
  // finish, so nothing is left filling and a panel's resting state is always
  // readable from its style. Only opacity is committed: the transform and
  // blur are motion, and a logo's own CSS filter must stay the stylesheet's.

  /**
   * Cancel what's animating on `el` itself — its ::before / ::after included
   * (getAnimations() alone leaves those out), never its children's: an
   * Overlay.swap() cancelled from outside would never draw its new content.
   */
  function stopAnims(el) {
    if (!el?.getAnimations) return;
    el.getAnimations({ subtree: true }).forEach((a) => {
      if (!a.effect || a.effect.target === el) a.cancel();
    });
  }

  function tween(el, frames, rest, { duration, delay = 0, easing }) {
    const anim = el.animate(frames, { duration, delay, easing, fill: "both" });
    anim.finished.then(() => { Object.assign(el.style, rest); anim.cancel(); }, () => {});
    return anim;
  }

  function setStyle(el, styles) {
    stopAnims(el);
    Object.assign(el.style, styles);
  }

  // ── Beats ───────────────────────────────────────────────────────────────────
  //
  // An info panel animates as its rows, never as a whole. Each row that's
  // showing is a beat; the lists (and the head-to-head's header block, and a
  // stats card's grids and ledgers) open up into their own rows.

  const BEAT_GROUPS = ["run-list", "history-list", "sets-list", "completed-list", "crew-list", "h2h-header", "beat-group"];

  /** Element children only (the test sandbox's `children` holds text nodes too). */
  const elementsOf = (el) => Array.from(el.children).filter((c) => c.nodeType === 1);

  /** A panel's beats, in reading order. */
  function beatsOf(el) {
    const out = [];
    for (const child of elementsOf(el)) {
      if (child.style.display === "none") continue;
      if (BEAT_GROUPS.some((c) => child.classList.contains(c))) out.push(...beatsOf(child));
      else out.push(child);
    }
    return out;
  }

  /**
   * Bring beats in, beat i starting at delays[i] (ms, already at tempo). Each
   * holds invisible until its turn (fill: both) and commits its rest once in.
   */
  function beatsIn(beats, delays) {
    beats.forEach((b, i) => {
      stopAnims(b);
      const rest = restOf(b);
      tween(b, [pose(rest, { ...BEAT_IN, opacity: 0 }), pose(rest)], SHOWN,
        { duration: ms(BEAT_IN_MS), delay: delays[i], easing: ease("out") });
      if (b.classList.contains("panel-header") || b.classList.contains("lucky-credit")) drawRules(b, delays[i]);
      if (b.classList.contains("h2h-projection")) fillBar(b.querySelector(".prob-bar"), delays[i]);
      if (b.classList.contains("st-share")) fillBar(b.querySelector(".st-bar"), delays[i]);
      if (EDGED.some((c) => b.classList.contains(c))) wipeEdges(b, delays[i]);
    });
  }

  /** A header's hairlines draw outward from its label, once the label is arriving. */
  function drawRules(el, delay) {
    for (const pseudoElement of ["::before", "::after"]) {
      el.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { pseudoElement, duration: ms(RULE_MS), delay: delay + ms(BEAT_IN_MS) * 0.3, easing: ease("out"), fill: "backwards" });
    }
  }

  /** A bar (the projection, a stats card's share) fills from even to its split once its row is arriving. */
  function fillBar(bar, delay) {
    const to = bar ? bar.style.getPropertyValue("--p") : "";
    if (!to) return;
    stopAnims(bar);
    bar.animate([{ "--p": "50%" }, { "--p": to }],
      { duration: ms(BAR_MS), delay: delay + ms(BEAT_IN_MS) * 0.35, easing: ease("out"), fill: "backwards" });
  }

  /** A result pill's W/L edges wipe down once the pill has landed. */
  function wipeEdges(pill, delay) {
    for (const pseudoElement of ["::before", "::after"]) {
      pill.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
        { pseudoElement, duration: ms(EDGE_MS), delay: delay + ms(BEAT_IN_MS) * 0.5, easing: ease("out"), fill: "backwards" });
    }
  }

  /** When each of n beats starts, from the first (tempo-1 ms). */
  function cascadeOffsets(n, { gap, min, max }) {
    const raw = [];
    let t = 0;
    let g = gap;
    for (let i = 0; i < n; i++) {
      raw.push(t);
      t += g;
      g = Math.max(min, g * GAP_DECAY);
    }
    const last = raw.length ? raw[raw.length - 1] : 0;
    const k = last > max ? max / last : 1;
    return raw.map((x) => x * k);
  }

  /**
   * Take beats out, beat i starting at delays[i] (ms, already at tempo), each
   * from wherever it is now. They hold invisible (fill: both) until the
   * caller hides their panel. Returns the animations.
   */
  function beatsOut(beats, delays) {
    return beats.map((b, i) => {
      const from = getComputedStyle(b).opacity;
      stopAnims(b);
      const rest = restOf(b);
      return b.animate([pose(rest, { opacity: from }), pose(rest, { ...BEAT_OUT, opacity: 0 })],
        { duration: ms(BEAT_OUT_MS), delay: delays[i], easing: ease("out"), fill: "both" });
    });
  }

  /** A node's vertical extent, or null where nothing is laid out. */
  function spanOf(el) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return r && r.height > 0 ? { top: r.top, bottom: r.bottom } : null;
  }

  /**
   * When each incoming beat starts, given where the outgoing rows were
   * (outSpans) and when each has gone (outEnds, ms at tempo): a beat waits
   * until every old row it would be drawn over has gone, and the cascade
   * (own: its offsets, ms at tempo) carries on from the first beat's start,
   * never out of reading order. Where anything can't be measured, every
   * beat waits for the whole exit.
   */
  function handoff(beats, own, outSpans, outEnds) {
    const allGone = outEnds.length ? Math.max(...outEnds) : 0;
    const blind = outSpans.some((s) => !s);
    const waits = beats.map((b) => {
      const s = blind ? null : spanOf(b);
      if (!s) return allGone;
      let w = 0;
      outSpans.forEach((o, j) => {
        if (o.top < s.bottom + 4 && o.bottom > s.top - 4) w = Math.max(w, outEnds[j]);
      });
      return w;
    });
    const base = waits.length ? waits[0] : allGone;
    let prev = 0;
    return beats.map((_, i) => (prev = Math.max(prev, base + own[i], waits[i])));
  }

  // ── Rotation ────────────────────────────────────────────────────────────────

  class Rotator {
    constructor() {
      this._slots   = ["logo-primary"];
      this._index   = 0;
      this._timer   = null;
      this._current = null;
      this._run     = 0;   // bumped per transition; a stale one's onDone is dropped
      this._busy    = {};  // panel id → a token while its beats are leaving
      this._pending = {};  // panel id → its newest render, held while the panel's rows are leaving
    }

    buildSlots() {
      const active = PANEL_ORDER.filter(slotHasContent);
      const next = active.length > 0 ? active : ["logo-primary"];
      const changed = next.length !== this._slots.length || next.some((id, i) => id !== this._slots[i]);
      this._slots = next;
      if (!changed || !this._current) return;

      // The visible panel survived: leave it on screen for its full dwell and
      // just re-aim the cursor at whatever follows it now. Restarting here
      // instead flashes the logo — slot 0 — on every stats answer.
      const pos = this._slots.indexOf(this._current);
      if (pos !== -1) {
        this._index = (pos + 1) % this._slots.length;
        return;
      }
      // The visible panel has dropped out. It must not stay on screen, and only
      // a restart guarantees nothing is left stacked underneath it.
      this.restart();
    }

    start() {
      this._advance();
    }

    /**
     * Cancel the pending advance and any transition in flight, force every
     * panel but the visible one hidden, and rotate from the top. The current
     * panel is kept so it still leaves rather than cutting.
     */
    restart() {
      clearTimeout(this._timer);
      this._run++;
      this._hideAllExcept([this._current]);
      this._index = 0;
      this._advance();
    }

    /**
     * Panels are absolutely stacked and only opacity separates them, so a
     * panel abandoned mid-fade would stay visible under the next one. This
     * sets the hidden state outright rather than trusting a fade to finish,
     * and puts its beats back at rest for the next time it shows.
     */
    _hideAllExcept(keep) {
      for (const id of PANEL_ORDER) {
        if (keep.includes(id)) continue;
        const el = this._el(id);
        if (el) this._settleHidden(id, el);
      }
    }

    /** A panel off screen: hidden outright, its beats back at rest, and any render it was holding drawn now. */
    _settleHidden(id, el) {
      delete this._busy[id];
      setStyle(el, HIDDEN);
      beatsOf(el).forEach((b) => setStyle(b, SHOWN));
      this._flush(id);
    }

    /**
     * Draw a panel's new content. Off screen: at once. Leaving: once it's
     * hidden. On screen: `patch` first, if given (true = it updated the rows
     * in place); else between two cascades — the rows leave, the new ones are
     * drawn and come in — so data landing mid-dwell never pops.
     */
    render(id, fn, patch) {
      if (this._busy[id]) { this._pending[id] = fn; return; }
      if (id !== this._current) { delete this._pending[id]; fn(); return; }
      if (patch && patch()) return;

      const el = this._el(id);
      const token = this._busy[id] = {};
      this._pending[id] = fn;
      const beats = beatsOf(el);
      const anims = beatsOut(beats, cascadeOffsets(beats.length, CASCADE_OUT).map(ms));
      Promise.all(anims.map((a) => a.finished)).then(() => {
        if (this._busy[id] !== token) return; // a transition or restart took it over
        delete this._busy[id];
        this._flush(id);
        const fresh = beatsOf(el);
        beatsIn(fresh, cascadeOffsets(fresh.length, CASCADE_IN).map(ms));
      }, () => {});
    }

    _flush(id) {
      const fn = this._pending[id];
      if (!fn) return;
      delete this._pending[id];
      fn();
    }

    _advance() {
      clearTimeout(this._timer);
      if (HOLD_PANEL) {
        this._transitionTo(HOLD_PANEL, () => {});
        return;
      }
      const id = this._slots[this._index];
      this._index = (this._index + 1) % this._slots.length;
      this._transitionTo(id, () => {
        this._timer = setTimeout(() => this._advance(), PANEL_INTERVAL);
      });
    }

    _el(id) {
      if (id === "logo-primary") return document.querySelector(".logo-primary");
      if (id === "logo-sponsor") return document.querySelector(".logo-sponsor");
      return document.getElementById("panel-" + id);
    }

    _transitionTo(id, onDone) {
      const incoming = this._el(id);
      if (!incoming) { onDone(); return; }
      const outgoing = this._current ? this._el(this._current) : null;
      // A one-slot rotation advancing onto itself: already showing, so no blink.
      if (outgoing === incoming && id === this._current) { onDone(); return; }

      // Nothing but these two may be on screen — so a stray panel can never
      // survive more than one transition.
      this._hideAllExcept([id, this._current]);
      // Drawn while it's still hidden: a render held while it was leaving, and a
      // stats card's next look. One that turns out to have nothing (or couldn't
      // be drawn) never comes on: the panel up stays, and the rotation moves on.
      delete this._busy[id];
      this._flush(id);
      if (BEFORE_SHOW[id]) BEFORE_SHOW[id]();
      if (!HOLD_PANEL && !slotHasContent(id)) { this._skip(); return; }
      const leaving = this._current;
      this._current = id;
      const run = ++this._run;

      // Out: a logo drifts away whole; an info panel stays put while its beats
      // cascade out, top first. outSpans / outEnds: where each outgoing thing
      // was and when it has gone, for the handoff below.
      let outSpans = [];
      let outEnds = [];
      if (outgoing && outgoing !== incoming) {
        const token = this._busy[leaving] = {};
        let anims;
        if (this._isLogo(leaving)) {
          const from = getComputedStyle(outgoing).opacity;
          stopAnims(outgoing);
          const rest = restOf(outgoing);
          anims = [outgoing.animate([pose(rest, { opacity: from }), pose(rest, { ...LOGO_OUT, opacity: 0 })],
            { duration: ms(LOGO_OUT_MS), easing: ease("out"), fill: "forwards" })];
          // The logo stands for the whole card, gone half-way (--ease-out: ~97%).
          outSpans = [{ top: -Infinity, bottom: Infinity }];
          outEnds = [ms(LOGO_OUT_MS) * 0.5];
        } else {
          const beats = beatsOf(outgoing);
          outSpans = beats.map(spanOf); // before anything moves
          const delays = cascadeOffsets(beats.length, CASCADE_OUT).map(ms);
          anims = beatsOut(beats, delays);
          outEnds = delays.map((d) => d + ms(BEAT_OUT_MS));
        }
        // Settled once everything has gone — unless the panel was taken over
        // meanwhile (shown again, or hidden outright by a restart).
        Promise.all(anims.map((a) => a.finished)).then(() => {
          if (this._busy[leaving] === token) this._settleHidden(leaving, outgoing);
        }, () => {});
      }
      const allGone = outEnds.length ? Math.max(...outEnds) : 0;

      // In. A logo arrives whole once everything has gone. An info panel
      // appears at once (it has no surface of its own) and each of its beats
      // takes its place as soon as the old rows there have left.
      const logo = this._isLogo(id);
      let end;
      if (logo) {
        this._surface(false, 0);
        stopAnims(incoming);
        const rest = restOf(incoming);
        tween(incoming, [pose(rest, { ...LOGO_IN, opacity: 0 }), pose(rest)], SHOWN,
          { duration: ms(LOGO_IN_MS), delay: allGone, easing: ease("out") });
        end = allGone + ms(LOGO_IN_MS);
      } else {
        setStyle(incoming, SHOWN);
        const beats = beatsOf(incoming);
        const delays = handoff(beats, cascadeOffsets(beats.length, CASCADE_IN).map(ms), outSpans, outEnds);
        this._surface(true, delays.length ? delays[0] : allGone);
        beatsIn(beats, delays);
        end = (delays.length ? delays[delays.length - 1] : allGone) + ms(BEAT_IN_MS);
      }
      // On a timer, not an animation's promise: a beat cancelled later (a
      // re-render) must never stall the rotation.
      setTimeout(() => { if (run === this._run) onDone(); }, end);
    }

    /** The panel about to come on has nothing: out of the list, and on to the next now. */
    _skip() {
      const run = this._run;
      this.buildSlots(); // may restart the rotation itself (the panel up left the list too)
      if (run === this._run) this._advance();
    }

    _isLogo(id) {
      return Boolean(id) && id.startsWith("logo-");
    }

    /**
     * The panels' shared tint: in under an info panel, out under a logo,
     * left alone between two of the same kind. `delay` lines its fade-in
     * up with the incoming panel.
     */
    _surface(on, delay) {
      const el = document.querySelector(".panel-surface");
      if (!el || el.__on === on) return;
      el.__on = on;
      const from = getComputedStyle(el).opacity;
      const to = on ? "1" : "0";
      stopAnims(el);
      tween(el, [{ opacity: from }, { opacity: to }], { opacity: to },
        { duration: ms(on ? SURFACE_IN_MS : SURFACE_OUT_MS), delay: on ? delay : 0, easing: ease("out") });
    }
  }

  const rotator = new Rotator();

  // ── Rendering ───────────────────────────────────────────────────────────────

  function ordinalSuffix(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }

  function placementEl(placement, entrants) {
    const span = h("span", "pill-placement");
    span.appendChild(document.createTextNode(String(placement)));
    span.appendChild(h("sup", "ordinal-sup", ordinalSuffix(placement)));
    if (entrants) span.appendChild(document.createTextNode("/" + entrants));
    return span;
  }

  function formatDate(seconds) {
    const d = new Date(seconds * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${String(d.getFullYear()).slice(-2)}`;
  }

  const pill = (extra) => h("div", "panel-pill" + (extra ? " " + extra : ""));

  /** Show a list and its header only when it has rows. */
  function showList(list, on) {
    list.style.display = on ? "" : "none";
    if (list.previousElementSibling) list.previousElementSibling.style.display = on ? "" : "none";
  }

  function renderPlayerCard(i) {
    const panel = document.getElementById(`panel-player-${i + 1}`);
    const p = playerOf(i);
    if (!panel || !p) return;

    const tagEl = panel.querySelector(".player-tag");
    tagEl.replaceChildren();
    if (p.prefix) tagEl.appendChild(h("span", "player-sponsor", p.prefix + " "));
    tagEl.appendChild(document.createTextNode(p.tag || ""));
    const charEl = panel.querySelector(".player-char-name");
    charEl.textContent = (p.character?.name ?? "").toUpperCase();

    // luckystats.gg: the Lucky Rank under the character (behind their clover,
    // in CSS), and Class and Region in a box right of the tag. Anything it
    // doesn't have takes no room: no rank line, no row, no box, no credit.
    // Drawn before the tag and character are fitted, since the box narrows them.
    const lucky = luckyLine(i);
    panel.querySelector(".lucky-credit").style.display = lucky ? "" : "none";
    const rankEl = panel.querySelector(".player-rank");
    rankEl.replaceChildren();
    rankEl.style.display = lucky?.rank ? "" : "none";
    if (lucky?.rank) rankEl.appendChild(h("span", "lucky-rank", "#" + lucky.rank));

    const box = panel.querySelector(".player-lucky");
    box.replaceChildren();
    const rows = [
      lucky?.className && { kind: "class", label: "Class", value: lucky.className, icon: lucky.badge },
      lucky?.region && { kind: "region", label: "Region", value: lucky.region, icon: lucky.regionIcon, place: lucky.regionRank },
    ].filter(Boolean);
    box.style.display = rows.length ? "" : "none";
    const values = [];
    for (const r of rows) {
      const row = box.appendChild(h("div", "lucky-row " + r.kind));
      row.appendChild(luckyIcon(r.icon, r.kind));
      const text = row.appendChild(h("div", "lucky-text"));
      text.appendChild(h("div", "lucky-label", r.label));
      const line = text.appendChild(h("div", "lucky-line"));
      values.push(line.appendChild(h("span", "lucky-value", r.value)));
      if (r.place) line.appendChild(h("span", "lucky-place", "#" + r.place));
    }
    for (const v of values) fitText(v, 11);
    fitText(tagEl, 20);
    fitText(charEl, 12);

    // Rows are fitted together once the card is complete — see fitGroup.
    const fit = { opp: [], round: [], hist: [] };
    const runList = panel.querySelector(".run-list");
    const run = runView(i).slice(0, 5);
    runList.replaceChildren();
    showList(runList, run.length > 0);
    for (const s of run) {
      const row = pill(s.won ? "win" : "loss");
      const opp = h("span", "pill-name", s.opponent || "");
      const round = h("span", "pill-round", s.round || "");
      const [mine, theirs] = scoreLabels([s.myScore, s.oppScore], s.won ? 0 : 1);
      row.append(opp, round, h("span", "pill-run-score", `${mine}–${theirs}`));
      runList.appendChild(row);
      fit.opp.push(opp);
      fit.round.push(round);
    }

    const histList = panel.querySelector(".history-list");
    const history = historyView(i).slice(0, 5);
    histList.replaceChildren();
    showList(histList, history.length > 0);
    for (const r of history) {
      const row = pill();
      const name = h("span", "pill-name", r.tournament || r.event || "");
      row.append(name, r.placement ? placementEl(r.placement, r.entrants) : h("span", "pill-placement"));
      histList.appendChild(row);
      fit.hist.push(name);
    }
    fitGroup(fit.opp, 12);
    fitGroup(fit.round, 10);
    fitGroup(fit.hist, 12);
  }

  const pct = (p) => `${(p * 100).toFixed(1)}%`;

  /**
   * A class badge or Region artwork, in its slot. Missing, or failing to load,
   * the slot is marked .none — empty for a class, a pin for a Region (CSS) —
   * so a source never shows a broken image.
   */
  function luckyIcon(src, kind) {
    const slot = h("i", `lucky-icon ${kind}`);
    if (!src) {
      slot.classList.add("none");
      return slot;
    }
    const img = slot.appendChild(h("img"));
    img.alt = "";
    img.addEventListener("error", () => {
      img.remove();
      slot.classList.add("none");
    });
    img.src = src;
    return slot;
  }

  /**
   * Each player's chance either side of the bar (its colours meet at the left
   * player's), and their Elo under it, level with the bar's caption.
   */
  function projectionRow(prob, elo) {
    const bar = h("div", "prob-bar");
    bar.style.setProperty("--p", pct(prob[0]));
    bar.appendChild(h("i", "prob-marker"));
    // The number and its sign apart: a pack's score font may draw "%" large.
    const side = (p, cls) => {
      const el = h("span", cls, pct(p).slice(0, -1));
      el.appendChild(h("span", "prob-pct-sign", "%"));
      return el;
    };
    const rating = (r, cls) => {
      const el = h("div", cls);
      if (r != null) el.append(h("span", "prob-elo-val", String(r)), h("span", "prob-elo-label", "Elo"));
      return el;
    };
    const row = h("div", "h2h-projection");
    row.append(
      side(prob[0], "prob-pct"), bar, side(prob[1], "prob-pct right"),
      rating(elo?.[0], "prob-elo"), h("div", "h2h-subtitle", "Win Projection"), rating(elo?.[1], "prob-elo right"));
    return row;
  }

  function renderRecentSets() {
    const panel = document.getElementById("panel-recent-sets");
    const list = panel?.querySelector(".sets-list");
    if (!list) return;
    list.replaceChildren();
    const v = h2hCardView();
    panel.querySelector(".lucky-credit").style.display = v?.prob ? "" : "none";
    if (!v) return;
    const h2h = v.record;

    // The tally is the whole record; the pills below are its newest few.
    const head = h("div", "h2h-header");
    const row = h("div", "h2h-row");
    const left = h("div", "h2h-name", playerOf(0)?.tag || "P1");
    const right = h("div", "h2h-name right", playerOf(1)?.tag || "P2");
    const mid = h("div", "h2h-mid");
    mid.append(h("div", "h2h-subtitle", "Head to Head"), h("span", "h2h-score", `${h2h.wins[0]} – ${h2h.wins[1]}`));
    row.append(left, mid, right);
    head.appendChild(row);
    if (v.prob) head.appendChild(projectionRow(v.prob, v.elo));
    list.appendChild(head);

    const subs = [], rounds = [];
    for (const s of h2h.sets.slice(0, H2H_SHOWN)) {
      const sc = scoreLabels(s.score, s.winner);
      const sub = (s.tournament || "") + (s.timestamp ? " · " + formatDate(s.timestamp) : "");
      const row2 = pill("recent-set-pill " + (s.winner === 0 ? "win" : "loss"));
      const info = h("div", "recent-set-info");
      const subEl = sub ? info.appendChild(h("div", "pill-line-2", sub)) : null;
      const roundEl = s.round ? info.appendChild(h("div", "pill-round recent-set-round", s.round)) : null;
      row2.append(h("span", "pill-score-val", sc[0]), info, h("span", "pill-score-val recent-score-right", sc[1]));
      list.appendChild(row2);
      subs.push(subEl);
      rounds.push(roundEl);
    }
    fitGroup([left, right], 16);
    fitGroup(subs, 9);
    fitGroup(rounds, 10);
  }

  function renderCompletedSets() {
    const list = document.querySelector("#panel-completed-sets .completed-list");
    if (!list) return;
    list.replaceChildren();
    const names = [], rounds = [];
    for (const s of completedView()) {
      const sc = scoreLabels(s.scores, s.winner);
      const row = pill("completed-set-pill " + (s.winner === 0 ? "p1win" : "p2win"));
      const a = h("span", "pill-name", s.names?.[0] || "");
      const info = h("div", "completed-set-info");
      if (s.round) rounds.push(info.appendChild(h("div", "pill-line-2", s.round)));
      info.appendChild(h("span", "set-score", `${sc[0]}–${sc[1]}`));
      const b = h("span", "pill-name right", s.names?.[1] || "");
      row.append(a, info, b);
      list.appendChild(row);
      names.push(a, b);
    }
    fitGroup(names, 12);
    fitGroup(rounds, 9);
  }

  /** A roster row's character icon; with none, or one that fails to load, the slot stays empty. */
  function crewIcon(character) {
    const slot = h("i", "crew-icon");
    const src = icon(character);
    if (!src) return slot;
    const img = slot.appendChild(h("img"));
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    img.src = src;
    return slot;
  }

  /** A count that turns like the scoreboard's score (a new element's first draw is instant). */
  const rollNum = (el, n) => reel(el, n, (v) => [v]);

  /** A crew's card: its name and stocks left, then a row per member in roster order. */
  function renderCrew(i) {
    const panel = document.getElementById(`panel-crew-${i + 1}`);
    const team = crewView(i);
    if (!panel || !team) return;
    const name = panel.querySelector(".crew-name");
    draw(name, team.name, (node) => { node.textContent = team.name; });
    rollNum(panel.querySelector(".crew-total-num"), team.total);

    const list = panel.querySelector(".crew-list");
    list.replaceChildren();
    const tags = [];
    for (const m of team.members) {
      const row = pill("crew-member " + m.status);
      row.dataset.memberId = String(m.id);
      row.dataset.icon = icon(m.icon) || "";
      const tag = h("span", "pill-name");
      draw(tag, m.tag, (node) => { node.textContent = m.tag; });
      const stocks = h("span", "crew-stocks");
      row.append(crewIcon(m.icon), tag, stocks);
      rollNum(stocks, m.stocks);
      list.appendChild(row);
      tags.push(tag);
    }
    fitText(name, 20);
    fitGroup(tags, 14);
  }

  /**
   * The same members in the same order, wearing the same icons: update the
   * card in place — a stock lost rolls its number instead of rebuilding
   * (and re-cascading) the roster. False when the roster itself changed.
   */
  function patchCrew(i) {
    const panel = document.getElementById(`panel-crew-${i + 1}`);
    const team = crewView(i);
    const list = panel?.querySelector(".crew-list");
    if (!list || !team) return false;
    const rows = elementsOf(list);
    const same = rows.length === team.members.length && team.members.every((m, k) =>
      rows[k].dataset.memberId === String(m.id) && rows[k].dataset.icon === (icon(m.icon) || ""));
    if (!same) return false;

    const name = panel.querySelector(".crew-name");
    swap(name, team.name, (node) => { node.textContent = team.name; fitText(node, 20); });
    rollNum(panel.querySelector(".crew-total-num"), team.total);
    const tags = [];
    team.members.forEach((m, k) => {
      const row = rows[k];
      for (const s of ["active", "in", "out"]) row.classList.toggle(s, s === m.status);
      const tag = row.querySelector(".pill-name");
      swap(tag, m.tag, (node) => { node.textContent = m.tag; fitGroup(tags, 14); });
      tags.push(tag);
      rollNum(row.querySelector(".crew-stocks"), m.stocks);
    });
    fitGroup(tags, 14);
    return true;
  }

  // ── Stats cards ─────────────────────────────────────────────────────────────
  //
  // The stats popup's numbers, made for the card. Last Game has three looks
  // that take turns, the next one each time the card comes on screen:
  //   story  the summary, two callouts, the game's facts, three stats
  //   reel   the callouts one at a time, share bars, the facts
  //   box    four callouts, a ledger, the summary in a line, the facts
  // Set Recap is the set's ledger (each player's line across the games), its
  // summary, two callouts and its facts.
  //
  // Each showing also starts further down the callouts and summaries, so a
  // game shown four times reads four ways; a new game starts from the best
  // again. No names, characters or score — the scoreboard has them: left and
  // right are its columns, and a callout says whose it is.

  const GAME_LOOKS = ["story", "reel", "box"];
  const PIN_LOOK   = GAME_LOOKS.includes(param("look")) ? param("look") : null;
  const REEL_MS    = 5000;   // a dwell: each callout on the reel

  /** Per card: showings so far, the look, and where in the callouts and summaries this showing starts. */
  const shows = {
    "last-game": { n: 0, look: PIN_LOOK || GAME_LOOKS[0], key: null, from: 0, used: 0, story: 0 },
    "set-recap": { n: 0, key: null, from: 0, used: 0, story: 0 },
  };

  /** Called by the rotator as a panel comes on screen, while it's still hidden. */
  const BEFORE_SHOW = {
    "last-game": () => drawSafely("last-game", () => nextShowing("last-game")),
    "set-recap": () => drawSafely("set-recap", () => nextShowing("set-recap")),
  };

  function nextShowing(id) {
    const s = shows[id];
    const v = statsView(id === "last-game" ? "game" : "set");
    if (!v) return;
    const key = `${v.key}|${v.counted}`;
    if (s.key === key) { s.from += s.used; s.story++; }
    else { s.key = key; s.from = 0; s.story = 0; }
    s.n++;
    if (id === "last-game") {
      s.look = PIN_LOOK || GAME_LOOKS[(s.n - 1) % GAME_LOOKS.length];
      renderGameCard();
    } else {
      renderSetRecap();
    }
  }

  /** Up to n of the callouts, from where this showing starts (wrapping); remembers how many it took. */
  function take(list, s, n) {
    const k = Math.min(n, list.length);
    s.used = k;
    const from = list.length ? s.from % list.length : 0;
    return Array.from({ length: k }, (_, i) => list[(from + i) % list.length]);
  }
  const storyOf = (v, s) => (v.stories.length ? v.stories[s.story % v.stories.length] : null);

  /** The keys a card asks for that the set has, topped up from the rest. */
  const FALLBACK_KEYS = ["neutral", "opk", "dpo", "damage", "kills", "punish", "counter", "combo", "earliest", "lcancel", "avgkill", "ipm"];
  function keysFor(v, prefer) {
    const out = prefer.filter((k) => v.rows[k] && v.stats[k]);
    for (const k of FALLBACK_KEYS) if (out.length < prefer.length && v.rows[k] && v.stats[k] && !out.includes(k)) out.push(k);
    return out;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const sideCls = (side) => (side === 0 ? " lead-l" : side === 1 ? " lead-r" : "");
  const fixed = (v, dp) => Number(v).toFixed(dp);
  /** A stat's number at the game's (0) or the set's (1) decimals, "–" when there isn't one. */
  const statText = (st, v, set) => (v == null ? "–" : fixed(v, st.dp[set]));
  const withPct = (st, v, set) => statText(st, v, set) + (v != null && st.unit === "%" ? "%" : "");
  const SET_WORD = { avg: "Set avg", max: "Set best", min: "Set best", sum: "Set total" };

  /** A number with its unit small beside it. */
  function numEl(cls, value, unit) {
    const el = h("div", cls, value == null ? "–" : String(value));
    if (unit && value != null) el.appendChild(h("span", "st-unit", unit));
    return el;
  }
  const statEl = (st, v, set, cls) => numEl(cls, v == null ? null : statText(st, v, set), st.unit);

  /** A sentence from segments ({ t } plain, { em } lit) — never parsed as markup. */
  function sentence(cls, segs) {
    const el = h("div", cls);
    for (const s of segs || []) el.appendChild(s.em != null ? h("em", null, String(s.em)) : document.createTextNode(String(s.t ?? "")));
    return el;
  }

  function titleBeats(panel, v) {
    const set = v.mode === "set";
    const format = v.bestOf ? `Best of ${v.bestOf}` : (v.format && v.format !== "None" ? v.format : "");
    const sub = [v.round, set ? plural(v.total, "game") : format].filter(Boolean).join(" · ");
    panel.appendChild(h("div", "st-name", set ? (v.over ? "Set Complete" : "The Set So Far") : `Game ${v.last.n}`));
    if (sub) panel.appendChild(h("div", "panel-header st-sub", sub));
  }

  const storyLabel = (v) => (v.mode === "set" ? `The set · ${plural(v.total, "game")}` : `The story of game ${v.last.n}`);
  function storyCard(v, segs) {
    const box = h("div", "st-story");
    box.append(h("div", "st-tag", storyLabel(v)), sentence("st-say", segs));
    return box;
  }

  /** A callout: its title, number and line, and whose it is — edged on that player's side. */
  function calloutBox(x, extra) {
    const box = h("div", `st-box${sideCls(x.side)}${extra ? " " + extra : ""}`);
    box.append(h("div", "st-tag", x.tag), numEl("st-big", x.big, x.unit), h("div", "st-txt", x.text));
    if (x.who) box.appendChild(h("div", "st-who", x.who));
    return box;
  }
  function grid(items, extra) {
    const g = h("div", "st-grid beat-group" + (extra ? " " + extra : ""));
    items.forEach((x) => g.appendChild(x));
    return g;
  }

  /** The stage's picture, when a stage set is installed (the dock's Setup → Art packs). */
  function stagePic(game) {
    const pics = game?.stage?.pics;
    return pics ? Object.values(pics).find(Boolean) ?? null : null;
  }

  /** The facts in a strip — for the last game, after its stage's picture. */
  function factsRow(v, n) {
    const pic = v.mode === "game" ? stagePic(v.last) : null;
    const row = h("div", "st-facts" + (pic ? " with-pic" : ""));
    if (pic) row.appendChild(h("i", "st-thumb")).style.backgroundImage = `url("${pic}")`;
    for (const f of v.facts.slice(0, n)) {
      const cell = row.appendChild(h("div", "st-fact" + (String(f.val).length > 11 ? " long" : "")));
      cell.append(h("div", "st-fact-lab", f.lab), h("div", "st-fact-val", f.val));
    }
    return row;
  }

  /** One stat: the game's numbers either side, the label and the set's between. */
  function statPill(v, key) {
    const st = v.stats[key], r = v.rows[key], lead = r.lead.g;
    const pill = h("div", `panel-pill st-pill${sideCls(lead)}`);
    const mid = h("div", "st-k");
    mid.appendChild(h("div", "st-lab", st.label));
    const sub = v.counted >= 2 ? `${SET_WORD[st.agg] || "Set"} ${withPct(st, r.s[0], 1)} – ${withPct(st, r.s[1], 1)}` : (st.hint || "");
    if (sub) mid.appendChild(h("div", "st-set", sub));
    pill.append(statEl(st, r.g[0], 0, "st-v" + (lead === 1 ? " trail" : "")), mid, statEl(st, r.g[1], 0, "st-v r" + (lead === 0 ? " trail" : "")));
    return pill;
  }

  /** One stat as a share: the numbers either side, and a bar split by how much of it each had. */
  function sharePill(v, key) {
    const st = v.stats[key], r = v.rows[key], lead = r.lead.g;
    const pill = h("div", `panel-pill st-share${sideCls(lead)}`);
    const row = pill.appendChild(h("div", "st-share-row"));
    row.append(statEl(st, r.g[0], 0, "st-v" + (lead === 1 ? " trail" : "")), h("div", "st-lab", st.label), statEl(st, r.g[1], 0, "st-v r" + (lead === 0 ? " trail" : "")));
    const [a, b] = r.g.map((x) => Math.max(0, Number(x) || 0));
    let p = a + b > 0 ? a / (a + b) : 0.5;
    if (st.better === "lo" && a + b > 0) p = 1 - p; // fewer is better: the bar is who did better
    pill.appendChild(h("div", "st-bar")).style.setProperty("--p", `${(p * 100).toFixed(1)}%`);
    return pill;
  }

  const SVG = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, String(val));
    return el;
  }

  /** A player's line across the set's games, their best game marked. */
  function spark(r, side, st, W = 66, H = 22) {
    const vals = r.pg?.[side] ?? [];
    const all = (r.pg ?? []).flat().filter((n) => n != null);
    const mine = vals.filter((n) => n != null);
    if (!all.length || !mine.length) return h("div", "st-small", "–");
    const lo = Math.min(...all), hi = Math.max(...all);
    const x = (i) => 3 + i * ((W - 6) / Math.max(1, vals.length - 1));
    const y = (n) => H - 3 - (hi === lo ? 0.5 : (n - lo) / (hi - lo)) * (H - 6);
    const best = st.better === "lo" ? Math.min(...mine) : Math.max(...mine);
    const svg = svgEl("svg", { class: "st-spark", width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    svg.appendChild(svgEl("polyline", { points: vals.map((n, i) => (n == null ? null : `${x(i).toFixed(1)},${y(n).toFixed(1)}`)).filter(Boolean).join(" ") }));
    vals.forEach((n, i) => { if (n != null) svg.appendChild(svgEl("circle", { cx: x(i).toFixed(1), cy: y(n).toFixed(1), r: n === best ? 2.8 : 1.8, class: n === best ? "hi" : "" })); });
    const wrap = h("div", "st-small");
    wrap.appendChild(svg);
    return wrap;
  }

  /**
   * A ledger: a caption, then a row per stat — the big number on the outside,
   * the small one inside, the label between. After a game: the game big and
   * the set small. The recap: the set big and each player's line small.
   */
  function ledger(v, keys, extra) {
    const set = v.mode === "set";
    const t = h("div", "st-ledger beat-group" + (extra ? " " + extra : ""));
    const big = set ? "Set" : `Game ${v.last.n}`;
    const small = set ? "By game" : (v.counted >= 2 ? "Set" : "");
    const cap = t.appendChild(h("div", "st-row st-cap"));
    cap.append(h("div", "st-c l", big), h("div", "st-c", small), h("div"), h("div", "st-c", small), h("div", "st-c r", big));
    for (const key of keys) {
      const st = v.stats[key], r = v.rows[key];
      const lead = set ? r.lead.s : r.lead.g;
      const bigEl = (s) => statEl(st, set ? r.s[s] : r.g[s], set ? 1 : 0, `st-v ${s ? "r" : "l"}${lead === 1 - s ? " trail" : ""}`);
      const smallEl = (s) => (set ? spark(r, s, st) : h("div", "st-small", v.counted >= 2 ? withPct(st, r.s[s], 1) : ""));
      const row = t.appendChild(h("div", "st-row"));
      row.append(bigEl(0), smallEl(0), h("div", "st-lab", st.label), smallEl(1), bigEl(1));
    }
    return t;
  }

  // The reel: one callout at a time, turning every REEL_MS while the card is
  // on screen (a timer that stops itself once it isn't).
  const reelRun = { timer: null };
  function stopReel() { clearTimeout(reelRun.timer); reelRun.timer = null; }
  function fillReelItem(node, x) {
    node.className = "st-reel-item" + sideCls(x.side);
    node.replaceChildren(numEl("st-big", x.big, x.unit));
    const col = node.appendChild(h("div", "st-reel-text"));
    col.append(h("div", "st-tag", x.tag), h("div", "st-txt", x.text));
    if (x.who) col.appendChild(h("div", "st-who", x.who));
    fitText(node.querySelector(".st-big"), 30);
  }
  function reelBox(ins) {
    const box = h("div", "st-reel");
    box.__items = ins;
    draw(box.appendChild(h("div", "st-reel-item")), `${ins[0].id}|0`, (node) => fillReelItem(node, ins[0]));
    const dots = box.appendChild(h("div", "st-dots"));
    ins.forEach((_, i) => dots.appendChild(h("i", i === 0 ? "on" : null)));
    return box;
  }
  function startReel() {
    stopReel();
    let i = 0;
    const step = () => {
      reelRun.timer = null;
      const box = document.querySelector("#panel-last-game .st-reel");
      const items = box?.__items;
      if (rotator._current !== "last-game" || !items || items.length < 2) return;
      i = (i + 1) % items.length;
      const x = items[i];
      swap(box.querySelector(".st-reel-item"), `${x.id}|${i}`, (node) => fillReelItem(node, x));
      elementsOf(box.querySelector(".st-dots")).forEach((d, k) => d.classList.toggle("on", k === i));
      reelRun.timer = setTimeout(step, REEL_MS);
    };
    reelRun.timer = setTimeout(step, REEL_MS);
  }

  const LOOKS = {
    story(panel, v, s) {
      titleBeats(panel, v);
      const story = storyOf(v, s);
      if (story) panel.appendChild(storyCard(v, story));
      const ins = take(v.ins, s, 2);
      if (ins.length) panel.appendChild(grid(ins.map((x) => calloutBox(x))));
      panel.appendChild(factsRow(v, 3));
      for (const key of keysFor(v, ["opk", "neutral", "punish"])) panel.appendChild(statPill(v, key));
    },
    reel(panel, v, s) {
      titleBeats(panel, v);
      const ins = take(v.ins, s, 4);
      if (ins.length) panel.appendChild(reelBox(ins));
      for (const key of keysFor(v, ["neutral", "damage", "counter", "dpo"])) panel.appendChild(sharePill(v, key));
      panel.appendChild(factsRow(v, 3));
    },
    box(panel, v, s) {
      titleBeats(panel, v);
      const ins = take(v.ins, s, 4);
      if (ins.length) panel.appendChild(grid(ins.map((x) => calloutBox(x, "small"))));
      panel.appendChild(ledger(v, keysFor(v, ["kills", "opk", "neutral", "punish"])));
      const story = storyOf(v, s);
      if (story) panel.appendChild(sentence("st-line", story));
      panel.appendChild(factsRow(v, 3));
    },
  };

  /** Shrink a sentence in a box of fixed height until it fits (to 62% of its size). */
  function fitBlock(el) {
    el.style.fontSize = "";
    const base = parseFloat(getComputedStyle(el).fontSize) || 16;
    const floor = base * 0.62;
    let size = base;
    for (let i = 0; i < 12 && el.scrollHeight > el.clientHeight + 1 && size > floor; i++) {
      size = Math.max(floor, size * 0.92);
      el.style.fontSize = `${size.toFixed(1)}px`;
    }
  }
  const each = (panel, sel, fn) => panel.querySelectorAll(sel).forEach(fn);
  function fitCard(panel) {
    for (const sel of [".st-say", ".st-line", ".st-txt"]) each(panel, sel, fitBlock);
    each(panel, ".st-name", (n) => fitText(n, 24));
    for (const sel of [".st-tag", ".st-who", ".st-lab", ".st-set", ".st-sub"]) each(panel, sel, (n) => fitText(n, 9));
    for (const sel of [".st-big", ".st-v"]) each(panel, sel, (n) => fitText(n, 18));
    each(panel, ".st-fact-val", (n) => fitText(n, 12));
  }

  function renderGameCard() {
    const panel = document.getElementById("panel-last-game");
    if (!panel) return;
    stopReel();
    const s = shows["last-game"];
    const v = statsView("game");
    panel.className = `info-panel stats-panel look-${s.look}`;
    panel.dataset.look = s.look;
    panel.replaceChildren();
    if (!v) return;
    LOOKS[s.look](panel, v, s);
    fitCard(panel);
    if (s.look === "reel") startReel();
  }

  function renderSetRecap() {
    const panel = document.getElementById("panel-set-recap");
    if (!panel) return;
    const s = shows["set-recap"];
    const v = statsView("set");
    panel.replaceChildren();
    if (!v) return;
    titleBeats(panel, v);
    panel.appendChild(ledger(v, keysFor(v, ["kills", "neutral", "opk", "dpo", "punish"]), "recap"));
    const story = storyOf(v, s);
    if (story) panel.appendChild(storyCard(v, story));
    const ins = take(v.ins, s, 2);
    if (ins.length) panel.appendChild(grid(ins.map((x) => calloutBox(x))));
    panel.appendChild(factsRow(v, 4));
    fitCard(panel);
  }

  // Each panel remembers the slice it last drew and skips the rebuild when
  // that slice is unchanged — a score bump must not re-cascade the visible
  // panel, nor re-run fitText's measuring. A change goes through the rotator,
  // which draws it at once off screen and between two cascades on screen.
  const lastRendered = {};
  function renderIfChanged(key, slice, render, patch) {
    const json = JSON.stringify(slice === undefined ? null : slice);
    if (lastRendered[key] === json) return;
    lastRendered[key] = json;
    rotator.render(key, render, patch);
  }

  const identity = (i) => {
    const p = playerOf(i);
    return p && [p.tag, p.prefix, p.character?.name ?? null];
  };

  /**
   * Draw a panel, or — if drawing it throws — empty it and take it out of the
   * rotation (`broken`) until its data changes. Whenever the draw runs (now,
   * or held until the panel has left), the rotation hears about it.
   */
  function drawSafely(id, render) {
    try {
      render();
      delete broken[id];
    } catch (err) {
      broken[id] = true;
      console.error(`[side-panel] ${id} couldn't be drawn — out of the rotation until its data changes`, err);
      if (id === "last-game") stopReel();
      try { rotator._el(id)?.replaceChildren(); } catch (_) { /* nothing more to clear */ }
      setTimeout(() => rotator.buildSlots(), 0);
    }
  }

  /** Each panel: the slice of the state it draws, how to draw it, and (the crews) how to patch it in place. */
  const FEEDS = [
    ["player-1", () => [identity(0), historyView(0), runView(0), luckyLine(0)], () => renderPlayerCard(0)],
    ["player-2", () => [identity(1), historyView(1), runView(1), luckyLine(1)], () => renderPlayerCard(1)],
    ["recent-sets", () => [h2hCardView(), identity(0), identity(1)], renderRecentSets],
    ["completed-sets", completedView, renderCompletedSets],
    ["crew-1", () => crewView(0), () => renderCrew(0), () => patchCrew(0)],
    ["crew-2", () => crewView(1), () => renderCrew(1), () => patchCrew(1)],
    ["last-game", () => statsView("game"), renderGameCard],
    ["set-recap", () => statsView("set"), renderSetRecap],
  ];

  /** Every panel on its own: one whose data can't be read is out of the rotation, and the rest still update. */
  function refresh() {
    for (const [id, slice, render, patch] of FEEDS) {
      try {
        const safePatch = patch && (() => { try { return patch(); } catch (_) { return false; } });
        renderIfChanged(id, slice(), () => drawSafely(id, render), safePatch);
      } catch (err) {
        broken[id] = true;
        delete lastRendered[id]; // drawn again once it can be read
        console.error(`[side-panel] ${id}: couldn't read its data — out of the rotation`, err);
      }
    }
    // After rendering: buildSlots can restart the rotation, and the panel it
    // fades in should already hold the new content.
    rotator.buildSlots();
  }

  function setTournamentName(name) {
    const text = String(name ?? "").trim();
    swap(document.querySelector(".tournament-name"), text, (node) => {
      node.textContent = text;
      fitText(node, 16);
    });
  }

  // ── Clip-saved toast ────────────────────────────────────────────────────────
  //
  // Springs up over the bottom card's bottom edge and into focus, its record
  // dot pulsing; holds; then sinks back and blurs away. Queued rather than
  // concurrent — restarting a visible pill reads as a flicker — and only the
  // newest waiting clip is kept.

  const TOAST_IN = 520, TOAST_HOLD = 3200, TOAST_OUT = 300;
  const toast = { busy: false, pending: null };

  function showClipToast(clip) {
    const el = document.querySelector(".clip-toast");
    if (!el) return;
    if (toast.busy) { toast.pending = clip; return; }
    toast.busy = true;

    const detail = el.querySelector(".clip-toast-detail");
    const bits = [];
    if (clip?.playerName) bits.push(clip.playerName);
    if (clip?.moveCount) bits.push(`${clip.moveCount} moves, ${Math.round(clip.damage ?? 0)}%`);
    detail.textContent = bits.join(" · ");
    fitText(detail, 12);

    // Every keyframe repeats the -50% X so the centring holds throughout.
    const at = (y, scale, blur, opacity) =>
      ({ transform: `translate(-50%, ${y}%) scale(${scale})`, filter: `blur(${blur}px)`, opacity });
    const tIn = ms(TOAST_IN), tOut = ms(TOAST_OUT); // the hold is a dwell, unscaled
    const total = tIn + TOAST_HOLD + tOut;
    const shown = at(0, 1, 0, 1);
    const anim = el.animate([
      { ...at(160, 0.9, 6, 0), offset: 0, easing: ease("spring") },
      { ...shown, offset: tIn / total },
      { ...shown, offset: (tIn + TOAST_HOLD) / total, easing: ease("out") },
      { ...at(40, 0.96, 6, 0), offset: 1 },
    ], { duration: total });

    const dot = el.querySelector(".clip-toast-icon");
    if (dot?.animate) {
      dot.animate([
        { transform: "scale(1)", opacity: 1 },
        { transform: "scale(1.45)", opacity: 0.5 },
        { transform: "scale(1)", opacity: 1 },
      ], { duration: ms(900), delay: tIn * 0.6, iterations: 2, easing: "ease-in-out" });
    }
    const done = () => {
      toast.busy = false;
      const next = toast.pending;
      toast.pending = null;
      if (next) showClipToast(next);
    };
    anim.finished.then(done, done);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  const ov = Overlay.connect({ tag: "side-panel" });
  ov.select("scoreboard", (s) => { sb = s; refresh(); });
  ov.select("tournament", (t) => setTournamentName(t?.name));
  ov.on("stats", (snap) => { stats = snap; refresh(); });
  ov.select("setStats", (d) => { setStats = d; refresh(); });
  ov.select("statsShot", (s) => { statsShot = s; refresh(); });
  ov.on("clip:saved", showClipToast);
  ov.ready.then(() => rotator.start());

  // For tests/side-panel.test.js, and for poking at from OBS's devtools.
  root.SidePanel = {
    rotator, historyView, runView, h2hView, completedView, luckyPlayer, projectionView, crewView, slotHasContent, scoreLabels, cascadeOffsets,
    statsView, shows, GAME_LOOKS,
  };
})(window);
