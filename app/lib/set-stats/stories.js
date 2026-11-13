/**
 * stories.js — the stats popup's summary sentences (the long form a strip or
 * band rotates through). Pure.
 *
 *   gameStories(ctx) / setStories(ctx) → [segments…], best first
 *
 * Each story is a fact that holds for this game or set (who won neutral but
 * not the game, a seesaw of lead changes, a ledge battle, a quick finish…)
 * told in one of several wordings, picked by the seed, so a set's five
 * summaries — and the next set's — don't read alike. Segments: { t } text,
 * { em } lit, { t, name: true } a player's name (as typed, never parsed), so
 * a page can set the names apart from the words and the numbers.
 *
 * Templates: {key} plain, {*key} lit; the keys in NAME_KEYS are players' names.
 * A value can be segments already (a clause with a name in it).
 *
 * ctx: { games, last, names, score, seed } — set-view.js's counted games
 * (per side: game-stats numbers with `fun`), the newest, the two names, the
 * score on the scoreboard.
 */

const { pick } = require("./accolades");

const plural = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);
const clock = (secs) => (secs == null ? "" : `${Math.floor(secs / 60)}:${String(Math.round(secs) % 60).padStart(2, "0")}`);
const fixed = (v, dp = 1) => (v == null ? null : Number(v).toFixed(dp));
const nums = (list) => list.filter((v) => v != null && Number.isFinite(v));
const sum = (list) => nums(list).reduce((a, b) => a + b, 0);
const avg = (list) => { const v = nums(list); return v.length ? sum(v) / v.length : null; };
const fun = (p, k) => (p && p.fun ? p.fun[k] : null);
const gameList = (ns) => (ns.length === 1 ? String(ns[0]) : ns.length === 2 ? `${ns[0]} and ${ns[1]}` : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);

/** The template keys that are a player's name (the callouts' long forms use who and opp). */
const NAME_KEYS = new Set(["W", "L", "N", "K", "X", "Y", "A", "B", "who", "opp"]);
const plain = (s) => s.t != null && !s.name;

/** A template to segments: {*k} lit, {k} plain, a name marked. Opens on a capital unless it opens on a value. */
function say(tpl, v) {
  const out = [];
  let last = 0;
  tpl.replace(/\{(\*?)(\w+)\}/g, (m, star, k, at) => {
    if (at > last) out.push({ t: tpl.slice(last, at) });
    if (Array.isArray(v[k])) out.push(...v[k]);
    else {
      const val = v[k] == null ? "" : String(v[k]);
      if (val) out.push(star ? { em: val } : NAME_KEYS.has(k) ? { t: val, name: true } : { t: val });
    }
    last = at + m.length;
    return m;
  });
  if (last < tpl.length) out.push({ t: tpl.slice(last) });
  if (tpl[0] !== "{" && out[0] && plain(out[0])) out[0] = { t: out[0].t.charAt(0).toUpperCase() + out[0].t.slice(1) };
  // Adjacent plain pieces in one: fewer nodes, and nothing reads as two.
  return out.reduce((acc, s) => {
    const prev = acc[acc.length - 1];
    if (prev && plain(prev) && plain(s)) prev.t += s.t; else acc.push({ ...s });
    return acc;
  }, []);
}

/** A story: its id, how much it's worth telling, and its wordings. */
const story = (id, score, tpls, vars) => ({ id, score, tpls, vars });

// ── After a game ──────────────────────────────────────────────────────────────

