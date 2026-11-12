/**
 * accolades.js — the stats popup's pool of personal accolades. Pure.
 *
 *   accolades(ctx, "game" | "set") → callouts, in set-view.js's insight shape
 *
 * An accolade is something a player DID (fun-stats.js): grabbed the ledge 22
 * times, fired 60 lasers, lived to 190%, missed seven techs. Each entry is a
 * number per side, a floor it must reach, and several wordings for every slot
 * a layout has:
 *
 *   tag    the title ("Hungry Box Fan")                  ≤ 20 characters
 *   short  one line under a big number                  ≤ 34
 *   note   a handwritten margin note beside a row         ≤ 14 (ledger stats only)
 *   long   a sentence for the rotating strips/bands      ≤ 130 (segments)
 *
 * The wording is picked by a seed (the set, the game, the reading), so the
 * same accolade reads differently from game to game and set to set. Repeats
 * are scored down: one that also fired for the same player earlier in this
 * set, and (ctx.recent) one shown in the last few sets.
 *
 * Templates: {who} {opp} the two names, {n} the number, {o} the other side's,
 * {move} {noun} the move or projectile, {span} "this game" / "this set",
 * {inSpan} "in game 3" / "across 4 games", {g} the game. In a long one, {n},
 * {o} and {move} are lit (segments { em }); {s} is "s" unless {n} is 1.
 */

const { CHAR_MAP } = require("../char_map");

// ── Seeded picks ──────────────────────────────────────────────────────────────

/** FNV-1a: a string to a 32-bit number, the same everywhere. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/**
 * One of a list of wordings: where it starts is the seed's, and each step (a
 * game number) moves one along, so consecutive games never pick the same one.
 */
const pick = (list, seed, salt, step = 0) => (Array.isArray(list) ? list[(hash(`${seed}|${salt}`) + step) % list.length] : list);
/** The whole list from the one pick() gives, round: the picked wording, then its alternatives in order. */
function rotate(list, seed, salt, step = 0) {
  const l = [].concat(list);
  const i = (hash(`${seed}|${salt}`) + step) % l.length;
  return l.slice(i).concat(l.slice(0, i));
}

const display = (codename) => Object.values(CHAR_MAP).find((c) => c.codename === codename)?.display ?? null;

// ── The pool ──────────────────────────────────────────────────────────────────
// stat(p, o, side, ctx): this side's number from its game numbers (p, the
// other side's o; the `fun` block is p.fun). min: the floor for one game. For
// the set: agg "sum" (floor min × games × 0.75), "max" (a single game's
// best), "avg". most: must beat the other side (by `by`× if set). lo: smaller
// is the notable end. only: the characters it's for. w: weight; hot: the
// number where it's as remarkable as it gets. side: "opp" credits the other
// side (a star KO is the killer's accolade, read off the victim's deaths).

const f = (key) => (p) => (p.fun ? p.fun[key] : null);

