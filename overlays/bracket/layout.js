/**
 * layout.js — where every card and connector of a bracket view goes.
 *
 * Pure: the `bracket` state section (lib/event/bracket-feed.js) and a view
 * name in, positions in unscaled 1080p pixels out. No DOM, so
 * tests/bracket-layout.test.js runs it under Node on captured tournaments.
 * bracket.js draws the result and scales it to fit.
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
    nameSize: 28,       // px at scale 1
    floorNamePx: 22,    // the legibility floor: never scale names below this
  };

  const cardH = (m) => m.rowH * 2;

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

  /**
   * @param {object} feed — the state's `bracket` section
   * @param {string} viewName — winners | losers | top8 | top16 | full
   * @param {object} [m] — METRICS
   * @returns {{
   *   width: number, height: number,
   *   sections: Array<{ key: "W"|"L", top: number, columns: Array<{ key, name, x, setIds }> }>,
   *   cards: Record<string, { x: number, y: number }>,
   *   links: Array<{ from: string, to: string, slot: number|null, lit: boolean, d: string }>,
   *   tags: Record<string, Array<{ label: string, loser: boolean } | null>>,
   *   focus: { x: number, y: number } | null,
   * }}
   */
  function layoutBracket(feed, viewName, m = METRICS) {
    const empty = { width: 0, height: 0, sections: [], cards: {}, links: [], tags: {}, focus: null };
    const view = feed?.views?.[viewName];
    if (!view || view.setIds.length === 0) return empty;

    const sets = feed.sets;
    const inView = new Set(view.setIds);
    const H = cardH(m);
    const pitch = H + m.rowGap;

    const out = { ...empty, cards: {}, links: [], tags: {}, sections: [] };
    let top = 0;

    for (const key of ["W", "L"]) {
      const rounds = view.rounds.filter((r) => r.setIds.length && sectionOf(sets[r.setIds[0]]) === key);
      if (rounds.length === 0) continue;

      const column = {};
      rounds.forEach((r, i) => r.setIds.forEach((id) => { column[id] = i; }));
      const ids = rounds.flatMap((r) => r.setIds);

      // Children in slot order; a set fed twice by the same set (the reset) once.
      const children = (id) => {
        const kids = [];
        for (const slot of sets[id].slots) {
          const f = slot.from;
          if (f.kind !== "set" || !inView.has(f.setId)) continue;
          if (sectionOf(sets[f.setId]) !== key) continue;
          if (f.placement === 2 && sets[id].side !== "GFR") continue; // a drop-in
          if (!kids.includes(f.setId)) kids.push(f.setId);
        }
        return kids;
      };
      const parentOf = {};
      for (const id of ids) for (const k of children(id)) parentOf[k] = id;

      // Roots: the rightmost first (the final), then any stragglers top-down.
      const roots = ids.filter((id) => !parentOf[id])
        .sort((a, b) => column[b] - column[a]);

      const y = {};
      let nextRow = 0;
      const place = (id) => {
        const kids = children(id);
        kids.forEach(place);
        if (kids.length === 0) {
          y[id] = nextRow;
          nextRow += pitch;
        } else {
          y[id] = kids.reduce((sum, k) => sum + y[k], 0) / kids.length;
        }
      };
      roots.forEach(place);

      // Rows were assigned from the final backwards, so a root placed later
      // can sit above an earlier one's leaves — normalise to start at 0.
      const minY = Math.min(...ids.map((id) => y[id]));
      const cardsTop = top + m.headerH;
      for (const id of ids) {
        out.cards[id] = { x: column[id] * (m.cardW + m.colGap), y: cardsTop + y[id] - minY };
      }

      out.sections.push({
        key,
        top,
        columns: rounds.map((r, i) => ({
          key: r.key,
          name: r.name,
          x: i * (m.cardW + m.colGap),
          setIds: r.setIds,
        })),
      });

      for (const id of ids) {
        const kids = children(id);
        const slots = sets[id].slots;
        for (const k of kids) {
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

      const bottom = Math.max(...ids.map((id) => out.cards[id].y + H));
      out.width = Math.max(out.width, rounds.length * (m.cardW + m.colGap) - m.colGap);
      top = bottom + m.sectionGap;
      out.height = bottom;
    }

    out.focus = focusOf(view.setIds.map((id) => sets[id]), out.cards, m);
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
   * Where a pan starts: the leftmost set being played, else the leftmost set
   * ready to be played, else the set finished most recently.
   */
  function focusOf(list, cards, m) {
    const center = (s) => ({ x: cards[s.id].x + m.cardW / 2, y: cards[s.id].y + m.rowH });
    const byX = (a, b) => cards[a.id].x - cards[b.id].x || cards[a.id].y - cards[b.id].y;
    const live = list.filter((s) => s.state === "live").sort(byX);
    if (live.length) return center(live[0]);
    const ready = list.filter((s) => s.state === "pending" && s.slots.every((x) => x.entrantId)).sort(byX);
    if (ready.length) return center(ready[0]);
    // By start.gg's completion time, falling back to the rightmost column.
    // (The losers side runs further right than the grand final, so
    // "rightmost" alone would open a finished bracket on the losers final.)
    const done = list.filter((s) => s.state === "done")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)
        || cards[b.id].x - cards[a.id].x || cards[a.id].y - cards[b.id].y);
    if (done.length) return center(done[0]);
    return list.length ? center([...list].sort(byX)[0]) : null;
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
   * overflow are panned.
   */
  function fitScale(width, height, viewW, viewH, m = METRICS) {
    const floor = m.floorNamePx / m.nameSize;
    if (!width || !height) return { scale: 1, floor, panX: false, panY: false };
    const fit = Math.min(1, viewW / width, viewH / height);
    const scale = Math.max(fit, floor);
    return { scale, floor, panX: width * scale > viewW + 0.5, panY: height * scale > viewH + 0.5 };
  }

  const api = { layoutBracket, fitScale, shortRound, elbow, METRICS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BracketLayout = api;
})(typeof window !== "undefined" ? window : globalThis);
