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

const MAX_INSIGHTS = 8;
const MAX_STORIES = 3;

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
/** A label mid-sentence: "Damage dealt" → "damage dealt", but "L-cancel" stays. */
const lower = (s) => (/^[A-Z]-/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
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
 */
function buildSetView(sb, statsOf, portraitsOf = () => null) {
  if (!sb) return unavailable("No set on the scoreboard");
  if (sb.crew) return unavailable("Crew battle — no set stats");
  if (sb.isDoubles) return unavailable("Doubles — set stats are singles only");

  let pending = 0;
  let unreadable = 0;
  const games = [];
  sb.games.forEach((g, i) => {
    const file = g.replay?.file;
    if (!file) return;
    const r = statsOf(file);
    if (r === undefined) { pending++; return; }
    if (!r.ok) { unreadable++; return; }
    const per = [0, 1].map((side) => r.players[g.replay.players?.[side]?.[0]?.port]);
    if (!per[0] || !per[1]) { unreadable++; return; }
    games.push({
      n: i + 1,
      winner: g.winnerSide,
      stage: stageOf(r.stageId),
      seconds: r.seconds,
      per,
      chars: per.map((x) => ({ codename: CHAR_MAP[x.characterId]?.codename ?? null, skin: x.costume ?? 0 })),
    });
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

  const ctx = { games, last, names, score, rows, over };
  return {
    ...base,
    games: games.map((g) => ({ n: g.n, winner: g.winner, stage: g.stage, len: clock(g.seconds), seconds: g.seconds, stocks: g.per[g.winner]?.stocksLeft ?? null })),
    rows,
    insights: { game: rank(safe(gameInsights, ctx)), set: rank(safe(setInsights, ctx)) },
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
 * Best first, the top few; the score stays server-side. One callout per id,
 * and one per stat and player: "Early kill 17%" and "Earliest yet 17%" are
 * the same fact told twice.
 */
function rank(list) {
  const seen = new Set();
  return list.sort((a, b) => b.score - a.score)
    .filter((x) => {
      const keys = [x.id, x.row ? `${x.row}:${x.side}` : null].filter(Boolean);
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .slice(0, MAX_INSIGHTS)
    .map(({ score, ...x }) => x);
}

// ── Callouts: after a game ────────────────────────────────────────────────────

const HIGH = {
  combo:    ["Set high", "Longest combo of the set so far", "longest of the set!"],
  punish:   ["Set high", "Biggest punish of the set so far", "set's biggest"],
  dpo:      ["Hardest hitter", "Damage per opening, a set high", "set high"],
  lcancel:  ["Set high", "L-cancels, the set's best so far", "cleanest yet"],
  damage:   ["Set high", "Most damage in a game this set", "most yet"],
  neutral:  ["Set high", "Neutral wins, the most in a game this set", "most yet"],
  earliest: ["Earliest yet", "The set's earliest kill so far", "earliest yet!"],
  opk:      ["Best yet", "Fewest openings per kill this set", "cleanest yet"],
};
const WEIGHT = { combo: 5, punish: 5, dpo: 4, lcancel: 3, damage: 3, neutral: 4, earliest: 5, opk: 4 };

function gameInsights({ games, last, names, score }) {
  const out = [];
  const n = games.length;
  const P = last.per;
  const W = last.winner;
  const Lo = 1 - W;
  const who = (s) => names[s];

  // Set highs: this game's number beats every other game's, either player's.
  if (n >= 2) {
    for (const [key, [tag, text, note]] of Object.entries(HIGH)) {
      const st = STATS[key];
      for (const s of [0, 1]) {
        const v = P[s][key];
        if (v == null) continue;
        const others = nums(games.flatMap((g, gi) => [0, 1].map((ss) => (gi === n - 1 && ss === s ? null : g.per[ss][key]))));
        if (!others.length) continue;
        if (!(st.better === "lo" ? v < Math.min(...others) : v > Math.max(...others))) continue;
        let line = text;
        const first = games[0].per[s][key];
        if (key === "lcancel" && first != null && v - first >= 5) line = `L-cancels, up from ${first}% in game 1`;
        out.push({ id: `high-${key}-${s}`, tag, big: fmt(key, v), unit: st.unit, text: line, who: who(s), side: s, row: key, note, score: WEIGHT[key] + 3 });
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
        out.push({
          id: `streak-${key}`, tag: "Streak", big: `${n}/${n}`,
          text: `Games ahead on ${lower(STATS[key].label)}${down ? `, and still down ${score[s]}–${score[1 - s]}` : ""}`,
          who: who(s), side: s, row: key, note: `${n} of ${n}`, score: 5 + (down ? 4 : 0) + (key === "neutral" ? 1 : 0),
        });
      }
    }
  }

  // The result against the run of play.
  const nw = [P[0].neutral, P[1].neutral];
  if (nw[W] != null && nw[Lo] != null && nw[W] < nw[Lo]) {
    out.push({ id: "grain", tag: "Against the grain", big: `${nw[W]}–${nw[Lo]}`, text: "Lost neutral and still won the game", who: who(W), side: W, row: "neutral", note: "lost neutral, won anyway", score: 6 });
  }

  // How it finished.
  const left = P[W].stocksLeft;
  if (left === 1) {
    let k = 0;
    for (let i = n - 1; i >= 0 && games[i].per[games[i].winner].stocksLeft === 1; i--) k++;
    if (k >= 2) {
      out.push({ id: "laststock", tag: "Down to the wire", big: String(k), unit: "×", text: "Last-stock finishes in a row", who: `Games ${gameList(games.slice(-k).map((g) => g.n))}`, side: -1, score: 6 + k });
    } else {
      out.push({ id: "laststock", tag: "Last stock", big: "1", unit: " stock", text: `Game ${last.n} came down to the last stock`, who: `${who(W)} held on`, side: -1, score: 4 });
    }
  } else if (left >= 3) {
    out.push({ id: "stocks", tag: left === 4 ? "Four-stock" : "Stocks to spare", big: String(left), unit: " stocks", text: `Left at the end of game ${last.n}`, who: who(W), side: W, score: 4 + left });
  }
  const deficit = P[W].maxDeficit ?? 0;
  if (deficit >= 2) {
    out.push({ id: "comeback", tag: "Comeback", big: String(deficit), unit: " stocks", text: `Down ${deficit} stocks and took the game anyway`, who: who(W), side: W, score: 9 + deficit });
  }

  for (const s of [0, 1]) {
    const o = 1 - s;
    const p = P[s];
    if (p.sd >= 1) out.push({ id: `sd-${s}`, tag: "Costly", big: String(p.sd), text: `${plural(p.sd, "Self-destruct")} this game`, who: who(s), side: s, note: `${p.sd} ${plural(p.sd, "SD")}`, score: 3 + p.sd });
    if (p.earliest != null && p.earliest <= 75) out.push({ id: `early-${s}`, tag: "Early kill", big: fmt("earliest", p.earliest), unit: "%", text: `Took a stock at ${p.earliest}%`, who: who(s), side: s, row: "earliest", note: `${p.earliest}%!`, score: 5 + (75 - p.earliest) / 10 });
    if (p.punish != null && p.punish >= 75) out.push({ id: `punish-${s}`, tag: "Big punish", big: fmt("punish", p.punish), unit: "%", text: "In a single opening", who: who(s), side: s, row: "punish", note: "one opening", score: 4 + (p.punish - 75) / 20 });
    if (p.combo != null && p.combo >= 8) out.push({ id: `combo-${s}`, tag: "Long combo", big: String(p.combo), unit: " hits", text: "Longest string of the game", who: who(s), side: s, row: "combo", note: `${p.combo} hits`, score: 4 + (p.combo - 8) / 2 });
    if (p.dpo != null && P[o].dpo != null && p.dpo >= 1.25 * P[o].dpo) out.push({ id: `dpo-${s}`, tag: "Hardest hitter", big: fmt("dpo", p.dpo), text: `Damage per opening (${who(o)} ${fmt("dpo", P[o].dpo)})`, who: who(s), side: s, row: "dpo", note: "hit harder", score: 4 });
    if (p.lcancel != null && p.lcancel >= 90) out.push({ id: `lc-${s}`, tag: "Clean tech", big: String(p.lcancel), unit: "%", text: "L-cancels this game", who: who(s), side: s, row: "lcancel", note: "clean", score: 3 });
    if (p.techMiss != null && p.techMiss >= 6) out.push({ id: `tech-${s}`, tag: "Missed techs", big: String(p.techMiss), text: "Missed techs this game", who: who(s), side: s, score: 2 });
  }

  if (last.seconds != null) {
    const shortest = n >= 2 && games.every((g) => g === last || (g.seconds ?? Infinity) > last.seconds);
    if (last.seconds < 120 || shortest) {
      out.push({ id: "quick", tag: shortest ? "Shortest yet" : "Quick", big: clock(last.seconds), text: shortest ? `Game ${last.n}, the set's shortest so far` : `Game ${last.n}, over in under two minutes`, who: `${who(W)} won it`, side: -1, score: last.seconds < 120 ? 5 : 3 });
    }
  }
  return out;
}

// ── Callouts: the set ─────────────────────────────────────────────────────────

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

function setInsights({ games, names, score }) {
  const out = [];
  const n = games.length;
  const W = score[0] === score[1] ? null : (score[0] > score[1] ? 0 : 1);
  const who = (s) => names[s];
  const total = (key, s) => sum(games.map((g) => g.per[s][key]));
  const avg = (key, s) => agg(games.map((g) => g.per[s][key]), "avg");

  if (W != null) {
    const L = 1 - W;
    const nw = [total("neutral", 0), total("neutral", 1)];
    if (nw[W] < nw[L]) out.push({ id: "grain", tag: "Against the grain", big: `${nw[W]}–${nw[L]}`, text: `Lost neutral over the set and took it ${score[W]}–${score[L]}`, who: who(W), side: W, row: "neutral", note: "lost neutral, won anyway", score: 9 });
    if (score[L] === 0 && score[W] >= 2) out.push({ id: "sweep", tag: "Clean sweep", big: `${score[W]}–0`, text: "Didn't drop a game", who: who(W), side: W, score: 5 });
    // Lost the opening games, won every one after.
    const order = games.map((g) => g.winner);
    const k = order.findIndex((x) => x === W);
    if (n === score[0] + score[1] && k >= 2 && order.slice(k).every((x) => x === W)) {
      out.push({ id: "reverse", tag: "Reverse sweep", big: `0–${k}`, text: `Down ${k} games, then won ${score[W]} straight`, who: who(W), side: W, score: 12 });
    }
  }

  if (n >= 2) {
    const leads = games.map((g) => leader([g.per[0].neutral, g.per[1].neutral], "hi"));
    for (const s of [0, 1]) {
      if (leads.every((l) => l === s)) out.push({ id: "neutral-all", tag: "Every game", big: `${n}/${n}`, text: "Games winning neutral", who: who(s), side: s, row: "neutral", note: `${n} of ${n}`, score: 6 + (W === 1 - s ? 2 : 0) });
    }
  }

  const e = setBest(games, "earliest");
  if (e) out.push({ id: "earliest", tag: "Earliest kill", big: fmt("earliest", e.v), unit: "%", text: `Game ${e.games[0]}${e.stage?.name ? ` on ${e.stage.name}` : ""}`, who: who(e.side), side: e.side, row: "earliest", note: `${e.v}%!`, score: 5 + (100 - e.v) / 15 });
  const p = setBest(games, "punish");
  if (p) {
    const twice = p.games.length > 1;
    out.push({ id: "punish", tag: "Biggest punish", big: fmt("punish", p.v), unit: "%", text: twice ? `${p.games.length === 2 ? "Twice" : `${p.games.length} times`}, in games ${gameList(p.games)}` : `Game ${p.games[0]}${p.stage?.name ? ` on ${p.stage.name}` : ""}`, who: who(p.side), side: p.side, row: "punish", note: twice ? "twice" : "set's biggest", score: 5 + (twice ? 2 : 0) });
  }
  const c = setBest(games, "combo");
  if (c && c.v >= 4) out.push({ id: "combo", tag: "Longest combo", big: String(c.v), unit: " hits", text: `Game ${c.games[0]}${c.stage?.name ? ` on ${c.stage.name}` : ""}`, who: who(c.side), side: c.side, row: "combo", note: "set's longest", score: 4 + c.v / 4 });

  const timed = games.filter((g) => g.seconds != null);
  if (timed.length >= 2) {
    const q = timed.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    const left = q.per[q.winner].stocksLeft;
    out.push({ id: "quick", tag: "Closed out", big: clock(q.seconds), text: `Game ${q.n}, the set's shortest`, who: left > 1 ? `${left} stocks to spare` : `${who(q.winner)} won it`, side: -1, score: 4 });
  }

  for (const s of [0, 1]) {
    const sds = total("sd", s);
    if (sds >= 2) out.push({ id: `sd-${s}`, tag: "Costly", big: String(sds), text: `Self-destructs in ${n} ${plural(n, "game")}`, who: who(s), side: s, note: `${sds} SDs`, score: 4 + sds });
    const o = 1 - s;
    const d = [avg("dpo", s), avg("dpo", o)];
    if (d[0] != null && d[1] != null && d[0] >= 1.2 * d[1]) out.push({ id: `dpo-${s}`, tag: "Hardest hitter", big: fmt("dpo", d[0], true), text: `Damage per opening (${who(o)} ${fmt("dpo", d[1], true)})`, who: who(s), side: s, row: "dpo", note: "hit harder", score: 4 });
    const lc = avg("lcancel", s);
    if (lc != null && lc >= 88) out.push({ id: `lc-${s}`, tag: "Clean tech", big: fixed(lc, 0), unit: "%", text: "L-cancels across the set", who: who(s), side: s, row: "lcancel", note: "clean", score: 3 });
  }

  const comebacks = games.filter((g) => (g.per[g.winner].maxDeficit ?? 0) >= 2);
  if (comebacks.length) {
    const g = comebacks.reduce((a, b) => (b.per[b.winner].maxDeficit > a.per[a.winner].maxDeficit ? b : a));
    const d = g.per[g.winner].maxDeficit;
    out.push({ id: "comeback", tag: "Comeback", big: String(d), unit: " stocks", text: `Down ${d} in game ${g.n} and came back`, who: who(g.winner), side: g.winner, score: 9 + d });
  }
  const close = games.filter((g) => g.per[g.winner].stocksLeft === 1).map((g) => g.n);
  if (close.length >= 2) out.push({ id: "laststock", tag: "Down to the wire", big: String(close.length), text: "Last-stock games", who: `Games ${gameList(close)}`, side: -1, score: 5 + close.length });
  return out;
}

// ── Summaries ─────────────────────────────────────────────────────────────────

function gameStories({ games, last, names, score }) {
  const out = [];
  const P = last.per;
  const W = last.winner;
  const L = 1 - W;
  const n = games.length;

  const nl = leader([P[0].neutral, P[1].neutral], "hi");
  const kl = leader([P[0].opk, P[1].opk], "lo");
  if (nl != null) {
    const nv = `${P[nl].neutral}–${P[1 - nl].neutral}`;
    if (kl != null && kl !== nl) {
      out.push([t(`${names[nl]} won neutral `), em(nv), t(`, but ${names[kl]} turned openings into stocks faster: `), em(fmt("opk", P[kl].opk)), t(" a kill to "), em(fmt("opk", P[nl].opk)), t(".")]);
    } else if (P[nl].opk != null) {
      out.push([t(`${names[nl]} won neutral `), em(nv), t(" and needed just "), em(fmt("opk", P[nl].opk)), t(" openings a kill.")]);
    }
  }

  const left = P[W].stocksLeft;
  const seg = [t(`${names[W]} took game ${last.n}${last.stage?.name ? ` on ${last.stage.name}` : ""}`)];
  if (left != null) seg.push(t(" with "), em(left), t(` ${plural(left, "stock")} left`));
  if ((P[W].maxDeficit ?? 0) >= 2) seg.push(t(" after being down "), em(P[W].maxDeficit));
  const [a, b] = [score[W], score[L]];
  seg.push(t(a > b ? `, and leads ${a}–${b}.` : a === b ? `; the set is tied ${a}–${b}.` : `; ${names[L]} still leads ${b}–${a}.`));
  out.push(seg);

  // A player's best game: two or more set highs at once.
  if (n >= 2) {
    for (const s of [0, 1]) {
      const highs = ["lcancel", "combo", "punish", "dpo", "damage", "neutral"].filter((key) => {
        const v = P[s][key];
        const others = nums(games.flatMap((g, gi) => [0, 1].map((ss) => (gi === n - 1 && ss === s ? null : g.per[ss][key]))));
        return v != null && others.length && v > Math.max(...others);
      }).slice(0, 2);
      if (highs.length === 2) {
        const part = (key) => [em(`${fmt(key, P[s][key])}${(STATS[key].unit ?? "").trim() === "%" ? "%" : ""}`), t(` ${key === "combo" ? "-hit combo" : lower(STATS[key].label)}`)];
        out.push([t(`${names[s]}'s best game yet: `), ...part(highs[0]), t(" and "), ...part(highs[1]), t(", both set highs.")]);
        break;
      }
    }
  }

  const ps = leader([P[0].punish, P[1].punish], "hi");
  if (ps != null) {
    const e = leader([P[0].earliest, P[1].earliest], "lo");
    const seg2 = [t(`Biggest punish: ${names[ps]}'s `), em(`${P[ps].punish}%`)];
    if (e != null) seg2.push(t(`; the earliest kill, ${names[e]} at `), em(`${P[e].earliest}%`));
    seg2.push(t("."));
    out.push(seg2);
  }
  return out;
}

function setStories({ games, names, score }) {
  const out = [];
  const n = games.length;
  if (score[0] === score[1]) {
    out.push([t(`The set is tied `), em(`${score[0]}–${score[1]}`), t(` after ${n} counted ${plural(n, "game")}.`)]);
  } else {
    const W = score[0] > score[1] ? 0 : 1;
    const L = 1 - W;
    const nw = [0, 1].map((s) => sum(games.map((g) => g.per[s].neutral)));
    const opk = [0, 1].map((s) => agg(games.map((g) => g.per[s].opk), "avg"));
    const dpo = [0, 1].map((s) => agg(games.map((g) => g.per[s].dpo), "avg"));
    const head = [t(`${names[W]} took the set `), em(`${score[W]}–${score[L]}`)];
    if (nw[W] < nw[L] && opk[W] != null && opk[L] != null) {
      out.push([...head, t(` without winning neutral: ${names[L]} won it `), em(`${nw[L]}–${nw[W]}`), t(`, but needed `), em(fixed(opk[L], 1)), t(` openings a kill to ${names[W]}'s `), em(fixed(opk[W], 1)), t(".")]);
    } else if (dpo[W] != null) {
      out.push([...head, t(", winning neutral "), em(`${nw[W]}–${nw[L]}`), t(" and averaging "), em(fixed(dpo[W], 1)), t(" damage an opening.")]);
    } else {
      out.push([...head, t(".")]);
    }
  }

  const p = setBest(games, "punish");
  if (p) {
    const sds = sum(games.map((g) => g.per[p.side].sd));
    const seg = [t(`${names[p.side]}'s punishes were the set's biggest, `), em(`${p.v}%`), t(p.games.length > 1 ? ` ${p.games.length === 2 ? "twice" : `${p.games.length} times`}` : "")];
    if (sds >= 2) seg.push(t(", but "), em(sds), t(" self-destructs handed stocks back."));
    else seg.push(t("."));
    out.push(seg);
  }

  const timed = games.filter((g) => g.seconds != null);
  const close = games.filter((g) => g.per[g.winner].stocksLeft === 1);
  if (close.length >= 2) {
    out.push([em(close.length), t(` of ${n} games went to the last stock: games ${gameList(close.map((g) => g.n))}.`)]);
  } else if (timed.length >= 2) {
    const q = timed.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    const left = q.per[q.winner].stocksLeft;
    out.push([t(`Game ${q.n} was the quickest: `), em(clock(q.seconds)), t(`${q.stage?.name ? ` on ${q.stage.name}` : ""}, ${names[q.winner]}`), ...(left != null ? [t(" with "), em(left), t(` ${plural(left, "stock")} to spare.`)] : [t(".")])]);
  }
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

module.exports = { buildSetView, STATS, bestOfNumber, leader };
