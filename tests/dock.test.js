/**
 * dock.test.js
 *
 * The dock (slippi-bridge/public/dock/) run headlessly against the real
 * store, the real overlay channel, and a real Express app built from
 * registerRoutes — so a key press goes through the actual route and store
 * command, and what the dock then shows is the actual state patch.
 *
 * What is pinned here is the operator's side of the failures that reach the
 * broadcast without anyone noticing at the desk:
 *
 *   - the live strip shows what's on stream, and its keys change it;
 *   - a name being typed survives a push arriving mid-word (the strip is
 *     redrawn on every patch — a score, a game start — and the old panel's
 *     2s repaint ate half-typed values);
 *   - the [L] toggle sends both sides, because JSON turns an omitted array
 *     entry into null and null clears the other side's override;
 *   - Report and a load over a set in progress ask first, and Cancel really
 *     cancels (the old confirm came back on the next redraw);
 *   - a malformed status never freezes the dock.
 *
 * Usage: node tests/dock.test.js
 */

const assert  = require("assert");
const path    = require("path");
const express = require("../slippi-bridge/node_modules/express");

const { ScoreboardStore } = require("../slippi-bridge/lib/scoreboard/store");
const { createOverlayChannel } = require("../slippi-bridge/lib/overlay/channel");
const { registerRoutes } = require("../slippi-bridge/lib/server/routes");
const { resolveOverlayPath } = require("../slippi-bridge/lib/server/overlays");
const { loadPayload, pickerList } = require("../slippi-bridge/lib/event/set-model");
const { buildBracket } = require("../slippi-bridge/lib/event/bracket-model");
const { CSS_ORDER, CHAR_MAP } = require("../slippi-bridge/lib/char_map");
const { eventFrom } = require("./helpers/fake-startgg");
const { loadOverlay, fakeIo, texts, sleep, fire } = require("./helpers/overlay-sandbox");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "slippi-bridge", "public");
const OVERLAYS = path.join(ROOT, "overlays");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 5).join("\n       ")}`);
  }
}

// ── Real material ─────────────────────────────────────────────────────────────

const finished = eventFrom("hundred-acres-49", "singles");
const graph = buildBracket(finished.sets, { phaseGroupId: finished.phaseGroup.id });
const setNamed = (name) => Object.values(graph.sets).find((s) => s.name === name).id;
const LOSERS_FINAL = loadPayload(graph, setNamed("Losers Final"));   // Player2 (seed 1) vs Player3, 3-1
const fresh = (payload) => ({ ...payload, sides: payload.sides.map((s) => ({ ...s, score: 0 })) });

// An unstarted event, for the picker: its round-1 sets are playable.
const preview = eventFrom("hundred-acres-51", "singles");
const pgraph = buildBracket(preview.sets, { phaseGroupId: preview.phaseGroup.id });

/** Wait until `cond()` holds (a request, a patch and a redraw take a few ms). */
async function until(cond, what, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

// ── A dock wired to an app ────────────────────────────────────────────────────

async function rig() {
  const store = new ScoreboardStore();
  const { io, nsps } = fakeIo();
  const channel = createOverlayChannel({ io, store });
  const calls = { report: 0, loadSet: [], swapPorts: 0 };

  // The event service's reads, over the preview graph.
  const event = {
    status: () => ({ state: "ok", error: null }),
    snapshot: () => ({ event: { name: "Melee Singles" } }),
    openSets: (opts) => pickerList(pgraph, opts).map((r) => ({ ...r, phaseGroupId: pgraph.phaseGroupId, phase: "" })),
    groups: () => [{ id: String(pgraph.phaseGroupId), label: "Bracket" }],
    refresh: async () => ({ ok: true }),
    loadSet: async (id) => {
      calls.loadSet.push(id);
      store.loadSet(loadPayload(pgraph, id));
      return { ok: true, setId: id };
    },
  };

  const app = express();
  app.use(express.json());
  registerRoutes(app, {
    publicDir: PUBLIC,
    iconsDir: path.join(OVERLAYS, "assets", "icons"),
    store,
    event,
    clipperSettings: { save: () => ({ ok: true }), get: () => ({}) },
    obs: { applySettings() {}, saveReplayBuffer: async () => ({ ok: false, error: "no OBS here" }) },
    refreshControlStatus: async () => ({}),
    clipperSnapshot: () => ({}),
    reportCurrentSet: async () => { calls.report++; return { ok: true, winnerName: "Player2", score: "2-0" }; },
    startCurrentSet: async () => ({ ok: true }),
    swapPorts: () => { calls.swapPorts++; return { ok: true }; },
    switchSides: () => store.switchSides(),
    reresolvePorts: () => ({ ok: false, error: "No game in progress" }),
    recordClip: () => null,
    playerStatsSnapshot: () => ({}),
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await loadOverlay({
    htmlFile: path.join(PUBLIC, "dock", "index.html"),
    resolve: (src) => (src.startsWith("/dock/")
      ? path.join(PUBLIC, "dock", src.slice("/dock/".length))
      : resolveOverlayPath(src, { overlaysDir: OVERLAYS })),
    nsps,
    fetch: (url, opts) => fetch(base + url, opts),
  });
  const Dock = page.window.Dock;
  const side = (i) => page.$(`#side-${i}`);
  const tagInput = (i) => side(i).querySelector(".tag");
  const scoreText = (i) => side(i).querySelector(".score").textContent;
  const keys = (i) => side(i).querySelectorAll(".score-box .key"); // [−, +]
  const button = (root, label) => root.querySelectorAll("button").find((b) => b.textContent === label);
  const status = (s) => channel.emit("control_status", s);

  return { store, channel, page, Dock, calls, side, tagInput, scoreText, keys, button, status, close: () => server.close() };
}