function gameStories(ctx) {
  const { games, last, names, score } = ctx;
  const P = last.per;
  const W = last.winner;
  const L = 1 - W;
  const n = games.length;
  const out = [];
  const stage = last.stage && last.stage.name ? last.stage.name : null;

  // The result, and where it leaves the set.
  const left = P[W].stocksLeft;
  const [a, b] = [score[W], score[L]];
  // Segments, so its name is marked like the sentence's own; {Line} opens a sentence.
  const scoreline = a > b ? [{ t: names[W], name: true }, { t: ` leads ${a}–${b}` }]
    : a === b ? [{ t: `the set is tied ${a}–${b}` }]
    : [{ t: names[L], name: true }, { t: ` still leads ${b}–${a}` }];
  const deficit = P[W].maxDeficit ?? 0;
  out.push(story("result", 10, deficit >= 2 ? [
    "{W} took game {g}{on} from {*deficit} stocks down; {line}.",
    "Down {*deficit} stocks, {W} came back to take game {g}{on} — {line}.",
    "{W} was {*deficit} stocks behind in game {g} and won it anyway. {Line}.",
  ] : left != null ? [
    "{W} took game {g}{on} with {*left} {stocks} left; {line}.",
    "Game {g}{on} goes to {W}, {*left} {stocks} to spare — {line}.",
    "{W} closed out game {g}{on} on {*left} {stocks}. {Line}.",
  ] : ["{W} took game {g}{on}; {line}."], {
    W: names[W], g: last.n, on: stage ? ` on ${stage}` : "", left, stocks: plural(left, "stock"), deficit,
    line: scoreline, Line: scoreline.map((s, i) => (i === 0 && plain(s) ? { t: s.t.charAt(0).toUpperCase() + s.t.slice(1) } : s)),
  }));

  // Neutral against efficiency.
  const lead = (k, lo) => (P[0][k] == null || P[1][k] == null || P[0][k] === P[1][k] ? null : (lo ? P[0][k] < P[1][k] : P[0][k] > P[1][k]) ? 0 : 1);
  const nl = lead("neutral");
  const kl = lead("opk", true);
  if (nl != null && P[nl].opk != null) {
    const v = { N: names[nl], K: kl != null ? names[kl] : "", nv: `${P[nl].neutral}–${P[1 - nl].neutral}`, ka: kl != null ? fixed(P[kl].opk) : null, kb: kl != null ? fixed(P[1 - kl].opk) : null, opk: fixed(P[nl].opk) };
    if (kl != null && kl !== nl) {
      out.push(story("neutral", 8, [
        "{N} won neutral {*nv}, but {K} turned openings into stocks faster: {*ka} a kill to {*kb}.",
        "Neutral went to {N}, {*nv}. {K} made theirs count — {*ka} openings a kill against {*kb}.",
        "{N} won more exchanges ({*nv}); {K} won the ones that mattered, at {*ka} openings per kill.",
      ], v));
    } else {
      out.push(story("neutral", 5, [
        "{N} won neutral {*nv} and needed just {*opk} openings a kill.",
        "{N} owned neutral, {*nv}, and cashed in every {*opk} openings.",
        "Neutral and efficiency both went {N}'s way: {*nv}, and {*opk} openings a kill.",
      ], v));
    }
  }

  // How the stocks went.
  if ((ctx.leadChanges ?? 0) >= 2) {
    out.push(story("seesaw", 7 + ctx.leadChanges, [
      "The stock lead changed hands {*k} times before {W} closed it out.",
      "A seesaw: {*k} lead changes, and {W} on top when it stopped.",
      "Back and forth — the lead flipped {*k} times. {W} had the last word.",
    ], { k: ctx.leadChanges, W: names[W] }));
  }
  if (ctx.bothLastStock && left === 1) {
    out.push(story("standoff", 7, [
      "Last stock each, and {L} blinked first.",
      "It came down to one stock apiece; {W} took it.",
      "Both players on their final stock — {W} held their nerve.",
    ], { W: names[W], L: names[L] }));
  } else if (deficit === 0 && P[W].firstBlood && left >= 2) {
    out.push(story("wire", 6, [
      "{W} led from the first stock to the last.",
      "Wire to wire: {W} took the first stock and never gave up the lead.",
      "{L} never got in front. {W} led all the way.",
    ], { W: names[W], L: names[L] }));
  } else if (P[L].firstBlood && left != null) {
    out.push(story("firstblood", 4, [
      "{L} drew first blood, but {W} took the game.",
      "{L} struck first; {W} struck last.",
    ], { W: names[W], L: names[L] }));
  }

  // The best game yet: two set highs at once.
  if (n >= 2) {
    const LABEL = { lcancel: "L-cancel", combo: "-hit combo", punish: "% punish", dpo: "damage per opening", damage: "% damage dealt", neutral: "neutral wins" };
    for (const s of [0, 1]) {
      const highs = Object.keys(LABEL).filter((key) => {
        const v = P[s][key];
        const others = nums(games.flatMap((g) => [0, 1].map((ss) => (g === last && ss === s ? null : g.per[ss][key]))));
        return v != null && others.length && v > Math.max(...others);
      }).slice(0, 2);
      if (highs.length === 2) {
        const part = (key) => `${key === "dpo" ? fixed(P[s][key]) : P[s][key]}${key === "lcancel" ? "%" : ""}`;
        const word = (key) => (key === "combo" || key === "punish" || key === "damage" ? LABEL[key] : ` ${LABEL[key]}`);
        out.push(story("best", 7, [
          "{X}'s best game yet: {*a}{aw} and {*b}{bw}, both set highs.",
          "Two set highs in one game for {X}: {*a}{aw}, {*b}{bw}.",
          "{X} raised the bar twice this game — {*a}{aw} and {*b}{bw}.",
        ], { X: names[s], a: part(highs[0]), aw: word(highs[0]), b: part(highs[1]), bw: word(highs[1]) }));
        break;
      }
    }
  }

  // The punish and the earliest kill.
  const ps = lead("punish");
  if (ps != null) {
    const e = lead("earliest", true);
    out.push(story("punish", 4, e != null ? [
      "Biggest punish: {X}'s {*p}%; the earliest kill, {Y} at {*e}%.",
      "{X} landed the game's biggest punish ({*p}%); {Y} took the earliest stock, at {*e}%.",
    ] : ["Biggest punish of the game: {X}, {*p}%."], { X: names[ps], p: P[ps].punish, Y: e != null ? names[e] : "", e: e != null ? P[e].earliest : null }));
  }

  // Character and style.
  for (const s of [0, 1]) {
    const km = fun(P[s], "killMove");
    if (km && km.n >= 2 && km.of >= 3 && km.n < km.of) {
      out.push(story(`killmove-${s}`, 4, [
        "{X}'s {*move} did the heavy lifting: {*k} of {*of} kills.",
        "{*k} of {X}'s {*of} kills came from {*move}.",
      ], { X: names[s], move: km.name, k: km.n, of: km.of }));
    }
  }
  const air = [fun(P[0], "airPct"), fun(P[1], "airPct")];
  if (air[0] != null && air[1] != null && Math.abs(air[0] - air[1]) >= 14) {
    const hi = air[0] > air[1] ? 0 : 1;
    out.push(story("style", 4, [
      "Two styles: {A} in the air {*a}% of the time, {B} only {*b}%.",
      "{A} spent {*a}% of the game airborne; {B} kept it grounded at {*b}%.",
    ], { A: names[hi], B: names[1 - hi], a: air[hi], b: air[1 - hi] }));
  }
  const ledge = [fun(P[0], "ledgegrabs"), fun(P[1], "ledgegrabs")];
  if (ledge[0] >= 10 && ledge[1] >= 10) {
    out.push(story("ledgewar", 5, [
      "A ledge war: {A} grabbed it {*a} times, {B} {*b}.",
      "Neither wanted to leave the ledge — {*a} grabs for {A}, {*b} for {B}.",
    ], { A: names[0], B: names[1], a: ledge[0], b: ledge[1] }));
  }
  for (const s of [0, 1]) {
    const pr = fun(P[s], "projectiles");
    if (pr && pr.n >= 20) {
      out.push(story(`proj-${s}`, 4, [
        "{X} fired {*k} {noun} this game; {Y} had to come through every one.",
        "{*k} {noun} from {X}. Approaching was never going to be easy.",
      ], { X: names[s], Y: names[1 - s], k: pr.n, noun: pr.many }));
      break;
    }
  }
  const surv = [fun(P[0], "survived"), fun(P[1], "survived")];
  const sv = surv[0] >= surv[1] ? 0 : 1;
  if (surv[sv] >= 160) {
    out.push(story("survive", 5, [
      "{X} lived to {*p}% before {Y} finally found the kill.",
      "{Y} had {X} at {*p}% and still had to work for it.",
    ], { X: names[sv], Y: names[1 - sv], p: surv[sv] }));
  }
  const wd = [fun(P[0], "wavedash"), fun(P[1], "wavedash")];
  for (const s of [0, 1]) {
    if (wd[s] >= 45 && (P[s].lcancel ?? 0) >= 85) {
      out.push(story(`clean-${s}`, 3, [
        "{X} wavedashed {*w} times and L-cancelled {*lc}% — clean hands.",
        "Tidy tech from {X}: {*w} wavedashes, {*lc}% L-cancels.",
      ], { X: names[s], w: wd[s], lc: P[s].lcancel }));
      break;
    }
  }
  if (last.seconds != null && last.seconds < 120) {
    out.push(story("quick", 5, [
      "Over in {*t}: {W} wasted no time.",
      "{*t} on the clock — the quickest kind of game.",
    ], { t: clock(last.seconds), W: names[W] }));
  }
  const dmg = [P[0].damage, P[1].damage];
  if (dmg[0] != null && dmg[1] != null && dmg[W] < dmg[L]) {
    out.push(story("dmg", 5, [
      "{L} dealt more damage, {*dl}% to {*dw}%, and still lost the game.",
      "Damage said {L} ({*dl}% to {*dw}%); the stocks said {W}.",
    ], { W: names[W], L: names[L], dl: dmg[L], dw: dmg[W] }));
  }
  return finish(out, ctx.seed, last.n);
}

