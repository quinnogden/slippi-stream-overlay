/**
 * context.js — a set's context.json, in Replay Reporter for Slippi's format.
 *
 * Pure. LuckyStats' importer reads the files Replay Reporter writes
 * (github.com/jmlee337/replay-manager-for-slippi, `Context` in
 * src/common/types.ts, built in src/renderer/App.tsx), and it validates the
 * event, tournament, games and scores in them — so this matches that format
 * field for field rather than describing the set in the app's own terms:
 *
 *   scores[i]      one per game; its two slots are in GAME 1's port order
 *                  (slot 0 = the side holding the lowest port in game 1), and
 *                  each slot's `score` is that side's wins BEFORE game i
 *   finalScore     the last game's slots, with the final score
 *   bestOf         max(wins) * 2 - 1 — Replay Reporter's formula, not the set's
 *   players        entrant1 / entrant2 in start.gg's slot order (not the
 *                  scoreboard's left/right, which Switch Sides reverses)
 *   startgg        tournament, event, phase, phase group and set, from
 *                  start.gg's own ids (metaFromStartgg)
 *   ports          1-based, like Slippi's port numbers
 *
 * Two inputs: the set as the scoreboard had it (a stream-sets.js record — its
 * sides and its game list, each game with its `replay`), and the start.gg
 * meta for that set (metaFromStartgg, read once by id).
 */

// Slippi frames → ms, as Replay Reporter counts a game's length: the frame
// counter starts at -123, and Melee runs at 59.94 frames a second
// (its `frameMsDivisor`).
const FIRST_FRAME = -123;
const FRAME_MS_DIVISOR = 0.05994;

// Replay Reporter's names for Slippi's character ids (its `characterNames`),
// which is what `players[].characters` holds — not the app's display names.
const RR_CHARACTER_NAMES = [
  "Falcon", "DK", "Fox", "GW", "Kirby", "Bowser", "Link", "Luigi", "Mario", "Marth",
  "Mewtwo", "Ness", "Peach", "Pikachu", "ICs", "Puff", "Samus", "Yoshi", "Zelda", "Sheik",
  "Falco", "YL", "Doc", "Roy", "Pichu", "Ganon",
];

// start.gg's BracketType enum → the numeric id Replay Reporter stores
// (developer.start.gg/reference/brackettype.doc).
const BRACKET_TYPES = {
  SINGLE_ELIMINATION: 1,
  DOUBLE_ELIMINATION: 2,
  ROUND_ROBIN: 3,
  SWISS: 4,
  EXHIBITION: 5,
  CUSTOM_SCHEDULE: 6,
  MATCHMAKING: 7,
  ELIMINATION_ROUNDS: 8,
  RACE: 9,
  CIRCUIT: 10,
};

const MELEE = 1;

/** A start.gg id as Replay Reporter keeps it: a number when it is one. */
function idOf(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && String(n) === String(v).trim() ? n : v;
}

/**
 * The start.gg half of a context, from getSetContext()'s answer — kept on the
 * stream set so a rebuild needs no request. `hasSiblings` is Replay
 * Reporter's: the tournament has another Melee event, the event another
 * phase, the phase another group.
 * @param {object} set — startgg.getSetContext().set
 */
function metaFromStartgg(set) {
  const pg = set.phaseGroup;
  const phase = pg.phase;
  const event = phase.event;
  const t = event.tournament;
  const meleeEvents = (t.events ?? []).filter((e) => (e.videogame?.id ?? MELEE) === MELEE);
  const location = [t.city, t.addrState || (t.countryCode && t.countryCode !== "US" ? t.countryCode : "")]
    .filter(Boolean).join(", ");
  const stream = set.stream?.id && set.stream?.streamSource && set.stream?.streamName
    ? { id: idOf(set.stream.id), domain: String(set.stream.streamSource).toLowerCase(), path: set.stream.streamName }
    : null;
  const slots = [...(set.slots ?? [])].sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));
  return {
    tournament: { name: t.name ?? "", slug: t.slug ?? "", location },
    event: { id: idOf(event.id), name: event.name ?? "", slug: event.slug ?? "", hasSiblings: meleeEvents.length > 1 },
    phase: { id: idOf(phase.id), name: phase.name ?? "", hasSiblings: (event.phases ?? []).length > 1 },
    phaseGroup: {
      id: idOf(pg.id),
      name: pg.displayIdentifier ?? "",
      bracketType: BRACKET_TYPES[pg.bracketType] ?? null,
      hasSiblings: (phase.groupCount ?? 1) > 1,
      waveId: idOf(pg.wave?.id ?? null),
      // Only start.gg's old REST API has it; the field stays, as null.
      winnersTargetPhaseId: null,
    },
    set: {
      id: idOf(set.id),
      fullRoundText: set.fullRoundText ?? "",
      // Replay Reporter's own call order; null is what it writes without one.
      ordinal: null,
      round: set.round ?? null,
      stream,
    },
    entrantOrder: slots.map((s) => (s.entrant?.id == null ? null : String(s.entrant.id))),
  };
}

/** The ms a game lasted, from its last frame, as Replay Reporter counts it. */
function gameMs(lastFrame) {
  if (!Number.isFinite(lastFrame)) return 0;
  return Math.ceil((lastFrame - FIRST_FRAME + 1) / FRAME_MS_DIVISOR);
}

