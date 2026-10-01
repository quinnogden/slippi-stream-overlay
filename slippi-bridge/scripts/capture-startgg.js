/**
 * capture-startgg.js — save real start.gg brackets as scrubbed test fixtures.
 *
 *   node scripts/capture-startgg.js                    this week's tournament (config.BRACKETS.shortLink)
 *   node scripts/capture-startgg.js --past 4           …plus the series' last 4 tournaments
 *   node scripts/capture-startgg.js <tournament-slug>  one specific tournament (repeatable)
 *   node scripts/capture-startgg.js --label live-r2    name this snapshot (…/<slug>.live-r2.json)
 *
 * An existing fixture is never overwritten: a repeat capture without --label is
 * saved as <slug>.<HHMM>.json.
 *
 * Writes tests/fixtures/startgg/<tournament>.json: the tournament, every Melee
 * event's phases and phase groups, every set in every phase group (with the slot
 * prereq edges the bracket model is built from), and the stream queue.
 *
 * Why this exists: the replacement bracket model is built from start.gg's own
 * set graph, and tests/README.md is explicit that hand-written state produces
 * tests that pass without exercising anything. So the fixtures are real
 * responses — scrubbed, because they carry attendee data:
 *
 *   - every id (set, entrant, player, seed, phase group…) is remapped to a
 *     synthetic value through ONE table, so the prereq edges still join up;
 *   - gamer tags become "Player<n>", prefixes "Team<n>", entrant names are rebuilt
 *     from the scrubbed tags, and displayScore is rewritten to match;
 *   - tournament / event / phase / round names and stream names are kept (public,
 *     and the bracket model reads them).
 *
 * Read-only against start.gg; goes through backgroundQuery so it respects the
 * same rate budget as the bridge's stats.
 */

const fs   = require("fs");
const path = require("path");

const config        = require("../config");
const StartggClient = require("../lib/startgg-client");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR   = path.join(REPO_ROOT, "tests", "fixtures", "startgg");

const MELEE_VIDEOGAME_ID = 1;

// Per set: set + 2 slots + 2 seeds + 2 standings + 2 entrants + ~2–4 participants
// + their players ≈ 15–20 objects. 40 a page stays well under the 1000 ceiling;
// a refusal halves it.
const PAGE_SIZES = [40, 20, 10];

const TOURNAMENT_QUERY = `
query capTournament($slug: String!) {
  tournament(slug: $slug) {
    id name slug startAt state
    owner { id }
    streams { id streamName streamSource }
    events {
      id name slug state type numEntrants
      videogame { id }
      phases {
        id name phaseOrder bracketType numSeeds groupCount state
        phaseGroups(query: { page: 1, perPage: 64 }) {
          nodes { id displayIdentifier bracketType state }
        }
      }
    }
  }
}`.trim();

const SET_FIELDS = `
  id identifier round fullRoundText state winnerId displayScore
  lPlacement wPlacement hasPlaceholder totalGames
  startedAt completedAt
  stream { streamName }
  phaseGroup { id }
  slots {
    slotIndex prereqType prereqId prereqPlacement
    seed { id seedNum }
    standing { placement stats { score { value } } }
    entrant {
      id name initialSeedNum
      participants { id gamerTag prefix player { id gamerTag prefix } }
    }
  }`;

const PHASE_GROUP_SETS_QUERY = `
query capPhaseGroupSets($id: ID!, $page: Int!, $perPage: Int!) {
  phaseGroup(id: $id) {
    id
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { total totalPages }
      nodes { ${SET_FIELDS} }
    }
  }
}`.trim();

const STREAM_QUEUE_QUERY = `
query capStreamQueue($tournamentId: ID!) {
  streamQueue(tournamentId: $tournamentId) {
    stream { id streamName }
    sets { ${SET_FIELDS} }
  }
}`.trim();

const PAST_TOURNAMENTS_QUERY = `
query capPast($ownerId: ID!, $perPage: Int!) {
  tournaments(query: { perPage: $perPage, page: 1, sortBy: "startAt desc",
                       filter: { ownerId: $ownerId, past: true } }) {
    nodes { slug name startAt }
  }
}`.trim();

// ── Fetching ──────────────────────────────────────────────────────────────────

