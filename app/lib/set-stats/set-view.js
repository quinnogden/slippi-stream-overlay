/**
 * set-view.js — the set on the scoreboard, as the stats popup draws it. Pure.
 *
 *   buildSetView(scoreboard, statsOf, portraitsOf) → the store's `setStats` section
 *
 * `statsOf(file)` is game-stats.js's result for a game's .slp (undefined while
 * it hasn't been read). A game counts once it has a replay and its stats; a ±
 * game, a handwarmer and a doubles game don't, so the popup says how many of
 * the set's games it is drawn from.
 *
 * Both of the popup's readings are built every time, so the dock can switch
 * between them without a round trip:
 *   game  after a game: the game just played big, the set so far small
 *   set   the wrap-up: the set big, each game's line small
 *
 * Besides the ledger rows, three kinds of text:
 *   insights  the callouts — one thing worth pointing out (a set high, a
 *             streak, a comeback, a stat that went against the result), each
 *             scored by how unusual it is; best first
 *   stories   summary sentences, as segments ({ t } plain, { em } lit) so no
 *             name from start.gg is ever parsed as markup
 *   facts     the useful-to-know line: stage, length, stocks, the set so far
 *
 * Sides are the scoreboard's columns, read through each game's
 * `replay.players` — which Switch Sides reverses — so the stats follow the
 * players across a switch without being re-read.
 */

const { stageOf } = require("./stages");
const { CHAR_MAP } = require("../char_map");
const { setIsWon } = require("../scoreboard/set-text");
const { accolades, pick, rotate } = require("./accolades");
const { gameStories, setStories, say } = require("./stories");

/** Every ledger stat: label, decimals [one game, the set], which way is better, how the set sums it. */
const STATS = {
  kills:    { label: "Kills",            dp: [0, 1], better: "hi", agg: "avg" },
  damage:   { label: "Damage dealt",     dp: [0, 0], better: "hi", agg: "avg" },
  opk:      { label: "Openings / kill",  dp: [1, 1], better: "lo", agg: "avg", hint: "fewer is better" },
  dpo:      { label: "Damage / opening", dp: [1, 1], better: "hi", agg: "avg" },
  neutral:  { label: "Neutral wins",     dp: [0, 1], better: "hi", agg: "avg" },
  counter:  { label: "Counter hits",     dp: [0, 1], better: "hi", agg: "avg" },
  punish:   { label: "Highest punish",   dp: [0, 0], better: "hi", agg: "max", unit: "%", setWord: "set best" },
  combo:    { label: "Longest combo",    dp: [0, 0], better: "hi", agg: "max", unit: " hits", setWord: "set best" },
  earliest: { label: "Earliest kill",    dp: [0, 0], better: "lo", agg: "min", unit: "%", setWord: "set best" },
  avgkill:  { label: "Average kill %",   dp: [0, 0], better: "lo", agg: "avg", unit: "%" },
  lcancel:  { label: "L-cancel",         dp: [0, 0], better: "hi", agg: "avg", unit: "%" },
  ipm:      { label: "Inputs / min",     dp: [0, 0], better: "hi", agg: "avg" },
  sd:       { label: "Self-destructs",   dp: [0, 0], better: "lo", agg: "sum" },
};

/** Enough for a rotation to run a while before it comes round again. */
const MAX_INSIGHTS = 12;
const MAX_STORIES = 6;

// ── Small helpers ─────────────────────────────────────────────────────────────

const nums = (list) => list.filter((v) => v != null && Number.isFinite(v));
const sum = (list) => nums(list).reduce((a, b) => a + b, 0);
function agg(list, how) {
  const v = nums(list);
  if (!v.length) return null;
  if (how === "max") return Math.max(...v);
  if (how === "min") return Math.min(...v);
  if (how === "sum") return sum(v);
  return sum(v) / v.length;
}
/** The side ahead on a stat: 0, 1, or null (a tie or a missing value). */
function leader([a, b], better) {
  if (a == null || b == null || a === b) return null;
  return (better === "lo" ? a < b : a > b) ? 0 : 1;
}
const fixed = (v, dp) => (v == null ? null : Number(v).toFixed(dp));
const fmt = (key, v, set = false) => fixed(v, STATS[key].dp[set ? 1 : 0]);
const clock = (secs) => (secs == null ? "" : `${Math.floor(secs / 60)}:${String(Math.round(secs) % 60).padStart(2, "0")}`);
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const em = (v) => ({ em: String(v) });
const t = (v) => ({ t: String(v) });
const gameList = (ns) => (ns.length === 2 ? `${ns[0]} and ${ns[1]}` : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);

/** "Bo5" → 5; anything else → null (Flex, None, empty). */
function bestOfNumber(label) {
  const m = /(\d+)/.exec(String(label ?? ""));
  return m ? Number(m[1]) : null;
}

