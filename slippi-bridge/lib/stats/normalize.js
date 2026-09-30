/**
 * Pure shaping for the side panel's stats: start.gg nodes in, display records
 * out. No I/O — lib/stats/index.js does the fetching, and tests drive these
 * directly.
 *
 * Everything leaving here is keyed by start.gg **player id**, never by TSH
 * column. The side panel orients each record against the ids TSH shows on each
 * side *right now*, so a Swap Teams needs no refetch, and a snapshot that
 * arrives late for a pair that is no longer loaded simply fails to match
 * instead of putting the previous pair's record under the new names.
 */

const { MELEE_VIDEOGAME_ID } = require("./queries");

/** A slot's game count; null when the set was reported as a bare winner. */
function slotScore(slot) {
  const v = slot?.standing?.stats?.score?.value;
  return typeof v === "number" ? v : null;
}

/** start.gg marks a DQ as a score of -1, and its display string as "DQ". */
function isDqNode(node) {
  return node?.displayScore === "DQ" || (node?.slots ?? []).some((s) => (slotScore(s) ?? 0) < 0);
}

const participants = (slot) => slot?.entrant?.participants ?? [];
const playerIdsOf  = (slot) => participants(slot).map((p) => String(p?.player?.id ?? ""));

// ── Head-to-head ────────────────────────────────────────────────────────────

/**
 * Every singles Melee set between two players, from both players' histories.
 *
 * The rules, each checked against a hand-verified record (ZODD-01's):
 *
 *   - **Find the opponent by id; the other side is the player.** Not the
 *     reverse. start.gg's merged player record keeps sets played under old
 *     tags, but their slots still carry the *old* player id — ZODD-01's two
 *     wins over Redd as "CG | JI" sit under id 5297839. Requiring the player's
 *     current id on their own side drops them.
 *   - **Both histories are read, and unioned by set id.** From A's history that
 *     catches A-under-an-old-id vs B; from B's, A vs B-under-an-old-id.
 *   - **Melee only.** Player.sets spans every game (ZODD-01 vs Redd includes a
 *     Project M set at Tiger Smash 4).
 *   - **Singles only** — one participant per side. Decided per set, not from
 *     the event's name.
 *   - **Finished, not DQ'd, with a winner.**
 *
 * @param {object[]} setsA — pidA's history (set-history.js compact records)
 * @param {object[]} setsB — pidB's history
 * @param {string} pidA
 * @param {string} pidB
 * @returns {{ sets: Array<{ id: string, when: number, winner: string, entrants: Object<string,string> }>, wins: Object<string, number> }}
 */
function headToHead(setsA, setsB, pidA, pidB) {
  pidA = String(pidA);
  pidB = String(pidB);
  const found = new Map();

  const take = (list, owner, opponent) => {
    for (const s of list ?? []) {
      if (found.has(s.id)) continue;
      if (s.state !== 3 || s.dq || !s.winnerId) continue;
      if (s.videogameId !== String(MELEE_VIDEOGAME_ID)) continue;
      const slots = s.slots ?? [];
      if (slots.length !== 2 || !slots.every((sl) => sl && sl.players.length === 1)) continue;

      const oppSlot = slots.find((sl) => sl.players[0] === opponent);
      if (!oppSlot) continue;
      const ownSlot = slots.find((sl) => sl !== oppSlot);

      found.set(s.id, {
        id: s.id,
        when: s.completedAt || s.eventStartAt || 0,
        winner: s.winnerId === ownSlot.entrantId ? owner : s.winnerId === oppSlot.entrantId ? opponent : null,
        entrants: { [owner]: ownSlot.entrantId, [opponent]: oppSlot.entrantId },
      });
    }
  };
  take(setsA, pidA, pidB);
  take(setsB, pidB, pidA);

  const sets = [...found.values()]
    .filter((s) => s.winner !== null)
    .sort((a, b) => b.when - a.when || Number(b.id) - Number(a.id));

  const wins = { [pidA]: 0, [pidB]: 0 };
  for (const s of sets) wins[s.winner]++;
  return { sets, wins };
}

/**
 * One head-to-head set as a pill draws it, from a set(id) detail node.
 * @param {object} node — setDetailsQuery() result
 * @param {{ winner: string, entrants: Object<string,string>, when: number }} h2hSet
 */
