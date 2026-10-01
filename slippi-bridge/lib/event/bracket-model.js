/**
 * bracket-model.js — a start.gg phase group as a graph the bracket overlay can draw.
 *
 * Pure: raw start.gg sets in, plain data out. No I/O, no clock.
 *
 * The graph is built from start.gg's own edges — every slot names what fills it
 * (`prereqType` "seed" or "set", `prereqId`, `prereqPlacement` 1 = winner of,
 * 2 = loser of). TSH instead rebuilt the tree from the seed count and renumbered
 * rounds to suit its view; following the edges means a bracket start.gg can draw,
 * this can draw, byes and odd entrant counts included.
 *
 * Facts about start.gg's sets this relies on (all visible in
 * tests/fixtures/startgg/):
 *
 *   - `round` > 0 is winners, < 0 is losers. Losers numbering need not start at
 *     -1 (a 22-entrant bracket's losers start at -4); only the order matters.
 *   - **A bye is an edge to a set that isn't in the list.** start.gg never returns
 *     bye sets, but the slot still names one, and its entrant is already filled in.
 *   - **The grand final reset** is the set whose two slots both come from the
 *     same set (the grand final, placements 1 and 2). Once a grand final is won
 *     from the winners side, start.gg deletes the reset — so a missing reset is
 *     normal, and a present one is only certain once the losers side won GF 1.
 *   - **The grand final** is the winners-side set fed by a losers-side set. The
 *     name is the fallback: an unstarted 2-entrant bracket's GF names a losers
 *     final that doesn't exist (a bye), so the structure alone can't see it.
 *   - **A DQ** is a score of -1 on the DQ'd slot (and null on the other), with
 *     `displayScore` "DQ". The winner is still set.
 *   - Unstarted ("preview") sets have string ids `preview_…`, and already carry
 *     their edges and `lPlacement` — which is what lets the top-8 rule work before
 *     the bracket starts.
 *   - `lPlacement` is where the set's loser finishes if they lose out from here.
 *     That is the "top N" test: a set is top 8 when its loser is guaranteed 8th or
 *     better, i.e. lPlacement ≤ 8 — exactly winners semis, losers top 8 and on.
 *
 * Ids are compared as strings throughout: start.gg returns set ids as numbers but
 * `prereqId` as a string.
 */

const VIEWS = ["winners", "losers", "top8", "top16", "full"];

const sid = (v) => (v == null ? null : String(v));

/** start.gg set state → the three things the overlay distinguishes. */
function stateOf(raw) {
  if (Number(raw.state) === 3) return "done";
  if (Number(raw.state) === 2) return "live";
  return "pending";
}

function entrantOf(slot) {
  const e = slot?.entrant;
  if (!e || e.id == null) return null;
  return {
    id: sid(e.id),
    name: e.name ?? "",
    seed: slot.seed?.seedNum ?? e.initialSeedNum ?? null,
    players: (e.participants ?? []).map((p) => ({
      playerId: sid(p.player?.id),
      tag: p.player?.gamerTag ?? p.gamerTag ?? "",
      prefix: p.player?.prefix ?? p.prefix ?? "",
    })),
  };
}

function scoreOf(slot) {
  const v = slot?.standing?.stats?.score?.value;
  return typeof v === "number" ? v : null;
}

/**
 * Build the graph for one phase group.
 *
 * @param {Array<object>} rawSets — PhaseGroup.sets nodes (see scripts/capture-startgg.js SET_FIELDS)
 * @param {{ phaseGroupId?: string|number, bracketType?: string }} [meta]
 * @returns {{
 *   phaseGroupId: string|null, bracketType: string|null, preview: boolean,
 *   entrants: Record<string, object>, sets: Record<string, object>,
 *   rounds: Array<{ key: string, side: string, round: number, name: string, setIds: string[] }>,
 * }}
 */