// ── The view ──────────────────────────────────────────────────────────────────

/**
 * @param {object|null} sb — store.scoreboard()
 * @param {(file: string) => object|undefined} statsOf
 * @param {(character: object|null) => object|null} [portraitsOf] — portraits.js: the character's portrait in every installed pack, by pack id
 * @param {{ recent?: Map<string, number> }} [opts] — recent: accolade ids shown in the last few sets (index.js), scored down
 */
function buildSetView(sb, statsOf, portraitsOf = () => null, opts = {}) {
  if (!sb) return unavailable("No set on the scoreboard");
  if (sb.crew) return unavailable("Crew battle — no set stats");
  if (sb.isDoubles) return unavailable("Doubles — set stats are singles only");
  if (!sb.setId) return unavailable("No start.gg set loaded — set stats need one");

  let pending = 0;
  let unreadable = 0;
  const games = [];
  sb.games.forEach((g, i) => {
    const file = g.replay?.file;
    if (!file) return;
    const r = statsOf(file);
    if (r === undefined) { pending++; return; }
    if (r?.notSingles) return; // a doubles game on a singles scoreboard: not counted, like a ± game
    if (!r?.ok) { unreadable++; return; }
    // A read of a shape nobody expected costs that game, never the view.
    try {
      const per = [0, 1].map((side) => r.players?.[g.replay.players?.[side]?.[0]?.port]);
      if (!per.every((x) => x && typeof x === "object")) { unreadable++; return; }
      games.push({
        n: i + 1,
        winner: g.winnerSide,
        stage: stageOf(r.stageId),
        seconds: r.seconds,
        per,
        chars: per.map((x) => ({ codename: CHAR_MAP[x.characterId]?.codename ?? null, skin: x.costume ?? 0 })),
        leadChanges: r.leadChanges ?? null,
        bothLastStock: r.bothLastStock ?? null,
      });
    } catch {
      unreadable++;
    }
  });

  const score = sb.sides.map((s) => s.score);
  const bestOf = bestOfNumber(sb.bestOfLabel);
  // Won by the format on the scoreboard now: Bo3 at 2, Bo5 at 3, Flex at 2–0 or 3.
  const over = setIsWon(sb.bestOfLabel, score);
  const last = games[games.length - 1] ?? null;
  const names = sb.sides.map((s, i) => nameOf(s, last?.chars[i] ?? s.players[0]?.character, i));

  const sides = sb.sides.map((s, i) => {
    const ch = last ? { codename: last.chars[i].codename, skin: last.chars[i].skin } : s.players[0]?.character;
    const character = ch?.codename ? { codename: ch.codename, skin: Number(ch.skin) || 0 } : null;
    return { tag: names[i], character, portraits: portraitsOf(character) };
  });

  const base = {
    available: games.length > 0,
    reason: games.length ? null : (pending ? "Reading the replays…" : "No Slippi games in this set yet"),
    key: `${sb.setId ?? ""}|${sb.sides.map((s) => s.players.map((p) => p.tag).join("+")).join("|")}`,
    round: sb.round || "",
    bestOf, format: sb.bestOfLabel || "", score, over,
    counted: games.length, total: sb.games.length, pending, unreadable,
    sides,
    stats: STATS,
  };
  if (!games.length) return { ...base, games: [], rows: {}, insights: { game: [], set: [] }, stories: { game: [], set: [] }, facts: { game: [], set: [] } };

  const rows = {};
  for (const [key, st] of Object.entries(STATS)) {
    const pg = [0, 1].map((s) => games.map((g) => g.per[s][key] ?? null));
    const g = [0, 1].map((s) => last.per[s][key] ?? null);
    const set = pg.map((list) => agg(list, st.agg));
    if (g.every((v) => v == null) && set.every((v) => v == null)) continue;
    rows[key] = {
      g, s: set.map((v) => (v == null ? null : Number(Number(v).toFixed(st.dp[1])))), pg,
      lead: { g: leader(g, st.better), s: leader(set, st.better) },
    };
  }

  // The seed picks each callout's wording: the set and its players, so the next set reads differently.
  const ctx = { games, last, names, score, rows, over, seed: base.key, recent: opts.recent, leadChanges: last.leadChanges, bothLastStock: last.bothLastStock };
  return {
    ...base,
    games: games.map((g) => ({ n: g.n, winner: g.winner, stage: g.stage, len: clock(g.seconds), seconds: g.seconds, stocks: g.per[g.winner]?.stocksLeft ?? null })),
    rows,
    insights: {
      game: rank([...safe(gameInsights, ctx), ...safe(accolades, ctx, "game")]),
      set: rank([...safe(setInsights, ctx), ...safe(accolades, ctx, "set")]),
    },
    stories: { game: safe(gameStories, ctx).slice(0, MAX_STORIES), set: safe(setStories, ctx).slice(0, MAX_STORIES) },
    facts: { game: safe(gameFacts, ctx, sb), set: safe(setFacts, ctx, sb) },
  };
}

