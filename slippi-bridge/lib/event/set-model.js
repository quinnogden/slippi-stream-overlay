/**
 * set-model.js — bracket sets as the operator sees them: what loading a set puts
 * on the scoreboard, and which sets the dock's picker offers first.
 *
 * Pure. Works off bracket-model.js's graph rather than raw start.gg sets, because
 * whether a slot came up through losers (the [L] tag) is a fact about the graph,
 * not about the set.
 */

const PICK_ORDER = { playable: 0, live: 1, waiting: 2, done: 3 };

/**
 * What loading `setId` puts on the scoreboard.
 *
 * @param {ReturnType<import("./bracket-model").buildBracket>} graph
 * @param {string} setId
 * @returns {null | {
 *   setId: string, phaseGroupId: string|null, roundName: string, identifier: string,
 *   lPlacement: number|null, isGrandFinal: boolean, isReset: boolean, isPreview: boolean,
 *   state: string,
 *   sides: Array<{ entrantId: string|null, seed: number|null, name: string, score: number,
 *                  fromLosers: boolean, players: Array<{ playerId: string|null, tag: string, prefix: string }> }>
 * }}
 */
function loadPayload(graph, setId) {
  const set = graph?.sets?.[String(setId)];
  if (!set) return null;
  return {
    setId: set.id,
    phaseGroupId: graph.phaseGroupId,
    roundName: set.name,
    identifier: set.identifier,
    lPlacement: set.lPlacement,
    isGrandFinal: set.side === "GF",
    isReset: set.side === "GFR",
    isPreview: set.preview,
    state: set.state,
    sides: set.slots.map((slot) => {
      const ent = slot.entrantId ? graph.entrants[slot.entrantId] : null;
      return {
        entrantId: slot.entrantId,
        seed: slot.seed,
        name: ent?.name ?? "",
        // A set loaded mid-way (another setup started it) keeps its games; a DQ
        // score (-1) or a not-yet-reported null both start the scoreboard at 0.
        score: slot.score > 0 ? slot.score : 0,
        fromLosers: set.side === "GFR" || !!slot.fromLosers,
        players: (ent?.players ?? []).map((p) => ({ ...p })),
      };
    }),
  };
}

/**
 * Where a set belongs in the picker.
 *   playable — both players known and nobody has started it: one tap to put on stream
 *   live     — in progress on start.gg (another setup is playing it)
 *   waiting  — a slot is still waiting on an earlier set
 *   done     — finished
 */
function pickStatus(set) {
  if (set.state === "done") return "done";
  if (set.state === "live") return "live";
  return set.slots.every((s) => s.entrantId) ? "playable" : "waiting";
}

/**
 * The picker's list: playable sets first, then live, then waiting; finished sets
 * only on request. Within a group, earliest in the bracket first (those are the
 * sets holding it up), then winners before losers, then top to bottom.
 *
 * @param {ReturnType<import("./bracket-model").buildBracket>} graph
 * @param {{ includeDone?: boolean }} [opts]
 * @returns {Array<{ setId: string, status: string, roundName: string, identifier: string,
 *                   names: [string, string], seeds: [number|null, number|null],
 *                   scores: [number|null, number|null], preview: boolean }>}
 */
function pickerList(graph, opts = {}) {
  const position = new Map();
  graph.rounds.forEach((r, ri) => r.setIds.forEach((id, si) => position.set(id, ri * 1000 + si)));
  // lPlacement is the bracket's own "how early is this": a set whose loser
  // finishes 17th comes before one whose loser finishes 9th, on either side.
  // Round numbers can't say that — losers numbering starts wherever start.gg
  // likes (-4 in a 22-entrant bracket).
  const lp = (set) => set.lPlacement ?? 0;

  return Object.values(graph.sets)
    .map((set) => ({ set, status: pickStatus(set) }))
    .filter(({ status }) => opts.includeDone || status !== "done")
    .sort((a, b) =>
      PICK_ORDER[a.status] - PICK_ORDER[b.status] ||
      lp(b.set) - lp(a.set) ||
      position.get(a.set.id) - position.get(b.set.id))
    .map(({ set, status }) => ({
      setId: set.id,
      status,
      roundName: set.name,
      identifier: set.identifier,
      names: set.slots.map((s) => (s.entrantId ? graph.entrants[s.entrantId]?.name ?? "" : "")),
      seeds: set.slots.map((s) => s.seed),
      scores: set.slots.map((s) => s.score),
      preview: set.preview,
    }));
}

module.exports = { loadPayload, pickStatus, pickerList, PICK_ORDER };
