/**
 * Stream-set replays (app/lib/replays/): what each game remembers, the
 * context.json LuckyStats validates, the history that survives captures, and
 * the upload journal.
 *
 * Every failure here is silent until the tournament is finished on LuckyStats
 * and a set comes back skipped (a score in the wrong slot, a game count that
 * doesn't match) or never arrives (an upload stuck after a restart, a second
 * revision created by a retry). The context's shape is Replay Reporter for
 * Slippi's; the rules pinned here are the ones its format actually encodes.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { PortMap } = require("../app/lib/ports/port-map");
const { createState } = require("../app/lib/state");
const { createModes } = require("../app/lib/modes");
const { buildContext, contextProblem, metaFromStartgg, gameMs } = require("../app/lib/replays/context");
const { StreamSets } = require("../app/lib/replays/stream-sets");
const { buildBundle } = require("../app/lib/replays/bundle");
const { archiveBundle } = require("../app/lib/replays/archive");
const { LuckyStatsUploads } = require("../app/lib/replays/uploader");
const { isFinished } = require("../app/lib/replays/slp-file");

let failed = 0;
const say = (s) => process.stdout.write(s + "\n");
async function test(name, fn) {
  try {
    await fn();
    say(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "replays-test-"));
const quiet = { emit() {} };

/** A file with a finished .slp header (Slippi closed it) and some bytes. */
function finishedSlp(name, body = name) {
  const file = path.join(TMP, name);
  const head = Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c, 0, 0, 0, 0]);
  const data = Buffer.from(String(body));
  head.writeInt32BE(data.length, 11);
  fs.writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

/** A live .slp: raw length still 0. */
function liveSlp(name) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c, 0, 0, 0, 0, 1, 2, 3]));
  return file;
}

// A real start.gg answer to getSetContext (Hundred Acres #51's grand final),
// players left out — the query asks for none.
const STARTGG_SET = {
  id: 108404138, round: 6, fullRoundText: "Grand Final", identifier: "AC", stream: null,
  slots: [{ slotIndex: 0, entrant: { id: 24866248 } }, { slotIndex: 1, entrant: { id: 24851427 } }],
  phaseGroup: {
    id: 3476001, displayIdentifier: "1", bracketType: "DOUBLE_ELIMINATION", wave: null,
    phase: {
      id: 2412452, name: "Bracket", groupCount: 1,
      event: {
        id: 1721107, name: "Melee Singles (Flex Bo5)", slug: "tournament/hundred-acres-51/event/melee-singles-flex-bo5",
        phases: [{ id: 2412452 }],
        tournament: {
          id: 958585, name: "Hundred Acres #51", slug: "tournament/hundred-acres-51",
          city: "Richmond", addrState: "VA", countryCode: "US",
          events: [{ id: 1721108, videogame: { id: 1 } }, { id: 1721107, videogame: { id: 1 } }],
        },
      },
    },
  },
};
const META = metaFromStartgg(STARTGG_SET);

/** The set as the event service loads it: entrant 24866248 on the left. */
function loadedStore() {
  const store = new ScoreboardStore();
  store.loadSet({
    setId: "108404138", phaseGroupId: "3476001", roundName: "Grand Final", identifier: "AC",
    isGrandFinal: true,
    sides: [
      { entrantId: "24866248", name: "Alpha", players: [{ playerId: "1", tag: "Alpha", prefix: "AA" }] },
      { entrantId: "24851427", name: "Beta", fromLosers: true, players: [{ playerId: "2", tag: "Beta", prefix: "" }] },
    ],
  });
  return store;
}

const raw = (playerIndex, characterId, characterColor = 0, teamId = null) =>
  ({ playerIndex, characterId, characterColor, teamId, type: 0 });

/**
 * Play games through the real modes (port map, game end) into the store.
 * Alpha (Fox, 2) plays on port 3, Beta (Marth, 9) on port 1 — so game 1's
 * lowest port is the RIGHT side's.
 */
