/**
 * fun-stats.js — what each player DID in one game, for the stats popup's
 * accolades (accolades.js): ledge grabs, lasers fired, time in the air, the
 * move they landed most, how they lost their stocks… — not how well they
 * played, which is game-stats.js's ledger.
 *
 *   funStats(game, stats, players, stageId) → { ports: { [port]: {...} }, leadChanges, bothLastStock }
 *
 * slippi-js's own counts (actionCounts) plus one walk over the frames for
 * what it doesn't count: time in shield, on the ledge, in the air, offstage;
 * distance run; taunts; times grabbed; projectiles (an item's `owner`, replay
 * 3.6+ — older files just have no projectile count). Runs in the stats worker.
 *
 * Every number is per PORT; a side is the scoreboard's (set-view.js).
 * Numbers that can't be read are null, never 0, so an accolade can't fire on
 * a missing count.
 */

const { CHAR_MAP } = require("../char_map");

/** The ledge's x on each legal stage (± from the middle): past it, a player is offstage. */
const LEDGE_X = { 2: 63.35, 3: 87.75, 8: 56, 28: 77.27, 31: 68.4, 32: 85.57 };
/** Final Destination's width (ledge to ledge), the unit distance is told in. */
const FD_WIDTH = 2 * 85.57;

// Action states (Melee's common ones; characters' own start at 341).
const DEAD_MAX = 10; // 0–10: the dying animations
const REBIRTH = [12, 13]; // the respawn platform
const KNEE_BEND = 24; // jump squat: one per jump
const SQUAT = [39, 41];
const GUARD = [178, 182];
const CAPTURE = [223, 232]; // being held
const CLIFF = [252, 253]; // catching / hanging on the ledge
const APPEAL = [264, 265]; // taunts
/** Fox's and Falco's shine starts (ground, air): their down-B shares state ids. */
const SHINE_START = [360, 365];

const inRange = (v, [a, b]) => v >= a && v <= b;

/**
 * Projectiles, by the item type ids each character's own attacks spawn
 * (Melee's item table — docs/research/melee-stat-accolades.md), told with the
 * character's own noun. One id per projectile, so a needle isn't counted twice.
 */
const PROJECTILES = {
  fox: { ids: [54], one: "laser", many: "lasers" },
  falco: { ids: [55], one: "laser", many: "lasers" },
  sheik: { ids: [79], one: "needle", many: "needles" },
  peach: { ids: [99], one: "turnip", many: "turnips" },
  samus: { ids: [93, 94, 95], one: "projectile", many: "missiles and blasts" },
  mario: { ids: [48], one: "fireball", many: "fireballs" },
  dr_mario: { ids: [49], one: "pill", many: "pills" },
  luigi: { ids: [105], one: "fireball", many: "fireballs" },
  pikachu: { ids: [89, 90], one: "thunder jolt", many: "thunder jolts" },
  pichu: { ids: [91, 92], one: "thunder jolt", many: "thunder jolts" },
  link: { ids: [58, 60, 64], one: "projectile", many: "projectiles" },
  young_link: { ids: [59, 61, 65], one: "projectile", many: "projectiles" },
  mewtwo: { ids: [112], one: "shadow ball", many: "shadow balls" },
  yoshi: { ids: [86], one: "egg", many: "eggs" },
  game_and_watch: { ids: [122], one: "sausage", many: "sausages" },
  ness: { ids: [66], one: "PK Fire", many: "PK Fires" },
  ice_climbers: { ids: [106], one: "ice shot", many: "ice shots" },
};