/** A side's ports in one game: [{ slot, port, characterId, costume }], ascending by port. */
function portsOf(game, side) {
  return (game.replay?.players?.[side] ?? [])
    .map((p, slot) => (p ? { slot, ...p } : null))
    .filter((p) => p && Number.isInteger(p.port))
    .sort((a, b) => a.port - b.port);
}

/** The lowest port a side played on in a game (Infinity with none). */
function minPort(game, side) {
  const ports = portsOf(game, side);
  return ports.length ? ports[0].port : Infinity;
}

/**
 * Why a set's context can't be written, or null when it can. The same checks
 * Replay Reporter makes before it writes one, plus the app's own: every game
 * needs its replay (a manual ± game has none), and every player a name.
 * @param {{ sides: Array, games: Array }} record
 */
function contextProblem(record) {
  const games = record?.games ?? [];
  if (!games.length) return "No games";
  const missing = games.findIndex((g) => !g.replay?.file);
  if (missing >= 0) return `Game ${missing + 1} has no replay file`;
  for (const [i, g] of games.entries()) {
    for (const side of [0, 1]) {
      if (!portsOf(g, side).length) return `Game ${i + 1}: no port on the ${side === 0 ? "left" : "right"}`;
      for (const p of portsOf(g, side)) {
        if (!record.sides?.[side]?.players?.[p.slot]?.tag) {
          return `Game ${i + 1}: the ${side === 0 ? "left" : "right"} side's port ${p.port + 1} has no player name`;
        }
      }
    }
  }
  const [a, b] = [0, 1].map((s) => games.filter((g) => g.winnerSide === s).length);
  if (a === b) return `The score is tied (${a}-${b})`;
  return null;
}

/**
 * The context.json object for a set.
 * @param {{ sides: Array, games: Array, doubles?: boolean }} record — the scoreboard's set (stream-sets.js)
 * @param {object|null} meta — metaFromStartgg(); null writes no `startgg` block
 * @param {{ startMs?: number }} [opts] — startMs: game 1's start, when the file's metadata has a better one
 * @returns {object}
 * @throws when contextProblem() says it can't be written
 */
function buildContext(record, meta, opts = {}) {
  const problem = contextProblem(record);
  if (problem) throw new Error(problem);
  const { sides, games } = record;
  const teams = !!record.doubles;

  // Game 1's port order fixes which side is slot 0 for the whole set.
  const order = minPort(games[0], 0) <= minPort(games[0], 1) ? [0, 1] : [1, 0];
  const wins = [0, 0]; // by side

  const slotOf = (game, side, score) => {
    const ports = portsOf(game, side);
    const players = ports.map((p) => sides[side].players[p.slot] ?? {});
    const slot = {
      displayNames: players.map((p) => p.tag ?? ""),
      ports: ports.map((p) => p.port + 1),
      prefixes: players.map((p) => p.prefix ?? ""),
      pronouns: players.map((p) => p.pronoun ?? ""),
      score,
      characters: ports.map((p) => ({ id: p.characterId, costume: p.costume ?? 0 })),
    };
    if (teams) slot.teamId = game.replay?.teamIds?.[side] ?? undefined;
    if (sides[side].fromLosers) slot.losers = true;
    return slot;
  };

  const scores = games.map((game) => {
    const slots = order.map((side) => slotOf(game, side, wins[side]));
    wins[game.winnerSide] += 1;
    return { slots };
  });

  const last = scores[scores.length - 1].slots;
  const finalScore = {
    slots: order.map((side, j) => ({
      displayNames: last[j].displayNames,
      ports: last[j].ports,
      prefixes: last[j].prefixes,
      pronouns: last[j].pronouns,
      score: wins[side],
      characters: last[j].characters,
      losers: last[j].losers,
    })),
  };

  // entrant1 / entrant2 in start.gg's slot order; game 1's order without it.
  const sideOfEntrant = (id) => sides.findIndex((s) => s.entrantId != null && String(s.entrantId) === String(id));
  let entrantSides = (meta?.entrantOrder ?? []).map(sideOfEntrant);
  if (entrantSides.length !== 2 || entrantSides.includes(-1) || entrantSides[0] === entrantSides[1]) entrantSides = order;
  const playersOf = (side) => sides[side].players.map((p, slot) => ({
    name: p.tag ?? "",
    characters: charactersPlayed(games, side, slot),
  }));

  const context = {
    bestOf: Math.max(wins[0], wins[1]) * 2 - 1,
    durationMs: games.reduce((sum, g) => sum + gameMs(g.replay?.lastFrame), 0),
    scores,
    finalScore,
    players: { entrant1: playersOf(entrantSides[0]), entrant2: playersOf(entrantSides[1]) },
    startMs: opts.startMs ?? games[0].replay?.startMs ?? 0,
  };

  if (meta) {
    context.startgg = {
      tournament: { name: meta.tournament.name, location: meta.tournament.location },
      event: meta.event,
      phase: meta.phase,
      phaseGroup: meta.phaseGroup,
      set: {
        id: meta.set.id,
        internalId: meta.set.id,
        fullRoundText: meta.set.fullRoundText,
        ordinal: meta.set.ordinal,
        round: meta.set.round,
        stream: meta.set.stream,
      },
    };
  }
  return context;
}

/** The characters a side's slot played across the set, in the order they first appeared. */
function charactersPlayed(games, side, slot) {
  const seen = [];
  for (const g of games) {
    const name = RR_CHARACTER_NAMES[g.replay?.players?.[side]?.[slot]?.characterId];
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

module.exports = { buildContext, contextProblem, metaFromStartgg, gameMs };
