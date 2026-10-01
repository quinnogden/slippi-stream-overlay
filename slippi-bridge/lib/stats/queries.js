/**
 * The start.gg GraphQL queries behind the side panel's stats.
 *
 * Every one of these is sized against start.gg's hard ceiling of 1000 objects
 * per response — over it, the *whole* response is refused, not trimmed. That
 * ceiling is what breaks TSH's own head-to-head (it asks for 10 events with up
 * to 100 sets each, gets refused, and reads the refusal as "no sets"). The
 * object counts noted below are per node, so a change to a selection set should
 * recheck the page size next to it.
 *
 * Ids are interpolated into the aliased batch queries rather than passed as
 * variables, because each alias needs its own; `idList()` refuses anything that
 * isn't a plain positive integer, so nothing else can reach the query text.
 */

// start.gg's videogame id for Melee. Player.sets spans every game a player has
// entered — ZODD-01's includes Project M — so this filter is load-bearing.
const MELEE_VIDEOGAME_ID = 1;

/** @param {Array<string|number>} ids @returns {string[]} */
function idList(ids) {
  return ids.map((id) => {
    const s = String(id);
    if (!/^[1-9]\d*$/.test(s)) throw new Error(`not a start.gg id: ${JSON.stringify(id)}`);
    return s;
  });
}

// ── A player's whole set history ────────────────────────────────────────────
//
// Player.sets is the only source that reaches a player's full history: it
// follows start.gg's merged player record, so sets played years ago under old
// tags are included. user.events stops at the user account's own events
// (ZODD-01: 276 events back to 2023, against 2,275 sets back to 2015).
//
// Its `filters` argument is broken — any filter at all returns zero sets — so
// the page is fetched whole and filtered on our side. That is why the selection
// is as lean as it is: ~11 objects per singles set, ~15 per doubles set, so
// 60 per page stays under the ceiling even for a doubles-heavy page.
//
// Ordered newest first, which is what lets a re-sync stop at the first page it
// already has (see set-history.js).
const PLAYER_SETS_PAGE = `
query playerSets($id: ID!, $page: Int!, $perPage: Int!) {
  player(id: $id) {
    id
    sets(page: $page, perPage: $perPage) {
      pageInfo { total totalPages }
      nodes {
        id winnerId completedAt state displayScore
        event { id startAt videogame { id } }
        slots { entrant { id participants { player { id } } } }
      }
    }
  }
}`.trim();

// ── Head-to-head pill detail ────────────────────────────────────────────────
// Only for the handful of sets actually drawn — the tally needs none of this.
// ~15 objects per set.
function setDetailsQuery(setIds) {
  const parts = idList(setIds).map((id, i) => `s${i}: set(id: ${id}) {
    id completedAt fullRoundText winnerId
    event { name startAt isOnline tournament { name } }
    slots { entrant { id } standing { stats { score { value } } } }
  }`);
  return `{ ${parts.join("\n")} }`;
}

// ── Player cards ────────────────────────────────────────────────────────────
// Both players' placements and their run in the loaded event, in one request.
//
// recentStandings(onlySinglesEvents) is start.gg deciding singles-vs-doubles
// from the event's own type, which replaces the side panel's old guess from the
// event *name* ("Melee Bracket" used to be dropped as unknowable).
//
// The run is the event's completed sets for either player (playerIds is OR,
// not AND), split per player afterwards. ~17 objects per set.
const STANDINGS_LIMIT = 8;
const RUN_PER_PAGE    = 30;

function playerCardsQuery(playerIds, eventSlug) {
  const players = idList(playerIds).map((id, i) => `p${i}: player(id: ${id}) {
    id
    recentStandings(videogameId: ${MELEE_VIDEOGAME_ID}, limit: ${STANDINGS_LIMIT}, onlySinglesEvents: true) {
      placement isFinal
      container { ... on Event { id name numEntrants startAt isOnline tournament { name } } }
    }
  }`);
  const run = eventSlug
    ? `ev: event(slug: ${JSON.stringify(eventSlug)}) {
        id type
        sets(page: 1, perPage: ${RUN_PER_PAGE}, sortType: RECENT, filters: { playerIds: [${idList(playerIds).join(", ")}], state: [3] }) {
          nodes { ...ResultSet }
        }
      }`
    : "";
  return `{ ${players.join("\n")} ${run} } ${run ? RESULT_SET_FRAGMENT : ""}`;
}

// A finished set with everything a pill shows: both entrants, their game
// counts, and who won. `gamerTag` is the tag alone; `entrant.name` carries the
// sponsor prefix (and is the team name in doubles).
const RESULT_SET_FRAGMENT = `
fragment ResultSet on Set {
  id completedAt fullRoundText winnerId displayScore
  slots {
    entrant { id name participants { gamerTag player { id } } }
    standing { stats { score { value } } }
  }
}`.trim();

module.exports = {
  MELEE_VIDEOGAME_ID,
  PLAYER_SETS_PAGE,
  setDetailsQuery,
  playerCardsQuery,
  idList,
};