/**
 * One kind of text, or none if it can't be worked out: a callout that trips
 * over an odd game (a missing number, a game with no winner) costs that line,
 * not the popup — the ledger still draws.
 */
function safe(fn, ...args) {
  try {
    const out = fn(...args);
    return Array.isArray(out) ? out : [];
  } catch (err) {
    console.warn(`[set-stats] ${fn.name} skipped: ${err?.message ?? err}`);
    return [];
  }
}

function unavailable(reason) {
  return { available: false, reason, key: "", games: [], rows: {}, sides: [], score: [0, 0], over: false, counted: 0, total: 0, pending: 0,
    insights: { game: [], set: [] }, stories: { game: [], set: [] }, facts: { game: [], set: [] }, stats: STATS };
}

/** A side's name: the tag, else the character, else the column. */
function nameOf(side, ch, i) {
  const tags = side.players.map((p) => p.tag).filter(Boolean);
  if (tags.length) return tags.join(" & ");
  const display = ch?.codename ? Object.values(CHAR_MAP).find((c) => c.codename === ch.codename)?.display : null;
  return display || (i === 0 ? "Left" : "Right");
}

/**
 * Best first, the top few, mixed: a callout (set highs, streaks, comebacks)
 * then an accolade (accolades.js), never three of one kind in a row, so the
 * fun ones reach the first few slots. One per id, one per stat and player
 * ("Early kill 17%" and "Earliest yet 17%" are the same fact told twice), and
 * one accolade per family and player. The score stays server-side.
 */
function rank(list) {
  const seen = new Set();
  const titles = new Set();
  const keep = (x) => {
    const keys = [x.id, x.row ? `${x.row}:${x.side}` : null, x.family ? `${x.family}:${x.side}` : null].filter(Boolean);
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    // Two on screen under one title ("Set high", "Set high"): the second takes another of its own.
    if (titles.has(x.tag)) x.tag = (x.tagAlts || []).find((t) => !titles.has(t)) || x.tag;
    titles.add(x.tag);
    return true;
  };
  const sorted = list.slice().sort((a, b) => b.score - a.score);
  const queues = { c: sorted.filter((x) => x.kind !== "accolade"), a: sorted.filter((x) => x.kind === "accolade") };
  const out = [];
  let run = { k: null, n: 0 };
  while ((queues.c.length || queues.a.length) && out.length < MAX_INSIGHTS) {
    const [c, a] = [queues.c[0], queues.a[0]];
    let k;
    if (!c) k = "a";
    else if (!a) k = "c";
    else if (run.n >= 2) k = run.k === "c" ? "a" : "c";
    else k = c.score >= a.score ? "c" : "a";
    const x = queues[k].shift();
    if (!keep(x)) continue;
    out.push(x);
    run = run.k === k ? { k, n: run.n + 1 } : { k, n: 1 };
  }
  return out.map(({ score, family, tagAlts, ...x }) => x);
}

// ── Callouts ──────────────────────────────────────────────────────────────────
// Each in several wordings — tag, line, margin note, long sentence — picked by
// the seed, so the same callout reads differently from game to game.