const POOL = [
  // ── The ledge ──
  { id: "ledge", family: "ledge", stat: f("ledgegrabs"), min: 14, hot: 24, most: true, w: 5, agg: "sum",
    tag: ["Hungry Box Fan", "Cliff Hanger", "Ledge Lord", "Planking Pro", "Living on the Edge", "Cliff Collector"],
    short: ["{n} ledge grabs {span}", "Grabbed the ledge {n} times", "{n} trips to the ledge"],
    note: ["ledge ×{n}", "plank ×{n}"],
    long: ["{who} grabbed the ledge {n} times {span}; {opp} managed {o}. The ledge has a favourite.",
      "Ledge grabs: {who} {n}, {opp} {o}. Somebody studied the classics.",
      "{who} spent {span} on a first-name basis with the ledge: {n} grabs."] },
  { id: "hang", family: "ledge", stat: f("ledgeSec"), min: 5, hot: 10, most: true, w: 4, agg: "sum", unit: "s",
    tag: ["Cliffhanger", "Just Hanging Out", "Hang Time"],
    short: ["{n}s hanging off the ledge", "On the ledge for {n} seconds"],
    long: ["{who} hung off the ledge for {n} seconds {span}. Great view from down there.",
      "{n} seconds of {who} hanging from the ledge {inSpan}, waiting for the right moment."] },

  // ── Movement ──
  { id: "wavedash", family: "move", stat: f("wavedash"), min: 50, hot: 85, most: true, w: 4, agg: "sum",
    tag: ["Surf's Up", "Wavedash Enthusiast", "Ice Skater", "Slip 'n Slide"],
    short: ["{n} wavedashes {span}", "Wavedashed {n} times"],
    long: ["{who} wavedashed {n} times {span}. The floor is a suggestion.",
      "{n} wavedashes from {who} {inSpan} — {opp} kept it to {o}.",
      "Physics engine stress test: {who}, {n} wavedashes."] },
  { id: "waveland", family: "move", stat: f("waveland"), min: 20, hot: 38, most: true, w: 4, agg: "sum",
    tag: ["Platform Surfer", "Smooth Landing", "Sticks the Landing"],
    short: ["{n} wavelands {span}", "Wavelanded {n} times"],
    long: ["{who} wavelanded {n} times {span}, treating every platform like a skate park.",
      "{n} wavelands from {who}. The platforms never stood a chance."] },
  { id: "dashdance", family: "move", stat: f("dashdance"), min: 50, hot: 110, most: true, w: 4, agg: "sum",
    tag: ["Twinkle Toes", "Dance Floor Regular", "Shuffle Mode", "Fancy Footwork"],
    short: ["{n} dash dances {span}", "Dash danced {n} times"],
    long: ["{who} dash danced {n} times {span}. Somebody put a song on.",
      "{n} dash dances from {who} {inSpan}; {opp} answered with {o}.",
      "{who}'s feet never stopped: {n} dash dances."] },
  { id: "jumps", family: "air", stat: f("jumps"), min: 130, hot: 180, most: true, w: 3, agg: "sum",
    tag: ["Pogo Stick", "Bunny Hop", "Spring Loaded"],
    short: ["{n} jumps {span}", "Left the ground {n} times"],
    long: ["{who} jumped {n} times {span}. The ground is lava, apparently.",
      "{n} jumps from {who} {inSpan}, to {opp}'s {o}."] },
  { id: "airtime", family: "air", stat: f("airPct"), min: 60, hot: 70, most: true, w: 3, agg: "avg", unit: "%",
    tag: ["Frequent Flyer", "Cloud Nine", "Head in the Clouds"],
    short: ["Airborne {n}% of the time", "{n}% of {span} in the air"],
    long: ["{who} spent {n}% of {span} off the ground. Frequent flyer miles: earned.",
      "Air time: {who} {n}%, {opp} {o}%. One of them forgot the floor exists."] },
  { id: "grounded", family: "air", stat: f("airPct"), min: 38, hot: 30, lo: true, most: true, w: 3, agg: "avg", unit: "%",
    tag: ["Grounded", "Feet on the Floor", "Ground Game"],
    short: ["Only {n}% of the time airborne", "Kept it grounded: {n}% in the air"],
    long: ["{who} spent just {n}% of {span} in the air. Both feet, firmly planted.",
      "{who} kept it on the ground — {n}% airborne to {opp}'s {o}%."] },
  { id: "offstage", family: "off", stat: f("offPct"), min: 24, hot: 34, most: true, w: 4, agg: "avg", unit: "%",
    tag: ["Deep Diver", "Offstage Explorer", "Scuba Certified"],
    short: ["{n}% of {span} offstage", "Offstage for {n}% of it"],
    long: ["{who} spent {n}% of {span} offstage. Out there is where the fun is.",
      "Offstage time: {who} {n}%, {opp} {o}%. Brave, or lost? Both."] },
  { id: "laps", family: "run", stat: f("laps"), min: 95, hot: 125, most: true, w: 3, agg: "sum", fmt: 0,
    tag: ["Marathon Runner", "Cardio Day", "Step Count"],
    short: ["Ran {n} lengths of Final D", "{n} laps of Final Destination"],
    long: ["{who} covered {n} lengths of Final Destination {span}. Somebody check the step counter.",
      "Distance run {inSpan}: {who} {n} Final D lengths, {opp} {o}."] },

  // ── Defence ──
  { id: "shield", family: "def", stat: f("shieldSec"), min: 12, hot: 22, most: true, w: 4, agg: "sum", unit: "s",
    tag: ["Bubble Wrap", "Shield Wall", "Force Field"],
    short: ["{n}s in shield {span}", "Held shield for {n} seconds"],
    long: ["{who} sat in shield for {n} seconds {span}. Safety first.",
      "{n} seconds of shield from {who} {inSpan}. The bubble held up."] },
  { id: "spotdodge", family: "def", stat: f("spotdodge"), min: 7, hot: 13, most: true, w: 3, agg: "sum",
    tag: ["Now You See Me", "Matrix Mode", "Dodgeball Pro"],
    short: ["{n} spot dodges {span}", "Spot dodged {n} times"],
    long: ["{who} spot dodged {n} times {span}. Can't hit what isn't there.",
      "{n} spot dodges from {who} {inSpan}. Blink and they were gone."] },
  { id: "rolls", family: "def", stat: f("rolls"), min: 8, hot: 16, most: true, w: 3, agg: "sum",
    tag: ["Barrel Roll", "Roll Model", "Tumble Dry"],
    short: ["{n} rolls {span}", "Rolled {n} times"],
    long: ["{who} rolled {n} times {span}. Do a barrel roll, indeed.",
      "{n} rolls from {who} {inSpan}; {opp} rolled {o}."] },
  { id: "airdodge", family: "def", stat: f("airdodge"), min: 7, hot: 11, most: true, w: 2, agg: "sum",
    tag: ["Panic Button", "Escape Artist"],
    short: ["{n} air dodges {span}", "Air dodged {n} times"],
    long: ["{who} hit the air dodge {n} times {span}. When in doubt, dodge out."] },
  { id: "crouch", family: "def", stat: f("crouchSec"), min: 5, hot: 11, most: true, w: 3, agg: "sum", unit: "s",
    tag: ["Crouch Potato", "Low Profile", "Squat Goals"],
    short: ["{n}s crouching {span}", "Crouched for {n} seconds"],
    long: ["{who} crouched for {n} seconds {span}. Crouch cancel, or just comfy?",
      "{n} seconds low to the ground from {who}. Crouch cancelling all the way."] },
  { id: "techs", family: "tech", stat: f("techs"), min: 6, hot: 11, most: true, w: 3, agg: "sum",
    tag: ["Hit the Deck", "Floor Expert", "Tech Wizard"],
    short: ["{n} techs {span}", "Teched {n} times"],
    long: ["{who} teched {n} times {span}. The floor kept trying, the floor kept losing.",
      "{n} clean techs from {who} {inSpan}."] },
  { id: "techmiss", family: "tech", stat: f("techMiss"), min: 7, hot: 12, most: true, w: 3, agg: "sum",
    tag: ["Floor Inspector", "Nap Time", "Missed the Tech"],
    short: ["{n} missed techs {span}", "Lay on the floor {n} times"],
    long: ["{who} missed {n} techs {span}. The floor was very comfortable today.",
      "{n} missed techs from {who} {inSpan}. A thorough inspection of the stage floor."] },
  { id: "walltech", family: "tech", stat: f("wallTechs"), min: 1, hot: 3, w: 4, agg: "sum",
    tag: ["Off the Wall", "Wall Tech!", "Bounce Back"],
    short: ["{n} wall tech{s} {span}", "Teched off the wall"],
    long: ["{who} wall teched {span}: {n} of them. Respect the wall tech.",
      "A wall tech from {who} {inSpan}. Those don't happen by accident."] },
  { id: "grabbed", family: "grab", stat: f("grabbed"), min: 7, hot: 12, most: true, w: 3, agg: "sum",
    tag: ["Grab Magnet", "Very Huggable", "Hugs Welcome"],
    short: ["Got grabbed {n} times", "Grabbed by {opp} {n} times"],
    long: ["{who} got grabbed {n} times {span}. Some people are just huggable.",
      "{opp} grabbed {who} {n} times {inSpan}. Personal space: optional."] },

  // ── Offence ──
  { id: "grabs", family: "grab", stat: f("grabs"), min: 7, hot: 12, most: true, w: 3, agg: "sum",
    tag: ["Hands Like Velcro", "Grab Master", "Hug Machine"],
    short: ["{n} grabs landed {span}", "Grabbed {opp} {n} times"],
    long: ["{who} landed {n} grabs {span}. Nobody was safe within arm's reach.",
      "{n} grabs from {who} {inSpan}, to {opp}'s {o}."] },
  { id: "grabwhiff", family: "grab", stat: f("grabWhiffs"), min: 6, hot: 10, most: true, w: 2, agg: "sum",
    tag: ["Butterfingers", "Grabbing at Air", "Swing and a Miss"],
    short: ["{n} whiffed grabs {span}", "Grabbed at air {n} times"],
    long: ["{who} whiffed {n} grabs {span}. The air was not impressed.",
      "{n} grabs from {who} closed on nothing {inSpan}."] },
  { id: "chaingrab", family: "grab", stat: f("chaingrab"), min: 3, hot: 6, most: true, w: 5, agg: "max",
    tag: ["Chaingrab Champ", "Conveyor Belt", "Grab and Go"],
    short: ["{n} throws in one punish", "A {n}-throw chain"],
    long: ["{who} threw {opp} {n} times in a single punish. Conveyor belt, open for business.",
      "One opening, {n} throws: {who} found the chaingrab {inSpan}."] },
  { id: "wobble", family: "grab", stat: f("wobble"), min: 6, hot: 15, w: 6, agg: "max",
    tag: ["Wobble Wobble", "Pummel Party"],
    short: ["{n} pummels in one grab", "Pummelled {n} times in one go"],
    long: ["{who} pummelled {n} times in one grab {span}. Wobble, wobble.",
      "{n} pummels, one grab. {who} made {opp} feel every one of them."] },
  { id: "smashes", family: "atk", stat: f("smashes"), min: 14, hot: 24, most: true, w: 3, agg: "sum",
    tag: ["Smash Happy", "Swing for the Fences", "Charged Up"],
    short: ["{n} smash attacks {span}", "Threw out {n} smashes"],
    long: ["{who} threw out {n} smash attacks {span}. It is in the name of the game.",
      "{n} smash attacks from {who} {inSpan}. Subtle? No. Fun? Yes."] },
  { id: "aerials", family: "atk", stat: f("aerials"), min: 75, hot: 105, most: true, w: 3, agg: "sum",
    tag: ["Air Traffic Control", "Aerial Ace", "Sky's the Limit"],
    short: ["{n} aerials {span}", "Threw out {n} aerials"],
    long: ["{who} threw {n} aerials {span}. Air traffic control has questions.",
      "{n} aerials from {who} {inSpan}, to {opp}'s {o}."] },
  { id: "jabs", family: "atk", stat: f("jabs"), min: 12, hot: 25, most: true, w: 3, agg: "sum",
    tag: ["Jab Happy", "Poke Machine", "Jab Jab Jab"],
    short: ["{n} jabs {span}", "Jabbed {n} times"],
    long: ["{who} jabbed {n} times {span}. Death by a thousand pokes.",
      "{n} jabs from {who} {inSpan}. Never underestimate the jab."] },
  { id: "tilts", family: "atk", stat: f("tilts"), min: 30, hot: 50, most: true, w: 2, agg: "sum",
    tag: ["Fully Tilted", "Tilt Master", "On Tilt"],
    short: ["{n} tilts {span}", "Threw out {n} tilts"],
    long: ["{who} used {n} tilt attacks {span}. Fully tilted, in the good way."] },
  { id: "dashattack", family: "atk", stat: f("dashAttacks"), min: 6, hot: 12, most: true, w: 2, agg: "sum",
    tag: ["Running Start", "Charge!", "Full Sprint"],
    short: ["{n} dash attacks {span}", "Dash attacked {n} times"],
    long: ["{who} dash attacked {n} times {span}. Running start, every time."] },
  { id: "hits", family: "atk", stat: f("hits"), min: 65, hot: 95, most: true, w: 3, agg: "sum",
    tag: ["Hit Parade", "Volume Dealer", "Busy Hands"],
    short: ["{n} hits landed {span}", "Landed {n} hits"],
    long: ["{who} landed {n} hits {span}; {opp} landed {o}. Volume wins.",
      "{n} hits from {who} {inSpan}. Busy, busy, busy."] },
  { id: "upairs", family: "atk", stat: f("upairs"), min: 10, hot: 20, most: true, w: 3, agg: "sum",
    tag: ["Juggling Act", "Up and Away", "Head Space"],
    short: ["{n} up airs landed {span}", "Up air ×{n}"],
    long: ["{who} landed {n} up airs {span}. {opp} spent a lot of time looking down.",
      "{n} up airs from {who} {inSpan}: a juggling act."] },
  { id: "combos5", family: "combo", stat: f("combos5"), min: 3, hot: 6, most: true, w: 4, agg: "sum",
    tag: ["Combo Chef", "Combo Kitchen", "Five-Hit Club"],
    short: ["{n} combos of five hits or more", "{n} combos of 5+ hits"],
    long: ["{who} strung {n} combos of five hits or more {span}. The kitchen was open.",
      "{n} five-hit combos from {who} {inSpan}. Cooking."] },
  { id: "z2d", family: "combo", stat: f("z2d"), min: 1, hot: 2, w: 8, agg: "sum",
    tag: ["Zero to Death", "From Zero", "No Escape"],
    short: ["{n} zero-to-death{s} {span}", "Took a stock from 0%"],
    long: ["{who} took a stock from zero {span}. One opening, no way out.",
      "{n} zero-to-death{s} from {who} {inSpan}. {opp} never touched the ground."] },
  { id: "trades", family: "atk", stat: f("trades"), min: 3, hot: 6, most: true, w: 2, agg: "sum",
    tag: ["Fair Trade", "Trade Deal"],
    short: ["Won {n} trades {span}", "{n} trades that went their way"],
    long: ["{who} came out ahead in {n} trades {span}. Good business."] },

  // ── Inputs ──
  { id: "cstick", family: "input", stat: f("cstick"), min: 130, hot: 220, most: true, w: 2, agg: "sum",
    tag: ["C-Stick Connoisseur", "Stick Shift", "C You Later"],
    short: ["{n} C-stick flicks {span}", "Flicked the C-stick {n} times"],
    long: ["{who} flicked the C-stick {n} times {span}. That stick has seen things."] },
  { id: "fasthands", family: "input", stat: (p) => p.ipm ?? null, min: 560, hot: 680, most: true, w: 3, agg: "avg",
    tag: ["Fast Hands", "Controller Cardio", "Button Symphony"],
    short: ["{n} inputs a minute", "{n} APM {span}"],
    long: ["{who} averaged {n} inputs a minute {span}. The controller needs a nap.",
      "{n} inputs a minute from {who} — {opp} at {o}. Fingers of fury."] },
  { id: "zen", family: "input", stat: (p) => p.ipm ?? null, min: 260, hot: 180, lo: true, most: true, w: 2, agg: "avg",
    tag: ["Zen Mode", "Economy of Motion", "Chill Inputs"],
    short: ["Just {n} inputs a minute", "{n} APM: every input counted"],
    long: ["{who} needed just {n} inputs a minute {span}. Nothing wasted.",
      "Economy of motion: {who} at {n} inputs a minute, {opp} at {o}."] },
  { id: "lcmiss", family: "tech", stat: f("lcMiss"), min: 10, hot: 18, most: true, w: 2, agg: "sum",
    tag: ["Took the L", "Lag Enthusiast", "Missed the L"],
    short: ["{n} missed L-cancels {span}", "Skipped {n} L-cancels"],
    long: ["{who} missed {n} L-cancels {span}. Full landing lag, savoured every frame.",
      "{n} L-cancels slipped by {who} {inSpan}. The lag was real."] },
  { id: "taunt", family: "taunt", stat: f("taunts"), min: 1, hot: 3, w: 7, agg: "sum",
    tag: ["Showboat", "Poser", "Style Points", "Show Me Your Moves"],
    short: ["Taunted {n}× {span}", "Found time to taunt"],
    long: ["{who} found time to taunt {span}: {n} taunt{s}. Respect.",
      "In the middle of all that, {who} taunted. Style points awarded."] },

  // ── Surviving and dying ──
  { id: "survived", family: "life", stat: f("survived"), min: 165, hot: 210, most: true, w: 5, agg: "max", unit: "%",
    tag: ["Unkillable", "Refused to Die", "Built Different", "Iron Will"],
    short: ["Lived to {n}%", "Survived to {n}%"],
    long: ["{who} lived to {n}% {span}. {opp} hit them with everything.",
      "{n}% and still standing: {who} refused to leave {inSpan}.",
      "{who} took a stock to {n}% before finally going. Heavy, apparently."] },
  { id: "speedrun", family: "life", stat: f("quickestLoss"), min: 15, hot: 6, lo: true, w: 4, agg: "max", aggLo: true, unit: "s",
    tag: ["Speedrun", "Blink and Miss It", "Express Checkout"],
    short: ["Lost a stock in {n} seconds", "A {n}-second stock"],
    long: ["One of {who}'s stocks lasted {n} seconds {span}. Speedrun strats.",
      "{who} lost a stock in just {n} seconds {inSpan}. Blink and you missed it."] },
  { id: "endurance", family: "life", stat: f("longestStock"), min: 110, hot: 170, most: true, w: 3, agg: "max", unit: "s",
    tag: ["Long Haul", "Endurance Test", "Stock Market Stable"],
    short: ["One stock lasted {n}s", "A {n}-second stock"],
    long: ["{who} made one stock last {n} seconds {span}. Long haul.",
      "{who}'s longest stock {inSpan}: {n} seconds and counting."] },
  { id: "starko", family: "ko", stat: (p, o) => (o.fun && o.fun.deaths ? o.fun.deaths.star : null), min: 1, hot: 3, w: 4, agg: "sum",
    tag: ["Twinkle Twinkle", "Sent to the Stars", "Star Finish"],
    short: ["{n} star KO{s} {span}", "Sent {opp} into the stars"],
    long: ["{who} sent {opp} into the stars {span}: {n} star KO{s}. Twinkle twinkle.",
      "{n} star KO{s} from {who} {inSpan}. {opp} is somewhere in orbit."] },
  { id: "screenko", family: "ko", stat: (p, o) => (o.fun && o.fun.deaths ? o.fun.deaths.screen : null), min: 1, hot: 2, w: 6, agg: "sum",
    tag: ["Window Washer", "Smashed the Camera", "Fourth Wall"],
    short: ["{n} screen KO{s} {span}", "Into the camera ×{n}"],
    long: ["{who} knocked {opp} into the camera {span}. Someone get a cloth.",
      "{n} screen KO{s} from {who} {inSpan}. The fourth wall took damage."] },
  { id: "gravity", family: "ko", stat: (p, o) => (o.fun && o.fun.deaths ? o.fun.deaths.down : null), min: 2, hot: 4, w: 3, agg: "sum",
    tag: ["Gravity Assist", "Sent Downtown", "Off the Bottom"],
    short: ["{n} stocks off the bottom", "Took {n} stocks downward"],
    long: ["{who} took {n} of {opp}'s stocks off the bottom {span}. Gravity is a teammate.",
      "{n} kills off the bottom from {who} {inSpan}. Down is a direction too."] },
  { id: "sponge", family: "life", stat: (p, o) => o.damage ?? null, min: 450, hot: 560, most: true, w: 2, agg: "sum", unit: "%",
    tag: ["Damage Sponge", "Took a Beating", "Absorbent"],
    short: ["Took {n}% {span}", "Soaked up {n}% damage"],
    long: ["{who} soaked up {n}% {span}. Absorbent and resilient.",
      "{opp} dealt {who} {n}% {inSpan}. Still here."] },

  // ── Moves ──
  { id: "favmove", family: "favmove", stat: (p) => (p.fun && p.fun.favMove ? p.fun.favMove.n : null), min: 5, hot: 16, w: 2, agg: "none",
    vars: (p) => ({ move: p.fun.favMove.name }),
    tag: ["Signature Move", "Old Reliable", "Bread and Butter", "Comfort Food", "Go-To Move"],
    short: ["{move} ×{n}", "{n} hits with {move}"],
    long: ["{who}'s go-to {span} was {move}: landed {n} times.",
      "{move}, again and again — {n} hits for {who} {inSpan}.",
      "If {who} has a favourite move, it's {move}. {n} hits {span}."] },
  { id: "onetrick", family: "killmove", stat: (p) => (p.fun && p.fun.killMove && p.fun.killMove.kinds === 1 && p.fun.killMove.n >= 3 ? p.fun.killMove.n : null), min: 3, hot: 4, w: 5, agg: "none",
    vars: (p) => ({ move: p.fun.killMove.name }),
    tag: ["If It Ain't Broke", "One-Trick", "Signature Finish"],
    short: ["Every kill with {move}", "{n} kills, all {move}"],
    long: ["Every one of {who}'s {n} kills {span} came from {move}. If it ain't broke.",
      "{who} took {n} stocks {inSpan}, every one with {move}."] },
  { id: "variety", family: "killmove", stat: (p) => (p.fun && p.fun.killMove ? p.fun.killMove.kinds : null), min: 4, hot: 5, w: 4, agg: "none",
    tag: ["Swiss Army Knife", "Variety Pack", "Mixed Bag"],
    short: ["Killed with {n} different moves", "{n} kill moves {span}"],
    long: ["{who} took stocks with {n} different moves {span}. Something for everyone.",
      "{n} different finishers from {who} {inSpan}. Unpredictable."] },
  { id: "firstblood", family: "first", stat: (p) => (p.firstBlood ? 1 : null), min: 1, hot: 1, w: 1, agg: "none", big: () => "1st",
    tag: ["First Blood", "Opening Act", "Struck First"],
    short: ["Took the first stock", "First stock of the game"],
    long: ["{who} drew first blood {span}.", "The first stock {inSpan} went to {who}."] },

  // ── Characters' own ──
  { id: "projectiles", family: "proj", stat: (p) => (p.fun && p.fun.projectiles ? p.fun.projectiles.n : null), min: 12, hot: 45, most: true, w: 4, agg: "sum",
    vars: (p) => ({ noun: p.fun.projectiles.many }),
    tagBy: {
      fox: ["Laser Light Show", "Pew Pew", "Blaster Master"], falco: ["Laser Light Show", "Pew Pew", "Blaster Master"],
      sheik: ["Pin Cushion", "Needle Point", "Sewing Circle"], peach: ["Farmer's Market", "Green Thumb", "Harvest Season"],
      samus: ["Missile Command", "Heavy Artillery"], mario: ["Fireball Frenzy", "Hot Hands"], dr_mario: ["Doctor's Orders", "House Call"],
      luigi: ["Green Flame", "Fireball Frenzy"], pikachu: ["Thunderstruck", "Shocking"], pichu: ["Thunderstruck", "Shocking"],
      link: ["Full Quiver", "Bomb Squad", "Arsenal"], young_link: ["Full Quiver", "Bomb Squad", "Arsenal"],
      mewtwo: ["Shadow Ball Pitcher"], yoshi: ["Egg Toss Champ", "Breakfast Is Served"], game_and_watch: ["Short-Order Cook", "Chef's Special"], ness: ["PK Fire Starter"], ice_climbers: ["Cold Shoulder", "Ice to Meet You"],
    },
    tag: ["Zoning Specialist", "Keep Away"],
    short: ["{n} {noun} {span}", "Fired {n} {noun}"],
    long: ["{who} sent {n} {noun} across the stage {span}. Approach at your own risk.",
      "{n} {noun} from {who} {inSpan}. {opp} spent a lot of time dodging.",
      "Zoning report: {who}, {n} {noun}."] },
  { id: "shines", family: "shine", only: ["fox", "falco"], stat: f("shines"), min: 30, hot: 60, w: 4, agg: "sum",
    tag: ["Shine Spark", "Multishine Maniac", "Reflector Duty"],
    short: ["{n} shines {span}", "Shined {n} times"],
    long: ["{who} shined {n} times {span}. The reflector worked overtime.",
      "{n} shines from {who} {inSpan}. Shine, shine, shine."] },
  { id: "shinehits", family: "shine", only: ["fox", "falco"], stat: f("shinesLanded"), min: 8, hot: 18, w: 4, agg: "sum",
    tag: ["Shine On", "Bright Idea", "Reflected Glory"],
    short: ["{n} shines landed {span}", "Hit {opp} with {n} shines"],
    long: ["{who} landed {n} shines {span}. Bright idea, every time.",
      "{n} shines connected for {who} {inSpan}."] },
  { id: "sharpshooter", family: "proj", only: ["fox", "falco"], stat: f("lasersLanded"), min: 8, hot: 25, w: 4, agg: "sum",
    tag: ["Sharpshooter", "Laser Sight"],
    short: ["{n} lasers landed {span}", "Hit {n} lasers"],
    long: ["{who} hit {opp} with {n} lasers {span}. Sharpshooter.",
      "{n} lasers found their mark for {who} {inSpan}."] },
  { id: "rest", family: "rest", only: ["purin"], stat: f("restsLanded"), min: 1, hot: 3, w: 7, agg: "sum",
    tag: ["Rest in Peace", "Nap Time", "Sleeper Hit", "Lights Out"],
    short: ["{n} rest{s} landed {span}", "Landed rest ×{n}"],
    long: ["{who} landed {n} rest{s} {span}. Lights out, sleep tight.",
      "{n} rest{s} connected for {who} {inSpan}. The riskiest move in the game, landed."] },
  { id: "knee", family: "knee", only: ["captain_falcon"], stat: f("kneesLanded"), min: 3, hot: 8, w: 5, agg: "sum",
    tag: ["Knee of Justice", "Knee Deep", "Show Me Your Knees"],
    short: ["{n} knees landed {span}", "Landed the knee {n} times"],
    long: ["{who} landed {n} knees {span}. Justice was served.",
      "{n} knees from {who} {inSpan}. Show me your moves."] },
  { id: "stomp", family: "stomp", only: ["ganondorf"], stat: f("stompsLanded"), min: 2, hot: 6, w: 5, agg: "sum",
    tag: ["Stomped", "Boot Camp", "Heavy Footed"],
    short: ["{n} stomps landed {span}", "Stomped {opp} {n} times"],
    long: ["{who} stomped {opp} {n} times {span}. Heavy footed.",
      "{n} stomps from {who} {inSpan}. Watch your head."] },
];

