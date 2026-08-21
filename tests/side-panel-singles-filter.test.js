/**
 * side-panel-singles-filter.test.js
 *
 * The head-to-head card must show singles sets only.
 *
 * start.gg's recent-sets query filters on player ids, not on event, and TSH's
 * provider only compares participants[0] of each entrant
 * (StartGGDataProvider.GetRecentSetsWorker) — so a doubles set the two players
 * happened to be listed first in arrives in `recent_sets.sets` shaped exactly
 * like a singles one. Unfiltered, it renders as a pill *and* counts toward the
 * H2H record, which is the part that is wrong rather than merely noisy.
 *
 * Invisible until it is on stream, and reproducing it by hand needs a
 * tournament where these two also played doubles — hence a test.
 *
 * Usage: node tests/side-panel-singles-filter.test.js
 */

const { loadLayout, fixture, clone } = require("./helpers/layout-sandbox");

const SB = "1"; // SCOREBOARD_NUM in side-panel.js
const BASE = fixture("program-state");

// A doubles set as the provider emits one: same shape, only `event` differs.
const DOUBLES_SET = {
  tournament: "Hundred Acres #42",
  event: "Melee Doubles",
  score: [0, 2],
  timestamp: 1784845800,
  winner: 1,
  round: "Winners Round 1",
};

function withSets(sets) {
  const s = clone(BASE);
  s.score[SB].recent_sets = { state: "done", sets };
  return s;
}

/** Every textContent in a stub subtree, so an assertion needn't know the markup. */
function texts(el, out = []) {
  if (!el) return out;
  if (el.textContent) out.push(el.textContent);
  (el.children || []).forEach((c) => texts(c, out));
  return out;
}

async function main() {
  const env = await loadLayout({
    file: "TournamentStreamHelper-5.972/layout/side-panel/side-panel.js",
    ids: ["panel-player-1", "panel-player-2", "panel-recent-sets", "panel-queue"],
    selectors: [".logo-primary", ".logo-sponsor", ".tournament-name", ".clip-toast"],
    expose: ["isSinglesEvent", "recentSinglesSets", "hasRecentSets"],
  }).ready();

  const { isSinglesEvent, recentSinglesSets, hasRecentSets } = env.exposed;
  const failures = [];
  const check = (ok, msg) => { if (!ok) failures.push(msg); };

  // ── The event-name rule ────────────────────────────────────────────────────
  const NAMES = [
    ["Melee Singles", true],
    ["Melee Singles (Flex Bo5)", true],
    ["SSBM SINGLES", true],
    ["Melee Doubles", false],
    ["Melee Singles Doubles Bracket", false], // a doubles marker always wins
    ["Dubs", false],
    ["Melee Teams", false],
    ["2v2", false],
    ["Melee Bracket", false], // no format signal — kept out on purpose
    ["", false],
    [undefined, false],
  ];
  for (const [name, want] of NAMES) {
    check(isSinglesEvent(name) === want,
      `isSinglesEvent(${JSON.stringify(name)}) === ${!want}, want ${want}`);
  }

  // ── The filtered list ──────────────────────────────────────────────────────
  const singlesOnly = BASE.score[SB].recent_sets.sets;
  check(recentSinglesSets(BASE).length === singlesOnly.length,
    `the fixture's ${singlesOnly.length} singles sets must survive the filter — ` +
    `got ${recentSinglesSets(BASE).length}. If the fixture's event names changed, ` +
    `the filter is now dropping real sets.`);

  const mixed = withSets([DOUBLES_SET, ...clone(singlesOnly)]);
  const kept = recentSinglesSets(mixed);
  check(kept.length === singlesOnly.length && !kept.some((s) => s.event === DOUBLES_SET.event),
    `a doubles set survived the filter: kept ${kept.map((s) => s.event).join(", ")}`);

  // Nothing left after filtering means the panel must be skipped, not shown
  // empty — the slot predicate and the renderer read the same list.
  check(hasRecentSets(withSets([DOUBLES_SET])) === false,
    "hasRecentSets() is true with only doubles sets — the H2H panel would rotate in blank");
  check(hasRecentSets(mixed) === true,
    "hasRecentSets() is false with singles sets present — the H2H panel would never show");

  // ── What actually reaches the screen ───────────────────────────────────────
  // Guards the renderer specifically: it used to read recent_sets.sets directly,
  // and a drift back would show the doubles pill and bank its win in the H2H count.
  await env.sandbox.Update({ data: mixed });

  const list = env.getEl("panel-recent-sets").querySelector(".sets-list");
  const pills = (list.children || []).filter(
    (c) => String(c.className).includes("recent-set-pill"));
  check(pills.length === singlesOnly.length,
    `rendered ${pills.length} result pills, want ${singlesOnly.length} (the doubles set was drawn)`);

  // Both fixture sets are wins for player 1; the doubles set is a win for
  // player 2, so an unfiltered tally reads "2 – 1".
  const wanted = singlesOnly.length + " – 0";
  check(texts(list).some((t) => t === wanted),
    `the head-to-head record never read "${wanted}" — the doubles set is being counted. ` +
    `saw: ${texts(list).filter((t) => /\d\s–\s\d/.test(t)).join(" | ") || "no score text at all"}`);

  console.log("side-panel head-to-head — doubles sets stay off the singles card");
  if (failures.length) {
    failures.forEach((f) => console.log("  FAIL  " + f));
    console.log(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`  ok    ${NAMES.length} event names, filter, slot predicate, rendered card`);
  console.log("\nSingles filter holds.");
}

main().catch((e) => { console.error(e); process.exit(1); });