function playSet(store, { winners, files }) {
  const ctx = { store, portMap: new PortMap(), io: quiet, state: createState() };
  store.setPlayer(0, 0, { main: { codename: "fox", name: "Fox", skin: 0 } });
  store.setPlayer(1, 0, { main: { codename: "marth", name: "Marth", skin: 0 } });
  const modes = createModes(ctx);
  winners.forEach((winnerPort, i) => {
    modes.onGameStart([raw(0, 9), null, raw(2, 2, 1), null]);
    modes.onGameEnd({ winnerPlayerIndex: winnerPort, isHandwarmer: false, stocks: {},
      replay: { file: files[i], startMs: 1000 + i, lastFrame: 5000 + i, stageId: 31 } });
  });
}

(async () => {
  say("replays");

  // ── What each game remembers ───────────────────────────────────────────────

  await test("a Slippi game keeps its file and each side's ports by slot; a ± game has none", () => {
    const store = loadedStore();
    playSet(store, { winners: [2], files: ["G1.slp"] });
    store.bump(1, 1);
    const [g1, g2] = store.scoreboard().games;
    assert.strictEqual(g1.replay.file, "G1.slp");
    assert.deepStrictEqual(g1.replay.players, [[{ port: 2, characterId: 2, costume: 1 }], [{ port: 0, characterId: 9, costume: 0 }]]);
    assert.strictEqual(g1.winnerSide, 0);
    assert.strictEqual(g2.replay, null);
  });

  await test("Switch Sides moves each game's ports with its side", () => {
    const store = loadedStore();
    playSet(store, { winners: [2], files: ["G1.slp"] });
    store.switchSides();
    const g = store.scoreboard().games[0];
    assert.strictEqual(g.winnerSide, 1);
    assert.strictEqual(g.replay.players[1][0].port, 2, "Alpha's port went right with Alpha");
  });

  // ── context.json ───────────────────────────────────────────────────────────

  const sets = new StreamSets(path.join(TMP, "ctx-sets.json"));
  const recordOf = (store) => sets.capture(store.scoreboard(), store.tournament()).record;

  await test("slots are in game 1's port order, and each score is the score BEFORE that game", () => {
    const store = loadedStore();
    // Alpha (port 3) wins G1, Beta (port 1) wins G2, Alpha wins G3.
    playSet(store, { winners: [2, 0, 2], files: ["a.slp", "b.slp", "c.slp"] });
    const ctx = buildContext(recordOf(store), META);
    // Beta holds port 1, so Beta is slot 0 throughout.
    assert.deepStrictEqual(ctx.scores.map((s) => s.slots.map((x) => x.displayNames[0])), [["Beta", "Alpha"], ["Beta", "Alpha"], ["Beta", "Alpha"]]);
    assert.deepStrictEqual(ctx.scores.map((s) => s.slots.map((x) => x.score)), [[0, 0], [0, 1], [1, 1]]);
    assert.deepStrictEqual(ctx.finalScore.slots.map((x) => x.score), [1, 2]);
    assert.deepStrictEqual(ctx.scores[0].slots.map((x) => x.ports), [[1], [3]], "ports are 1-based");
    assert.deepStrictEqual(ctx.scores[0].slots[1].characters, [{ id: 2, costume: 1 }]);
    assert.strictEqual(ctx.bestOf, 3);
  });

  await test("Switch Sides before the set closes changes nothing in its context", () => {
    const a = loadedStore();
    playSet(a, { winners: [2, 0, 2], files: ["a.slp", "b.slp", "c.slp"] });
    const before = buildContext(recordOf(a), META);
    a.switchSides();
    const after = buildContext(recordOf(a), META);
    assert.deepStrictEqual(after, before);
  });

  await test("players are entrant1/entrant2 in start.gg's slot order, with Replay Reporter's character names", () => {
    const store = loadedStore();
    store.switchSides(); // Beta now on the left — start.gg's order is unchanged
    playSet(store, { winners: [0, 0], files: ["a.slp", "b.slp"] });
    const ctx = buildContext(recordOf(store), META);
    assert.strictEqual(ctx.players.entrant1[0].name, "Alpha");
    assert.strictEqual(ctx.players.entrant2[0].name, "Beta");
    // Who played what follows the port map, not the mains.
    const chars = [ctx.players.entrant1[0].characters, ctx.players.entrant2[0].characters].flat().sort();
    assert.deepStrictEqual(chars, ["Fox", "Marth"]);
  });

  await test("the [L] side carries losers; the startgg block is start.gg's own ids", () => {
    const store = loadedStore();
    playSet(store, { winners: [2, 2], files: ["a.slp", "b.slp"] });
    const ctx = buildContext(recordOf(store), META);
    assert.strictEqual(ctx.finalScore.slots[0].losers, true, "Beta came from losers");
    assert.strictEqual(ctx.finalScore.slots[1].losers, undefined);
    assert.deepStrictEqual(ctx.startgg.set, { id: 108404138, internalId: 108404138, fullRoundText: "Grand Final", ordinal: null, round: 6, stream: null });
    assert.deepStrictEqual(ctx.startgg.event, { id: 1721107, name: "Melee Singles (Flex Bo5)", slug: "tournament/hundred-acres-51/event/melee-singles-flex-bo5", hasSiblings: true });
    assert.strictEqual(ctx.startgg.tournament.location, "Richmond, VA");
    assert.strictEqual(ctx.startgg.phaseGroup.bracketType, 2);
    assert.strictEqual(ctx.durationMs, gameMs(5000) + gameMs(5001));
  });

  await test("a set with a game scored by hand, or a tie, has no context", () => {
    const store = loadedStore();
    playSet(store, { winners: [2], files: ["a.slp"] });
    store.bump(1, 1);
    assert.match(contextProblem(recordOf(store)), /Game 2 has no replay/);
    const tie = loadedStore();
    playSet(tie, { winners: [2, 0], files: ["a.slp", "b.slp"] });
    assert.match(contextProblem(recordOf(tie)), /tied/);
  });

  // ── The history ────────────────────────────────────────────────────────────

  await test("only real start.gg sets with games are kept (no preview, crew or manual set)", () => {
    const s = new StreamSets(path.join(TMP, "keep.json"));
    const store = new ScoreboardStore();
    store.bump(0, 1);
    assert.strictEqual(s.capture(store.scoreboard(), store.tournament()).ok, false, "manual set");
    store.loadSet({ setId: "preview_1_2_3", sides: [{}, {}] });
    store.bump(0, 1);
    assert.strictEqual(s.capture(store.scoreboard(), store.tournament()).ok, false, "preview set");
    assert.strictEqual(s.list().length, 0);
  });

  await test("a set reloaded later (start.gg's score as ± games) doesn't replace its replays", () => {
    const s = new StreamSets(path.join(TMP, "reload.json"));
    const store = loadedStore();
    playSet(store, { winners: [2, 2], files: ["a.slp", "b.slp"] });
    s.capture(store.scoreboard(), store.tournament(), { reported: true });
    const again = loadedStore();
    again.bump(0, 1); again.bump(0, 1);
    s.capture(again.scoreboard(), again.tournament());
    const r = s.get("108404138");
    assert.deepStrictEqual(r.games.map((g) => g.replay?.file), ["a.slp", "b.slp"]);
    assert.strictEqual(r.reported, true);
  });

  await test("a corrected set keeps its correction when the set is captured again, and survives a restart", () => {
    const file = path.join(TMP, "edit.json");
    const s = new StreamSets(file);
    const store = loadedStore();
    playSet(store, { winners: [2, 2, 0], files: ["a.slp", "b.slp", "c.slp"] });
    s.capture(store.scoreboard(), store.tournament());
    assert.ok(s.editGame("108404138", 2, { op: "remove" }).ok);
    s.capture(store.scoreboard(), store.tournament());
    assert.strictEqual(s.get("108404138").games.length, 2);
    s.flush();
    const back = new StreamSets(file);
    assert.strictEqual(back.get("108404138").games.length, 2);
    assert.strictEqual(back.get("108404138").edited, true);
  });

  await test("Zelda ⇄ Sheik changes the game's character id and its icon; ⇄ Ports moves ports and characters, not the winner", () => {
    const s = new StreamSets(path.join(TMP, "zs.json"));
    const store = loadedStore();
    const ctx = { store, portMap: new PortMap(), io: quiet, state: createState() };
    const modes = createModes(ctx);
    modes.onGameStart([raw(0, 18), null, raw(2, 2), null]);
    modes.onGameEnd({ winnerPlayerIndex: 0, isHandwarmer: false, stocks: {}, replay: { file: "z.slp" } });
    s.capture(store.scoreboard(), store.tournament());
    const r = s.get("108404138");
    const side = r.games[0].replay.players.findIndex((l) => l[0]?.characterId === 18);
    assert.ok(s.editGame("108404138", 0, { op: "zelda-sheik", side, slot: 0 }).ok);
    const g = s.get("108404138").games[0];
    assert.strictEqual(g.replay.players[side][0].characterId, 19);
    assert.strictEqual(g.characters[side][0].codename, "sheik");

    assert.ok(s.editGame("108404138", 0, { op: "ports" }).ok);
    const p = s.get("108404138").games[0];
    assert.strictEqual(p.replay.players[1 - side][0].port, g.replay.players[side][0].port);
    assert.strictEqual(p.characters[1 - side][0].codename, "sheik");
    assert.strictEqual(p.winnerSide, g.winnerSide);
  });

  // ── Bundle and archive ─────────────────────────────────────────────────────

  await test("a file Slippi is still writing holds the bundle back (waiting, not broken)", () => {
    const store = loadedStore();
    playSet(store, { winners: [2, 2], files: [finishedSlp("w1.slp"), liveSlp("w2.slp")] });
    assert.strictEqual(isFinished(path.join(TMP, "w2.slp")), false);
    const b = buildBundle({ ...recordOf(store), meta: META });
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.waiting, true);
  });

  await test("a bundle is one folder: one context.json beside the games, with sizes and checksums", () => {
    const store = loadedStore();
    playSet(store, { winners: [2, 2], files: [finishedSlp("b1.slp"), finishedSlp("b2.slp")] });
    const b = buildBundle({ ...recordOf(store), meta: META });
    assert.ok(b.ok, b.error);
    const dirs = new Set(b.files.map((f) => path.posix.dirname(f.path)));
    assert.strictEqual(dirs.size, 1);
    assert.strictEqual(b.files.filter((f) => f.path.endsWith("/context.json")).length, 1);
    const g = b.files.find((f) => f.path.endsWith("b1.slp"));
    assert.strictEqual(g.sha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(TMP, "b1.slp"))).digest("hex"));
    // The archive is the same folder, and a corrected bundle replaces the old copy's games.
    const root = path.join(TMP, "archive");
    const a = archiveBundle(b, root, "tournament/hundred-acres-51");
    assert.ok(a.ok, a.error);
    assert.deepStrictEqual(fs.readdirSync(a.dir).sort(), ["b1.slp", "b2.slp", "context.json"]);
    const fewer = { ...b, files: b.files.filter((f) => !f.path.endsWith("b2.slp")) };
    archiveBundle(fewer, root, "tournament/hundred-acres-51");
    assert.deepStrictEqual(fs.readdirSync(a.dir).sort(), ["b1.slp", "context.json"]);
  });

  // ── The uploader, against a stand-in LuckyStats + storage ──────────────────

  /** A LuckyStats look-alike: approvals, signed PUTs, completion. */
  async function fakeLuckyStats(opts = {}) {
    const seen = { approvals: [], puts: [], completes: 0, headers: [] };
    const stored = new Map();
    const uploads = new Map(); // idempotency key → upload
    let putFailures = opts.putFailures ?? 0;
    const server = http.createServer((req, res) => {
      let body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        body = Buffer.concat(body);
        const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
        if (req.url.startsWith("/s3/")) {
          const key = decodeURIComponent(req.url.slice(4));
          seen.puts.push(key);
          if (putFailures > 0) { putFailures--; res.writeHead(500); return res.end("boom"); }
          const want = Buffer.from(req.headers["x-amz-checksum-sha256"] ?? "", "base64").toString("hex");
          const got = crypto.createHash("sha256").update(body).digest("hex");
          if (want !== got) { res.writeHead(400); return res.end("checksum"); }
          if (stored.has(key) && req.headers["if-none-match"] === "*") { res.writeHead(412); return res.end(); }
          stored.set(key, body);
          res.writeHead(200);
          return res.end();
        }
        seen.headers.push({ auth: req.headers.authorization, app: req.headers["x-app-id"] });
        const api = req.url.replace(/^\/api/, "");
        if (req.method === "POST" && api === "/uploads") {
          const idem = req.headers["idempotency-key"];
          if (!idem) return json(400, { error: "idempotency key required" });
          const b = JSON.parse(body);
          seen.approvals.push({ idem, body: b });
          if (opts.rateLimitOnce && seen.approvals.length === 1) {
            res.writeHead(429, { "Retry-After": "7", "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "rate_limited" }));
          }
          let u = uploads.get(idem);
          if (!u) {
            u = { uploadId: `up${uploads.size + 1}`, tournamentUploadId: "t1", setId: b.setId, revision: String(uploads.size + 1), status: "awaiting_upload", files: b.files };
            uploads.set(idem, u);
          }
          return json(200, {
            uploadId: u.uploadId, tournamentUploadId: u.tournamentUploadId, setId: u.setId, revision: u.revision, status: u.status,
            files: u.files.map((f) => ({
              path: f.path, method: "PUT", url: `http://127.0.0.1:${server.address().port}/s3/${encodeURIComponent(`${u.uploadId}/${f.path}`)}`,
              headers: { "Content-Type": f.path.endsWith(".json") ? "application/json" : "application/octet-stream",
                "Content-Length": String(f.size), "x-amz-checksum-sha256": Buffer.from(f.sha256, "hex").toString("base64"), "If-None-Match": "*" },
            })),
          });
        }
        const done = api.match(/^\/uploads\/(\w+)\/complete$/);
        if (req.method === "POST" && done) {
          const u = [...uploads.values()].find((x) => x.uploadId === done[1]);
          const missing = u.files.filter((f) => !stored.has(`${u.uploadId}/${f.path}`));
          if (missing.length) return json(409, { error: "files_missing" });
          u.status = "staged";
          seen.completes++;
          return json(200, { uploadId: u.uploadId, tournamentUploadId: "t1", setId: u.setId, revision: u.revision, status: "staged", handoffAccepted: true });
        }
        if (req.method === "GET" && api === "/tournaments/t1") return json(200, { status: "collecting", collectionVersion: 3, totalUploadedSets: 1 });
        if (req.method === "POST" && api === "/tournaments/t1/complete") {
          seen.finish = JSON.parse(body);
          return json(200, { status: "finishing" });
        }
        json(404, { error: "not_found" });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { server, seen, stored, base: `http://127.0.0.1:${server.address().port}/api` };
  }

  function uploadSetup(name, files, winners = files.map(() => 2)) {
    const s = new StreamSets(path.join(TMP, `${name}.json`));
    const store = loadedStore();
    playSet(store, { winners, files: files.map((f) => finishedSlp(`${name}-${f}`)) });
    s.capture(store.scoreboard(), store.tournament(), { reported: true });
    s.update("108404138", { meta: META });
    return s;
  }

  let clock = 1e12;
  const now = () => clock;
  const bundleFor = (r) => buildBundle(r, { requireMeta: true });

  await test("an upload is approved, every file goes to its signed link exactly, and the set is staged", async () => {
    const fake = await fakeLuckyStats();
    try {
      const s = uploadSetup("happy", ["g1.slp", "g2.slp"]);
      const up = new LuckyStatsUploads({ key: "l7u_test", sets: s, bundleFor, baseUrl: fake.base, now });
      assert.ok(up.enqueue("108404138").ok);
      await up.kick();
      const u = s.get("108404138").upload;
      assert.strictEqual(u.state, "staged", u.error);
      assert.strictEqual(fake.seen.approvals[0].body.tournament, "tournament/hundred-acres-51");
      assert.strictEqual(fake.seen.approvals[0].body.setId, "108404138");
      assert.strictEqual(fake.seen.puts.length, 3);
      assert.ok(fake.seen.headers.every((x) => x.auth === "Bearer l7u_test" && x.app === "replay-reporter"));
      const ctxKey = [...fake.stored.keys()].find((k) => k.endsWith("context.json"));
      assert.strictEqual(JSON.parse(fake.stored.get(ctxKey)).startgg.set.id, 108404138);
    } finally { fake.server.close(); }
  });

  await test("a failed transfer retries with the SAME idempotency key — one upload, not two", async () => {
    const fake = await fakeLuckyStats({ putFailures: 1 });
    try {
      const s = uploadSetup("retry", ["g1.slp", "g2.slp"]);
      const up = new LuckyStatsUploads({ key: "k", sets: s, bundleFor, baseUrl: fake.base, now });
      up.enqueue("108404138");
      await up.kick();
      assert.strictEqual(s.get("108404138").upload.state, "retry");
      clock += 60 * 60 * 1000;
      // A restart: a new uploader reading the same journal from disk.
      s.flush();
      const reread = new StreamSets(path.join(TMP, "retry.json"));
      const again = new LuckyStatsUploads({ key: "k", sets: reread, bundleFor, baseUrl: fake.base, now });
      await again.kick();
      assert.strictEqual(reread.get("108404138").upload.state, "staged", reread.get("108404138").upload.error);
      const keys = new Set(fake.seen.approvals.map((a) => a.idem));
      assert.strictEqual(keys.size, 1, "the retry reused the key");
      assert.strictEqual(fake.seen.completes, 1);
    } finally { fake.server.close(); }
  });

  await test("an unchanged set re-uploaded is the same upload; a corrected one is a new revision", async () => {
    const fake = await fakeLuckyStats();
    try {
      // Alpha, Alpha, Beta: 2–1.
      const s = uploadSetup("revise", ["g1.slp", "g2.slp", "g3.slp"], [2, 2, 0]);
      const up = new LuckyStatsUploads({ key: "k", sets: s, bundleFor, baseUrl: fake.base, now });
      up.enqueue("108404138"); await up.kick();
      up.enqueue("108404138"); await up.kick();
      assert.strictEqual(new Set(fake.seen.approvals.map((a) => a.idem)).size, 1);
      assert.ok(s.editGame("108404138", 2, { op: "remove" }).ok);
      up.enqueue("108404138"); await up.kick();
      assert.strictEqual(new Set(fake.seen.approvals.map((a) => a.idem)).size, 2);
      assert.strictEqual(s.get("108404138").upload.revision, "2");
    } finally { fake.server.close(); }
  });

  await test("a 429 waits for Retry-After", async () => {
    const fake = await fakeLuckyStats({ rateLimitOnce: true });
    try {
      const s = uploadSetup("limited", ["g1.slp", "g2.slp"]);
      const up = new LuckyStatsUploads({ key: "k", sets: s, bundleFor, baseUrl: fake.base, now });
      up.enqueue("108404138"); await up.kick();
      const u = s.get("108404138").upload;
      assert.strictEqual(u.state, "retry");
      assert.strictEqual(u.nextTryAt, clock + 7000);
    } finally { fake.server.close(); }
  });

  await test("Finish sends the collectionVersion LuckyStats just reported", async () => {
    const fake = await fakeLuckyStats();
    try {
      const s = uploadSetup("finish", ["g1.slp", "g2.slp"]);
      const up = new LuckyStatsUploads({ key: "k", sets: s, bundleFor, baseUrl: fake.base, now });
      up.enqueue("108404138"); await up.kick();
      const r = await up.collectionAction("complete");
      assert.ok(r.ok, r.error);
      assert.deepStrictEqual(fake.seen.finish, { collectionVersion: 3 });
    } finally { fake.server.close(); }
  });

  // ── Reported on start.gg instead (a TO's own report) ───────────────────────

  const { createReplays } = require("../app/lib/replays");
  let replaysNo = 0;

  /** The real replays module over a stand-in start.gg (results by turn) and uploader. */
  function replaysRig(results) {
    const store = loadedStore();
    const asked = [];
    const queued = [];
    const startgg = {
      getSetContext: async () => ({ ok: false, error: "offline" }),
      getSetResult: async (id) => { asked.push(String(id)); return results.shift() ?? { ok: false, error: "no more answers" }; },
    };
    const uploads = { enabled: true, enqueue: (id) => { queued.push(id); return { ok: true }; }, start() {}, currentCollection: () => null };
    const replays = createReplays({ config: {}, store, startgg, io: quiet }, { file: path.join(TMP, `auto-${++replaysNo}.json`), uploads });
    return { store, replays, asked, queued };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));
  // Alpha is entrant 24866248, Beta 24851427.
  const result = (state, alpha, beta, winnerId = alpha > beta ? "24866248" : "24851427") =>
    ({ ok: true, state, winnerId, scores: { 24866248: alpha, 24851427: beta } });

  await test("a set the TO reports on start.gg uploads once start.gg shows it completed with the same games", async () => {
    const r = replaysRig([result(2, null, null), result(3, 2, 0)]);
    playSet(r.store, { winners: [2, 2], files: ["a.slp", "b.slp"] });
    r.store.clearSet(); // the next set: this one closes, unreported
    await settle();
    assert.deepStrictEqual(r.queued, [], "still in progress on start.gg");
    assert.strictEqual(r.replays.sets.get("108404138").startgg.verdict, "waiting");
    r.replays.sets.update("108404138", (x) => ({ startgg: { ...x.startgg, nextCheckAt: 0 } })); // two minutes later
    r.replays.watchCompletion();
    await settle();
    assert.deepStrictEqual(r.queued, ["108404138"]);
  });

  await test("a start.gg score that differs from the replays never uploads by itself — until the games are fixed", async () => {
    const r = replaysRig([result(3, 2, 0)]);
    playSet(r.store, { winners: [2, 0, 2], files: ["a.slp", "b.slp", "c.slp"] }); // the app saw 2–1
    r.store.clearSet();
    await settle();
    assert.strictEqual(r.replays.sets.get("108404138").startgg.verdict, "mismatch");
    assert.deepStrictEqual(r.queued, []);
    // Game 2 was a handwarmer that counted: take it out, and the set agrees with start.gg.
    assert.ok(r.replays.editGame("108404138", 1, { op: "remove" }).ok);
    assert.deepStrictEqual(r.queued, ["108404138"]);
  });

  await test("a DQ on start.gg, or a set reported from the app, isn't watched", async () => {
    const dq = replaysRig([result(3, -1, 0, "24851427")]);
    playSet(dq.store, { winners: [2, 2], files: ["a.slp", "b.slp"] });
    dq.store.clearSet();
    await settle();
    assert.strictEqual(dq.replays.sets.get("108404138").startgg.verdict, "dq");
    assert.deepStrictEqual(dq.queued, []);

    const here = replaysRig([]);
    playSet(here.store, { winners: [2, 2], files: ["a.slp", "b.slp"] });
    here.replays.onSetReported();
    here.store.clearSet();
    await settle();
    here.replays.watchCompletion();
    await settle();
    assert.deepStrictEqual(here.asked, [], "a set reported here never asks start.gg");
    assert.deepStrictEqual(here.queued, ["108404138"], "queued once, by the report");
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  say(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
