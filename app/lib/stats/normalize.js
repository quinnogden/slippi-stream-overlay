/**
 * Pure shaping for the side panel's stats: start.gg nodes in, display records
 * out. No I/O — lib/stats/index.js does the fetching, and tests drive these
 * directly.
 *
 * Everything leaving here is keyed by start.gg **player id**, never by column.
 * The side panel orients each record against the ids on each side of the
 * scoreboard *right now*, so Switch Sides needs no refetch, and a snapshot that
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

// ── luckystats.gg ───────────────────────────────────────────────────────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// What a card can show, or null: a rank is a whole number from 1, a name is
// text. Anything else luckystats sends is treated as missing.
const place = (v) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
};
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * A luckystats answer, keyed by start.gg player id like everything else here.
 *
 * Each player is placed by the `startggUserId` it came back with, never by its
 * position: a player luckystats doesn't know is simply missing from the list,
 * and an id that isn't the one we asked for is someone else entirely. The
 * matchup is placed by its own `order` the same way.
 *
 * The win probability is luckystats' `glickoOnly`, not `blended`: blended mixes
 * in luckystats' head-to-head, which undercounts against start.gg's (ZODD-01
 * vs NAV: 60–23 there, 69–25 on start.gg). The ratings alone don't disagree
 * with anything we show.
 *
 * The region is the player's public Region — its name and its artwork — when
 * they're on one, else their calculated `primaryRegion`. Never a crew: the
 * card labels it "Region", and `displayRegion` falls back to a crew. Their
 * place in the region's ranking is the player's own `regionRank`, a sibling
 * of `primaryRegion` (not inside `displayRegion`).
 *
 * `classSvg` and `regionImage` are luckystats' urls, for the caller to save
 * and swap for the app's own (luckystats.js).
 *
 * @param {object} body — the /api/stream/players response
 * @param {Object<string,string>} userToPlayer — start.gg user id → player id, for the ids asked for
 * @returns {{ ratings: Object<string, object>, matchup: object|null }}
 */
function luckyFromResponse(body, userToPlayer) {
  const ratings = {};
  for (const p of body?.players ?? []) {
    const pid = userToPlayer[String(p?.startggUserId)];
    if (!pid) continue;
    const d = p.displayRegion;
    const region = d?.source === "region" && text(d.name) ? d : null;
    ratings[pid] = {
      rank: place(p.luckyRank?.rank),        // Lucky Rank; null when unranked
      className: text(p.playerClass?.name),
      classKey: text(p.playerClass?.key),
      classSvg: text(p.playerClass?.svgUrl),
      region: text(region?.name) || text(p.primaryRegion) || (d?.source === "calculated" ? text(d.name) : null),
      regionImage: text(region?.imageUrl),
      regionRank: place(p.regionRank),       // in their region's ranking; null without one
    };
  }

  let matchup = null;
  const m = body?.matchup;
  const prob = m?.winProbability?.glickoOnly;
  if (m?.ok && Array.isArray(m.order) && m.order.length === 2) {
    const [p1, p2] = m.order.map((u) => userToPlayer[String(u)]);
    if (p1 && p2 && p1 !== p2 && ratings[p1] && ratings[p2] && num(prob?.player1) !== null && num(prob?.player2) !== null) {
      matchup = { winProbability: { [p1]: prob.player1, [p2]: prob.player2 } };
    }
  }
  return { ratings, matchup };
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

module.exports = {
  headToHead, h2hPill, luckyFromResponse,
  historyFromStandings, runFromEventSets, completedFromEventSets,
};