/** A landed move's name, friendlier than slippi's ("fair" → "Forward air"), with each character's specials named. */
const MOVE = {
  2: "Jab", 3: "Jab", 4: "Jab", 5: "Rapid jabs", 6: "Dash attack", 7: "Forward tilt", 8: "Up tilt", 9: "Down tilt",
  10: "Forward smash", 11: "Up smash", 12: "Down smash", 13: "Neutral air", 14: "Forward air", 15: "Back air",
  16: "Up air", 17: "Down air", 18: "Neutral B", 19: "Side B", 20: "Up B", 21: "Down B", 50: "Getup attack",
  51: "Getup attack", 52: "Pummel", 53: "Forward throw", 54: "Back throw", 55: "Up throw", 56: "Down throw",
  61: "Ledge attack", 62: "Ledge attack",
};
const SPECIALS = {
  fox: { 18: "Laser", 19: "Illusion", 20: "Firefox", 21: "Shine" },
  falco: { 18: "Laser", 19: "Phantasm", 20: "Firebird", 21: "Shine" },
  sheik: { 18: "Needles", 19: "Chain", 20: "Vanish" },
  marth: { 18: "Shield Breaker", 19: "Dancing Blade", 20: "Dolphin Slash", 21: "Counter" },
  roy: { 18: "Flare Blade", 19: "Double-Edge Dance", 20: "Blazer", 21: "Counter" },
  captain_falcon: { 14: "Knee", 18: "Falcon Punch", 19: "Raptor Boost", 20: "Falcon Dive", 21: "Falcon Kick" },
  ganondorf: { 18: "Warlock Punch", 19: "Gerudo Dragon", 20: "Dark Dive", 21: "Wizard's Foot", 17: "Stomp" },
  purin: { 18: "Rollout", 19: "Pound", 20: "Sing", 21: "Rest" },
  peach: { 18: "Toad", 19: "Peach Bomber", 20: "Parasol", 21: "Turnip" },
  samus: { 18: "Charge Shot", 19: "Missile", 20: "Screw Attack", 21: "Bomb" },
  pikachu: { 18: "Thunder Jolt", 19: "Skull Bash", 20: "Quick Attack", 21: "Thunder" },
  pichu: { 18: "Thunder Jolt", 19: "Skull Bash", 20: "Agility", 21: "Thunder" },
  mario: { 18: "Fireball", 19: "Cape", 20: "Super Jump Punch", 21: "Tornado" },
  dr_mario: { 18: "Megavitamin", 19: "Super Sheet", 20: "Super Jump Punch", 21: "Tornado" },
  luigi: { 18: "Fireball", 19: "Green Missile", 20: "Super Jump Punch", 21: "Cyclone" },
  link: { 18: "Arrow", 19: "Boomerang", 20: "Spin Attack", 21: "Bomb" },
  young_link: { 18: "Fire Arrow", 19: "Boomerang", 20: "Spin Attack", 21: "Bomb" },
  ice_climbers: { 18: "Ice Shot", 19: "Squall Hammer", 20: "Belay", 21: "Blizzard", 52: "Wobble" },
  yoshi: { 18: "Egg Lay", 19: "Egg Roll", 20: "Egg Throw", 21: "Yoshi Bomb" },
  donkey: { 18: "Giant Punch", 19: "Headbutt", 20: "Spinning Kong", 21: "Hand Slap" },
  kirby: { 18: "Inhale", 19: "Hammer", 20: "Final Cutter", 21: "Stone" },
  mewtwo: { 18: "Shadow Ball", 19: "Confusion", 20: "Teleport", 21: "Disable" },
  ness: { 18: "PK Flash", 19: "PK Fire", 20: "PK Thunder", 21: "PSI Magnet" },
  game_and_watch: { 18: "Chef", 19: "Judge", 20: "Fire", 21: "Oil Panic" },
  zelda: { 18: "Nayru's Love", 19: "Din's Fire", 20: "Farore's Wind" },
  bowser: { 18: "Fire Breath", 19: "Koopa Klaw", 20: "Whirling Fortress", 21: "Bowser Bomb" },
};
function moveName(moveId, codename) {
  return (SPECIALS[codename] && SPECIALS[codename][moveId]) || MOVE[moveId] || null;
}

const AERIALS = ["nair", "fair", "bair", "uair", "dair"];
const SMASHES = ["fsmash", "usmash", "dsmash"];
const TILTS = ["ftilt", "utilt", "dtilt"];

/** How a stock was lost, from its death animation: off the bottom, a side, the top, a star, the screen. */
function deathKind(anim) {
  if (anim == null) return null;
  if (anim === 0) return "down";
  if (anim === 1 || anim === 2) return "side";
  if (anim === 3) return "up";
  if (anim >= 4 && anim <= 6) return "star";
  if (anim >= 7 && anim <= 10) return "screen";
  return null;
}

const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const sumOf = (o, keys) => (o ? keys.reduce((a, k) => a + (o[k] ?? 0), 0) : null);
/** The most frequent of a list of names, and how often: { name, n, kinds }. */
function mostOf(list) {
  if (!list.length) return null;
  const n = {};
  for (const x of list) n[x] = (n[x] || 0) + 1;
  const [name, count] = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return { name, n: count, kinds: Object.keys(n).length, of: list.length };
}

