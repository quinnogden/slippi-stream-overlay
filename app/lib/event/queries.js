/**
 * queries.js — the start.gg queries behind the event service and the bracket.
 *
 * Shared with scripts/capture-startgg.js on purpose: the test fixtures are
 * captured with exactly the fields the app reads, so a field added here shows
 * up in the next capture instead of being silently absent from every test.
 *
 * Sized against start.gg's 1000-objects-per-response ceiling. Per set:
 * set + 2 slots + 2 seeds + 2 standings + 2 entrants + 2–4 participants and
 * their players ≈ 15–20 objects, so 40 sets a page fits and a refusal halves it
 * (see PAGE_SIZES). Every query here also works unchanged against start.gg's
 * keyless web endpoint, which is what the read fallback relies on.
 */

const SET_FIELDS = `
  id identifier round fullRoundText state winnerId displayScore
  lPlacement completedAt
  phaseGroup { id }
  slots {
    slotIndex prereqType prereqId prereqPlacement
    seed { id seedNum }
    standing { placement stats { score { value } } }
    entrant {
      id name initialSeedNum
      participants { id gamerTag prefix player { id gamerTag prefix } }
    }
  }`;

// Halved on a complexity refusal. Offsets change with page size, so a caller
// that has to shrink restarts the phase group from page 1.
const PAGE_SIZES = [40, 20, 10];

const EVENT_QUERY = `
query event($slug: String!) {
  event(slug: $slug) {
    id name slug state type numEntrants
    videogame { id }
    tournament { id name slug }
    phases {
      id name phaseOrder bracketType numSeeds groupCount state
      phaseGroups(query: { page: 1, perPage: 64 }) {
        nodes { id displayIdentifier bracketType state }
      }
    }
  }
}`.trim();

const PHASE_GROUP_SETS_QUERY = `
query phaseGroupSets($id: ID!, $page: Int!, $perPage: Int!) {
  phaseGroup(id: $id) {
    id
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { total totalPages }
      nodes { ${SET_FIELDS} }
    }
  }
}`.trim();

// One set, fresh — read when the operator loads it, so the scoreboard never
// starts from a picker list up to 90s old.
const SET_QUERY = `
query set($id: ID!) {
  set(id: $id) { ${SET_FIELDS} }
}`.trim();

// Everything a set's replay bundle says about where it was played
// (lib/replays/context.js, Replay Reporter for Slippi's context.json): the
// tournament, event, phase and phase group around one set, and the set's own
// round, stream and entrant order. Read once per set, when it's bundled — by
// id, so it doesn't depend on which event the dock has loaded by then. Small:
// a tournament's events and an event's phases are a handful of objects each.
const SET_CONTEXT_QUERY = `
query setContext($id: ID!) {
  set(id: $id) {
    id round fullRoundText identifier
    stream { id streamSource streamName }
    slots { slotIndex entrant { id } }
    phaseGroup {
      id displayIdentifier bracketType
      wave { id }
      phase {
        id name groupCount
        event {
          id name slug
          phases { id }
          tournament {
            id name slug city addrState countryCode
            events { id videogame { id } }
          }
        }
      }
    }
  }
}`.trim();

module.exports = { PAGE_SIZES, EVENT_QUERY, PHASE_GROUP_SETS_QUERY, SET_QUERY, SET_CONTEXT_QUERY };