// ── The set ───────────────────────────────────────────────────────────────────

function setStories(ctx) {
  const { games, names, score, over } = ctx;
  const n = games.length;
  const out = [];
  const total = (key, s) => sum(games.map((g) => g.per[s][key]));
  const totalFun = (key, s) => sum(games.map((g) => fun(g.per[s], key)));

  if (score[0] === score[1]) {
    out.push(story("result", 20, [
      "The set is tied {*a}–{*b} after {n} counted {games}.",
      "{*a}–{*b}: nothing between them after {n} {games}.",
    ], { a: score[0], b: score[1], n, games: plural(n, "game") }));
  } else {
    const W = score[0] > score[1] ? 0 : 1;
    const L = 1 - W;
    const nw = [total("neutral", 0), total("neutral", 1)];
    const opk = [0, 1].map((s) => avg(games.map((g) => g.per[s].opk)));
    const dpo = [0, 1].map((s) => avg(games.map((g) => g.per[s].dpo)));
    const v = { W: names[W], L: names[L], sc: `${score[W]}–${score[L]}`, nw: `${nw[W]}–${nw[L]}`, nl: `${nw[L]}–${nw[W]}`, ol: fixed(opk[L]), ow: fixed(opk[W]), d: fixed(dpo[W]) };
    // Won, or only ahead: the set reading is up between games too.
    if (nw[W] < nw[L] && opk[W] != null && opk[L] != null) {
      out.push(story("result", 20, over ? [
        "{W} took the set {*sc} without winning neutral: {L} won it {*nl}, but needed {*ol} openings a kill to {W}'s {*ow}.",
        "{W} wins {*sc} on efficiency — {L} took neutral {*nl}, but {*ow} openings a kill beat {*ol}.",
      ] : [
        "{W} leads {*sc} without winning neutral: {L} has it {*nl}, but needs {*ol} openings a kill to {W}'s {*ow}.",
        "{W} is up {*sc} on efficiency — {L} has neutral {*nl}, but {*ow} openings a kill beats {*ol}.",
      ], v));
    } else if (dpo[W] != null) {
      out.push(story("result", 20, over ? [
        "{W} took the set {*sc}, winning neutral {*nw} and averaging {*d} damage an opening.",
        "{W} wins it {*sc}: neutral {*nw}, {*d} damage every time they got in.",
        "Set to {W}, {*sc} — ahead in neutral ({*nw}) and hitting for {*d} an opening.",
      ] : [
        "{W} leads {*sc}, winning neutral {*nw} and averaging {*d} damage an opening.",
        "{W} is up {*sc}: neutral {*nw}, {*d} damage every time they get in.",
        "{W} leads the set {*sc} — ahead in neutral ({*nw}) and hitting for {*d} an opening.",
      ], v));
    } else {
      out.push(story("result", 20, [over ? "{W} took the set {*sc}." : "{W} leads the set {*sc}."], v));
    }
    // Momentum.
    const order = games.map((g) => g.winner);
    let streak = 0;
    for (let i = order.length - 1; i >= 0 && order[i] === W; i--) streak++;
    if (streak >= 2 && streak < n) {
      out.push(story("closer", 6, over ? [
        "{W} won the last {*k} games to close it.",
        "{*k} straight to finish: {W} found another gear.",
      ] : [
        "{W} has won the last {*k} games.",
        "{*k} straight for {W}: the momentum is theirs.",
      ], { W: names[W], k: streak }));
    }
  }

  // The punishes.
  let best = null;
  for (const g of games) for (const s of [0, 1]) {
    const v = g.per[s].punish;
    if (v != null && (!best || v > best.v)) best = { v, s, g: [g.n] };
    else if (best && v === best.v && s === best.s) best.g.push(g.n);
  }
  if (best) {
    const sds = total("sd", best.s);
    out.push(story("punishes", 5, sds >= 2 ? [
      "{X}'s punishes were the set's biggest, {*p}%, but {*sd} self-destructs handed stocks back.",
      "{X} hit hardest ({*p}% in one punish) and gave {*sd} stocks away to self-destructs.",
    ] : [
      "{X}'s punishes were the set's biggest: {*p}%{twice}.",
      "The set's biggest punish: {X}, {*p}%{twice}.",
    ], { X: names[best.s], p: best.v, sd: sds, twice: best.g.length > 1 ? `, ${best.g.length === 2 ? "twice" : `${best.g.length} times`}` : "" }));
  }

  // How close it was.
  const close = games.filter((g) => g.per[g.winner].stocksLeft === 1);
  const timed = games.filter((g) => g.seconds != null);
  if (close.length >= 2) {
    out.push(story("close", 7, [
      "{*k} of {n} games went to the last stock: games {list}.",
      "Last stock, {*k} times out of {n} (games {list}).",
    ], { k: close.length, n, list: gameList(close.map((g) => g.n)) }));
  } else if (timed.length >= 2) {
    const q = timed.reduce((x, y) => (y.seconds < x.seconds ? y : x));
    const left = q.per[q.winner].stocksLeft;
    out.push(story("quickest", 4, [
      "Game {g} was the quickest: {*t}{on}, {X}{spare}.",
      "The quickest game was game {g} — {*t}{on}, won by {X}{spare}.",
    ], { g: q.n, t: clock(q.seconds), on: q.stage && q.stage.name ? ` on ${q.stage.name}` : "", X: names[q.winner], spare: left != null ? ` with ${left} ${plural(left, "stock")} to spare` : "" }));
  }

  // Totals across the set.
  const len = sum(timed.map((g) => g.seconds));
  const stocks = sum(games.map((g) => sum([g.per[0].kills, g.per[1].kills])));
  if (n >= 2 && len) {
    out.push(story("length", 3, [
      "{*t} of Melee across {n} games, {*k} stocks taken.",
      "{n} games, {*t} on the clock, {*k} stocks lost between them.",
    ], { t: clock(len), n, k: stocks }));
  }
  const laps = sum([totalFun("laps", 0), totalFun("laps", 1)]);
  if (n >= 2 && laps >= 150) {
    out.push(story("laps", 3, [
      "Between them they ran {*l} lengths of Final Destination.",
      "Combined distance: {*l} Final D lengths. Nobody stood still.",
    ], { l: Math.round(laps) }));
  }
  const ledge = [totalFun("ledgegrabs", 0), totalFun("ledgegrabs", 1)];
  const lg = ledge[0] >= ledge[1] ? 0 : 1;
  if (ledge[lg] >= 12 * n * 0.75) {
    out.push(story("ledge", 4, [
      "{X} grabbed the ledge {*a} times across the set; {Y} {*b}.",
      "Ledge grabs, set total: {X} {*a}, {Y} {*b}.",
    ], { X: names[lg], Y: names[1 - lg], a: ledge[lg], b: ledge[1 - lg] }));
  }
  const counts = {};
  for (const g of games) if (g.stage && g.stage.name) counts[g.stage.name] = (counts[g.stage.name] || 0) + 1;
  const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  if (top && top[1] >= 2) {
    out.push(story("stage", 2, [
      "{st} hosted {*k} of the {n} games.",
      "{*k} of {n} games on {st}.",
    ], { st: top[0], k: top[1], n }));
  }
  return finish(out, ctx.seed, 0, ":set");
}

/** Best first, each in its picked wording. */
function finish(list, seed, step, salt = "") {
  return list.sort((a, b) => b.score - a.score).map((s) => say(pick(s.tpls, seed, `${s.id}${salt}`, step), s.vars));
}

module.exports = { gameStories, setStories, say };
