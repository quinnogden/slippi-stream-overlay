/**
 * Crew battles — the rules, as functions over plain data.
 *
 * Two crews of 1–10 players play 1v1 games. Each player starts with
 * `stocksEach` stocks; the winner of a game stays in with what they have left
 * (the rule is "SD to match": a player carrying 2 stocks into a 4-stock game
 * SDs twice, so the last frame is the truth), the loser is out, and that side
 * sends in someone new — picked by hand, never by the app. A crew is out when
 * it has no stocks left.
 *
 * The store owns the crew object (lib/scoreboard/store.js keeps it in the set,
 * as `set.crew`); the functions here mutate the crew they're handed and report
 * what happened, so the rules can be tested without a store.
 *
 *   crew = {
 *     stocksEach: 4,
 *     teams: [{ name, members: [member…] }, …],  // teams[i] is scoreboard side i
 *     active: [memberId | null, memberId | null],
 *     nextId: 1,
 *   }
 *   member = { id, tag, prefix, pronoun, main, character, stocks, played }
 *
 * `main` is the player's DB main and `character` what they last played in this
 * battle; the roster shows the latter, else the former.
 */

const MAX_MEMBERS = 10;
const MAX_STOCKS = 9;
const DEFAULT_STOCKS = 4;
const FIELD_MAX = 40;

/** The round card's text while a crew battle is on the scoreboard (an override still wins). */
const CREW_ROUND = "Crew Battle";

const text = (v) => (typeof v === "string" ? v.trim().slice(0, FIELD_MAX) : "");
const charOrNull = (c) => (c && c.codename ? { codename: c.codename, name: c.name ?? "", skin: Number(c.skin) || 0 } : null);

/**
 * Why a crew can't go on the scoreboard as given, or null if it can.
 * @param {{ name?: string, members?: Array<{ tag?: string }> }} team
 * @returns {string|null}
 */
function teamError(team) {
  if (!team || typeof team !== "object") return "a crew is missing";
  if (!text(team.name)) return "every crew needs a name";
  const members = Array.isArray(team.members) ? team.members : [];
  if (!members.length) return `${text(team.name)} has no members`;
  if (members.length > MAX_MEMBERS) return `${text(team.name)} has more than ${MAX_MEMBERS} members`;
  if (members.some((m) => !text(m?.tag))) return `${text(team.name)} has a member with no tag`;
  return null;
}

/** Stocks each, or null if it isn't a whole number from 1 to MAX_STOCKS. */
function stocksOf(v) {
  return Number.isInteger(v) && v >= 1 && v <= MAX_STOCKS ? v : null;
}

/**
 * A new battle: every member on full stocks, nobody sent in yet.
 * @param {{ teams: Array<{ name: string, members: Array<{ tag, prefix?, pronoun?, main? }> }>, stocksEach?: number }} o
 */
function createCrew({ teams, stocksEach = DEFAULT_STOCKS }) {
  const crew = { stocksEach: stocksOf(stocksEach) ?? DEFAULT_STOCKS, teams: [], active: [null, null], nextId: 1 };
  crew.teams = [0, 1].map((i) => ({
    name: text(teams[i].name),
    members: teams[i].members.slice(0, MAX_MEMBERS).map((m) => newMember(crew, m)),
  }));
  return crew;
}

function newMember(crew, m) {
  return {
    id: crew.nextId++,
    tag: text(m.tag),
    prefix: text(m.prefix),
    pronoun: text(m.pronoun),
    main: charOrNull(m.main),
    character: null,
    stocks: crew.stocksEach,
    played: false,
  };
}

const memberOf = (crew, side, id) => (id == null ? null : crew.teams[side].members.find((m) => m.id === id) ?? null);
const activeOf = (crew, side) => memberOf(crew, side, crew.active[side]);

/** A crew's stocks left: the scoreboard's number for that side. */
const teamTotal = (team) => team.members.reduce((n, m) => n + m.stocks, 0);

/** "active" (playing now), "in" (still has stocks) or "out". */
function statusOf(crew, side, m) {
  if (crew.active[side] === m.id) return "active";
  return m.stocks > 0 ? "in" : "out";
}

/** Has this member's battle started — so they can no longer just be taken off the roster? */
const touched = (crew, m) => m.played || m.stocks !== crew.stocksEach;

/**
 * Send a member in (or nobody, with id null).
 * @returns {{ ok: true, changed: boolean } | { ok: false, error: string }}
 */
function pick(crew, side, id) {
  if (id == null) {
    const changed = crew.active[side] != null;
    crew.active[side] = null;
    return { ok: true, changed };
  }
  const m = memberOf(crew, side, id);
  if (!m) return { ok: false, error: "That player isn't on this crew" };
  if (m.stocks <= 0) return { ok: false, error: `${m.tag} is out` };
  if (crew.active[side] === id) return { ok: true, changed: false };
  crew.active[side] = id;
  return { ok: true, changed: true };
}

/**
 * ± one stock for a member, between 0 and stocksEach. Reaching 0 takes them
 * out (and off the active slot); going above 0 brings them back.
 * @returns {{ ok: true, changed: boolean } | { ok: false, error: string }}
 */
