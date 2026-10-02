/**
 * bracket-feed.js — what the bracket overlay draws, published into the store's
 * `bracket` section.
 *
 * One phase group of the loaded event at a time: the one the operator picked
 * (`view.bracketPhaseGroupId`), else the one the set on the scoreboard is in,
 * else the furthest phase that is running. All five views are precomputed
 * here (bracket-model.selectView), so switching views in the dock is a
 * `view` patch the overlay answers from what it already has.
 *
 * The overlay lays the bracket out itself — positions depend on measured card
 * sizes and the fit scale — so this sends the graph, not coordinates.
 *
 * Two things are filled in that start.gg doesn't have:
 *   - **A character per singles entrant.** The live one for the two players on
 *     the scoreboard (what Slippi last saw), the player DB's main for everyone
 *     else.
 *   - **The live score of the set on the scoreboard,** while start.gg still
 *     has it unfinished — the bracket shouldn't read 0-0 on a set that is 2-1
 *     on the scoreboard.
 */

const { selectView, VIEWS } = require("./bracket-model");
const { characterByName } = require("../char_map");

const ACTIVE = 2;
const COMPLETED = 3;

/**
 * @param {{ event: import("./event-service").EventService,
 *           store: import("../scoreboard/store").ScoreboardStore,
 *           playerDb?: import("../players/player-db").PlayerDb | null }} deps
 */
function createBracketFeed({ event, store, playerDb = null }) {
  let lastKey = null;

  function publish() {
    const groups = event.groups().filter((g) => g.graph);
    const info = event.eventInfo();
    if (!info || groups.length === 0) {
      lastKey = null;
      store.setBracket(null);
      return;
    }
    const view = store.view();
    const sb = store.scoreboard();
    const group = pickGroup(groups, view.bracketPhaseGroupId, sb.phaseGroupId);
    store.setBracket(buildFeed(group, groups, info, sb, playerDb));
  }

  // A score bump or a character change can change a card; anything else on the
  // scoreboard (an override, a pronoun) can't, so it isn't worth a rebuild.
  function scoreboardKey() {
    const sb = store.scoreboard();
    return JSON.stringify([store.view(), sb.setId, sb.phaseGroupId,
      sb.sides.map((s) => [s.entrantId, s.score, s.players.map((p) => p.character)])]);
  }

  const onStore = ({ keys }) => {
    if (!keys.includes("scoreboard") && !keys.includes("view")) return;
    const key = scoreboardKey();
    if (key === lastKey) return;
    lastKey = key;
    publish();
  };
  const onEvent = () => { lastKey = scoreboardKey(); publish(); };

  return {
    start() {
      store.on("change", onStore);
      event.on("change", onEvent);
      onEvent();
    },
    stop() {
      store.off("change", onStore);
      event.off("change", onEvent);
    },
    publish,
  };
}

/**
 * The group to show: the operator's pick, else the scoreboard's, else the
 * last running group in bracket order (top 8 over pools once it starts),
 * else the last finished one, else the first.
 */
function pickGroup(groups, pinned, onAir) {
  const byId = (id) => (id == null ? null : groups.find((g) => g.id === String(id)));
  return byId(pinned)
    ?? byId(onAir)
    ?? [...groups].reverse().find((g) => Number(g.state) === ACTIVE)
    ?? [...groups].reverse().find((g) => Number(g.state) === COMPLETED)
    ?? groups[0];
}

function buildFeed(group, groups, info, sb, playerDb) {
  const graph = group.graph;
  const onAir = new Map(); // entrantId → the scoreboard side showing it
  for (const side of sb.sides) if (side.entrantId) onAir.set(String(side.entrantId), side);

  const entrants = {};
  for (const [id, e] of Object.entries(graph.entrants)) {
    entrants[id] = { ...e, character: e.players.length === 1 ? characterOf(e, onAir.get(id), playerDb) : null };
  }

  const sets = {};
  for (const [id, s] of Object.entries(graph.sets)) {
    let slots = s.slots;
    if (id === String(sb.setId ?? "") && s.state !== "done") {
      slots = s.slots.map((slot) => {
        const side = onAir.get(String(slot.entrantId ?? ""));
        return side ? { ...slot, score: side.score } : slot;
      });
    }
    sets[id] = { ...s, slots };
  }

  return {
    phaseGroupId: group.id,
    label: group.label,
    phaseName: group.phaseName,
    bracketType: group.bracketType,
    eventName: info.name,
    tournamentName: info.tournamentName,
    groups: groups.map((g) => ({ id: g.id, label: g.label })),
    preview: graph.preview,
    entrants,
    sets,
    rounds: graph.rounds,
    views: Object.fromEntries(VIEWS.map((v) => [v, selectView(graph, v)])),
  };
}

function characterOf(entrant, side, playerDb) {
  const live = side?.players?.[0]?.character;
  if (live) return { codename: live.codename, name: live.name, skin: live.skin };
  const p = entrant.players[0];
  const rec = playerDb?.find({ playerId: p.playerId, tag: p.tag, prefix: p.prefix });
  const main = rec ? playerDb.preferredMain(rec) : null;
  return main ? characterByName(main.name, main.skin) : null;
}

module.exports = { createBracketFeed, pickGroup };