function buildBracket(rawSets, meta = {}) {
  const raw = new Map();
  for (const s of rawSets ?? []) if (s?.id != null) raw.set(sid(s.id), s);

  const entrants = {};
  const sets = {};

  // ── Pass 1: nodes ───────────────────────────────────────────────────────────
  for (const [id, s] of raw) {
    const slots = [0, 1].map((i) => {
      const slot = (s.slots ?? []).find((x) => x.slotIndex === i) ?? s.slots?.[i] ?? null;
      const ent = entrantOf(slot);
      if (ent) entrants[ent.id] = { ...entrants[ent.id], ...ent };
      const score = scoreOf(slot);
      const preId = sid(slot?.prereqId);
      let from;
      if (slot?.prereqType === "set") {
        from = raw.has(preId)
          ? { kind: "set", setId: preId, placement: slot.prereqPlacement ?? 1 }
          : { kind: "bye" };
      } else if (slot?.prereqType === "seed") {
        from = { kind: "seed" };
      } else {
        from = { kind: "bye" };
      }
      return { entrantId: ent?.id ?? null, seed: ent?.seed ?? null, score, dq: score === -1, from };
    });

    const winnerId = sid(s.winnerId);
    const winner = winnerId == null ? null
      : slots[0].entrantId === winnerId ? 0
      : slots[1].entrantId === winnerId ? 1
      : null;

    sets[id] = {
      id,
      identifier: s.identifier ?? "",
      round: Number(s.round) || 0,
      name: s.fullRoundText ?? "",
      side: Number(s.round) < 0 ? "L" : "W", // GF / GFR resolved in pass 2
      lPlacement: s.lPlacement ?? null,
      wPlacement: s.wPlacement ?? null,
      state: stateOf(s),
      preview: id.startsWith("preview"),
      dq: slots.some((x) => x.dq) || s.displayScore === "DQ",
      winner,
      slots,
      next: { win: null, lose: null },
      conditional: false,
    };
  }

  // ── Pass 2: edges, grand finals ─────────────────────────────────────────────
  for (const set of Object.values(sets)) {
    for (const slot of set.slots) {
      if (slot.from.kind !== "set") continue;
      const feeder = sets[slot.from.setId];
      if (slot.from.placement === 2) feeder.next.lose = set.id;
      else feeder.next.win = set.id;
    }
  }

  for (const set of Object.values(sets)) {
    if (set.side !== "W") continue;
    const [a, b] = set.slots.map((x) => x.from);
    const isReset = a.kind === "set" && b.kind === "set" && a.setId === b.setId;
    if (isReset) {
      set.side = "GFR";
      sets[a.setId].side = "GF";
      continue;
    }
    const fedByLosers = set.slots.some((x) => x.from.kind === "set" && sets[x.from.setId].round < 0);
    if (fedByLosers || /^grand final(?! reset)/i.test(set.name)) set.side = "GF";
  }

  // The reset only happens if the losers-side player takes GF 1. Until GF 1 is
  // done it is a maybe; start.gg deletes it when the winners side wins, so a
  // reset still present after a finished GF is real.
  for (const set of Object.values(sets)) {
    if (set.side !== "GFR") continue;
    const gf = sets[set.slots[0].from.setId];
    set.conditional = gf.state !== "done";
  }

  // Grand-final slots: which one came up through losers. Read by set-model for
  // the [L] tag, and by the overlay for its drop-in label.
  for (const set of Object.values(sets)) {
    if (set.side !== "GF") continue;
    set.slots.forEach((slot, i) => {
      const f = slot.from;
      slot.fromLosers = f.kind === "set"
        ? sets[f.setId].round < 0
        // Bye or missing feeder (an unstarted tiny bracket): start.gg puts the
        // winners-side entrant in slot 0.
        : i === 1;
    });
  }

  // Drop-in labels: a losers slot filled by the LOSER of a winners set.
  for (const set of Object.values(sets)) {
    if (set.side !== "L") continue;
    for (const slot of set.slots) {
      const f = slot.from;
      if (f.kind !== "set" || f.placement !== 2) continue;
      const feeder = sets[f.setId];
      if (feeder.side !== "W") continue;
      f.dropIn = { identifier: feeder.identifier, roundName: feeder.name };
    }
  }

  return {
    phaseGroupId: sid(meta.phaseGroupId) ?? null,
    bracketType: meta.bracketType ?? null,
    preview: Object.values(sets).some((s) => s.preview),
    entrants,
    sets,
    rounds: roundsOf(sets),
  };
}