function h2hPill(node, h2hSet) {
  const scores = {};
  for (const [pid, entrantId] of Object.entries(h2hSet.entrants)) {
    const slot = (node?.slots ?? []).find((s) => String(s?.entrant?.id) === entrantId);
    scores[pid] = slotScore(slot);
  }
  return {
    id: h2hSet.id,
    tournament: node?.event?.tournament?.name ?? "",
    event: node?.event?.name ?? "",
    round: node?.fullRoundText ?? "",
    online: Boolean(node?.event?.isOnline),
    completedAt: node?.completedAt || node?.event?.startAt || h2hSet.when || null,
    winner: h2hSet.winner,
    scores,
  };
}

// ── Player cards ────────────────────────────────────────────────────────────

/**
 * Past singles placements, newest first. The loaded event's own standing is
 * left out: it isn't final while the event is running.
 * @param {object[]} standings — player.recentStandings
 * @param {string|null} currentEventId
 */
function historyFromStandings(standings, currentEventId) {
  return (standings ?? [])
    .filter((s) => s && s.isFinal !== false && s.container?.name)
    .filter((s) => !currentEventId || String(s.container.id) !== String(currentEventId))
    .map((s) => ({
      tournament: s.container.tournament?.name ?? "",
      event: s.container.name,
      placement: s.placement ?? null,
      entrants: s.container.numEntrants ?? null,
      startAt: s.container.startAt ?? null,
      online: Boolean(s.container.isOnline),
    }));
}

/**
 * A player's finished sets in the loaded event, newest first.
 * @param {object[]} nodes — ResultSet nodes for the event
 * @param {string} pid
 */
function runFromEventSets(nodes, pid) {
  pid = String(pid);
  const out = [];
  for (const n of nodes ?? []) {
    if (!n || isDqNode(n)) continue;
    const slots = n.slots ?? [];
    const mine = slots.find((s) => playerIdsOf(s).includes(pid));
    const theirs = slots.find((s) => s !== mine);
    if (!mine || !theirs) continue;
    out.push({
      id: String(n.id),
      opponent: participants(theirs)[0]?.gamerTag ?? theirs.entrant?.name ?? "",
      round: n.fullRoundText ?? "",
      myScore: slotScore(mine),
      oppScore: slotScore(theirs),
      won: String(n.winnerId) === String(mine.entrant?.id),
      completedAt: n.completedAt ?? null,
    });
  }
  return out.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}

// ── Just finished ───────────────────────────────────────────────────────────

/**
 * The loaded event's most recently finished sets, newest first. Singles shows
 * each player's tag; doubles, the team's entrant name.
 * @param {object[]} nodes — ResultSet nodes
 */
function completedFromEventSets(nodes) {
  const out = [];
  for (const n of nodes ?? []) {
    if (!n || !n.winnerId || isDqNode(n)) continue;
    const slots = n.slots ?? [];
    if (slots.length !== 2 || !slots.every((s) => s?.entrant)) continue;
    const name = (s) => {
      const ps = participants(s);
      return ps.length === 1 ? (ps[0]?.gamerTag ?? s.entrant.name ?? "") : (s.entrant.name ?? "");
    };
    out.push({
      id: String(n.id),
      round: n.fullRoundText ?? "",
      names: [name(slots[0]), name(slots[1])],
      scores: [slotScore(slots[0]), slotScore(slots[1])],
      winner: String(n.winnerId) === String(slots[0].entrant.id) ? 0 : 1,
      completedAt: n.completedAt ?? null,
    });
  }
  return out.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}

/** Player ids in the stream queue, in queue order, deduped. */
function queuedPlayerIds(streamQueue, limitSets) {
  const ids = [];
  for (const q of streamQueue ?? []) {
    for (const set of (q?.sets ?? []).slice(0, limitSets)) {
      for (const slot of set?.slots ?? []) {
        for (const id of playerIdsOf(slot)) if (id && !ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

module.exports = {
  headToHead,
  h2hPill,
  historyFromStandings,
  runFromEventSets,
  completedFromEventSets,
  queuedPlayerIds,
  slotScore,
};