// ── Building the callouts ─────────────────────────────────────────────────────

/** One template filled in, as text. */
function fill(tpl, v) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : m));
}
/** One template as segments: the numbers and the move/noun lit. */
const LIT = new Set(["n", "o", "move"]);
function segments(tpl, v) {
  const out = [];
  let last = 0;
  tpl.replace(/\{(\w+)\}/g, (m, k, at) => {
    if (at > last) out.push({ t: tpl.slice(last, at) });
    const val = v[k] != null ? String(v[k]) : m;
    out.push(LIT.has(k) ? { em: val } : { t: val });
    last = at + m.length;
    return m;
  });
  if (last < tpl.length) out.push({ t: tpl.slice(last) });
  // A sentence opening on its own words starts with a capital; one opening on a name keeps the name as typed.
  if (tpl[0] !== "{" && out[0] && out[0].t) out[0] = { t: out[0].t.charAt(0).toUpperCase() + out[0].t.slice(1) };
  return out;
}
const num = (v, dp) => (v == null ? null : dp ? Number(v).toFixed(dp) : String(Math.round(v)));

/** A number for the set reading from each game's: sum, a single game's best, or the average. */
function setValue(A, list) {
  const v = list.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return null;
  if (A.agg === "sum") return v.reduce((a, b) => a + b, 0);
  if (A.agg === "avg") return v.reduce((a, b) => a + b, 0) / v.length;
  if (A.agg === "max") return A.aggLo ? Math.min(...v) : Math.max(...v);
  return null; // "none": a single game's fact, not summed
}

