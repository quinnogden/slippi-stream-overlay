/**
 * bracket.js — draws the bracket overlay from the state's `bracket` and
 * `bracketShot` sections.
 *
 * layout.js decides where everything goes at 1080p size and how a view too
 * big for the screen is cut into pages; the app (bracket-director.js) decides
 * what is up. This draws one of three things:
 *
 *   - **A page** of a bracket view: its round bands laid out together, scaled
 *     to fit (every page fits at or above the legibility floor — nothing
 *     pans). The tour turns pages; dots under the title count them.
 *   - **Up Next**: every live or ready set in the event, as cards in a grid.
 *   - **The Board**: the classic connected bracket, steered from the dock —
 *     near moves glide, far jumps crossfade, and round headers stay pinned to
 *     the top edge.
 *
 * The view follows the dock (state `view.bracketView`) unless ?view= pins
 * this source; a pinned source tours its own view's pages by itself. A switch
 * of view or page crossfades through depth to a freshly drawn board; a data
 * change (a reported set, a score) redraws the board in place.
 */
(function () {
  "use strict";

  const { h, text, icon, fitGroup, param, presence } = Overlay;
  const { ease, ms } = Overlay.motion;
  const L = BracketLayout;
  const { METRICS, VIEWPORT } = L;

  const VIEW_TITLES = {
    winners: "Winners Bracket",
    losers:  "Losers Bracket",
    top8:    "Top 8",
    top16:   "Top 16",
    full:    "Bracket",
    upnext:  "Up Next",
  };
  const PINNED = VIEW_TITLES[param("view")] ? param("view") : null;

  const GLIDE_MS    = 1000;
  const FADE_IN_MS  = 760;
  const FADE_OUT_MS = 380;
  const STATUS_TEXT = { onstream: "On Stream", live: "Live", ready: "Ready" };

  const SVG = "http://www.w3.org/2000/svg";
  const viewport = document.querySelector(".viewport");
  const dots = document.querySelector(".page-dots");
  const animated = () => !document.body.classList.contains("no-animate");

  let feed = null;
  let shot = null;
  let viewName = PINNED || "top8";
  let current = null;   // { el, board, key, size, lay, mini }
  const local = { page: null, since: 0, holdMs: 0, timer: null }; // a pinned source's own tour

  // ── Cards ───────────────────────────────────────────────────────────────────

  /** @param tag — layout.js's tagOf: { label, loser } or null */
  function entrantRow(set, i, tag, entrants) {
    const slot = set.slots[i];
    const ent = slot.entrantId ? entrants[slot.entrantId] : null;
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

  function sizeBoard(board, width, height, entrants) {
    const m = METRICS;
    board.replaceChildren();
    board.style.width = `${width}px`;
    board.style.height = `${height}px`;
    board.style.setProperty("--card-w", `${m.cardW}px`);
    board.style.setProperty("--row-h", `${m.rowH}px`);
    board.style.setProperty("--head-h", `${m.headerH}px`);
    board.style.setProperty("--name-size", `${m.nameSize}px`);
    board.classList.toggle("no-chars", !Object.values(entrants).some((e) => e.character));
  }

  // ── Drawing a bracket board ─────────────────────────────────────────────────

  function draw(board, lay) {
    sizeBoard(board, lay.width, lay.height, feed.entrants);

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
        head.dataset.top = section.top;
        head.dataset.bottom = section.bottom;
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
      card.append(entrantRow(set, 0, tags[0], feed.entrants), entrantRow(set, 1, tags[1], feed.entrants));
      board.appendChild(card);
      names.push(...card.querySelectorAll(".name"));
    }
    // In the document now, so the names can be measured: shrunk together,
    // so one long tag does not leave its card a different size (see fitGroup).
    fitGroup(names, Math.round(METRICS.nameSize * 0.7));
  }

  // ── Drawing Up Next ─────────────────────────────────────────────────────────

  function drawList(board, rows) {
    const grid = L.layoutList(rows.length);
    const entrants = feed.upNextEntrants ?? {};
    sizeBoard(board, grid.width, grid.height, entrants);
    board.style.setProperty("--list-head-h", `${L.LIST.headH}px`);
    const names = [];
    rows.forEach((row, i) => {
      const cell = grid.cells[i];
      const item = h("div", `ucard ${row.status}`);
      item.style.left = `${cell.x}px`;
      item.style.top = `${cell.y}px`;
      const head = item.appendChild(h("div", "uhead"));
      head.appendChild(h("span", "uround", [row.round, row.group].filter(Boolean).join(" · ")));
      head.appendChild(h("span", "chip", STATUS_TEXT[row.status]));
      const card = item.appendChild(h("div", `card ${row.state}`));
      card.append(entrantRow(row, 0, null, entrants), entrantRow(row, 1, null, entrants));
      board.appendChild(item);
      names.push(...card.querySelectorAll(".name"));
    });
    fitGroup(names, Math.round(METRICS.nameSize * 0.7));
    return grid;
  }

  // ── What's up ───────────────────────────────────────────────────────────────

  const pagesNow = () => feed?.pages?.[viewName] ?? [];

  /** The shot this source shows: the app's, or a pinned source's own tour. */
  function shotNow() {
    const pages = pagesNow();
    if (PINNED) {
      const page = pages.find((p) => p.key === local.page) ?? pages[0] ?? null;
      return { mode: "tour", page, since: local.since, holdMs: local.holdMs, camera: null };
    }
    const s = shot && shot.view === viewName ? shot : null;
    if (s?.mode === "board" && viewName !== "upnext") return { mode: "board", page: null, camera: s.camera };
    const page = pages.find((p) => p.key === s?.page) ?? pages[0] ?? null;
    return { mode: s?.mode === "page" ? "page" : "tour", page, since: s?.since ?? 0, holdMs: s?.holdMs ?? 0, camera: null };
  }

  /** A pinned source turns its own pages, on the same holds as the app's tour. */
  function localTour() {
    clearTimeout(local.timer);
    const pages = pagesNow();
    if (!pages.some((p) => p.key === local.page)) {
      local.page = pages[0]?.key ?? null;
      local.since = Date.now();
      local.holdMs = L.holdMs(pages[0]);
    }
    if (pages.length < 2) return;
    local.timer = setTimeout(() => {
      const i = pages.findIndex((p) => p.key === local.page);
      const next = pagesNow()[(i + 1) % pagesNow().length];
      local.page = next?.key ?? null;
      local.since = Date.now();
      local.holdMs = L.holdMs(next);
      schedule();
    }, Math.max(0, local.since + local.holdMs - Date.now()));
  }

  // ── Placing a board ─────────────────────────────────────────────────────────

  const transformAt = (t) => `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;

  /** Centred in the viewport at `scale`. */
  function centred(width, height, scale) {
    return { scale, x: (VIEWPORT.w - width * scale) / 2, y: (VIEWPORT.h - height * scale) / 2 };
  }

  /** Where the board is right now, mid-glide included. */
  function transformOf(board) {
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(board).transform || "");
    if (!m) return null;
    const v = m[1].split(",").map(Number);
    return { scale: v[0], x: v[4], y: v[5] };
  }

  /** The Board's round headers stay on screen while their side does. */
  function pinHeaders(layer, t) {
    const topEdge = -t.y / t.scale;
    const overview = layer.el.classList.contains("overview");
    for (const head of layer.board.querySelectorAll(".round-head")) {
      const top = Number(head.dataset.top), bottom = Number(head.dataset.bottom);
      const pinned = overview ? top : Math.min(Math.max(top, topEdge), bottom - METRICS.headerH);
      head.style.top = `${Math.max(top, pinned)}px`;
    }
  }

  function place(layer, t, { glide = false } = {}) {
    const board = layer.board;
    const from = glide && animated() ? transformOf(board) : null;
    board.getAnimations?.().forEach((a) => a.cancel());
    board.style.transform = transformAt(t);
    if (from && Math.hypot(from.x - t.x, from.y - t.y) + Math.abs(from.scale - t.scale) * 1000 > 1) {
      board.animate([{ transform: transformAt(from) }, { transform: transformAt(t) }],
        { duration: ms(GLIDE_MS), easing: ease("out") });
    }
  }

  // ── Views and layers ────────────────────────────────────────────────────────

  function newLayer() {
    const el = h("div", "layer");
    const board = h("div", "board");
    el.appendChild(board);
    viewport.appendChild(el);
    return { el, board, key: null, lay: null, cam: null, feedRef: undefined };
  }

  function render() {
    if (PINNED) localTour();
    const s = shotNow();
    renderTitle();
    renderDots(s);

    const board = s.mode === "board";
    const key = !feed ? "none" : `${feed.phaseGroupId}:${viewName}:${board ? "board" : s.page?.key ?? "-"}`;

    if (current && current.key === key) {
      if (board) return redrawBoard(current, s.camera);
      paint(current, s);
      return;
    }

    const old = current;
    const layer = newLayer();
    layer.key = key;
    current = layer;
    if (board) redrawBoard(layer, s.camera, { fresh: true });
    else paint(layer, s);
    crossfade(old, layer);
  }

  /** A page, or Up Next, drawn into `layer` and fitted. A shot change alone (the tour's mode) redraws nothing. */
  function paint(layer, s) {
    if (layer.feedRef === feed && feed) return;
    layer.feedRef = feed;
    layer.el.querySelector(".placeholder")?.remove();
    layer.el.classList.toggle("list", viewName === "upnext");
    if (!feed) return placeholder(layer, "No bracket loaded");
    if (viewName === "upnext") {
      const rows = (feed.upNext ?? []).filter((r) => s.page?.setIds.includes(r.setId));
      if (rows.length === 0) { layer.board.replaceChildren(); return placeholder(layer, "No sets ready right now"); }
      const grid = drawList(layer.board, rows);
      return place(layer, centred(grid.width, grid.height, grid.scale));
    }
    if (!s.page) { layer.board.replaceChildren(); return placeholder(layer, "No sets in this view yet"); }
    const lay = L.layoutPage(feed, s.page);
    draw(layer.board, lay);
    place(layer, centred(lay.width, lay.height, Math.min(1, VIEWPORT.w / lay.width, VIEWPORT.h / lay.height)));
  }

  /**
   * The Board: the camera glided to — or crossfaded, for a long jump. The
   * cards are redrawn only when the data changed, so a camera move keeps
   * them (and the pinned headers slide with it).
   */
  function redrawBoard(layer, cam, { fresh = false } = {}) {
    const lay = layer.feedRef === feed && layer.lay ? layer.lay : L.layoutView(feed, L.prunedView(feed, viewName));
    if (!lay.width) {
      layer.board.replaceChildren();
      return placeholder(layer, "No sets in this view yet");
    }
    layer.el.querySelector(".placeholder")?.remove();
    const t = L.cameraTransform(lay, cam, VIEWPORT);
    if (!fresh && layer.cam && farJump(layer, t)) {
      // A long way off: a fresh board crossfades in rather than a whoosh across this one.
      const next = newLayer();
      next.key = layer.key;
      current = next;
      redrawBoard(next, cam, { fresh: true });
      crossfade(layer, next);
      return;
    }
    layer.el.classList.toggle("overview", !!cam?.overview);
    if (layer.feedRef !== feed || fresh) {
      layer.feedRef = feed;
      layer.lay = lay;
      draw(layer.board, lay);
    }
    place(layer, t, { glide: !fresh });
    pinHeaders(layer, t);
    layer.cam = t;
  }

  /** More than about a screen away, or in or out of the Overview. */
  function farJump(layer, t) {
    const a = layer.cam;
    const dist = Math.hypot((a.x / a.scale) - (t.x / t.scale), (a.y / a.scale) - (t.y / t.scale));
    return dist > VIEWPORT.w || Math.abs(a.scale - t.scale) > 0.3;
  }

  function placeholder(layer, msg) {
    layer.el.querySelector(".placeholder")?.remove();
    layer.el.appendChild(h("div", "placeholder", msg));
  }

  function crossfade(old, layer) {
    if (old && animated()) {
      // Scale and blur on the layer, never the board: the board's transform
      // is the camera's. The blur is light — the layer is most of the canvas.
      layer.el.animate([
        { opacity: 0, transform: "scale(1.02)", filter: "blur(6px)" },
        { opacity: 1, transform: "scale(1)",    filter: "blur(0px)" },
      ], { duration: ms(FADE_IN_MS), delay: ms(FADE_OUT_MS / 2), easing: ease("out"), fill: "backwards" });
      old.el.animate([
        { opacity: 1, transform: "scale(1)",     filter: "blur(0px)" },
        { opacity: 0, transform: "scale(0.985)", filter: "blur(4px)" },
      ], { duration: ms(FADE_OUT_MS), easing: ease("in"), fill: "forwards" })
        .finished.then(() => old.el.remove(), () => {});
    } else if (old) {
      old.el.remove();
    }
  }

  function renderTitle() {
    const title = viewName === "full" && feed?.label ? feed.label : VIEW_TITLES[viewName];
    text(document.querySelector(".title-main .text"), title);
    const sub = feed ? [feed.tournamentName, feed.eventName].filter(Boolean).join(" · ") : "";
    text(document.querySelector(".title-sub .text"), sub, { emptyOn: null });
  }

  /** A dot per page, the one up lit — filling over its hold while the tour runs. */
  function renderDots(s) {
    const pages = pagesNow();
    const show = s.mode !== "board" && pages.length > 1;
    presence(dots, show);
    if (!show) return;
    const sig = `${pages.map((p) => p.key).join(",")}|${s.page?.key}|${s.mode}|${s.since}`;
    if (dots.dataset.sig === sig) return;
    dots.dataset.sig = sig;
    dots.replaceChildren(...pages.map((p) => {
      const dot = h("i", p.key === s.page?.key ? "on" : null);
      if (p.key === s.page?.key) {
        const fill = dot.appendChild(h("b", s.mode === "tour" ? "fill" : "full"));
        if (s.mode === "tour" && s.holdMs > 0) {
          fill.style.animationDuration = `${s.holdMs}ms`;
          fill.style.animationDelay = `${-Math.min(s.holdMs, Math.max(0, Date.now() - s.since))}ms`;
        }
      }
      return dot;
    }));
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  // A full state runs every selector back to back; draw once, after all.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  }

  const ov = Overlay.connect({ tag: "bracket" });
  ov.select("bracket", (b) => { feed = b; schedule(); });
  ov.select("bracketShot", (s) => { shot = s; if (!PINNED) schedule(); });
  ov.select("view.bracketView", (v) => {
    if (PINNED || !VIEW_TITLES[v] || v === viewName) return;
    viewName = v;
    schedule();
  });
})();
