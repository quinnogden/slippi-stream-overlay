/**
 * queries.js — the start.gg queries behind the event service and the bracket.
 *
 * Shared with scripts/capture-startgg.js on purpose: the test fixtures are
 * captured with exactly the fields the app reads, so a field added here shows
 * up in the next capture instead of being silently absent from every test.
 *
 * Sized against start.gg's 1000-objects-per-response ceiling, which counts
 * what comes back. Measured on Hundred Acres #57 (2026-11-18): a finished
 * singles set costs 29 objects with these fields, a doubles set 33 (two
 * participants and players a side); an unstarted one about half. So 28 sets a
 * page fits either with room to spare — 40 did not (1081 on a full bracket:
 * every refresh used to be refused once). A refusal still shrinks the page
 * (startgg-client.js getPhaseGroupSets), and the size that worked is kept per
 * group. Every query here also works unchanged against start.gg's keyless web
 * endpoint, which is what the read fallback relies on.
 */

// startedAt: how long a set has been running (the dock's bracket card).
// stream / station: which stream and station start.gg has it on — one object
// each, so 2 of the 29.
const SET_FIELDS = `
  id identifier round fullRoundText state winnerId displayScore
  lPlacement completedAt startedAt
  stream { id }
  station { id number }
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

// The first size to try, then what a refusal falls back to when start.gg
// doesn't say how far over it was. Offsets change with page size, so a caller
// that has to shrink restarts the phase group from page 1.
const PAGE_SIZES = [28, 14, 7];

// The tournament's streams ride along: "on stream" on start.gg is one of them
// (lib/event/bracket-ops.js). A handful of objects.
const EVENT_QUERY = `
query event($slug: String!) {
  event(slug: $slug) {
    id name slug state type numEntrants
    videogame { id }
    tournament { id name slug streams { id streamName streamSource enabled } }
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

// Whether a stream set has been reported on start.gg (by anyone), and with
// what score — so a set a TO reported from start.gg can upload its replays
// (lib/replays/). Tiny: one set, its two slots.
const SET_RESULT_QUERY = `
query setResult($id: ID!) {
  set(id: $id) {
    id state winnerId
    slots { entrant { id } standing { stats { score { value } } } }
  }
}`.trim();

module.exports = { PAGE_SIZES, EVENT_QUERY, PHASE_GROUP_SETS_QUERY, SET_QUERY, SET_CONTEXT_QUERY, SET_RESULT_QUERY };