/** Does side s qualify on A with value v (against the other side's o)? */
function qualifies(A, v, o, floor) {
  if (v == null || !Number.isFinite(v)) return false;
  if (A.lo ? v > floor : v < floor) return false;
  if (A.most && o != null && Number.isFinite(o)) {
    if (A.lo ? !(v < o) : !(v > o)) return false;
    if (A.by && !(A.lo ? v * A.by <= o : v >= o * A.by)) return false;
  }
  return true;
}

/** How remarkable: 0 at the floor, 1 at `hot`. */
function heat(A, v, floor, hot) {
  if (hot == null || hot === floor) return 0.5;
  return Math.max(0, Math.min(1, (v - floor) / (hot - floor)));
}

/**
 * @param {{ games: Array, last: object, names: string[], seed: string, recent?: Map<string, number> }} ctx
 *   games: set-view's counted games ({ n, per: [side0, side1] numbers, stage }), last the newest
 * @param {"game"|"set"} mode
 */
function accolades(ctx, mode) {
  const { games, last, names } = ctx;
  if (!last) return [];
  const set = mode === "set";
  const n = games.length;
  const seed = ctx.seed || "";
  const step = set ? 0 : last.n;
  const at = (list, key, k) => pick(list, seed, `${key}:${k}${set ? ":set" : ""}`, step);
  const titles = (list, key) => rotate(list, seed, `${key}:t${set ? ":set" : ""}`, step);
  const recent = ctx.recent || new Map();
  const out = [];
  for (const A of POOL) {
    for (const s of [0, 1]) {
      const o = 1 - s;
      const cn = last.per[s].fun ? last.per[s].fun.char : null;
      if (A.only && !A.only.includes(cn)) continue;
      const read = (g, side) => { try { const p = g.per[side], q = g.per[1 - side]; return A.stat(p, q, side); } catch { return null; } };
      let v;
      let ov;
      let floor = A.min;
      let hot = A.hot;
      if (set) {
        if (A.agg === "none") continue;
        v = setValue(A, games.map((g) => read(g, s)));
        ov = setValue(A, games.map((g) => read(g, o)));
        if (A.agg === "sum") { floor = A.min * Math.max(1, n * 0.75); hot = A.hot * Math.max(1, n * 0.75); }
      } else {
        v = read(last, s);
        ov = read(last, o);
      }
      if (!qualifies(A, v, ov, floor)) continue;
      const P = last.per[s];
      let vars = {};
      try { vars = A.vars ? A.vars(P) || {} : {}; } catch { continue; }
      const dp = A.fmt != null ? A.fmt : A.agg === "avg" && set ? 0 : (Number.isInteger(v) ? 0 : 1);
      Object.assign(vars, {
        who: names[s], opp: names[o], n: num(v, dp), o: ov == null ? "–" : num(ov, dp), g: last.n, s: Math.round(v) === 1 ? "" : "s",
        span: set ? "this set" : "this game",
        inSpan: set ? `across ${n} ${n === 1 ? "game" : "games"}` : `in game ${last.n}`,
        char: display(cn) || names[s],
      });
      const key = `${A.id}:${s}`;
      const tags = (A.tagBy && A.tagBy[cn]) || A.tag;
      // Old news: the same accolade for the same player in an earlier game of this set.
      let earlier = 0;
      if (!set) {
        for (const g of games) {
          if (g === last) continue;
          if (qualifies(A, read(g, s), read(g, o), A.min)) earlier++;
        }
      }
      const score = A.w + 3 * heat(A, v, floor, hot) - 2 * earlier - 1.5 * (recent.get(A.id) || 0);
      const big = A.big ? A.big(v) : vars.n;
      const shortT = at(A.short, key, "s");
      out.push({
        id: `acc-${A.id}-${s}`, kind: "accolade", family: A.family,
        tag: titles(tags, key)[0], tagAlts: titles(tags, key).slice(1),
        big, unit: A.unit || "",
        text: fill(shortT, vars),
        long: segments(at(A.long, key, "l"), vars),
        note: A.note ? fill(at(A.note, key, "n"), vars) : null,
        who: names[s], side: s, score,
      });
    }
  }
  return out;
}

/** Every wording in the pool, for the tests' length budgets. */
function allWordings() {
  return POOL.map((A) => ({ id: A.id, tags: [].concat(A.tag, ...Object.values(A.tagBy || {})), short: A.short, long: A.long, note: A.note || [] }));
}

module.exports = { accolades, allWordings, pick, rotate, hash, segments, fill, POOL };
