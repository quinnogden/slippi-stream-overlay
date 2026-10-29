/**
 * layout.js — where every card and connector of a bracket view goes, how a view
 * too big for the screen is cut into pages, and where the Board camera can sit.
 *
 * Pure: the `bracket` state section (lib/event/bracket-feed.js) and a view
 * name in, positions in unscaled 1080p pixels out. No DOM, so it runs under
 * Node too: bracket-feed.js paginates with it (so the dock and every source
 * agree on the pages), bracket-director.js moves the Board camera with it, and
 * tests/bracket-overlay.test.js runs it on captured tournaments.
 *
 * The winners side (with grand finals) is drawn above the losers side, each
 * as a tree laid out from its final backwards:
 *
 *   - A set's children are the sets that send their WINNER into it, from the
 *     same side and in this view. A losers set's drop-in (the loser of a
 *     winners set) is not a child — it gets a small "W R2" tag instead of a
 *     line across the screen — and neither is a feeder outside the view. The
 *     grand final's losers-side slot is tagged the same way ("L F").
 *   - A set with no children takes the next free row; a set with children is
 *     centred on them. Each subtree owns a contiguous run of rows, so no two
 *     cards in a column can overlap, byes and odd entrant counts included.
 *   - Columns are the view's rounds, left to right (bracket-model.roundsOf).
 *
 * Connectors run from a child's right edge to the row of its parent that it
 * fills. A connector is lit once its child set is finished — the winner has
 * travelled along it.
 *
 * **Pages.** One tree on one canvas is mostly empty: the busiest round sets
 * the height and the later rounds sit in a triangle of nothing beside it. So a
 * view that doesn't fit the viewport at the legibility floor is cut into
 * *round bands* (consecutive rounds of one side), each laid out on its own so
 * its later rounds pull together. A band still too tall is wrapped k-up — its
 * subtrees split into k groups side by side, so no connector is ever cut —
 * and short bands from the two sides stack on one page. Every page fits at or
 * above the floor, so nothing pans. Before that, rounds past the next one
 * with anybody in them are dropped (only when the view doesn't fit whole).
 */