/** A template to text: {k} and {*k} both plain. */
const fillText = (tpl, v) => tpl.replace(/\{\*?(\w+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : ""));
/** One callout: its wordings picked and filled, the rest as given. */
function callout({ seed, step = 0, salt = "" }, base, w, vars) {
  const one = (list, k) => (list ? pick([].concat(list), seed, `${base.id}:${k}${salt}`, step) : null);
  const v = { who: base.who, ...vars };
  return {
    ...base,
    ...(() => { const t = rotate(w.tag, seed, `${base.id}:t${salt}`, step); return { tag: t[0], tagAlts: t.slice(1) }; })(),
    text: fillText(one(w.text, "s"), v),
    note: w.note ? fillText(one(w.note, "n"), v) : null,
    long: w.long ? say(one(w.long, "l"), v) : null,
  };
}

// The set highs. Notes go between a ledger row's label and its number: short.
const HIGH = {
  combo: { tag: ["Set high", "Longest yet", "New high"], text: ["Longest combo of the set so far", "The set's longest string yet"], note: ["longest yet!", "set high"],
    long: ["{who}'s {*v}-hit combo is the longest of the set so far.", "Set high: a {*v}-hit string from {who}.", "Nobody's strung more together this set than {who}'s {*v} hits."] },
  punish: { tag: ["Set high", "Biggest yet"], text: ["Biggest punish of the set so far", "The set's biggest punish yet"], note: ["set's biggest", "biggest yet"],
    long: ["{who}'s {*v}% punish is the biggest of the set so far.", "Set high: {who} took {*v}% off a single opening.", "{*v}% in one go from {who}, the most of the set."] },
  dpo: { tag: ["Hardest hitter", "Heavy hands"], text: ["Damage per opening, a set high", "The most damage an opening this set"], note: ["set high", "hits hard"],
    long: ["{who} hit for {*v} damage an opening, the most in any game this set.", "{*v} damage per opening from {who}: a set high."] },
  lcancel: { tag: ["Set high", "Cleanest yet"], text: ["L-cancels, the set's best so far", "The cleanest L-cancelling yet"], note: ["cleanest yet", "clean!"],
    long: ["{who} L-cancelled {*v}%, the cleanest game of the set.", "Tech check passed: {*v}% L-cancels from {who}, a set high."] },
  damage: { tag: ["Set high", "Most yet"], text: ["Most damage in a game this set", "The set's biggest damage total"], note: ["most yet", "set high"],
    long: ["{who} dealt {*v}% this game, the most of the set.", "{*v}% dealt by {who}: nobody has done more in a game this set."] },
  neutral: { tag: ["Set high", "Neutral ace"], text: ["Neutral wins, the most in a game this set", "The most neutral wins in a game yet"], note: ["most yet", "set high"],
    long: ["{who} won neutral {*v} times this game, a set high.", "{*v} neutral wins for {who}, more than in any game so far."] },
  earliest: { tag: ["Earliest yet", "Early exit"], text: ["The set's earliest kill so far", "The earliest stock of the set"], note: ["earliest yet!", "{v}%!"],
    long: ["{who} took a stock at {*v}%, the earliest of the set so far.", "Earliest kill of the set: {who}, at just {*v}%."] },
  opk: { tag: ["Best yet", "Efficient"], text: ["Fewest openings per kill this set", "The set's most efficient game"], note: ["cleanest yet", "efficient"],
    long: ["{who} needed just {*v} openings a kill, the fewest of the set.", "{*v} openings per kill from {who}: the set's most efficient game."] },
};
/** A streak's stat, as a phrase: "ahead in neutral". */
const STREAK = { neutral: "ahead in neutral", opk: "the more efficient", dpo: "the harder hitter", damage: "ahead on damage" };
const WEIGHT = { combo: 5, punish: 5, dpo: 4, lcancel: 3, damage: 3, neutral: 4, earliest: 5, opk: 4 };

function gameInsights({ games, last, names, score, seed }) {
  const how = { seed, step: last.n };
  const out = [];
  const n = games.length;
  const P = last.per;
  const W = last.winner;
  const Lo = 1 - W;
  const who = (s) => names[s];
  const C = (base, w, vars) => out.push(callout(how, base, w, vars));

  // Set highs: this game's number beats every other game's, either player's.
  if (n >= 2) {
    for (const [key, w] of Object.entries(HIGH)) {
      const st = STATS[key];
      for (const s of [0, 1]) {
        const v = P[s][key];
        if (v == null) continue;
        const others = nums(games.flatMap((g, gi) => [0, 1].map((ss) => (gi === n - 1 && ss === s ? null : g.per[ss][key]))));
        if (!others.length) continue;
        if (!(st.better === "lo" ? v < Math.min(...others) : v > Math.max(...others))) continue;
        const first = games[0].per[s][key];
        const up = key === "lcancel" && first != null && v - first >= 5;
        C({ id: `high-${key}-${s}`, big: fmt(key, v), unit: st.unit, who: who(s), side: s, row: key, score: WEIGHT[key] + 3 },
          up ? { ...w, text: ["L-cancels, up from {first}% in game 1"], long: ["{who} L-cancelled {*v}%, up from {*first}% in game 1."] } : w, { v: fmt(key, v), first });
      }
    }
  }

  // Streaks: ahead on a stat in every game so far — more striking when behind in the set.
  if (n >= 2) {
    for (const key of ["neutral", "opk", "dpo", "damage"]) {
      const leads = games.map((g) => leader([g.per[0][key], g.per[1][key]], STATS[key].better));
      for (const s of [0, 1]) {
        if (!leads.every((l) => l === s)) continue;
        const down = score[s] < score[1 - s];
        const ahead = STREAK[key];
        C({ id: `streak-${key}`, big: `${n}/${n}`, who: who(s), side: s, row: key, span: "set", score: 5 + (down ? 4 : 0) + (key === "neutral" ? 1 : 0) }, {
          tag: down ? ["Streak", "Still pushing"] : ["Streak", "Every game", "Consistent"],
          text: down ? [`Games ${ahead}, and still down {a}–{b}`] : [`Games ${ahead}`, `${ahead.charAt(0).toUpperCase()}${ahead.slice(1)} every game`],
          note: ["{n} of {n}", "every game"],
          long: down ? [`{who} has been ${ahead} in all {*n} games and still trails {*a}–{*b}.`, `Every game, {who} has been ${ahead}. The scoreboard says {*a}–{*b} anyway.`]
            : [`{who} has been ${ahead} in all {*n} games.`, `{*n} games, {*n} times ${ahead} for {who}.`],
        }, { n, a: score[s], b: score[1 - s] });
      }
    }
  }

  // The result against the run of play.
  const nw = [P[0].neutral, P[1].neutral];
  if (nw[W] != null && nw[Lo] != null && nw[W] < nw[Lo]) {
    C({ id: "grain", big: `${nw[W]}–${nw[Lo]}`, who: who(W), side: W, row: "neutral", score: 6 }, {
      tag: ["Against the grain", "Won anyway", "Who needs neutral"],
      text: ["Lost neutral and still won the game", "Behind in neutral, ahead on stocks"],
      note: ["won anyway", "didn't matter"],
      long: ["{who} lost neutral {*nv} and took the game anyway.", "Neutral went {opp}'s way, {*nv}. The game didn't."],
    }, { nv: `${nw[W]}–${nw[Lo]}`, opp: who(Lo) });
  }

  // How it finished.
  const left = P[W].stocksLeft;
  if (left === 1) {
    let k = 0;
    for (let i = n - 1; i >= 0 && games[i].per[games[i].winner].stocksLeft === 1; i--) k++;
    if (k >= 2) {
      C({ id: "laststock", big: String(k), unit: "×", who: `Games ${gameList(games.slice(-k).map((g) => g.n))}`, side: -1, span: "set", score: 6 + k }, {
        tag: ["Down to the wire", "Nail-biters", "Heart rates up"], text: ["Last-stock finishes in a row", "Last stock, again"],
        long: k >= 3 ? ["{*k} last-stock finishes in a row. Nobody is getting comfortable.", "Last stock, last stock, last stock: {*k} in a row now."]
          : ["Two last-stock finishes in a row. Nobody is getting comfortable.", "Back-to-back games down to the last stock."],
      }, { k });
    } else {
      C({ id: "laststock", big: "1", unit: " stock", who: `${who(W)} held on`, side: -1, score: 4 }, {
        tag: ["Last stock", "Photo finish", "Close call"], text: [`Game ${last.n} came down to the last stock`, `Game ${last.n} went to the final stock`],
        long: [`Game ${last.n} came down to the last stock, and {W} held on.`, `{W} won game ${last.n} with one stock left, and not much of it.`],
      }, { W: who(W) });
    }
  } else if (left >= 3) {
    C({ id: "stocks", big: String(left), unit: " stocks", who: who(W), side: W, score: 4 + left }, {
      tag: left === 4 ? ["Four-stock", "Flawless", "Untouched"] : ["Stocks to spare", "Comfortable", "Cruise control"],
      text: [`Left at the end of game ${last.n}`, `Still in hand at the end of game ${last.n}`],
      long: left === 4 ? ["{who} four-stocked game {*g}. Not a single stock lost.", "A four-stock from {who} in game {*g}."] : ["{who} finished game {*g} with {*k} stocks still in hand.", "{*k} stocks to spare for {who} in game {*g}."],
    }, { k: left, g: last.n });
  }
  const deficit = P[W].maxDeficit ?? 0;
  if (deficit >= 2) {
    C({ id: "comeback", big: String(deficit), unit: " stocks", who: who(W), side: W, score: 9 + deficit }, {
      tag: ["Comeback", "Never out of it", "Rally"],
      text: [`Down ${deficit} stocks and took the game anyway`, `Came back from ${deficit} stocks down`],
      long: ["{who} was {*d} stocks down and won the game anyway.", "Down {*d} stocks, {who} came all the way back."],
    }, { d: deficit });
  }

  for (const s of [0, 1]) {
    const o = 1 - s;
    const p = P[s];
    if (p.sd >= 1) {
      C({ id: `sd-${s}`, big: String(p.sd), who: who(s), side: s, score: 3 + p.sd }, {
        tag: ["Costly", "Self-inflicted", "Oops"], text: [`${plural(p.sd, "Self-destruct")} this game`, `${p.sd} ${plural(p.sd, "stock")} given away`],
        note: [`${p.sd} ${plural(p.sd, "SD")}`],
        long: [`{who} self-destructed {*k} ${plural(p.sd, "time")} this game.`, `${p.sd === 1 ? "One stock" : "{*k} stocks"} handed over by {who}, no help needed.`],
      }, { k: p.sd });
    }
    if (p.earliest != null && p.earliest <= 75) {
      C({ id: `early-${s}`, big: fmt("earliest", p.earliest), unit: "%", who: who(s), side: s, row: "earliest", score: 5 + (75 - p.earliest) / 10 }, {
        tag: ["Early kill", "Quick kill", "Early exit"], text: ["Took a stock at {v}%", "A stock at just {v}%"], note: ["{v}%!", "so early"],
        long: ["{who} took a stock at just {*v}%.", "{*v}%: that's how early {who} found a kill."],
      }, { v: p.earliest });
    }
    if (p.punish != null && p.punish >= 75) {
      C({ id: `punish-${s}`, big: fmt("punish", p.punish), unit: "%", who: who(s), side: s, row: "punish", score: 4 + (p.punish - 75) / 20 }, {
        tag: ["Big punish", "Heavy punish", "One opening"], text: ["In a single opening", "Off one opening"], note: ["one opening", "{v}% punish"],
        long: ["{who} took {*v}% off a single opening.", "One opening, {*v}% damage: {who} made it count."],
      }, { v: p.punish });
    }
    if (p.combo != null && p.combo >= 8) {
      C({ id: `combo-${s}`, big: String(p.combo), unit: " hits", who: who(s), side: s, row: "combo", score: 4 + (p.combo - 8) / 2 }, {
        tag: ["Long combo", "Combo string", "Kept it going"], text: ["Longest string of the game", "Hits in one combo"], note: ["{v} hits", "long one"],
        long: ["{who} strung together {*v} hits in one combo.", "A {*v}-hit combo from {who}, the longest of the game."],
      }, { v: p.combo });
    }
    if (p.dpo != null && P[o].dpo != null && p.dpo >= 1.25 * P[o].dpo) {
      C({ id: `dpo-${s}`, big: fmt("dpo", p.dpo), who: who(s), side: s, row: "dpo", score: 4 }, {
        tag: ["Hardest hitter", "Heavy hands"], text: [`Damage per opening (${who(o)} ${fmt("dpo", P[o].dpo)})`, `Damage an opening, to ${fmt("dpo", P[o].dpo)}`], note: ["hit harder", "heavy"],
        long: ["{who} hit for {*v} damage an opening; {opp} for {*ov}.", "Every opening counted more for {who}: {*v} damage each, to {opp}'s {*ov}."],
      }, { v: fmt("dpo", p.dpo), ov: fmt("dpo", P[o].dpo), opp: who(o) });
    }
    if (p.lcancel != null && p.lcancel >= 90) {
      C({ id: `lc-${s}`, big: String(p.lcancel), unit: "%", who: who(s), side: s, row: "lcancel", score: 3 }, {
        tag: ["Clean tech", "Crisp", "Frame perfect"], text: ["L-cancels this game", "Of L-cancels hit"], note: ["clean", "crisp"],
        long: ["{who} hit {*v}% of their L-cancels.", "{*v}% L-cancels from {who}. Clean hands."],
      }, { v: p.lcancel });
    }
  }

  if (last.seconds != null) {
    const shortest = n >= 2 && games.every((g) => g === last || (g.seconds ?? Infinity) > last.seconds);
    if (last.seconds < 120 || shortest) {
      C({ id: "quick", big: clock(last.seconds), who: `${who(W)} won it`, side: -1, score: last.seconds < 120 ? 5 : 3 }, {
        tag: shortest ? ["Shortest yet", "Quickest yet"] : ["Quick", "In a hurry", "Speedy"],
        text: shortest ? [`Game ${last.n}, the set's shortest so far`] : [`Game ${last.n}, over in under two minutes`, `Under two minutes on the clock`],
        long: shortest ? [`Game ${last.n} took {*t}, the quickest of the set so far.`] : [`Game ${last.n} was over in {*t}.`, `{*t}, start to finish: {W} wasted no time.`],
      }, { t: clock(last.seconds), W: who(W) });
    }
  }
  return out;
}

/** The best value of a stat across the set: { v, side, games: [n…] } (the games it was reached in). */
function setBest(games, key) {
  const st = STATS[key];
  let best = null;
  for (const g of games) {
    for (const s of [0, 1]) {
      const v = g.per[s][key];
      if (v == null) continue;
      if (!best || (st.better === "lo" ? v < best.v : v > best.v)) best = { v, side: s, games: [g.n], stage: g.stage };
      else if (v === best.v && s === best.side) best.games.push(g.n);
    }
  }
  return best;
}

function setInsights({ games, names, score, seed }) {
  const how = { seed, salt: ":set" };
  const out = [];
  const n = games.length;
  const W = score[0] === score[1] ? null : (score[0] > score[1] ? 0 : 1);
  const who = (s) => names[s];
  const total = (key, s) => sum(games.map((g) => g.per[s][key]));
  const avg = (key, s) => agg(games.map((g) => g.per[s][key]), "avg");
  const C = (base, w, vars) => out.push(callout(how, base, w, vars));
  const where = (b) => `Game ${b.games[0]}${b.stage?.name ? ` on ${b.stage.name}` : ""}`;

  if (W != null) {
    const L = 1 - W;
    const nw = [total("neutral", 0), total("neutral", 1)];
    if (nw[W] < nw[L]) {
      C({ id: "grain", big: `${nw[W]}–${nw[L]}`, who: who(W), side: W, row: "neutral", score: 9 }, {
        tag: ["Against the grain", "Won anyway"], text: [`Lost neutral over the set and took it ${score[W]}–${score[L]}`, `Behind in neutral, won ${score[W]}–${score[L]}`],
        note: ["won anyway", "didn't matter"],
        long: ["{who} lost neutral {*nv} over the set and won it {*sc} anyway.", "Neutral, {*nv} to {opp}. The set, {*sc} to {who}."],
      }, { nv: `${nw[W]}–${nw[L]}`, sc: `${score[W]}–${score[L]}`, opp: who(L) });
    }
    if (score[L] === 0 && score[W] >= 2) {
      C({ id: "sweep", big: `${score[W]}–0`, who: who(W), side: W, score: 5 }, {
        tag: ["Clean sweep", "Swept", "No games dropped"], text: ["Didn't drop a game", "A clean sweep"],
        long: ["{who} didn't drop a game: {*sc}.", "A clean {*sc} sweep for {who}."],
      }, { sc: `${score[W]}–0` });
    }
    // Lost the opening games, won every one after.
    const order = games.map((g) => g.winner);
    const k = order.findIndex((x) => x === W);
    if (n === score[0] + score[1] && k >= 2 && order.slice(k).every((x) => x === W)) {
      C({ id: "reverse", big: `0–${k}`, who: who(W), side: W, score: 12 }, {
        tag: ["Reverse sweep", "From 0–" + k, "Never in doubt"], text: [`Down ${k} games, then won ${score[W]} straight`],
        long: ["{who} lost the first {*k} games and won the next {*w}. Reverse sweep.", "0–{*k} down, {*w} straight wins: a reverse sweep from {who}."],
      }, { k, w: score[W] });
    }
  }

  if (n >= 2) {
    const leads = games.map((g) => leader([g.per[0].neutral, g.per[1].neutral], "hi"));
    for (const s of [0, 1]) {
      if (leads.every((l) => l === s)) {
        C({ id: "neutral-all", big: `${n}/${n}`, who: who(s), side: s, row: "neutral", score: 6 + (W === 1 - s ? 2 : 0) }, {
          tag: ["Every game", "Neutral ace"], text: ["Games winning neutral", "Won neutral every game"], note: ["{n} of {n}", "every game"],
          long: ["{who} won neutral in all {*n} games.", "{*n} for {*n}: {who} won neutral every game of the set."],
        }, { n });
      }
    }
  }

  const e = setBest(games, "earliest");
  if (e) C({ id: "earliest", big: fmt("earliest", e.v), unit: "%", who: who(e.side), side: e.side, row: "earliest", score: 5 + (100 - e.v) / 15 }, {
    tag: ["Earliest kill", "Quickest kill"], text: [where(e)], note: ["{v}%!", "earliest"],
    long: ["The set's earliest kill: {who} at {*v}%, in game {*g}.", "{who} found the set's earliest stock at {*v}% (game {*g})."],
  }, { v: e.v, g: e.games[0] });
  const p = setBest(games, "punish");
  if (p) {
    const twice = p.games.length > 1;
    C({ id: "punish", big: fmt("punish", p.v), unit: "%", who: who(p.side), side: p.side, row: "punish", score: 5 + (twice ? 2 : 0) }, {
      tag: ["Biggest punish", "Heaviest punish"], text: [twice ? `${p.games.length === 2 ? "Twice" : `${p.games.length} times`}, in games ${gameList(p.games)}` : where(p)],
      note: [twice ? "twice" : "set's biggest", twice ? "twice!" : "biggest"],
      long: ["The set's biggest punish: {who}, {*v}% off one opening.", "{who} took {*v}% in one punish, the most of the set."],
    }, { v: p.v });
  }
  const c = setBest(games, "combo");
  if (c && c.v >= 4) C({ id: "combo", big: String(c.v), unit: " hits", who: who(c.side), side: c.side, row: "combo", score: 4 + c.v / 4 }, {
    tag: ["Longest combo", "Longest string"], text: [where(c)], note: ["set's longest", "longest"],
    long: ["The set's longest combo: {*v} hits from {who}.", "{who} strung {*v} hits together, the longest combo of the set."],
  }, { v: c.v });

  const timed = games.filter((g) => g.seconds != null);
  if (timed.length >= 2) {
    const q = timed.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    const left = q.per[q.winner].stocksLeft;
    C({ id: "quick", big: clock(q.seconds), who: left > 1 ? `${left} stocks to spare` : `${who(q.winner)} won it`, side: -1, score: 4 }, {
      tag: ["Closed out", "Quickest game", "In a hurry"], text: [`Game ${q.n}, the set's shortest`],
      long: [`Game ${q.n} was the quickest of the set: {*t}.`, `{*t} — game ${q.n} was over before it started.`],
    }, { t: clock(q.seconds) });
  }

  for (const s of [0, 1]) {
    const sds = total("sd", s);
    if (sds >= 2) C({ id: `sd-${s}`, big: String(sds), who: who(s), side: s, score: 4 + sds }, {
      tag: ["Costly", "Self-inflicted"], text: [`Self-destructs in ${n} ${plural(n, "game")}`], note: [`${sds} SDs`],
      long: [`{who} self-destructed {*k} times across the set.`, `{*k} stocks handed over by {who}, no help needed.`],
    }, { k: sds });
    const o = 1 - s;
    const d = [avg("dpo", s), avg("dpo", o)];
    if (d[0] != null && d[1] != null && d[0] >= 1.2 * d[1]) C({ id: `dpo-${s}`, big: fmt("dpo", d[0], true), who: who(s), side: s, row: "dpo", score: 4 }, {
      tag: ["Hardest hitter", "Heavy hands"], text: [`Damage per opening (${who(o)} ${fmt("dpo", d[1], true)})`], note: ["hit harder", "heavy"],
      long: ["{who} averaged {*v} damage an opening across the set; {opp} {*ov}."],
    }, { v: fmt("dpo", d[0], true), ov: fmt("dpo", d[1], true), opp: who(o) });
    const lc = avg("lcancel", s);
    if (lc != null && lc >= 88) C({ id: `lc-${s}`, big: fixed(lc, 0), unit: "%", who: who(s), side: s, row: "lcancel", score: 3 }, {
      tag: ["Clean tech", "Crisp"], text: ["L-cancels across the set"], note: ["clean", "crisp"],
      long: ["{who} hit {*v}% of their L-cancels across the set."],
    }, { v: fixed(lc, 0) });
  }

  const comebacks = games.filter((g) => (g.per[g.winner].maxDeficit ?? 0) >= 2);
  if (comebacks.length) {
    const g = comebacks.reduce((a, b) => (b.per[b.winner].maxDeficit > a.per[a.winner].maxDeficit ? b : a));
    const d = g.per[g.winner].maxDeficit;
    C({ id: "comeback", big: String(d), unit: " stocks", who: who(g.winner), side: g.winner, score: 9 + d }, {
      tag: ["Comeback", "Never out of it"], text: [`Down ${d} in game ${g.n} and came back`],
      long: ["{who} came back from {*d} stocks down in game {*g}.", "Game {*g}: {who}, {*d} stocks behind, won it anyway."],
    }, { d, g: g.n });
  }
  const close = games.filter((g) => g.per[g.winner].stocksLeft === 1).map((g) => g.n);
  if (close.length >= 2) C({ id: "laststock", big: String(close.length), who: `Games ${gameList(close)}`, side: -1, score: 5 + close.length }, {
    tag: ["Down to the wire", "Nail-biters"], text: ["Last-stock games", "Games to the last stock"],
    long: ["{*k} games went to the last stock: games {list}.", "Last stock, {*k} times (games {list})."],
  }, { k: close.length, list: gameList(close) });
  return out;
}

// ── Facts ─────────────────────────────────────────────────────────────────────

function gameFacts({ games, last }, sb) {
  const left = last.per[last.winner].stocksLeft;
  const total = sum(games.map((g) => g.seconds));
  return [
    { lab: "Stage", val: last.stage?.name || "—" },
    { lab: "Length", val: clock(last.seconds) || "—" },
    { lab: "Won with", val: left == null ? "—" : `${left} ${plural(left, "stock")}` },
    { lab: "Set so far", val: `${sb.games.length} ${plural(sb.games.length, "game")} · ${clock(total)}` },
  ];
}

function setFacts({ games }, sb) {
  const total = sum(games.map((g) => g.seconds));
  const counts = {};
  for (const g of games) if (g.stage?.name) counts[g.stage.name] = (counts[g.stage.name] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const timed = games.filter((g) => g.seconds != null);
  const longest = timed.length ? timed.reduce((a, b) => (b.seconds > a.seconds ? b : a)) : null;
  return [
    { lab: "Games", val: String(sb.games.length) },
    { lab: "Set length", val: clock(total) || "—" },
    { lab: "Most played", val: top ? `${top[0]}${top[1] > 1 ? ` ×${top[1]}` : ""}` : "—" },
    { lab: "Longest game", val: longest ? `G${longest.n} · ${clock(longest.seconds)}` : "—" },
  ];
}

module.exports = { buildSetView, unavailable, leader };