function funStats(game, stats, players, stageId) {
  const ports = players.map((p) => p.playerIndex);
  const code = Object.fromEntries(players.map((p) => [p.playerIndex, CHAR_MAP[p.characterId]?.codename ?? null]));
  const ledgeX = LEDGE_X[stageId] ?? null;

  // ── One walk over the frames ──
  const walk = Object.fromEntries(ports.map((p) => [p, {
    frames: 0, air: 0, off: 0, shield: 0, cliff: 0, crouch: 0, jumps: 0, taunts: 0, grabbed: 0, dist: 0, maxPct: 0, shines: 0, items: new Map(),
  }]));
  const prev = {};
  const frames = game.getFrames() || {};
  const ownedItems = new Set();
  let ownerSeen = false;
  for (const f of Object.keys(frames).map(Number).sort((a, b) => a - b)) {
    if (f < 0) continue;
    const fr = frames[f];
    for (const port of ports) {
      const post = fr?.players?.[port]?.post;
      if (!post) continue;
      const W = walk[port];
      const a = post.actionStateId;
      const was = prev[port];
      const entered = (range) => inRange(a, range) && !(was && inRange(was.actionStateId, range));
      const alive = a > DEAD_MAX && !inRange(a, REBIRTH);
      if (alive) {
        W.frames++;
        if (post.isAirborne) W.air++;
        if (ledgeX != null && (Math.abs(post.positionX) > ledgeX + 2 || post.positionY < -6)) W.off++;
        if (inRange(a, GUARD)) W.shield++;
        if (inRange(a, CLIFF)) W.cliff++;
        if (inRange(a, SQUAT)) W.crouch++;
        if (Number.isFinite(post.percent) && post.percent > W.maxPct) W.maxPct = post.percent;
        if (was && was.alive) {
          const d = Math.hypot(post.positionX - was.x, post.positionY - was.y);
          if (d < 20) W.dist += d; // a bigger jump is a respawn or a teleport, not a run
        }
      }
      if (a === KNEE_BEND && !(was && was.actionStateId === KNEE_BEND)) W.jumps++;
      if (entered(APPEAL)) W.taunts++;
      if (entered(CAPTURE)) W.grabbed++;
      if (SHINE_START.includes(a) && !(was && was.actionStateId === a)) W.shines++;
      prev[port] = { actionStateId: a, x: post.positionX, y: post.positionY, alive };
    }
    for (const it of fr?.items || []) {
      if (it.owner != null) ownerSeen = true;
      if (it.spawnId == null || it.owner == null || !walk[it.owner] || ownedItems.has(it.spawnId)) continue;
      ownedItems.add(it.spawnId);
      const m = walk[it.owner].items;
      m.set(it.typeId, (m.get(it.typeId) || 0) + 1);
    }
  }

  // ── The stock timeline: lead changes, both on their last stock ──
  const lost = stats.stocks.filter((s) => s.endFrame != null).sort((a, b) => a.endFrame - b.endFrame);
  const left = Object.fromEntries(players.map((p) => [p.playerIndex, p.startStocks || 4]));
  let leader = null;
  let leadChanges = 0;
  let bothLastStock = false;
  for (const s of lost) {
    left[s.playerIndex]--;
    const [a, b] = ports.map((p) => left[p]);
    if (a === 1 && b === 1) bothLastStock = true;
    const now = a > b ? ports[0] : b > a ? ports[1] : null;
    if (now != null && leader != null && now !== leader) leadChanges++;
    if (now != null) leader = now;
  }

  const lastFrame = stats.lastFrame ?? null;
  const out = {};
  for (const p of players) {
    const me = p.playerIndex;
    const opp = ports.find((x) => x !== me);
    const cn = code[me];
    const W = walk[me];
    const ac = stats.actionCounts.find((x) => x.playerIndex === me) ?? null;
    const ov = stats.overall.find((x) => x.playerIndex === me) ?? null;
    const mine = stats.conversions.filter((c) => c.lastHitBy === me && c.playerIndex === opp);
    const hits = mine.flatMap((c) => c.moves || []);
    const named = hits.map((m) => moveName(m.moveId, cn)).filter(Boolean);
    const kills = mine.filter((c) => c.didKill && c.moves?.length).map((c) => moveName(c.moves[c.moves.length - 1].moveId, cn)).filter(Boolean);
    const count = (list, ids) => list.filter((m) => ids.includes(m.moveId)).length;
    const perConv = (ids) => Math.max(0, ...mine.map((c) => count(c.moves || [], ids)));
    const myStocks = stats.stocks.filter((s) => s.playerIndex === me);
    const lives = myStocks.map((s) => ((s.endFrame ?? lastFrame) - s.startFrame) / 60).filter((v) => Number.isFinite(v) && v > 0);
    const lostLives = myStocks.filter((s) => s.endFrame != null).map((s) => (s.endFrame - s.startFrame) / 60).filter((v) => Number.isFinite(v) && v > 0);
    const deaths = { down: 0, side: 0, up: 0, star: 0, screen: 0 };
    for (const s of myStocks) { const k = deathKind(s.deathAnimation); if (k) deaths[k]++; }
    const proj = PROJECTILES[cn];
    const atk = ac?.attackCount ?? null;
    const alive = W.frames || null;
    out[me] = {
      char: cn,
      favMove: (() => { const m = mostOf(named); return m && m.n >= 3 ? { name: m.name, n: m.n } : null; })(),
      killMove: (() => { const m = mostOf(kills); return m ? { name: m.name, n: m.n, kinds: m.kinds, of: m.of } : null; })(),
      hits: hits.length,
      projectiles: proj && ownerSeen ? { n: proj.ids.reduce((a, id) => a + (W.items.get(id) || 0), 0), one: proj.one, many: proj.many } : null,
      shines: cn === "fox" || cn === "falco" ? W.shines : null,
      shinesLanded: cn === "fox" || cn === "falco" ? count(hits, [21]) : null,
      lasersLanded: cn === "fox" || cn === "falco" ? count(hits, [18]) : null,
      restsLanded: cn === "purin" ? count(hits, [21]) : null,
      kneesLanded: cn === "captain_falcon" ? count(hits, [14]) : null,
      stompsLanded: cn === "ganondorf" ? count(hits, [17]) : null,
      upairs: count(hits, [16]),
      wobble: perConv([52]),
      chaingrab: perConv([53, 54, 55, 56]),
      wavedash: ac?.wavedashCount ?? null,
      waveland: ac?.wavelandCount ?? null,
      airdodge: ac?.airDodgeCount ?? null,
      dashdance: ac?.dashDanceCount ?? null,
      spotdodge: ac?.spotDodgeCount ?? null,
      ledgegrabs: ac?.ledgegrabCount ?? null,
      rolls: ac?.rollCount ?? null,
      grabs: ac?.grabCount?.success ?? null,
      grabWhiffs: ac?.grabCount?.fail ?? null,
      throws: ac ? sumOf(ac.throwCount, ["up", "forward", "back", "down"]) : null,
      techs: ac ? sumOf(ac.groundTechCount, ["away", "in", "neutral"]) : null,
      techInPlace: ac?.groundTechCount?.neutral ?? null,
      techMiss: ac?.groundTechCount?.fail ?? null,
      wallTechs: ac?.wallTechCount?.success ?? null,
      lcMiss: ac?.lCancelCount?.fail ?? null,
      smashes: sumOf(atk, SMASHES),
      aerials: sumOf(atk, AERIALS),
      tilts: sumOf(atk, TILTS),
      jabs: atk ? atk.jab1 ?? 0 : null,
      dashAttacks: atk ? atk.dash ?? 0 : null,
      cstick: ov?.inputCounts?.cstick ?? null,
      trades: ov?.beneficialTradeRatio?.count ?? null,
      jumps: W.jumps,
      taunts: W.taunts,
      grabbed: W.grabbed,
      airPct: alive ? Math.round((100 * W.air) / alive) : null,
      offPct: alive && ledgeX != null ? Math.round((100 * W.off) / alive) : null,
      shieldSec: round1(W.shield / 60),
      ledgeSec: round1(W.cliff / 60),
      crouchSec: round1(W.crouch / 60),
      laps: round1(W.dist / FD_WIDTH),
      survived: Math.round(W.maxPct),
      quickestLoss: lostLives.length ? Math.round(Math.min(...lostLives)) : null,
      longestStock: lives.length ? Math.round(Math.max(...lives)) : null,
      deaths,
      z2d: mine.filter((c) => c.didKill && c.startPercent === 0).length,
      combos5: stats.combos.filter((c) => c.lastHitBy === me && c.playerIndex === opp && (c.moves?.length ?? 0) >= 5).length,
    };
  }
  return { ports: out, leadChanges, bothLastStock };
}

module.exports = { funStats };
