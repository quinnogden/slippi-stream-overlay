/**
 * side-panel.js — the 611 × 1080 panel beside the webcam.
 *
 * The header card carries the tournament name; the bottom card rotates
 * through the logos, both players' cards, their head-to-head and the event's
 * just-finished sets, skipping any slot with nothing to show.
 *
 * Everything comes from the app: the scoreboard and tournament sections of
 * the state, and the `stats` event (lib/stats/ — start.gg histories fetched
 * by the app, keyed by start.gg player id). There is no second source to fall
 * back to: a pair the stats haven't finished shows no card rather than
 * someone else's numbers.
 *
 *   ?panel=<id>     hold one panel instead of rotating (for styling)
 *   ?animate=false  still the theme pack's background flair
 *
 * tests/side-panel.test.js runs this file against the real store, channel
 * mirror and overlay client.
 */
(function (root) {
  "use strict";

  const { h, fitText, fitGroup, param } = Overlay;

  const PANEL_INTERVAL = 20000;   // ms per slot, logos included
  const FADE_MS        = 700;     // panel crossfade
  const PILL_MS        = 550;     // each pill's drop-in
  const PILL_DELAY     = 150;     // after the panel starts fading in
  const PILL_STAGGER   = 100;     // between pills
  const PILL_DROP      = 40;      // px
  const HOLD_PANEL     = param("panel");

  const PANEL_ORDER = [
    "logo-primary",
    "player-1", "player-2", "recent-sets",
    "logo-sponsor", "completed-sets",
  ];

  const HIDDEN = { opacity: "0", transform: "scale(0.97)" };
  const SHOWN  = { opacity: "1", transform: "scale(1)" };

  let sb = null;     // state.scoreboard
  let stats = null;  // the last `stats` event

  // ── Views ───────────────────────────────────────────────────────────────────
  //
  // Each panel reads a view — display-ready rows — so the renderers, the slot
  // predicates and the change detection all agree on what "has content" means.
  // Columns are sides[0] (left) and sides[1] (right) as the scoreboard has them
  // now; stats are keyed by start.gg player id and oriented against those
  // columns on every render, so Switch Sides needs nothing from the stats.

  const playerOf = (i) => sb?.sides?.[i]?.players?.[0] ?? null;
  const isDoubles = () => Boolean(sb?.isDoubles);

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

  function hasPlayerCard(i) {
    if (!playerOf(i)?.tag) return false;
    return historyView(i).length > 0 || runView(i).length > 0;
  }

  function slotHasContent(id) {
    switch (id) {
      case "logo-primary":
      case "logo-sponsor":   return true;
      case "player-1":       return !isDoubles() && hasPlayerCard(0);
      case "player-2":       return !isDoubles() && hasPlayerCard(1);
      case "recent-sets":    return !isDoubles() && h2hView() !== null;
      case "completed-sets": return completedView().length > 0;
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
  // Web Animations, committed to inline style when they finish, so nothing is
  // left filling and a panel's resting state is always readable from its style.

  function stopAnims(el) {
    if (el?.getAnimations) el.getAnimations().forEach((a) => a.cancel());
  }

  function tween(el, from, to, { duration, delay = 0, easing = "ease" }) {
    const anim = el.animate([from, to], { duration, delay, easing, fill: "both" });
    anim.finished.then(() => { Object.assign(el.style, to); anim.cancel(); }, () => {});
    return anim;
  }

  function setStyle(el, styles) {
    stopAnims(el);
    Object.assign(el.style, styles);
  }

  // ── Rotation ────────────────────────────────────────────────────────────────

  class Rotator {
    constructor() {
      this._slots   = ["logo-primary"];
      this._index   = 0;
      this._timer   = null;
      this._current = null;
      this._run     = 0;   // bumped per transition; a stale one's onDone is dropped
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
     * panel is kept so it still fades out rather than cutting.
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
     * sets the hidden state outright rather than trusting a fade to finish.
     */
    _hideAllExcept(keep) {
      for (const id of PANEL_ORDER) {
        if (keep.includes(id)) continue;
        const el = this._el(id);
        if (!el) continue;
        el.querySelectorAll(".panel-pill").forEach(stopAnims);
        setStyle(el, HIDDEN);
      }
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
      this._current = id;
      const run = ++this._run;

      let delay = 0;
      if (outgoing && outgoing !== incoming) {
        const from = getComputedStyle(outgoing).opacity;
        stopAnims(outgoing);
        tween(outgoing, { opacity: from, transform: "scale(1)" }, HIDDEN, { duration: FADE_MS, easing: "ease-in" });
        delay = FADE_MS - 100;
      }

      stopAnims(incoming);
      tween(incoming, HIDDEN, SHOWN, { duration: FADE_MS, delay, easing: "ease-out" })
        .finished.then(() => { if (run === this._run) onDone(); }, () => {});

      // The pills fall in top to bottom as the panel appears.
      if (!id.startsWith("logo-")) {
        incoming.querySelectorAll(".panel-pill").forEach((pill, i) => {
          stopAnims(pill);
          tween(pill,
            { opacity: "0", transform: `translateY(-${PILL_DROP}px)` },
            { opacity: "1", transform: "translateY(0)" },
            { duration: PILL_MS, delay: delay + PILL_DELAY + i * PILL_STAGGER, easing: "ease-out" });
        });
      }
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
    fitText(tagEl, 24);
    panel.querySelector(".player-char-name").textContent = (p.character?.name ?? "").toUpperCase();

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
    fitGroup(fit.opp);
    fitGroup(fit.round, 11);
    fitGroup(fit.hist);
  }

  function renderRecentSets() {
    const list = document.querySelector("#panel-recent-sets .sets-list");
    if (!list) return;
    list.replaceChildren();
    const h2h = h2hView();
    if (!h2h) return;

    // The tally is the whole record; the pills below are its newest five.
    const head = h("div", "h2h-header");
    const row = h("div", "h2h-row");
    const left = h("div", "h2h-name", playerOf(0)?.tag || "P1");
    const right = h("div", "h2h-name right", playerOf(1)?.tag || "P2");
    const mid = h("div", "h2h-mid");
    mid.append(h("div", "h2h-subtitle", "Head to Head"), h("span", "h2h-score", `${h2h.wins[0]} – ${h2h.wins[1]}`));
    row.append(left, mid, right);
    head.appendChild(row);
    list.appendChild(head);

    const subs = [], rounds = [];
    for (const s of h2h.sets.slice(0, 5)) {
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
    fitGroup([left, right], 18);
    fitGroup(subs, 11);
    fitGroup(rounds, 11);
  }

  function renderCompletedSets() {
    const list = document.querySelector("#panel-completed-sets .completed-list");
    if (!list) return;
    list.replaceChildren();
    const names = [];
    for (const s of completedView()) {
      const sc = scoreLabels(s.scores, s.winner);
      const row = pill("completed-set-pill " + (s.winner === 0 ? "p1win" : "p2win"));
      const a = h("span", "pill-name", s.names?.[0] || "");
      const info = h("div", "completed-set-info");
      if (s.round) info.appendChild(h("div", "pill-line-2", s.round));
      info.appendChild(h("span", "set-score", `${sc[0]}–${sc[1]}`));
      const b = h("span", "pill-name right", s.names?.[1] || "");
      row.append(a, info, b);
      list.appendChild(row);
      names.push(a, b);
    }
    fitGroup(names);
  }

  // Each panel remembers the slice it last drew and skips the rebuild when
  // that slice is unchanged — a score bump must not swap the visible panel's
  // pills with no entrance, nor re-run fitText's measuring.
  const lastRendered = {};
  function renderIfChanged(key, slice, render) {
    const json = JSON.stringify(slice === undefined ? null : slice);
    if (lastRendered[key] === json) return;
    lastRendered[key] = json;
    render();
  }

  const identity = (i) => {
    const p = playerOf(i);
    return p && [p.tag, p.prefix, p.character?.name ?? null];
  };

  function refresh() {
    renderIfChanged("player-1", [identity(0), historyView(0), runView(0)], () => renderPlayerCard(0));
    renderIfChanged("player-2", [identity(1), historyView(1), runView(1)], () => renderPlayerCard(1));
    renderIfChanged("recent-sets", [h2hView(), identity(0), identity(1)], renderRecentSets);
    renderIfChanged("completed-sets", completedView(), renderCompletedSets);
    // After rendering: buildSlots can restart the rotation, and the panel it
    // fades in should already hold the new content.
    rotator.buildSlots();
  }

  function setTournamentName(name) {
    const el = document.querySelector(".tournament-name");
    const text = String(name ?? "").trim();
    if (!el || el.textContent === text) return;
    el.textContent = text;
    fitText(el, 18);
  }

  // ── Clip-saved toast ────────────────────────────────────────────────────────
  //
  // Slides in over the bottom card's bottom edge, holds, slides back out.
  // Queued rather than concurrent — restarting a visible pill reads as a
  // flicker — and only the newest waiting clip is kept.

  const TOAST_IN = 450, TOAST_HOLD = 3200, TOAST_OUT = 400;
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
    fitText(detail, 14);

    const total = TOAST_IN + TOAST_HOLD + TOAST_OUT;
    const away = { transform: "translate(-50%, 160%)", opacity: 0 };
    const shown = { transform: "translate(-50%, 0)", opacity: 1 };
    const anim = el.animate([
      { ...away, offset: 0, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" },
      { ...shown, offset: TOAST_IN / total },
      { ...shown, offset: (TOAST_IN + TOAST_HOLD) / total, easing: "ease-in" },
      { ...away, offset: 1 },
    ], { duration: total });
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
  ov.on("clip:saved", showClipToast);
  ov.ready.then(() => rotator.start());

  // For tests/side-panel.test.js, and for poking at from OBS's devtools.
  root.SidePanel = { rotator, historyView, runView, h2hView, completedView, slotHasContent, scoreLabels };
})(window);