async function gql(gg, query, variables) {
  const res = await gg.backgroundQuery(query, variables);
  if (!res.ok) {
    const err = new Error(res.error || "start.gg query failed");
    err.complexity = !!res.complexity;
    throw err;
  }
  return res.data;
}

async function fetchPhaseGroupSets(gg, phaseGroupId) {
  for (const perPage of PAGE_SIZES) {
    try {
      const sets = [];
      for (let page = 1; ; page++) {
        const data = await gql(gg, PHASE_GROUP_SETS_QUERY, { id: phaseGroupId, page, perPage });
        const conn = data?.phaseGroup?.sets;
        sets.push(...(conn?.nodes ?? []));
        if (page >= (conn?.pageInfo?.totalPages ?? 0)) break;
      }
      return sets;
    } catch (err) {
      // Offsets change with the page size, so a refusal restarts the group.
      if (!err.complexity) throw err;
      console.warn(`  phase group ${phaseGroupId}: refused at ${perPage}/page, retrying smaller`);
    }
  }
  throw new Error(`phase group ${phaseGroupId}: refused even at ${PAGE_SIZES.at(-1)}/page`);
}

async function captureTournament(gg, slug) {
  const t = (await gql(gg, TOURNAMENT_QUERY, { slug }))?.tournament;
  if (!t) throw new Error(`start.gg doesn't recognise the tournament "${slug}"`);

  const events = (t.events ?? []).filter((e) => e.videogame?.id === MELEE_VIDEOGAME_ID);
  const phaseGroupSets = {};
  for (const ev of events) {
    for (const ph of ev.phases ?? []) {
      for (const pg of ph.phaseGroups?.nodes ?? []) {
        console.log(`  ${ev.name} / ${ph.name} / ${pg.displayIdentifier} (${pg.id})`);
        phaseGroupSets[pg.id] = await fetchPhaseGroupSets(gg, pg.id);
      }
    }
  }

  let streamQueue = [];
  try {
    streamQueue = (await gql(gg, STREAM_QUEUE_QUERY, { tournamentId: t.id }))?.streamQueue ?? [];
  } catch (err) {
    console.warn(`  stream queue unavailable: ${err.message}`);
  }

  return {
    capturedAt: new Date().toISOString(),
    tournament: { ...t, events },
    phaseGroupSets,
    streamQueue,
  };
}

