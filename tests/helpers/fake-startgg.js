/**
 * fake-startgg.js — a StartggClient stand-in that answers from a captured
 * tournament in fixtures/startgg/, plus small accessors for tests that want the
 * raw captured data directly.
 *
 * The answers are the captured responses, never hand-written ones (see
 * tests/README.md on why invented state makes tests that cannot fail). Calls
 * that would change start.gg are recorded instead of sent.
 */

const path = require("path");
const fs   = require("fs");

const FIXTURES = path.join(__dirname, "..", "fixtures", "startgg");

/** The parsed capture, e.g. loadCapture("hundred-acres-49"). Fresh copy each call. */
function loadCapture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

/**
 * One event out of a capture, matched on its name (case-insensitive substring).
 * @returns {{ capture: object, event: object, phaseGroup: object, sets: Array<object> }}
 */
function eventFrom(name, eventMatch) {
  const capture = loadCapture(name);
  const event = capture.tournament.events.find((e) => e.name.toLowerCase().includes(eventMatch.toLowerCase()));
  if (!event) throw new Error(`${name}: no event matching "${eventMatch}"`);
  const phaseGroup = event.phases[0].phaseGroups.nodes[0];
  return { capture, event, phaseGroup, sets: capture.phaseGroupSets[phaseGroup.id] };
}

/**
 * A StartggClient with the read methods answered from `captureName` — or from
 * a capture already loaded (and, say, rewound to mid-event with rewind()).
 * `calls` records every method invoked, mutations included.
 */
function fakeStartgg(captureName, { enabled = true } = {}) {
  const capture = typeof captureName === "string" ? loadCapture(captureName) : captureName;
  const calls = [];
  const rec = (method, args, result) => { calls.push({ method, args }); return Promise.resolve(result); };
  const events = capture.tournament.events;
  const t = capture.tournament;

  return {
    enabled,
    calls,
    resolveShortLink: (s) => rec("resolveShortLink", [s], { ok: true, slug: t.slug.replace(/^tournament\//, "") }),
    listEvents: (s) => rec("listEvents", [s], { ok: true, name: t.name, events: events.map(({ id, name, slug }) => ({ id, name, slug })) }),
    getEvent: (slug) => {
      const ev = events.find((e) => e.slug === slug);
      return rec("getEvent", [slug], ev
        ? { ok: true, event: { ...JSON.parse(JSON.stringify(ev)), tournament: { id: t.id, name: t.name, slug: t.slug } } }
        : { ok: false, error: `start.gg doesn't recognise the event "${slug}"` });
    },
    getPhaseGroupSets: (id) => {
      const sets = capture.phaseGroupSets[String(id)];
      return rec("getPhaseGroupSets", [id], sets
        ? { ok: true, sets: JSON.parse(JSON.stringify(sets)) }
        : { ok: false, error: `no phase group ${id}` });
    },
    getSet: (id) => {
      const set = Object.values(capture.phaseGroupSets).flat().find((s) => String(s.id) === String(id));
      return rec("getSet", [id], set
        ? { ok: true, set: JSON.parse(JSON.stringify(set)) }
        : { ok: false, error: `start.gg doesn't recognise set ${id}` });
    },
    reportSet: (...a) => rec("reportSet", a, { ok: true, state: 3 }),
    startSet: (...a) => rec("startSet", a, { ok: true, state: 2 }),
    getSetState: (...a) => rec("getSetState", a, { ok: true, state: 1 }),
    backgroundQuery: (...a) => rec("backgroundQuery", a, { ok: false, error: "fake-startgg: backgroundQuery not captured" }),
  };
}

/**
 * A finished capture wound back to mid-event: in every phase group, the sets
 * finished after the `frac` point (by start.gg's completion times) become
 * unplayed again, and a slot whose feeder is unplayed loses its entrant —
 * exactly what start.gg showed at that moment, short of scores in progress.
 * The first `live` ready sets of each group are then marked in progress.
 * Mutates and returns `capture`.
 */
function rewind(capture, frac, { live = 0 } = {}) {
  for (const sets of Object.values(capture.phaseGroupSets)) {
    const times = sets.map((s) => s.completedAt).filter(Boolean).sort((a, b) => a - b);
    const cut = times[Math.floor(times.length * frac)] ?? Infinity;
    const done = new Set(sets.filter((s) => s.completedAt && s.completedAt < cut).map((s) => String(s.id)));
    for (const s of sets) {
      if (done.has(String(s.id))) continue;
      Object.assign(s, { state: 1, winnerId: null, displayScore: null, completedAt: null });
      s.slots = s.slots.map((slot) => {
        const pending = slot.prereqType === "set" && sets.some((f) => String(f.id) === String(slot.prereqId)) && !done.has(String(slot.prereqId));
        return { ...slot, standing: null, ...(pending ? { entrant: null, seed: null } : {}) };
      });
    }
    sets.filter((s) => s.state === 1 && s.slots.every((x) => x.entrant)).slice(0, live).forEach((s) => { s.state = 2; });
  }
  return capture;
}

module.exports = { loadCapture, eventFrom, fakeStartgg, rewind };