(async () => {
  console.log("dock");

  await test("the strip shows the set on the scoreboard and follows it", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      await until(() => r.tagInput(1).value === "Player3", "the right side's tag");
      assert.strictEqual(r.tagInput(0).value, "Player2");
      assert.strictEqual(r.side(0).querySelector(".prefix").value, "Team1");
      assert.strictEqual(r.page.$("#round").value, "Losers Final");
      assert.strictEqual(r.page.$("#best-of").querySelector("option").textContent, "Auto · Bo5",
        "a top-8 set (loser places 3rd) is Bo5 unless overridden");
      assert.deepStrictEqual([r.scoreText(0), r.scoreText(1)], ["0", "0"]);
      assert.match(texts(r.side(0).querySelector(".side-sub")).join(""), /Seed 1/);

      r.store.bump(1, 1);
      await until(() => r.scoreText(1) === "1", "the score follows a game recorded by Slippi");

      r.store.setCharacter(0, 0, { codename: "fox", name: "Fox", skin: 2 });
      await until(() => r.side(0).querySelector(".char img").src === "/assets/icons/chara_2_fox_02.png", "the live character's icon");
    } finally { r.close(); }
  });

  await test("+ and − change the score through the app, never below 0", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      await until(() => r.scoreText(1) === "0", "the set");
      assert.strictEqual(r.keys(1)[0].disabled, true, "− is off at 0");
      fire(r.keys(1)[1], "click");
      await until(() => r.store.scoreboard().sides[1].score === 1, "the store got the game");
      await until(() => r.scoreText(1) === "1", "the strip shows it");
      assert.strictEqual(r.store.scoreboard().games.length, 1, "+ is one game, not a typed score");
      fire(r.keys(1)[0], "click");
      await until(() => r.scoreText(1) === "0", "− takes it back");
    } finally { r.close(); }
  });

  await test("a name being typed survives a push arriving mid-word, then commits", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      await until(() => r.tagInput(0).value === "Player2", "the set");
      const tag = r.tagInput(0);
      tag.focus();
      tag.value = "Play";
      fire(tag, "input");

      r.store.bump(0, 1); // a game ends mid-word: the strip redraws
      await until(() => r.scoreText(0) === "1", "the push landed");
      assert.strictEqual(tag.value, "Play", "the half-typed name is still there");

      tag.value = "PlayerTwo";
      fire(tag, "input");
      fire(tag, "change");
      await until(() => r.store.scoreboard().sides[0].players[0].tag === "PlayerTwo", "the tag reached the scoreboard");
      tag.blur();
      assert.strictEqual(r.store.scoreboard().sides[0].entrantId, LOSERS_FINAL.sides[0].entrantId,
        "a corrected tag leaves the start.gg entrant alone");

      tag.focus();
      tag.value = "oops";
      fire(tag, "input");
      fire(tag, "keydown", { key: "Escape" });
      assert.strictEqual(tag.value, "PlayerTwo", "Escape puts the saved name back");
      fire(tag, "change");
      await sleep(30);
      assert.strictEqual(r.store.scoreboard().sides[0].players[0].tag, "PlayerTwo", "and sends nothing");
    } finally { r.close(); }
  });

  await test("the character picker: Melee's select screen, a tap sets, a hold opens costumes", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      await until(() => r.tagInput(0).value === "Player2", "the set");
      r.Dock.openPicker(0, 0);
      await until(() => r.page.$$("#picker-grid .tile").length === 26, "26 characters");
      const tiles = r.page.$$("#picker-grid .tile");
      assert.deepStrictEqual(tiles.map((t) => t.dataset.codename), CSS_ORDER.map((id) => CHAR_MAP[id].codename),
        "laid out in character-select order");
      assert.ok(r.page.$("#picker").classList.contains("open"));
      assert.match(r.page.$("#picker-who").textContent, /Team1 Player2 — Left/);

      const tileOf = (codename) => r.page.$$("#picker-grid .tile").find((t) => t.dataset.codename === codename);
      fire(tileOf("fox"), "click");
      await until(() => r.store.scoreboard().sides[0].players[0].character?.codename === "fox", "Fox on the scoreboard");
      const p = r.store.scoreboard().sides[0].players[0];
      assert.strictEqual(p.character.skin, 0);
      assert.deepStrictEqual(p.main, p.character, "recorded as the player's main, so the port map matches against it");
      await until(() => !r.page.$("#picker").classList.contains("open"), "the picker closes");

      r.Dock.openPicker(0, 0);
      fire(tileOf("marth"), "contextmenu");
      const costumes = r.page.$$("#picker-costumes .tile");
      assert.ok(costumes.length >= 5, `Marth's costumes are offered (got ${costumes.length})`);
      assert.ok(r.page.$("#picker").classList.contains("open"), "a hold doesn't set anything");
      fire(costumes[3], "click");
      await until(() => r.store.scoreboard().sides[0].players[0].character?.skin === 3, "Marth, costume 4");
      assert.strictEqual(r.store.scoreboard().sides[0].players[0].character.codename, "marth");

      r.Dock.openPicker(0, 0);
      fire(tileOf("marth"), "click");
      await sleep(30);
      assert.strictEqual(r.store.scoreboard().sides[0].players[0].character.skin, 3,
        "tapping the character already shown keeps its costume");

      r.Dock.openPicker(0, 0);
      fire(r.page.$("#picker-none"), "click");
      await until(() => r.store.scoreboard().sides[0].players[0].character === null, "no character");
    } finally { r.close(); }
  });

  await test("[L] on one side keeps the other side's override", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      r.store.setOverrides({ losers: [true, null] });
      await until(() => r.side(0).querySelector(".l-chip").classList.contains("on"), "left [L] lit");
      assert.ok(r.side(0).querySelector(".l-chip").classList.contains("pinned"), "and marked as set by hand");
      fire(r.side(1).querySelector(".l-chip"), "click");
      await until(() => r.store.scoreboard().sides[1].losers === true, "right [L] on");
      assert.deepStrictEqual(r.store.scoreboard().overrides.losers, [true, true], "the left override survived");

      fire(r.page.$("#btn-text-auto"), "click");
      await until(() => r.store.scoreboard().overrides.losers.every((l) => l === null), "Auto text clears them");
    } finally { r.close(); }
  });

  await test("Report asks first; Cancel cancels; confirming reports once", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      r.store.bump(0, 1);
      r.store.bump(0, 1);
      r.status({ currentSet: { canReport: false, reason: "Score is tied" } });
      await until(() => r.scoreText(0) === "2", "the score");
      assert.strictEqual(r.page.$("#btn-report").disabled, true, "off while the app says it can't report");

      r.status({ currentSet: { canReport: true } });
      await until(() => !r.page.$("#btn-report").disabled, "on once it can");
      fire(r.page.$("#btn-report"), "click");
      const ask = texts(r.page.$("#report-confirm")).join("");
      assert.match(ask, /Player2/);
      assert.match(ask, /2–0/);
      fire(r.button(r.page.$("#report-confirm"), "Cancel"), "click");
      assert.strictEqual(r.page.$("#report-confirm").children.length, 0, "the confirm is gone");
      await sleep(20);
      assert.strictEqual(r.calls.report, 0, "Cancel reported nothing");

      fire(r.page.$("#btn-report"), "click");
      fire(r.button(r.page.$("#report-confirm"), "Report it"), "click");
      await until(() => r.calls.report === 1, "one report");
      await sleep(20);
      assert.strictEqual(r.calls.report, 1);
    } finally { r.close(); }
  });

  await test("the picker: playable first, ON AIR follows the scoreboard, a load over games asks first", async () => {
    const r = await rig();
    try {
      await until(() => r.page.$$(".set-row").length > 0, "the open sets");
      const rows = () => r.page.$$(".set-row");
      assert.ok(rows()[0].classList.contains("playable"), "playable sets lead");

      const first = r.Dock.sets[0];
      fire(rows()[0], "click");
      await until(() => r.calls.loadSet.length === 1, "one tap loads an empty scoreboard");
      assert.strictEqual(r.calls.loadSet[0], first.setId);
      await until(() => rows()[0].classList.contains("air"), "the loaded set is marked on air");
      assert.strictEqual(rows()[0].disabled, true, "and can't be loaded again");

      r.store.bump(0, 1);
      await until(() => r.scoreText(0) === "1", "a game on it");
      fire(rows()[1], "click");
      assert.ok(r.page.$("#sets-list .confirm"), "loading over a game asks first");
      fire(r.button(r.page.$("#sets-list .confirm"), "Cancel"), "click");
      fire(r.page.$("#set-filter"), "input"); // any redraw
      // A boolean, never a node: a failing assert inspects its operands with
      // getters on, and a fake DOM node drags the whole document in — it hangs.
      assert.ok(!r.page.$("#sets-list .confirm"), "Cancel stays cancelled through a redraw");
      assert.strictEqual(r.calls.loadSet.length, 1);

      fire(rows()[1], "click");
      fire(r.button(r.page.$("#sets-list .confirm"), "Load anyway"), "click");
      await until(() => r.calls.loadSet.length === 2, "Load anyway loads");
      await until(() => rows()[1].classList.contains("air"), "and ON AIR moves");
    } finally { r.close(); }
  });

  await test("Sides, Ports and the bracket view keys reach the app", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      await until(() => r.tagInput(0).value === "Player2", "the set");
      fire(r.page.$("#btn-sides"), "click");
      await until(() => r.tagInput(0).value === "Player3", "the sides traded columns");
      fire(r.page.$("#btn-ports"), "click");
      await until(() => r.calls.swapPorts === 1, "ports swapped");

      const fullKey = r.page.$$("#bracket-views .key").find((k) => k.dataset.view === "full");
      fire(fullKey, "click");
      await until(() => r.store.view().bracketView === "full", "the bracket overlay's view");
      await until(() => fullKey.classList.contains("lit"), "the key lights from the patch");
    } finally { r.close(); }
  });

  await test("a malformed status, a dropped socket, a game: none freeze the dock", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      await until(() => r.tagInput(0).value === "Player2", "the set");
      const errors = [];
      const consoleError = r.page.window.console.error;
      r.page.window.console.error = (...a) => errors.push(String(a[0]));
      try {
        // Shapes the code tolerates, and one that makes a renderer throw.
        assert.doesNotThrow(() => {
          r.status(null);
          r.status({});
          r.status({ currentSet: null, portMapping: { ports: null }, clipper: { settings: null, recentClips: null } });
          r.status({ portMapping: { method: "character", ports: [null] } });
        }, "a throwing renderer stays inside the dock");
      } finally {
        r.page.window.console.error = consoleError;
      }
      assert.ok(errors.length > 0 && errors.every((e) => e.startsWith("[dock]")),
        `the throw was caught and logged by the dock's guard (${errors.join(" | ")})`);

      r.store.bump(1, 1);
      await until(() => r.scoreText(1) === "1", "still drawing");

      r.channel.emit("slippi_game_start", { players: {}, isDoubles: false });
      await until(() => r.page.$("#lamp").classList.contains("on"), "IN GAME lit");
      r.channel.emit("slippi_game_end", { winner: 1 });
      await until(() => !r.page.$("#lamp").classList.contains("on"), "and out");

      r.page.socket.receive("disconnect");
      assert.ok(r.page.document.body.classList.contains("offline"), "a lost app is said so");
      r.page.socket.receive("connect");
      assert.ok(!r.page.document.body.classList.contains("offline"));
    } finally { r.close(); }
  });

  console.log(failed === 0 ? "dock: all passed" : `dock: ${failed} failed`);
  // The dock's polls would keep Node alive.
  process.exit(failed === 0 ? 0 : 1);
})();