function bumpStock(crew, side, id, delta) {
  const m = memberOf(crew, side, id);
  if (!m) return { ok: false, error: "That player isn't on this crew" };
  const next = Math.max(0, Math.min(crew.stocksEach, m.stocks + Math.sign(delta)));
  if (next === m.stocks) return { ok: true, changed: false };
  m.stocks = next;
  if (next === 0 && crew.active[side] === id) crew.active[side] = null;
  return { ok: true, changed: true };
}

/**
 * A finished game. The winner keeps the stocks they ended on — never more than
 * they carried in (a forgotten SD can't gain a stock), never fewer than one
 * (they won) — and the loser is out, leaving their side to be picked again.
 *
 * Nothing is applied unless both sides have someone sent in: who played can't
 * be guessed.
 *
 * @param {{ winnerSide: 0|1, winnerStocks?: number|null, characters?: Array<Array<object|null>>|null }} game
 *        winnerStocks: the winning port's stocks on the last frame;
 *        characters: [[left], [right]] as game-end.js builds them
 * @returns {{ applied: true, winner: object, loser: object, carried: number }
 *         | { applied: false, reason: string }}
 */
function applyResult(crew, { winnerSide, winnerStocks = null, characters = null }) {
  const loserSide = 1 - winnerSide;
  const missing = [winnerSide, loserSide].filter((s) => !activeOf(crew, s)).map((s) => crew.teams[s].name);
  if (missing.length) return { applied: false, reason: `No one sent in for ${missing.join(" or ")}` };

  const winner = activeOf(crew, winnerSide);
  const loser = activeOf(crew, loserSide);
  const carried = winner.stocks;
  const left = Number.isInteger(winnerStocks) ? winnerStocks : carried;
  winner.stocks = Math.max(1, Math.min(carried, left));
  loser.stocks = 0;
  for (const [m, s] of [[winner, winnerSide], [loser, loserSide]]) {
    m.played = true;
    m.character = charOrNull(characters?.[s]?.[0]) ?? m.character;
  }
  crew.active[loserSide] = null;
  return { applied: true, winner, loser, carried };
}

/**
 * A live roster edit: the crew's name, and its members in their new order.
 * A member sent with an `id` is that member (stocks and history kept, the
 * typed fields updated); one without is new, on full stocks. A member left
 * out is taken off — refused for anyone who has played, been knocked down, or
 * is in now.
 *
 * Validates before it changes anything.
 * @param {{ name: string, members: Array<{ id?: number, tag: string, prefix?: string, pronoun?: string, main?: object|null }> }} edit
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function editRoster(crew, side, edit) {
  const err = teamError(edit);
  if (err) return { ok: false, error: err };
  const team = crew.teams[side];
  const keepIds = new Set();
  for (const m of edit.members) {
    if (m.id == null) continue;
    if (!memberOf(crew, side, m.id)) return { ok: false, error: "That roster is out of date — try again" };
    if (keepIds.has(m.id)) return { ok: false, error: "A member is listed twice" };
    keepIds.add(m.id);
  }
  const dropped = team.members.filter((m) => !keepIds.has(m.id));
  const stuck = dropped.find((m) => touched(crew, m) || crew.active[side] === m.id);
  if (stuck) return { ok: false, error: `${stuck.tag} has played — they stay on the roster` };

  team.name = text(edit.name);
  team.members = edit.members.map((m) => {
    if (m.id == null) return newMember(crew, m);
    const was = memberOf(crew, side, m.id);
    const next = { ...was, tag: text(m.tag), prefix: text(m.prefix), pronoun: text(m.pronoun) };
    if (m.main !== undefined) next.main = charOrNull(m.main);
    return next;
  });
  return { ok: true };
}

/** Switch Sides: each crew goes with its column. */
function flip(crew) {
  crew.teams.reverse();
  crew.active.reverse();
}

/**
 * What a side of the scoreboard shows: the active member, with the crew's name
 * where a sponsor prefix goes — or, with nobody sent in, the crew's name alone
 * (in the tag: the overlay hides a name with no tag).
 * @param {object|null} liveCharacter — the character the store holds for the side (Slippi's, mid-game)
 */
function sideView(crew, side, liveCharacter) {
  const team = crew.teams[side];
  const m = activeOf(crew, side);
  const player = m
    ? { playerId: null, tag: m.tag, prefix: team.name, pronoun: m.pronoun, main: m.character ?? m.main, character: liveCharacter ?? null }
    : { playerId: null, tag: team.name, prefix: "", pronoun: "", main: null, character: null };
  return { entrantId: null, seed: null, teamName: team.name, color: null, fromLosers: false, players: [player] };
}

/** The scoreboard's `crew` section: display-ready rosters, in the scoreboard's column order. */
function crewView(crew) {
  return {
    stocksEach: crew.stocksEach,
    active: [...crew.active],
    teams: crew.teams.map((team, side) => ({
      name: team.name,
      total: teamTotal(team),
      members: team.members.map((m) => ({
        id: m.id,
        tag: m.tag,
        prefix: m.prefix,
        pronoun: m.pronoun,
        icon: m.character ?? m.main,
        stocks: m.stocks,
        played: m.played,
        status: statusOf(crew, side, m),
      })),
    })),
  };
}

module.exports = {
  MAX_MEMBERS, MAX_STOCKS, DEFAULT_STOCKS, CREW_ROUND,
  teamError, stocksOf, createCrew, activeOf, memberOf, teamTotal, statusOf,
  pick, bumpStock, applyResult, editRoster, flip, sideView, crewView,
};