async function pastSlugs(gg, currentSlug, count) {
  const t = (await gql(gg, TOURNAMENT_QUERY, { slug: currentSlug }))?.tournament;
  const ownerId = t?.owner?.id;
  if (!ownerId) return [];
  const data = await gql(gg, PAST_TOURNAMENTS_QUERY, { ownerId, perPage: count + 1 });
  return (data?.tournaments?.nodes ?? [])
    .map((n) => n.slug.replace(/^tournament\//, ""))
    .filter((s) => s !== currentSlug)
    .slice(0, count);
}

// ── Scrubbing ─────────────────────────────────────────────────────────────────

/**
 * One id table for the whole capture, so every reference (prereqId → set or
 * seed id, winnerId → entrant id, phaseGroup.id) still points at the same
 * synthetic node. Numeric ids stay numeric; preview ids keep their "preview_"
 * prefix because the bridge recognises unstarted sets by it.
 */
function makeScrubber() {
  const ids  = new Map();
  const tags = new Map();
  const pfxs = new Map();
  let nextId = 100000;

  const id = (v) => {
    if (v == null) return v;
    const key = String(v);
    if (!ids.has(key)) {
      const n = nextId++;
      ids.set(key, key.startsWith("preview") ? `preview_${n}` : typeof v === "number" ? n : String(n));
    }
    return ids.get(key);
  };
  const tag = (v) => {
    if (!v) return v;
    if (!tags.has(v)) tags.set(v, `Player${tags.size + 1}`);
    return tags.get(v);
  };
  const prefix = (v) => {
    if (!v) return v;
    if (!pfxs.has(v)) pfxs.set(v, `Team${pfxs.size + 1}`);
    return pfxs.get(v);
  };

  const ID_KEYS = new Set(["id", "prereqId", "winnerId"]);

  function entrantName(ent) {
    const parts = (ent.participants ?? []).map((p) => tag(p.gamerTag) ?? "");
    return parts.filter(Boolean).join(" / ") || "Entrant";
  }

  function scrubSet(set) {
    // displayScore embeds the real entrant names ("Zodd 2 - Redd 1"). Swap them
    // for the scrubbed names, longest first so a name containing another can't
    // be half-replaced.
    const renames = [];
    for (const slot of set.slots ?? []) {
      const ent = slot.entrant;
      if (ent?.name) renames.push([ent.name, entrantName(ent)]);
    }
    if (typeof set.displayScore === "string") {
      let s = set.displayScore;
      for (const [from, to] of renames.sort((a, b) => b[0].length - a[0].length)) {
        s = s.split(from).join(to);
      }
      set.displayScore = s;
    }
    for (const slot of set.slots ?? []) {
      const ent = slot.entrant;
      if (!ent) continue;
      ent.name = entrantName(ent);
      for (const p of ent.participants ?? []) {
        p.gamerTag = tag(p.gamerTag);
        p.prefix   = prefix(p.prefix);
        if (p.player) {
          p.player.gamerTag = tag(p.player.gamerTag);
          p.player.prefix   = prefix(p.player.prefix);
        }
      }
    }
  }

  function walkIds(node) {
    if (Array.isArray(node)) return node.forEach(walkIds);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (ID_KEYS.has(k) && (typeof v === "number" || typeof v === "string")) node[k] = id(v);
      else walkIds(v);
    }
  }

  return function scrub(capture) {
    // Names first: scrubSet reads the real entrant names to rewrite displayScore.
    for (const sets of Object.values(capture.phaseGroupSets)) sets.forEach(scrubSet);
    for (const q of capture.streamQueue) (q.sets ?? []).forEach(scrubSet);
    delete capture.tournament.owner;

    walkIds(capture.tournament);
    walkIds(capture.streamQueue);
    const remapped = {};
    for (const [pgId, sets] of Object.entries(capture.phaseGroupSets)) {
      walkIds(sets);
      remapped[id(Number(pgId))] = sets;
    }
    capture.phaseGroupSets = remapped;
    return capture;
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Never overwrite a fixture. The same tournament is worth capturing more than
 * once — before it starts (preview sets), mid-event (in-progress sets, a live
 * stream queue), after — and each is a different test case. So a repeat capture
 * gets a label: the one given with --label, else the local time.
 */
function outFile(slug, label) {
  const plain = path.join(OUT_DIR, `${slug}.json`);
  if (!label && !fs.existsSync(plain)) return plain;
  const now = new Date();
  const tag = label || `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return path.join(OUT_DIR, `${slug}.${tag}.json`);
}

async function main() {
  const argv = process.argv.slice(2);
  let past = 0;
  let label = null;
  const explicit = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--past") past = Math.max(0, Number(argv[++i]) || 0);
    else if (argv[i] === "--label") label = String(argv[++i] ?? "").replace(/[^\w-]/g, "") || null;
    else explicit.push(argv[i].replace(/^.*\/tournament\//, "").replace(/\/.*$/, ""));
  }

  const gg = new StartggClient(config);
  if (!gg.enabled) {
    console.error("No start.gg token configured (slippi-bridge/config.local.js → STARTGG_TOKEN).");
    process.exit(1);
  }

  let slugs = explicit;
  if (slugs.length === 0) {
    const res = await gg.resolveShortLink(config.BRACKETS?.shortLink);
    if (!res.ok) { console.error(res.error); process.exit(1); }
    slugs = [res.slug];
  }
  if (past > 0) slugs = [...slugs, ...(await pastSlugs(gg, slugs[0], past))];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const slug of slugs) {
    console.log(`Capturing ${slug}`);
    const capture = makeScrubber()(await captureTournament(gg, slug));
    const sets = Object.values(capture.phaseGroupSets).reduce((n, s) => n + s.length, 0);
    const file = outFile(slug, label);
    fs.writeFileSync(file, JSON.stringify(capture, null, 1) + "\n");
    console.log(`  → ${path.relative(REPO_ROOT, file)} (${sets} sets, ${capture.streamQueue.length} stream queues)`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
