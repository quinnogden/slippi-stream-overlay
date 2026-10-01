/**
 * bracket.js — draws the bracket overlay from the state's `bracket` section.
 *
 * layout.js decides where everything goes at 1080p size; this builds the
 * cards, headers and connectors, then fits the board into the viewport:
 *
 *   - It scales down to fit, but never below the legibility floor (names
 *     ≈22px). A Top 8 fits whole.
 *   - Past the floor it pans: from the round being played (or the most
 *     recent), to the far end, to the near end, and back — holding at each
 *     stop and gliding between them.
 *
 * The view follows the dock (state `view.bracketView`) unless ?view= pins
 * this source. A view switch crossfades through depth to a freshly drawn
 * board (the old one recedes, the new one settles forward); a data
 * change (a reported set, a score) redraws the board in place and keeps the
 * pan going unless the board changed size.
 */
(function () {
  "use strict";

  const { h, text, icon, fitGroup, param } = Overlay;
  const { ease, ms } = Overlay.motion;
  const { layoutBracket, fitScale, METRICS } = BracketLayout;

  const VIEW_TITLES = {
    winners: "Winners Bracket",
    losers:  "Losers Bracket",
    top8:    "Top 8",
    top16:   "Top 16",
    full:    "Bracket",
  };
  const PINNED = VIEW_TITLES[param("view")] ? param("view") : null;

  const PAN_SPEED   = 90;    // screen px per second
  const PAN_MIN_MS  = 1800;
  const FOCUS_HOLD  = 7000;  // at the live round
  const END_HOLD    = 4500;  // at each end
  const FADE_IN_MS  = 760;
  const FADE_OUT_MS = 380;

  const SVG = "http://www.w3.org/2000/svg";
  const viewport = document.querySelector(".viewport");
  const animated = () => !document.body.classList.contains("no-animate");

  let feed = null;
  let viewName = PINNED || "top8";
  let current = null;   // { el, board, key, size, pan }

  // ── Cards ───────────────────────────────────────────────────────────────────

  /** @param tag — layout.js's tagOf: { label, loser } or null */
  function entrantRow(set, i, tag) {
    const slot = set.slots[i];
    const ent = slot.entrantId ? feed.entrants[slot.entrantId] : null;
    const decided = set.state === "done" && set.winner != null;
    const row = h("div", "row" + (!ent ? " empty" : decided ? (set.winner === i ? " win" : " lose") : ""));

    row.appendChild(h("span", "seed", slot.seed ?? ""));
    const charBox = row.appendChild(h("span", "char"));
    const src = ent?.character ? icon(ent.character) : null;
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      charBox.appendChild(img);
    }

    const name = row.appendChild(h("span", "name"));
    if (ent) {
      const solo = ent.players.length === 1 ? ent.players[0] : null;
      if (solo?.prefix) name.appendChild(h("span", "prefix", solo.prefix));
      name.appendChild(document.createTextNode(solo ? solo.tag : ent.name));
    } else {
      name.textContent = tag ? `${tag.loser ? "Loser" : "Winner"} of ${tag.label}` : "TBD";
    }
    if (ent && tag) row.appendChild(h("span", "drop", tag.label));

    row.appendChild(h("span", "score", scoreLabel(set, i)));
    return row;
  }

  function scoreLabel(set, i) {
    const slot = set.slots[i];
    if (slot.dq) return "DQ";
    if (typeof slot.score === "number" && slot.score >= 0) {
      // A winner-only report reads 0-0 on start.gg; say who won instead.
      const other = set.slots[1 - i].score;
      if (set.state === "done" && slot.score === 0 && (other ?? 0) === 0 && set.winner != null) {
        return set.winner === i ? "W" : "L";
      }
      return String(slot.score);
    }
    if (set.state === "done" && set.winner != null) return set.winner === i ? "W" : "L";
    return "";
  }

  // ── Drawing a board ─────────────────────────────────────────────────────────

  function draw(board, lay) {
    const m = METRICS;
    board.replaceChildren();
    board.style.width = `${lay.width}px`;
    board.style.height = `${lay.height}px`;
    board.style.setProperty("--card-w", `${m.cardW}px`);
    board.style.setProperty("--row-h", `${m.rowH}px`);
    board.style.setProperty("--head-h", `${m.headerH}px`);
    board.style.setProperty("--name-size", `${m.nameSize}px`);
    const anyChar = Object.values(feed.entrants).some((e) => e.character);
    board.classList.toggle("no-chars", !anyChar);

    // Connectors first, so the cards sit on top. Lit ones last, with a glow
    // under them (CSS filters don't apply inside an SVG).
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "links");
    svg.setAttribute("width", lay.width);
    svg.setAttribute("height", lay.height);
    const path = (d, cls) => {
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", cls);
      svg.appendChild(p);
    };
    for (const l of lay.links) if (!l.lit) path(l.d, "dim");
    for (const l of lay.links) if (l.lit) path(l.d, "glow");
    for (const l of lay.links) if (l.lit) path(l.d, "lit");
    board.appendChild(svg);

    for (const section of lay.sections) {
      for (const col of section.columns) {
        const head = h("div", "round-head");
        head.style.left = `${col.x}px`;
        head.style.top = `${section.top}px`;
        const plate = head.appendChild(h("div", "plate"));
        plate.appendChild(h("span", null, col.name));
        if (col.setIds.every((id) => feed.sets[id].conditional)) plate.appendChild(h("span", "maybe", "if needed"));
        board.appendChild(head);
      }
    }

    const names = [];
    for (const [id, pos] of Object.entries(lay.cards)) {
      const set = feed.sets[id];
      const card = h("div", `card ${set.state}` + (set.conditional ? " maybe" : ""));
      card.style.left = `${pos.x}px`;
      card.style.top = `${pos.y}px`;
      const tags = lay.tags[id] ?? [];
      card.append(entrantRow(set, 0, tags[0]), entrantRow(set, 1, tags[1]));
      board.appendChild(card);
      names.push(...card.querySelectorAll(".name"));
    }
    // In the document now, so the names can be measured: shrunk together,
    // so one long tag does not leave its card a different size (see fitGroup).
    fitGroup(names, Math.round(METRICS.nameSize * 0.7));
  }

  // ── Fit and pan ─────────────────────────────────────────────────────────────

  function geometry(lay) {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const fit = fitScale(lay.width, lay.height, vw, vh);
    const w = lay.width * fit.scale;
    const ht = lay.height * fit.scale;
    // The translate range on each axis: centred when it fits, [view − board, 0] when it pans.
    const range = (size, view, pans) => (pans ? [view - size, 0] : [(view - size) / 2, (view - size) / 2]);
    const [minX, maxX] = range(w, vw, fit.panX);
    const [minY, maxY] = range(ht, vh, fit.panY);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const focus = lay.focus
      ? { x: clamp(vw / 2 - lay.focus.x * fit.scale, minX, maxX), y: clamp(vh / 2 - lay.focus.y * fit.scale, minY, maxY) }
      : { x: maxX, y: maxY };
    return { ...fit, minX, maxX, minY, maxY, focus };
  }

  const transformAt = (p, scale) => `translate(${p.x}px, ${p.y}px) scale(${scale})`;

  /** Where the board is right now, mid-glide included. */
  function positionOf(board) {
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(board).transform || "");
    if (!m) return null;
    const v = m[1].split(",").map(Number);
    return { x: v[4], y: v[5] };
  }

  /**
   * The pan's stops: the focus, the end farther from it, the other end. Each
   * axis that doesn't pan stays centred.
   */
  function stopsOf(g) {
    const far = (v, lo, hi) => (v - lo > hi - v ? lo : hi);
    const a = { x: far(g.focus.x, g.minX, g.maxX), y: far(g.focus.y, g.minY, g.maxY) };
    const b = { x: a.x === g.minX ? g.maxX : g.minX, y: a.y === g.minY ? g.maxY : g.minY };
    const stops = [g.focus];
    for (const p of [a, b]) {
      const last = stops[stops.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) stops.push(p);
    }
    return stops;
  }

  function stopPan(layer) {
    layer.pan.gen++;
    clearTimeout(layer.pan.timer);
    layer.board.getAnimations?.().forEach((a) => a.cancel());
  }

  /** Fit the board, and pan it if the floor still doesn't fit. */
  function startPan(layer, lay, { from = null } = {}) {
    const board = layer.board;
    const start = from ?? positionOf(board);
    stopPan(layer);
    const gen = layer.pan.gen;
    const g = geometry(lay);

    if ((!g.panX && !g.panY) || !animated()) {
      board.style.transform = transformAt(g.focus, g.scale);
      return;
    }

    const stops = stopsOf(g);
    const hold = (ms, then) => { layer.pan.timer = setTimeout(() => { if (gen === layer.pan.gen) then(); }, ms); };
    const glide = (a, b, then) => {
      const ms = Math.max(PAN_MIN_MS, (Math.hypot(b.x - a.x, b.y - a.y) / PAN_SPEED) * 1000);
      const anim = board.animate([{ transform: transformAt(a, g.scale) }, { transform: transformAt(b, g.scale) }],
        { duration: ms, easing: "ease-in-out", fill: "forwards" });
      anim.finished.then(() => {
        if (gen !== layer.pan.gen) return;
        board.style.transform = transformAt(b, g.scale);
        anim.cancel();
        then();
      }, () => {});
    };
    const visit = (i) => {
      const next = (i + 1) % stops.length;
      hold(i === 0 ? FOCUS_HOLD : END_HOLD, () => glide(stops[i], stops[next], () => visit(next)));
    };

    // From wherever the board is (a restart mid-glide) to the focus, then loop.
    if (start && Math.hypot(start.x - stops[0].x, start.y - stops[0].y) > 2 && board.style.transform) {
      glide(start, stops[0], () => visit(0));
    } else {
      board.style.transform = transformAt(stops[0], g.scale);
      visit(0);
    }
  }

  // ── Views and layers ────────────────────────────────────────────────────────

  function newLayer() {
    const el = h("div", "layer");
    const board = h("div", "board");
    el.appendChild(board);
    viewport.appendChild(el);
    return { el, board, key: null, size: null, pan: { gen: 0, timer: null } };
  }

  function render() {
    renderTitle();
    const key = feed ? `${feed.phaseGroupId}:${viewName}` : "none";
    const lay = feed ? layoutBracket(feed, viewName) : null;

    if (current && current.key === key) {
      // Same view, new data: redraw in place. The pan carries on unless the
      // board changed size (a round added, a phase finishing).
      draw(current.board, lay ?? emptyLayout());
      const size = `${lay?.width}x${lay?.height}`;
      if (size !== current.size) {
        current.size = size;
        startPan(current, lay ?? emptyLayout(), { from: positionOf(current.board) });
      }
      return;
    }

    const old = current;
    const layer = newLayer();
    layer.key = key;
    layer.size = `${lay?.width}x${lay?.height}`;
    current = layer;

    if (!lay || lay.sections.length === 0) {
      layer.el.appendChild(h("div", "placeholder", feed ? "No sets in this view yet" : "No bracket loaded"));
    } else {
      draw(layer.board, lay);
      startPan(layer, lay);
    }

    if (old && animated()) {
      // Scale and blur on the layer, never the board: the board's transform
      // is the pan's. The blur is light — the layer is most of the canvas.
      layer.el.animate([
        { opacity: 0, transform: "scale(1.02)", filter: "blur(6px)" },
        { opacity: 1, transform: "scale(1)",    filter: "blur(0px)" },
      ], { duration: ms(FADE_IN_MS), delay: ms(FADE_OUT_MS / 2), easing: ease("out"), fill: "backwards" });
      old.el.animate([
        { opacity: 1, transform: "scale(1)",     filter: "blur(0px)" },
        { opacity: 0, transform: "scale(0.985)", filter: "blur(4px)" },
      ], { duration: ms(FADE_OUT_MS), easing: ease("in"), fill: "forwards" })
        .finished.then(() => { stopPan(old); old.el.remove(); }, () => {});
    } else if (old) {
      stopPan(old);
      old.el.remove();
    }
  }

  const emptyLayout = () => ({ width: 0, height: 0, sections: [], cards: {}, links: [], tags: {}, focus: null });

  function renderTitle() {
    const title = viewName === "full" && feed?.label ? feed.label : VIEW_TITLES[viewName];
    text(document.querySelector(".title-main .text"), title);
    const sub = feed ? [feed.tournamentName, feed.eventName].filter(Boolean).join(" · ") : "";
    text(document.querySelector(".title-sub .text"), sub, { emptyOn: null });
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  // A full state runs both selectors back to back; draw once, after both.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  }

  const ov = Overlay.connect({ tag: "bracket" });
  ov.select("bracket", (b) => { feed = b; schedule(); });
  ov.select("view.bracketView", (v) => {
    if (PINNED || !VIEW_TITLES[v] || v === viewName) return;
    viewName = v;
    schedule();
  });
})();