(function (root) {
  "use strict";

  /** Unscaled sizes, in 1080p pixels. bracket.js mirrors them into CSS. */
  const METRICS = {
    cardW: 320,
    rowH: 44,           // one entrant; a card is two
    colGap: 76,         // room for the connector elbows
    rowGap: 22,         // between leaf cards
    headerH: 46,        // round names above each side's columns
    sectionGap: 64,     // winners side → losers side
    wrapGap: 152,       // between the groups of a band wrapped k-up
    nameSize: 28,       // px at scale 1
    floorNamePx: 22,    // the legibility floor: never scale names below this
  };

  /** The board's viewport: bracket.css's .viewport (1920 × 1080 less its insets). */
  const VIEWPORT = { w: 1824, h: 912 };

  /** Up Next cards: a header line over the bracket card, in a grid. */
  const LIST = { headH: 34, gapX: 40, gapY: 28, maxScale: 1.4 };

  /** How long the tour holds a page: a base, plus a little per set, capped. */
  const HOLD = { baseMs: 6000, perSetMs: 250, maxMs: 15000 };

  const MAX_WRAP = 6;
  const MAX_PARTS = 6;
  const MAX_PLANS = 48;  // optimal band partitions kept per side

  const cardH = (m) => m.rowH * 2;
  const floorOf = (m) => m.floorNamePx / m.nameSize;
  const scaleFor = (w, h, vp) => (!w || !h ? 1 : Math.min(1, vp.w / w, vp.h / h));
  const EPS = 1e-9;

  function sectionOf(set) {
    return set.side === "L" ? "L" : "W";
  }

  /**
   * "Winners Round 2" → "W R2", "Winners Semi-Final" → "W SF" — the drop-in tag.
   * Unrecognised names pass through.
   */
  function shortRound(name) {
    const n = String(name ?? "").trim();
    const side = /^winners/i.test(n) ? "W" : /^losers/i.test(n) ? "L" : "";
    if (!side) return n;
    const rest = n.replace(/^(winners|losers)\s*/i, "");
    let m;
    if ((m = rest.match(/^round\s*(\d+)/i))) return `${side} R${m[1]}`;
    if (/^quarter/i.test(rest)) return `${side} QF`;
    if (/^semi/i.test(rest)) return `${side} SF`;
    if (/^final/i.test(rest)) return `${side} F`;
    return n;
  }

  // ── The forest ──────────────────────────────────────────────────────────────

  /** A section's rounds in a view, left to right. */
  const sectionRounds = (sets, view, key) =>
    view.rounds.filter((r) => r.setIds.length && sectionOf(sets[r.setIds[0]]) === key);

  /**
   * One section of a view as a forest: each set's column and children, and
   * the roots in placement order with the rows (in pitch units) each one's
   * subtree takes. `y` is each set's row, the leaf rows counted from 0.
   */
  function forestOf(feed, view, key) {
    const sets = feed.sets;
    const inView = new Set(view.setIds);
    const rounds = sectionRounds(sets, view, key);
    const column = {};
    rounds.forEach((r, i) => r.setIds.forEach((id) => { column[id] = i; }));
    const ids = rounds.flatMap((r) => r.setIds);

    // Children in slot order; a set fed twice by the same set (the reset) once.
    const kidsOf = {};
    for (const id of ids) {
      const kids = [];
      for (const slot of sets[id].slots) {
        const f = slot.from;
        if (f.kind !== "set" || !inView.has(f.setId)) continue;
        if (sectionOf(sets[f.setId]) !== key) continue;
        if (f.placement === 2 && sets[id].side !== "GFR") continue; // a drop-in
        if (!kids.includes(f.setId)) kids.push(f.setId);
      }
      kidsOf[id] = kids;
    }
    const hasParent = new Set(ids.flatMap((id) => kidsOf[id]));

    // Roots: the rightmost first (the final), then any stragglers top-down.
    const roots = ids.filter((id) => !hasParent.has(id)).sort((a, b) => column[b] - column[a]);

    const y = {};
    let next = 0;
    const subtree = [];
    const place = (id) => {
      subtree.push(id);
      const kids = kidsOf[id];
      kids.forEach(place);
      if (kids.length === 0) y[id] = next++;
      else y[id] = kids.reduce((sum, k) => sum + y[k], 0) / kids.length;
    };
    const spans = roots.map((id) => {
      const start = next;
      subtree.length = 0;
      place(id);
      return { root: id, start, rows: next - start, ids: [...subtree] };
    });
    return { rounds, column, kidsOf, ids, spans, y };
  }

  /**
   * Split `weights` into at most `k` contiguous groups, minimising the largest
   * group's total. Returns [start, end) index pairs.
   */
  function splitContiguous(weights, k) {
    if (weights.length === 0) return [];
    k = Math.max(1, Math.min(k, weights.length));
    const groupsFor = (cap) => {
      const out = [];
      let start = 0, sum = 0;
      weights.forEach((w, i) => {
        if (sum + w > cap && i > start) { out.push([start, i]); start = i; sum = 0; }
        sum += w;
      });
      out.push([start, weights.length]);
      return out;
    };
    let lo = Math.max(...weights), hi = weights.reduce((a, b) => a + b, 0);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (groupsFor(mid).length <= k) hi = mid; else lo = mid + 1;
    }
    return groupsFor(lo);
  }

  // ── Laying out a view ───────────────────────────────────────────────────────

  /**
   * @param {object} feed — the state's `bracket` section
   * @param {string} viewName — winners | losers | top8 | top16 | full
   * @param {object} [m] — METRICS
   */
  function layoutBracket(feed, viewName, m = METRICS) {
    return layoutView(feed, feed?.views?.[viewName], m);
  }

  /**
   * Lay out any set of rounds: a whole view, a round band, a page.
   *
   * @param {object} feed
   * @param {{ rounds: Array<{ key, name, setIds }>, setIds: string[] }} view
   * @param {object} [m] — METRICS
   * @param {{ wrap?: { W?: number, L?: number } }} [opts] — k-up per side
   * @returns {{
   *   width: number, height: number,
   *   sections: Array<{ key: "W"|"L", top: number, bottom: number, columns: Array<{ key, name, x, setIds }> }>,
   *   cards: Record<string, { x: number, y: number }>,
   *   links: Array<{ from: string, to: string, slot: number|null, lit: boolean, d: string }>,
   *   tags: Record<string, Array<{ label: string, loser: boolean } | null>>,
   *   focus: { x: number, y: number } | null,
   * }}
   */
  function layoutView(feed, view, m = METRICS, opts = {}) {
    const empty = { width: 0, height: 0, sections: [], cards: {}, links: [], tags: {}, focus: null };
    if (!view || view.setIds.length === 0) return empty;

    const sets = feed.sets;
    const H = cardH(m);
    const pitch = H + m.rowGap;
    const colPitch = m.cardW + m.colGap;

    const out = { ...empty, cards: {}, links: [], tags: {}, sections: [] };
    let top = 0;

    for (const key of ["W", "L"]) {
      const f = forestOf(feed, view, key);
      if (f.rounds.length === 0) continue;

      const groups = splitContiguous(f.spans.map((s) => s.rows), opts.wrap?.[key] ?? 1);
      const bandW = f.rounds.length * colPitch - m.colGap;
      const cardsTop = top + m.headerH;
      const columns = [];

      groups.forEach(([a, b], g) => {
        const x0 = g * (bandW + m.wrapGap);
        const rowStart = f.spans[a].start;
        const inGroup = new Set(f.spans.slice(a, b).flatMap((s) => s.ids));
        for (const id of inGroup) {
          out.cards[id] = { x: x0 + f.column[id] * colPitch, y: cardsTop + (f.y[id] - rowStart) * pitch };
        }
        f.rounds.forEach((r, i) => {
          const ids = r.setIds.filter((id) => inGroup.has(id));
          if (ids.length) columns.push({ key: r.key, name: r.name, x: x0 + i * colPitch, setIds: ids });
        });
      });

      for (const id of f.ids) {
        const slots = sets[id].slots;
        for (const k of f.kidsOf[id]) {
          const both = slots.filter((s) => s.from.kind === "set" && s.from.setId === k).length > 1;
          const slot = both ? null : slots.findIndex((s) => s.from.kind === "set" && s.from.setId === k);
          const a = out.cards[k];
          const b = out.cards[id];
          const x1 = a.x + m.cardW;
          const y1 = a.y + H / 2;
          const y2 = b.y + (slot === null ? H / 2 : m.rowH * (slot + 0.5));
          out.links.push({ from: k, to: id, slot, lit: sets[k].state === "done", d: elbow(x1, y1, b.x, y2) });
        }
        out.tags[id] = slots.map((s) => tagOf(sets, sets[id], s));
      }

      const bottom = Math.max(...f.ids.map((id) => out.cards[id].y + H));
      out.sections.push({ key, top, bottom, columns });
      out.width = Math.max(out.width, groups.length * (bandW + m.wrapGap) - m.wrapGap);
      top = bottom + m.sectionGap;
      out.height = bottom;
    }

    const focusId = actionSetId(feed, view);
    out.focus = focusId && out.cards[focusId]
      ? { x: out.cards[focusId].x + m.cardW / 2, y: out.cards[focusId].y + m.rowH }
      : null;
    return out;
  }

  /**
   * Where a slot's entrant comes from, when no connector shows it: a losers
   * drop-in ("W R2", the loser of that set), or the grand final's losers-side
   * slot ("L F", the winner of it).
   */
  function tagOf(sets, set, slot) {
    const f = slot.from;
    if (f.dropIn) return { label: shortRound(f.dropIn.roundName), loser: true };
    if (set.side === "GF" && f.kind === "set" && sets[f.setId]?.side === "L") {
      return { label: shortRound(sets[f.setId].name), loser: false };
    }
    return null;
  }

  /**
   * Where the action is: the set on air if it's in the view, else the
   * leftmost set being played, else the leftmost set ready to be played, else
   * the set finished most recently.
   */
  function actionSetId(feed, view, onAirId = null) {
    if (!view || view.setIds.length === 0) return null;
    const sets = feed.sets;
    if (onAirId != null && view.setIds.includes(String(onAirId))) return String(onAirId);
    // Leftmost: by column within the side, winners before losers, then top-down.
    const pos = {};
    for (const key of ["W", "L"]) {
      sectionRounds(sets, view, key).forEach((r, c) => r.setIds.forEach((id, i) => {
        pos[id] = [c, key === "W" ? 0 : 1, i];
      }));
    }
    const byPos = (a, b) => pos[a.id][0] - pos[b.id][0] || pos[a.id][1] - pos[b.id][1] || pos[a.id][2] - pos[b.id][2];
    const list = view.setIds.map((id) => sets[id]);
    const live = list.filter((s) => s.state === "live").sort(byPos);
    if (live.length) return live[0].id;
    const ready = list.filter((s) => s.state === "pending" && s.slots.every((x) => x.entrantId)).sort(byPos);
    if (ready.length) return ready[0].id;
    // By start.gg's completion time, falling back to the rightmost column.
    // (The losers side runs further right than the grand final, so
    // "rightmost" alone would open a finished bracket on the losers final.)
    const done = list.filter((s) => s.state === "done")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || pos[b.id][0] - pos[a.id][0] || byPos(a, b));
    if (done.length) return done[0].id;
    return [...list].sort(byPos)[0].id;
  }

  /** A horizontal-vertical-horizontal connector with rounded corners. */
  function elbow(x1, y1, x2, y2, r = 10) {
    const f = (n) => Math.round(n * 10) / 10;
    if (Math.abs(y2 - y1) < 0.5) return `M${f(x1)} ${f(y1)}H${f(x2)}`;
    const xm = x1 + (x2 - x1) / 2;
    const dir = y2 > y1 ? 1 : -1;
    const rr = Math.min(r, Math.abs(y2 - y1) / 2, (x2 - x1) / 2);
    return `M${f(x1)} ${f(y1)}H${f(xm - rr)}Q${f(xm)} ${f(y1)} ${f(xm)} ${f(y1 + dir * rr)}`
      + `V${f(y2 - dir * rr)}Q${f(xm)} ${f(y2)} ${f(xm + rr)} ${f(y2)}H${f(x2)}`;
  }

  /**
   * The scale for a board in a viewport: as large as fits (never above 1),
   * but never below the legibility floor. Past the floor, the axes that still
   * overflow would have to pan — which only the Board mode's Overview allows.
   */
  function fitScale(width, height, viewW, viewH, m = METRICS) {
    const floor = floorOf(m);
    if (!width || !height) return { scale: 1, floor, panX: false, panY: false };
    const fit = Math.min(1, viewW / width, viewH / height);
    const scale = Math.max(fit, floor);
    return { scale, floor, panX: width * scale > viewW + 0.5, panY: height * scale > viewH + 0.5 };
  }

  // ── Pruning ─────────────────────────────────────────────────────────────────

  /** The view as `ids` alone, in round order. */
  function subView(feed, ids) {
    const keep = ids instanceof Set ? ids : new Set(ids);
    const rounds = (feed.rounds ?? []).map((r) => ({ ...r, setIds: r.setIds.filter((id) => keep.has(id)) }))
      .filter((r) => r.setIds.length > 0);
    return { rounds, setIds: rounds.flatMap((r) => r.setIds) };
  }

  /**
   * The part of a view worth drawing. A view that fits whole at the floor is
   * drawn whole (a Top 8 keeps its empty future sets — it's a map of what's
   * to come). One that doesn't drops, per side, every round past the next one
   * after the furthest round with anybody in it: finished, live and ready sets
   * and the round they feed stay; the empty rest of the bracket goes.
   */
  function prunedView(feed, viewName, m = METRICS, vp = VIEWPORT) {
    const view = feed?.views?.[viewName];
    if (!view || view.setIds.length === 0) return view ?? null;
    const whole = layoutView(feed, view, m);
    if (scaleFor(whole.width, whole.height, vp) >= floorOf(m) - EPS) return view;

    const known = (s) => s.state !== "pending" || s.slots.some((x) => x.entrantId);
    const keep = new Set();
    for (const key of ["W", "L"]) {
      const rounds = sectionRounds(feed.sets, view, key);
      let last = -1;
      rounds.forEach((r, i) => { if (r.setIds.some((id) => known(feed.sets[id]))) last = i; });
      rounds.slice(0, last + 2).forEach((r) => r.setIds.forEach((id) => keep.add(id)));
    }
    const rounds = view.rounds.map((r) => ({ ...r, setIds: r.setIds.filter((id) => keep.has(id)) }))
      .filter((r) => r.setIds.length > 0);
    return { ...view, rounds, setIds: rounds.flatMap((r) => r.setIds), pruned: true };
  }

  // ── Pages ───────────────────────────────────────────────────────────────────

  const SIDE_WORD = { W: "Winners", L: "Losers" };
  const restOf = (name) => String(name ?? "").replace(/^(winners|losers)\s*/i, "").trim();

  /** "Winners · Rounds 1–2", "Losers · Round 7 – Final", "Grand Final". */
  function bandLabel(key, first, last) {
    const a = restOf(first.name), b = restOf(last.name);
    let range;
    const ra = /^round\s*(\d+)$/i.exec(a), rb = /^round\s*(\d+)$/i.exec(b);
    if (first === last) range = a;
    else if (ra && rb) range = `Rounds ${ra[1]}–${rb[1]}`;
    else range = `${a} – ${b}`;
    const sided = /^(winners|losers)/i.test(first.name);
    return sided ? `${SIDE_WORD[key]} · ${range}` : range;
  }

  /** "W R1–R2", "W R3–GF", "L R7–F": short enough for a dock key. */
  function bandShort(first, last) {
    const s = (r) => {
      const n = String(r.name ?? "");
      if (/grand final reset/i.test(n)) return "GFR";
      if (/grand final/i.test(n)) return "GF";
      return shortRound(n);
    };
    const a = s(first), b = s(last);
    if (first === last) return a;
    const side = /^([WL]) /.exec(a)?.[1];
    return `${a}–${side && b.startsWith(`${side} `) ? b.slice(2) : b}`;
  }

  /**
   * The pages a view is shown on, each fitting the viewport at or above the
   * floor. A view that fits whole is one page ("all").
   *
   * Fewest pages first, then the largest smallest scale. Per side, every way
   * of cutting its rounds into bands is tried (each band wrapped k-up, or
   * split into parts by subtree if even that won't fit); then the two sides'
   * bands are stacked, paired from the final backwards, wherever a pair fits.
   *
   * @returns {Array<{ key: string, label: string, short: string, setIds: string[],
   *                   wrap: { W?: number, L?: number }, scale: number }>}
   */
  function paginate(feed, viewName, m = METRICS, vp = VIEWPORT) {
    const view = prunedView(feed, viewName, m, vp);
    if (!view || view.setIds.length === 0) return [];
    const floor = floorOf(m) - EPS;
    const whole = layoutView(feed, view, m);
    const wholeScale = scaleFor(whole.width, whole.height, vp);
    if (wholeScale >= floor) {
      return [{ key: "all", label: "", short: "All", setIds: [...view.setIds], wrap: {}, scale: wholeScale }];
    }

    const colPitch = m.cardW + m.colGap;
    const pitch = cardH(m) + m.rowGap;
    const sides = {};
    for (const key of ["W", "L"]) {
      const rounds = sectionRounds(feed.sets, view, key);
      if (rounds.length) sides[key] = planSide(feed, key, rounds);
    }

    /** One side's best partitions of its rounds into bands. */
    function planSide(feed, key, rounds) {
      const n = rounds.length;
      const bands = {};  // "i-j" → { pages: [...], cost, w, h, scale } | null
      const bandAt = (i, j) => {
        const id = `${i}-${j}`;
        if (id in bands) return bands[id];
        const rs = rounds.slice(i, j + 1);
        const v = { rounds: rs, setIds: rs.flatMap((r) => r.setIds) };
        const f = forestOf(feed, v, key);
        bands[id] = bestBand(key, rs, f);
        return bands[id];
      };

      // best[i]: the cheapest cover of rounds i..n-1, and every plan reaching it.
      const best = new Array(n + 1);
      best[n] = { cost: 0, plans: [[]] };
      for (let i = n - 1; i >= 0; i--) {
        let cost = Infinity, plans = [];
        for (let j = i; j < n; j++) {
          const b = bandAt(i, j);
          if (!b || !Number.isFinite(best[j + 1].cost)) continue;
          const c = b.cost + best[j + 1].cost;
          if (c < cost) { cost = c; plans = []; }
          if (c === cost) for (const rest of best[j + 1].plans) {
            if (plans.length < MAX_PLANS) plans.push([b, ...rest]);
          }
        }
        best[i] = { cost, plans };
      }
      return best[0];
    }

    /**
     * A band's best showing: one page wrapped k-up at the largest scale, else
     * the fewest parts (subtree runs) that each fit.
     */
    function bestBand(key, rs, f) {
      const label = bandLabel(key, rs[0], rs[rs.length - 1]);
      const short = bandShort(rs[0], rs[rs.length - 1]);
      const rows = f.spans.map((s) => s.rows);
      const measure = (spans, k) => {
        const groups = splitContiguous(spans.map((s) => s.rows), k);
        const cols = new Set(spans.flatMap((s) => s.ids.map((id) => f.column[id]))).size;
        const bandW = cols * colPitch - m.colGap;
        const tall = Math.max(...groups.map(([a, b]) => spans.slice(a, b).reduce((t, s) => t + s.rows, 0)));
        const w = groups.length * (bandW + m.wrapGap) - m.wrapGap;
        const h = m.headerH + tall * pitch - m.rowGap;
        return { k: groups.length, w, h, scale: scaleFor(w, h, vp) };
      };
      const bestWrap = (spans) => {
        let top = null;
        for (let k = 1; k <= Math.min(MAX_WRAP, spans.length); k++) {
          const r = measure(spans, k);
          if (r.scale >= floor && (!top || r.scale > top.scale + EPS)) top = r;
        }
        return top;
      };
      for (let parts = 1; parts <= Math.min(MAX_PARTS, f.spans.length); parts++) {
        const runs = splitContiguous(rows, parts).map(([a, b]) => f.spans.slice(a, b));
        const fits = runs.map(bestWrap);
        if (fits.some((x) => !x)) continue;
        const pages = runs.map((spans, p) => ({
          key: `${rs[0].key}-${rs[rs.length - 1].key}x${fits[p].k}` + (runs.length > 1 ? `p${p + 1}of${runs.length}` : ""),
          label: runs.length > 1 ? `${label} (${p + 1}/${runs.length})` : label,
          short: runs.length > 1 ? `${short} ${p + 1}/${runs.length}` : short,
          ids: spans.flatMap((s) => s.ids),
          ...fits[p],
        }));
        return { cost: pages.length, pages };
      }
      return null;
    }

    if (Object.values(sides).some((s) => !Number.isFinite(s.cost))) {
      // Nothing legible fits (a single subtree taller than the screen at the
      // floor). Fall back to one page per round band, whatever its scale.
      return fallbackPages(feed, view, m, vp);
    }

    const wPlans = sides.W?.plans ?? [[]];
    const lPlans = sides.L?.plans ?? [[]];
    let chosen = null;
    for (const wp of wPlans) for (const lp of lPlans) {
      const pages = assemble(wp, lp);
      const minScale = Math.min(...pages.map((p) => p.scale));
      if (!chosen || pages.length < chosen.pages.length
          || (pages.length === chosen.pages.length && minScale > chosen.minScale + EPS)) {
        chosen = { pages, minScale };
      }
    }
    return chosen.pages;

    /** The two sides' bands as pages: stacked from the final backwards where a pair fits. */
    function assemble(wp, lp) {
      const wPages = wp.flatMap((b) => b.pages.map((p) => ({ ...p, side: "W", single: b.pages.length === 1 })));
      const lPages = lp.flatMap((b) => b.pages.map((p) => ({ ...p, side: "L", single: b.pages.length === 1 })));
      const stackedWith = new Map(); // W page index → L page index
      for (let t = 1; t <= Math.min(wPages.length, lPages.length); t++) {
        const a = wPages[wPages.length - t], b = lPages[lPages.length - t];
        if (!a.single || !b.single) continue;
        const scale = scaleFor(Math.max(a.w, b.w), a.h + m.sectionGap + b.h, vp);
        if (scale >= floor) stackedWith.set(wPages.length - t, { l: lPages.length - t, scale });
      }
      const usedL = new Set([...stackedWith.values()].map((s) => s.l));
      const page = (parts, scale) => ({
        key: parts.map((p) => `${p.side}${p.key}`).join("|"),
        label: parts.map((p) => p.label).join("  +  "),
        short: parts.map((p) => p.short).join(" + "),
        setIds: subView(feed, parts.flatMap((p) => p.ids)).setIds,
        wrap: Object.fromEntries(parts.map((p) => [p.side, p.k])),
        scale,
      });
      const out = [];
      wPages.forEach((p, i) => {
        const s = stackedWith.get(i);
        out.push(s ? page([p, lPages[s.l]], s.scale) : page([p], p.scale));
      });
      lPages.forEach((p, i) => { if (!usedL.has(i)) out.push(page([p], p.scale)); });
      return out;
    }
  }

  /** Last resort: a page per round, at whatever scale fits. */
  function fallbackPages(feed, view, m, vp) {
    return view.rounds.map((r) => {
      const key = sectionOf(feed.sets[r.setIds[0]]);
      const lay = layoutView(feed, { rounds: [r], setIds: r.setIds }, m);
      return {
        key: `${key}${r.key}`, label: bandLabel(key, r, r), short: bandShort(r, r),
        setIds: [...r.setIds], wrap: {}, scale: scaleFor(lay.width, lay.height, vp),
      };
    });
  }

  /** The view a page draws: its sets, in round order. */
  function pageView(feed, page) {
    return subView(feed, page.setIds);
  }

  /** Positions for one page: its bands laid out together, each side wrapped as paginate chose. */
  function layoutPage(feed, page, m = METRICS) {
    return layoutView(feed, pageView(feed, page), m, { wrap: page.wrap });
  }

  /** How long the tour holds a page. */
  function holdMs(page) {
    const n = page?.setIds?.length ?? 0;
    return Math.min(HOLD.maxMs, HOLD.baseMs + HOLD.perSetMs * n);
  }

  // ── Up Next ─────────────────────────────────────────────────────────────────

  const listCard = (m) => ({ w: m.cardW, h: LIST.headH + cardH(m) });

  /** How many Up Next cards fit one screen at the floor. */
  function listCapacity(m = METRICS, vp = VIEWPORT) {
    const { w, h } = listCard(m);
    const s = floorOf(m);
    const cols = Math.max(1, Math.floor((vp.w / s + LIST.gapX) / (w + LIST.gapX)));
    const rows = Math.max(1, Math.floor((vp.h / s + LIST.gapY) / (h + LIST.gapY)));
    return cols * rows;
  }

  /**
   * Up Next's pages: the rows in order, a screenful each.
   * @param {Array<{ setId: string }>} rows
   */
  function paginateList(rows, m = METRICS, vp = VIEWPORT) {
    const cap = listCapacity(m, vp);
    const pages = [];
    for (let i = 0; i < rows.length; i += cap) pages.push(rows.slice(i, i + cap));
    return pages.map((chunk, i) => ({
      key: `U${i + 1}`,
      label: pages.length > 1 ? `Page ${i + 1} of ${pages.length}` : "",
      short: pages.length > 1 ? `${i + 1}/${pages.length}` : "All",
      setIds: chunk.map((r) => r.setId),
      wrap: {},
      scale: layoutList(chunk.length, m, vp).scale,
    }));
  }

  /**
   * A grid for `count` Up Next cards: the column count giving the largest
   * scale (up to LIST.maxScale), filled left to right, top to bottom.
   * Positions are unscaled; the board is drawn at `scale`, centred.
   */
  function layoutList(count, m = METRICS, vp = VIEWPORT) {
    const { w, h } = listCard(m);
    if (count === 0) return { cols: 0, rows: 0, scale: 1, width: 0, height: 0, cells: [], cardW: w, cardH: h };
    let top = null;
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const width = cols * w + (cols - 1) * LIST.gapX;
      const height = rows * h + (rows - 1) * LIST.gapY;
      const scale = Math.min(LIST.maxScale, vp.w / width, vp.h / height);
      if (!top || scale > top.scale + EPS) top = { cols, rows, width, height, scale };
    }
    const cells = [];
    for (let i = 0; i < count; i++) {
      const c = i % top.cols, r = Math.floor(i / top.cols);
      cells.push({ x: c * (w + LIST.gapX), y: r * (h + LIST.gapY) });
    }
    return { ...top, cells, cardW: w, cardH: h };
  }

  // ── The Board camera ────────────────────────────────────────────────────────
  //
  // A camera is { x, y, zoom }: the board point at the viewport's top-left and
  // the scale, or { overview: true } for the whole board fitted. Moves settle
  // on clean edges: a round column's left edge, the gap above a card.

  /** The readable zoom levels: N whole columns fit the width, down to the floor; then 1. */
  function boardZooms(lay, m = METRICS, vp = VIEWPORT) {
    const floor = floorOf(m);
    const colPitch = m.cardW + m.colGap;
    const steps = [];
    for (let n = 12; n >= 1; n--) {
      const s = vp.w / (n * colPitch - m.colGap);
      if (s >= floor - EPS && s < 1 - EPS) steps.push(s);
    }
    steps.push(1);
    const fit = scaleFor(lay.width, lay.height, vp);
    if (fit >= floor - EPS && fit < steps[0] - EPS) steps.unshift(fit);
    return steps;
  }

  function overviewScale(lay, vp = VIEWPORT) {
    return scaleFor(lay.width, lay.height, vp);
  }

  /** Keep the camera on the board: an axis the board doesn't fill is centred. */
  function clampCamera(lay, cam, vp = VIEWPORT) {
    if (!cam || cam.overview) return cam;
    const vw = vp.w / cam.zoom, vh = vp.h / cam.zoom;
    const axis = (v, size, view) => (size <= view ? (size - view) / 2 : Math.min(size - view, Math.max(0, v)));
    return { x: axis(cam.x, lay.width, vw), y: axis(cam.y, lay.height, vh), zoom: cam.zoom };
  }

  /** Clean stops: every column's left edge across, the top of each side and the gap above each card down. */
  function cameraStops(lay, m = METRICS) {
    const xs = new Set([0]);
    const ys = new Set([0]);
    for (const s of lay.sections) {
      ys.add(s.top);
      for (const c of s.columns) xs.add(c.x);
    }
    for (const c of Object.values(lay.cards)) ys.add(Math.max(0, c.y - m.rowGap / 2));
    const sort = (set) => [...set].sort((a, b) => a - b);
    return { xs: sort(xs), ys: sort(ys) };
  }

  const nearest = (list, v) => list.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), list[0]);

  /** Settle a camera on the nearest clean edges, then keep it on the board. */
  function snapCamera(lay, cam, m = METRICS, vp = VIEWPORT) {
    if (!cam || cam.overview) return cam;
    const { xs, ys } = cameraStops(lay, m);
    return clampCamera(lay, { x: nearest(xs, cam.x), y: nearest(ys, cam.y), zoom: cam.zoom }, vp);
  }

  /** The readable camera centred on a board point, at `zoom` (default: the widest readable). */
  function cameraAt(lay, cx, cy, zoom, m = METRICS, vp = VIEWPORT) {
    const z = zoom ?? boardZooms(lay, m, vp)[0];
    return snapCamera(lay, { x: cx - vp.w / z / 2, y: cy - vp.h / z / 2, zoom: z }, m, vp);
  }

  /** Framed on `setIds`: centred on `focusId` when it's one of them, else on their middle. */
  function cameraForSets(lay, setIds, focusId = null, m = METRICS, vp = VIEWPORT) {
    const cards = (setIds ?? []).map((id) => lay.cards[id]).filter(Boolean);
    const f = focusId != null ? lay.cards[focusId] : null;
    if (f && setIds.includes(String(focusId))) return cameraAt(lay, f.x + m.cardW / 2, f.y + m.rowH, null, m, vp);
    if (cards.length === 0) return cameraAt(lay, lay.width / 2, lay.height / 2, null, m, vp);
    const x0 = Math.min(...cards.map((c) => c.x)), x1 = Math.max(...cards.map((c) => c.x + m.cardW));
    const y0 = Math.min(...cards.map((c) => c.y)), y1 = Math.max(...cards.map((c) => c.y + cardH(m)));
    const z = boardZooms(lay, m, vp)[0];
    // Wider than the screen: start at its left/top edge rather than its middle.
    const cx = x1 - x0 > vp.w / z ? x0 + vp.w / z / 2 : (x0 + x1) / 2;
    const cy = y1 - y0 > vp.h / z ? y0 + vp.h / z / 2 : (y0 + y1) / 2;
    return cameraAt(lay, cx, cy, z, m, vp);
  }

  /** One press: a column across, or about half a screen down to the next clean edge. */
  function moveCamera(lay, cam, dir, m = METRICS, vp = VIEWPORT) {
    if (!cam || cam.overview) return cam;
    const { xs, ys } = cameraStops(lay, m);
    let { x, y } = cam;
    const vh = vp.h / cam.zoom;
    if (dir === "left") x = [...xs].reverse().find((v) => v < x - 1) ?? 0;
    else if (dir === "right") x = xs.find((v) => v > x + 1) ?? x;
    else if (dir === "up") {
      const target = y - vh / 2;
      const up = ys.filter((v) => v < y - 1);
      y = up.length ? nearest(up, target) : 0;
    } else if (dir === "down") {
      const target = y + vh / 2;
      const down = ys.filter((v) => v > y + 1);
      y = down.length ? nearest(down, target) : y;
    }
    return clampCamera(lay, { x, y, zoom: cam.zoom }, vp);
  }

  /** One zoom step in or out, about the screen's centre. */
  function zoomCamera(lay, cam, dir, m = METRICS, vp = VIEWPORT) {
    if (!cam || cam.overview) return cam;
    const steps = boardZooms(lay, m, vp);
    let i = steps.findIndex((s) => Math.abs(s - cam.zoom) < 1e-6);
    if (i < 0) i = steps.findIndex((s) => s > cam.zoom);
    if (i < 0) i = steps.length - 1;
    const next = steps[Math.max(0, Math.min(steps.length - 1, i + (dir === "in" ? 1 : -1)))];
    const cx = cam.x + vp.w / cam.zoom / 2, cy = cam.y + vp.h / cam.zoom / 2;
    return cameraAt(lay, cx, cy, next, m, vp);
  }

  /** The transform that shows a camera: { scale, x, y } for translate(x, y) scale(scale). */
  function cameraTransform(lay, cam, vp = VIEWPORT) {
    if (!cam || cam.overview) {
      const s = overviewScale(lay, vp);
      return { scale: s, x: (vp.w - lay.width * s) / 2, y: (vp.h - lay.height * s) / 2 };
    }
    const c = clampCamera(lay, cam, vp);
    return { scale: c.zoom, x: -c.x * c.zoom, y: -c.y * c.zoom };
  }

  const api = {
    METRICS, VIEWPORT, LIST, HOLD,
    layoutBracket, layoutView, layoutPage, pageView, subView, prunedView, paginate, holdMs,
    paginateList, layoutList, listCapacity,
    actionSetId, fitScale, shortRound, elbow, splitContiguous,
    boardZooms, clampCamera, snapCamera, cameraAt, cameraForSets, moveCamera, zoomCamera,
    cameraTransform, overviewScale, cameraStops,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BracketLayout = api;
})(typeof window !== "undefined" ? window : globalThis);
