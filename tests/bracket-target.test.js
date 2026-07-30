/**
 * The bracket switcher picks the right event.
 *
 * Squarely in this suite's charter: picking the wrong event is silent. TSH
 * validates nothing about the url it is handed, so a mis-picked event toasts
 * green, puts the wrong bracket on the broadcast, and mis-targets every set id
 * downstream — including the one /api/report publishes against. Nothing errors
 * anywhere, and the operator finds out on stream.
 *
 * The helpers under test are pure and the module has no side effects on
 * require, so this needs no sandbox and no network.
 */

const assert = require("assert");
const {
  pickEvent, sameEvent, normalizeEventUrl, normalizeBrackets,
} = require("../slippi-bridge/lib/server/bracket-switch");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

// The real event list for hundred-acres-43, as start.gg returns it.
const EVENTS = [
  { id: "1", name: "Ladder",                 slug: "tournament/hundred-acres-43/event/ladder" },
  { id: "2", name: "Melee Doubles",          slug: "tournament/hundred-acres-43/event/melee-doubles" },
  { id: "3", name: "Melee Singles (Flex Bo5)", slug: "tournament/hundred-acres-43/event/melee-singles-flex-bo5" },
];

const SINGLES = { match: ["melee", "singles"], fallbackSlug: "melee-singles-flex-bo5" };
const DOUBLES = { match: ["melee", "doubles"], fallbackSlug: "melee-doubles" };

console.log("bracket-target");

test("singles picks the singles event", () => {
  const r = pickEvent(EVENTS, SINGLES, "singles");
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.event.slug, "tournament/hundred-acres-43/event/melee-singles-flex-bo5");
});

test("doubles picks the doubles event", () => {
  const r = pickEvent(EVENTS, DOUBLES, "doubles");
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.event.slug, "tournament/hundred-acres-43/event/melee-doubles");
});

// The wrong-bracket-on-stream failure, stated directly.
test("neither kind can match the other's event", () => {
  assert.notStrictEqual(
    pickEvent(EVENTS, SINGLES, "singles").event.id,
    pickEvent(EVENTS, DOUBLES, "doubles").event.id
  );
});

// The whole reason the event list is queried instead of a slug appended.
test("a renamed slug still resolves", () => {
  const renamed = EVENTS.map((e) =>
    e.name === "Melee Singles (Flex Bo5)"
      ? { ...e, name: "Melee Singles", slug: "tournament/hundred-acres-43/event/melee-singles-bo3" }
      : e);
  const r = pickEvent(renamed, SINGLES, "singles");
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.event.slug, "tournament/hundred-acres-43/event/melee-singles-bo3");
});

test("an ambiguous match is refused, never guessed", () => {
  const withAmateur = [
    ...EVENTS,
    { id: "4", name: "Melee Singles Amateur", slug: "tournament/hundred-acres-43/event/melee-singles-amateur" },
  ];
  const r = pickEvent(withAmateur, SINGLES, "singles");
  assert.strictEqual(r.ok, false);
  assert.ok(/Melee Singles \(Flex Bo5\)/.test(r.error), `error should name the candidates: ${r.error}`);
  assert.ok(/Melee Singles Amateur/.test(r.error), `error should name the candidates: ${r.error}`);
});

test("no match lists what was actually there", () => {
  const r = pickEvent(EVENTS, { match: ["quadruples"] }, "quads");
  assert.strictEqual(r.ok, false);
  assert.ok(/Ladder/.test(r.error), `error should list the found events: ${r.error}`);
});

test("an empty event list is refused rather than throwing", () => {
  assert.strictEqual(pickEvent([], SINGLES, "singles").ok, false);
  assert.strictEqual(pickEvent(undefined, SINGLES, "singles").ok, false);
});

// This is what makes a second press re-pull the bracket instead of silently
// no-opping inside TSH.
test("sameEvent sees through scheme, www, /events/ and trailing path", () => {
  assert.strictEqual(
    sameEvent("start.gg/tournament/x/event/y",
              "https://www.start.gg/tournament/x/events/y/overview"),
    true
  );
});

test("sameEvent rejects a different event, and null", () => {
  assert.strictEqual(sameEvent("start.gg/tournament/x/event/y", "start.gg/tournament/x/event/z"), false);
  assert.strictEqual(sameEvent(null, "start.gg/tournament/x/event/y"), false);
  assert.strictEqual(sameEvent(null, null), false, "two unknowns must not read as a match");
});

test("normalizeEventUrl returns null for a non-event url", () => {
  assert.strictEqual(normalizeEventUrl("https://www.start.gg/tournament/x/details"), null);
  assert.strictEqual(normalizeEventUrl(""), null);
});

// config.local.js is merged with a shallow Object.assign, so a partial override
// of BRACKETS would otherwise leave `events` undefined and crash the buttons.
test("normalizeBrackets fills every key from a partial config", () => {
  for (const cfg of [{}, { BRACKETS: { shortLink: "x" } }, { BRACKETS: { events: {} } }]) {
    const b = normalizeBrackets(cfg);
    assert.ok(b.events.singles, "singles spec missing");
    assert.ok(b.events.doubles, "doubles spec missing");
    assert.ok(Array.isArray(b.events.singles.match) && b.events.singles.match.length > 0);
    assert.strictEqual(typeof b.events.singles.fallbackSlug, "string");
    assert.strictEqual(typeof b.shortLink, "string");
  }
});

test("normalizeBrackets keeps a real config and lowercases keywords", () => {
  const b = normalizeBrackets({ BRACKETS: { shortLink: " 100-acres ", events: { singles: { match: ["Melee", "SINGLES"] } } } });
  assert.strictEqual(b.shortLink, "100-acres");
  assert.deepStrictEqual(b.events.singles.match, ["melee", "singles"]);
});

// The committed config must actually pick the two events it claims to.
test("the shipped config.BRACKETS resolves against the real event list", () => {
  const b = normalizeBrackets(require("../slippi-bridge/config"));
  assert.ok(pickEvent(EVENTS, b.events.singles, "singles").ok, "shipped singles spec does not match");
  assert.ok(pickEvent(EVENTS, b.events.doubles, "doubles").ok, "shipped doubles spec does not match");
});

console.log(failed === 0 ? "bracket-target: all passed" : `bracket-target: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