/** Winners rounds left to right, then GF and the reset; losers rounds separately, outward to in. */
function roundsOf(sets) {
  const groups = new Map();
  for (const set of Object.values(sets)) {
    const key = set.side === "GF" ? "GF" : set.side === "GFR" ? "GFR" : `${set.side}${Math.abs(set.round)}`;
    if (!groups.has(key)) groups.set(key, { key, side: set.side, round: set.round, name: set.name, setIds: [] });
    groups.get(key).setIds.push(set.id);
  }
  const order = { W: 0, GF: 1, GFR: 2, L: 3 };
  const rounds = [...groups.values()].sort((a, b) =>
    order[a.side] - order[b.side] || Math.abs(a.round) - Math.abs(b.round));
  // Sets within a round in start.gg's identifier order (A, B, … Z, AA, …) —
  // the bracket's own top-to-bottom order.
  const idOrder = (s) => [s.identifier.length, s.identifier];
  for (const r of rounds) {
    r.setIds.sort((x, y) => {
      const [la, a] = idOrder(sets[x]);
      const [lb, b] = idOrder(sets[y]);
      return la - lb || (a < b ? -1 : a > b ? 1 : 0);
    });
  }
  return rounds;
}

/**
 * The part of the graph one overlay view shows.
 *
 *   winners — the winners side plus grand finals (the right-hand end of it)
 *   losers  — the losers side only
 *   top8 / top16 — every set whose loser is guaranteed that placement or better
 *   full    — everything
 *
 * A set whose feeder is outside the view keeps its edge but is marked
 * `fedFromOutside`, so the layout treats that slot as a leaf instead of
 * reaching for a column that isn't drawn.
 *
 * @param {ReturnType<typeof buildBracket>} graph
 * @param {string} view — one of VIEWS
 * @returns {{ view: string, rounds: typeof graph.rounds, setIds: string[], fedFromOutside: Record<string, boolean[]> }}
 */
function selectView(graph, view) {
  if (!VIEWS.includes(view)) throw new Error(`unknown bracket view "${view}" (expected ${VIEWS.join(", ")})`);
  const keep = (s) => {
    switch (view) {
      case "winners": return s.side !== "L";
      case "losers":  return s.side === "L";
      case "top8":    return isTopN(s, 8);
      case "top16":   return isTopN(s, 16);
      default:        return true;
    }
  };
  const ids = new Set(Object.values(graph.sets).filter(keep).map((s) => s.id));
  const rounds = graph.rounds
    .map((r) => ({ ...r, setIds: r.setIds.filter((id) => ids.has(id)) }))
    .filter((r) => r.setIds.length > 0);
  const fedFromOutside = {};
  for (const id of ids) {
    fedFromOutside[id] = graph.sets[id].slots.map((x) => x.from.kind === "set" && !ids.has(x.from.setId));
  }
  return { view, rounds, setIds: rounds.flatMap((r) => r.setIds), fedFromOutside };
}

/**
 * True when the set's loser is guaranteed `n`th or better — the top-8 / top-16
 * test. Grand finals always qualify (lPlacement 2).
 * @param {{ lPlacement: number|null }} set
 * @param {number} n
 */
function isTopN(set, n) {
  return set.lPlacement != null && set.lPlacement <= n;
}

module.exports = { buildBracket, selectView, isTopN, VIEWS };
