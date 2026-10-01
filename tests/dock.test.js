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
 *   - a malformed status never freezes the dock;
 *   - the casters are a draft until Put on stream, and a push doesn't undo it;
 *   - a player-list edit to someone on stream shows on stream; a pin lands in
 *     the DB through the same picker; a stale search can't edit someone else;
 *   - the Setup tab's urls are the full ones OBS needs, and the bound chords
 *     reach the strip's keys.
 *
 * Usage: node tests/dock.test.js
 */

const assert  = require("assert");
const fs      = require("fs");
const os      = require("os");
const path    = require("path");
const express = require("../slippi-bridge/node_modules/express");

const { ScoreboardStore } = require("../slippi-bridge/lib/scoreboard/store");
const { PlayerDb } = require("../slippi-bridge/lib/players/player-db");
const { createOverlayChannel } = require("../slippi-bridge/lib/overlay/channel");
const { registerRoutes } = require("../slippi-bridge/lib/server/routes");
const { resolveOverlayPath } = require("../slippi-bridge/lib/server/overlays");
const { loadPayload, pickerList } = require("../slippi-bridge/lib/event/set-model");
const { buildBracket } = require("../slippi-bridge/lib/event/bracket-model");
const { EventService } = require("../slippi-bridge/lib/event/event-service");
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

const PLAYER2_ID = LOSERS_FINAL.sides[0].players[0].playerId;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dock-"));
let dbNo = 0;

/** The player list: Player2 (on the Losers Final's left) and a caster. */
function playerDb() {
  const file = path.join(TMP, `players-${++dbNo}.json`);
  fs.writeFileSync(file, JSON.stringify([
    { prefix: "Team1", gamerTag: "Player2", name: "", pronoun: "", startggPlayerId: PLAYER2_ID,
      mains: { ssbm: [] }, learnedMains: [["Fox", 2], ["Falco", 0]] },
    { prefix: "", gamerTag: "Commentator", name: "", pronoun: "he/him", twitter: "@comms", mains: { ssbm: [] } },
    { prefix: "", gamerTag: "xPlayer", name: "", mains: { ssbm: [] } },
  ]));
  return new PlayerDb(file, { debounceMs: 60000 });
}

const SETUP = {
  base: "http://localhost:5001",
  lan: [{ url: "http://100.70.1.2:5001/dock", name: "Tailscale", tailscale: true }],
  hotkeys: {
    mode: "global",
    bindings: [
      { action: "swapPorts", label: "Swap ports", chord: "Ctrl+Shift+S" },
      { action: "leftPlus", label: "Left +1", chord: "Ctrl+Shift+1" },
    ],
    errors: ['HOTKEYS.switchSides "Shift+X": needs Ctrl, Alt or Win'],
  },
  players: { file: "C:/stream/local_players.json", count: 3 },
  slippiFolder: "C:/Slippi/Spectate",
  startgg: { token: false, shortLink: "100-acres" },
  theme: "hundred-acres",
};

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
  const calls = { report: 0, loadSet: [], swapPorts: 0, gameLive: false };

  // The event service's reads, over the preview graph.
  const event = {
    status: () => ({ state: "ok", error: null }),
    snapshot: () => ({ event: { name: "Melee Singles" } }),
    openSets: (opts) => pickerList(pgraph, opts).map((r) => ({ ...r, phaseGroupId: pgraph.phaseGroupId, phase: "" })),
    groups: () => [{ id: String(pgraph.phaseGroupId), label: "Bracket" }],
    // The real entrant list, over the preview graph.
    players: () => EventService.prototype.players.call({ _groups: [{ graph: pgraph }] }),
    refresh: async () => ({ ok: true }),
    loadSet: async (id) => {
      calls.loadSet.push(id);
      store.loadSet(loadPayload(pgraph, id));
      return { ok: true, setId: id };
    },
  };

  const db = playerDb();
  const app = express();
  app.use(express.json());
  registerRoutes(app, {
    publicDir: PUBLIC,
    iconsDir: path.join(OVERLAYS, "assets", "icons"),
    store,
    event,
    playerDb: db,
    setupInfo: () => SETUP,
    clipperSettings: { save: () => ({ ok: true }), get: () => ({}) },
    obs: { applySettings() {}, saveReplayBuffer: async () => ({ ok: false, error: "no OBS here" }) },
    refreshControlStatus: async () => ({}),
    clipperSnapshot: () => ({}),
    reportCurrentSet: async () => { calls.report++; return { ok: true, winnerName: "Player2", score: "2-0" }; },
    startCurrentSet: async () => ({ ok: true }),
    swapPorts: () => { calls.swapPorts++; return { ok: true }; },
    switchSides: () => store.switchSides(),
    reresolvePorts: () => ({ ok: false, error: "No game in progress" }),
    gameLive: () => calls.gameLive,
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

  return { store, db, base, channel, page, Dock, calls, side, tagInput, scoreText, keys, button, status, close: () => server.close() };
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

  await test("casters: a draft until Put on stream; a push doesn't undo it; the player list fills it in", async () => {
    const r = await rig();
    try {
      r.store.setCasters([{ tag: "Caster A" }]);
      const tagAt = (n) => r.page.$$("#casters-list .c-tag")[n];
      await until(() => tagAt(0) && tagAt(0).value === "Caster A", "the caster on stream");
      assert.strictEqual(r.page.$("#btn-casters-save").disabled, true, "nothing to put on stream yet");

      tagAt(0).focus();
      tagAt(0).value = "Caster B";
      fire(tagAt(0), "input");
      assert.strictEqual(r.page.$("#casters-stamp").textContent, "Not on stream yet");
      assert.strictEqual(r.store.casters()[0].tag, "Caster A", "typing reaches nothing");

      r.store.setCasters([{ tag: "Caster A", pronoun: "she/her" }]); // another dock, mid-word
      await until(() => r.Dock.casterDraft && r.page.$("#btn-casters-save").disabled === false, "still a draft");
      await sleep(20);
      assert.strictEqual(tagAt(0).value, "Caster B", "the push didn't undo the edit");
      tagAt(0).blur();

      fire(r.page.$("#btn-caster-add"), "click");
      await until(() => r.page.$$("#casters-list .c-tag").length === 2, "a second seat");
      tagAt(1).value = "commentator";
      fire(tagAt(1), "input");
      fire(tagAt(1), "change");
      await until(() => r.page.$$("#casters-list .c-pronoun")[1].value === "he/him", "filled from the player list");
      assert.strictEqual(tagAt(1).value, "Commentator", "with the list's spelling");

      fire(r.page.$("#btn-casters-save"), "click");
      await until(() => r.store.casters().length === 2, "on stream");
      assert.deepStrictEqual(r.store.casters().map((c) => [c.tag, c.pronoun, c.twitter]),
        [["Caster B", "", ""], ["Commentator", "he/him", "@comms"]]);
      await until(() => r.page.$("#btn-casters-save").disabled, "nothing left to send");

      fire(r.page.$$("#casters-list .c-ops .key")[2], "click"); // caster 2: up a seat
      assert.strictEqual(tagAt(0).value, "Commentator");
      fire(r.page.$("#btn-casters-revert"), "click");
      assert.strictEqual(tagAt(0).value, "Caster B", "Revert drops the draft");
      assert.strictEqual(r.store.casters()[0].tag, "Caster B");
    } finally { r.close(); }
  });

  // ── Autocomplete ──
  const menu = (r) => r.page.$("#ac-menu");
  const menuRows = (r) => (menu(r).classList.contains("open") ? menu(r).querySelectorAll(".ac-item") : []);
  const rowNamed = (r, text) => menuRows(r).find((b) => texts(b).join("").includes(text));
  const type = (input, text) => { input.value = text; fire(input, "input"); };
  const focusIn = (input) => { input.focus(); fire(input, "focus"); };

  await test("player autocomplete, no event: the player list; a pick puts the whole player in the slot", async () => {
    const r = await rig();
    try {
      r.store.clearSet();
      await until(() => r.tagInput(0), "the strip");
      const tag = r.tagInput(0);
      focusIn(tag);
      await until(() => menuRows(r).length === 3, "a click lists the player list");
      assert.deepStrictEqual(menuRows(r).map((b) => texts(b.querySelector(".ac-tag")).join("")), ["Commentator", "Player2", "xPlayer"],
        "no event: the whole player list, A–Z");

      type(tag, "play");
      await until(() => menuRows(r).length === 2, "two matches");
      assert.deepStrictEqual(menuRows(r).map((b) => texts(b).join(" ")), ["Team1 Player2", "xPlayer"],
        "tags starting with the text first, with their prefix");
      assert.strictEqual(texts(menu(r).querySelector(".ac-cap")).join(""), "Player list");

      fire(rowNamed(r, "Player2"), "click");
      await until(() => r.store.scoreboard().sides[0].players[0].tag === "Player2", "the pick reached the scoreboard");
      const p = r.store.scoreboard().sides[0].players[0];
      assert.strictEqual(p.prefix, "Team1");
      assert.strictEqual(p.playerId, PLAYER2_ID, "their start.gg id, for the side panel's stats");
      assert.strictEqual(`${p.main.codename}/${p.main.skin}`, "fox/2", "their learned main");
      assert.strictEqual(`${p.character.codename}/${p.character.skin}`, "fox/2", "shown, with no game running");
      assert.strictEqual(menuRows(r).length, 0, "the menu closed");
      assert.strictEqual(tag.value, "Player2");

      // Mid-game, Slippi's character is the true one: the pick sets only the main.
      r.store.setCharacter(1, 0, { codename: "marth", name: "Marth", skin: 0 });
      r.calls.gameLive = true;
      const right = r.tagInput(1);
      focusIn(right);
      type(right, "Player2");
      await until(() => menuRows(r).length === 1, "the exact match");
      assert.ok(menuRows(r)[0].classList.contains("on"), "an exact match starts highlighted");
      fire(right, "keydown", { key: "Enter" });
      await until(() => r.store.scoreboard().sides[1].players[0].prefix === "Team1", "Enter picked it");
      assert.strictEqual(r.store.scoreboard().sides[1].players[0].character.codename, "marth", "Slippi's character stays");
      assert.strictEqual(r.store.scoreboard().sides[1].players[0].main.codename, "fox");
    } finally { r.close(); }
  });

  await test("player autocomplete, event loaded: only its entrants, and a pick is the start.gg player", async () => {
    const r = await rig();
    try {
      const entrants = EventService.prototype.players.call({ _groups: [{ graph: pgraph }] });
      assert.ok(entrants.length > 4, "the preview event has entrants");
      const bySeed = [...entrants].sort((a, b) => a.seed - b.seed);
      r.store.clearSet();
      r.store.setTournament({ name: "100 Acres", eventName: "Melee Singles", eventSlug: "tournament/x/event/melee-singles", kind: "singles" });
      await until(() => r.tagInput(0), "the strip");
      const tag = r.tagInput(0);

      focusIn(tag);
      await until(() => menuRows(r).length === entrants.length, "every entrant, on focus");
      assert.strictEqual(texts(menu(r).querySelector(".ac-cap")).join(""), "Entered in this event");
      assert.ok(texts(menuRows(r)[0]).join(" ").includes(`Seed ${bySeed[0].seed}`), "top seed first");

      type(tag, "Comm");
      await sleep(200);
      assert.strictEqual(menuRows(r).length, 0, "the caster is in the player list but not the event: not offered");

      const pick = bySeed[2];
      type(tag, pick.tag);
      await until(() => rowNamed(r, pick.tag), "the entrant");
      fire(rowNamed(r, pick.tag), "click");
      await until(() => r.store.scoreboard().sides[0].players[0].tag === pick.tag, "the pick reached the scoreboard");
      assert.strictEqual(r.store.scoreboard().sides[0].players[0].playerId, pick.playerId);
      assert.ok(r.db.find({ playerId: pick.playerId }), "a new start.gg player is added to the list, as a set load does");
    } finally { r.close(); }
  });

  await test("autocomplete keys: Enter on a partial name commits the text; Escape only closes the menu", async () => {
    const r = await rig();
    try {
      r.store.clearSet();
      await until(() => r.tagInput(0), "the strip");
      const tag = r.tagInput(0);
      focusIn(tag);
      type(tag, "Play");
      await until(() => menuRows(r).length === 2, "suggestions");
      assert.ok(!menuRows(r).some((b) => b.classList.contains("on")), "nothing highlighted for a partial name");

      fire(tag, "keydown", { key: "Escape" });
      assert.strictEqual(menuRows(r).length, 0, "Escape closed the menu");
      assert.strictEqual(tag.value, "Play", "and kept the typing");

      fire(tag, "keydown", { key: "ArrowDown" });
      await until(() => menuRows(r).length === 2, "↓ reopens");
      fire(tag, "keydown", { key: "ArrowDown" });
      fire(tag, "keydown", { key: "ArrowDown" });
      assert.ok(menuRows(r)[1].classList.contains("on"), "↓ moves down the list");
      fire(tag, "keydown", { key: "Escape" });

      fire(tag, "keydown", { key: "Enter" });
      fire(tag, "change");
      await until(() => r.store.scoreboard().sides[0].players[0].tag === "Play", "the typed text");
      assert.strictEqual(r.store.scoreboard().sides[0].players[0].prefix, "", "no player filled in");
    } finally { r.close(); }
  });

  await test("round, prefix and pronoun suggestions", async () => {
    const r = await rig();
    try {
      const values = await (await fetch(r.base + "/api/players/values")).json();
      assert.deepStrictEqual(JSON.parse(JSON.stringify([values.prefixes, values.pronouns])), [["Team1"], ["he/him"]]);

      r.store.loadSet(fresh(LOSERS_FINAL));
      await until(() => r.Dock.sets.length > 0 && r.tagInput(0).value === "Player2", "the set and the picker");
      const round = r.page.$("#round");
      focusIn(round);
      await until(() => menuRows(r).length > 10, "the round list");
      const roundNames = new Set(r.Dock.sets.map((s) => s.roundName));
      const first = texts(menuRows(r)[0]).join("");
      assert.ok(roundNames.has(first), `the event's own round names first (got ${first})`);
      type(round, "money");
      await until(() => menuRows(r).length === 1, "narrowed");
      fire(menuRows(r)[0], "click");
      await until(() => r.store.scoreboard().round === "Money Match", "the round override");

      const prefix = r.side(1).querySelector(".prefix");
      focusIn(prefix);
      type(prefix, "te");
      await until(() => rowNamed(r, "Team1"), "the list's prefixes");
      fire(rowNamed(r, "Team1"), "click");
      await until(() => r.store.scoreboard().sides[1].players[0].prefix === "Team1", "the prefix");

      // Casters: a picked tag is that person — blanks included.
      r.store.setCasters([{ tag: "Old", prefix: "OldTeam", twitter: "@old" }]);
      const casterField = (k) => r.page.$(`#casters-list .c-${k}`);
      await until(() => casterField("tag") && casterField("tag").value === "Old", "the caster");
      focusIn(casterField("pronoun"));
      await until(() => menuRows(r).length > 0, "pronouns");
      assert.strictEqual(texts(menuRows(r)[0]).join(""), "he/him", "the common pronouns first");
      casterField("pronoun").blur();
      r.store.setTournament({ name: "100 Acres", eventName: "Melee Singles", eventSlug: "tournament/x/event/melee-singles", kind: "singles" });
      focusIn(casterField("tag"));
      await until(() => menuRows(r).length === 3, "a click lists the player list");
      assert.strictEqual(texts(menu(r).querySelector(".ac-cap")).join(""), "Player list",
        "casters aren't entrants: the player list even with an event loaded");
      type(casterField("tag"), "comm");
      await until(() => rowNamed(r, "Commentator"), "the player list");
      fire(rowNamed(r, "Commentator"), "click");
      assert.deepStrictEqual(["tag", "prefix", "pronoun", "twitter"].map((k) => casterField(k).value),
        ["Commentator", "", "he/him", "@comms"]);
      assert.strictEqual(r.store.casters()[0].tag, "Old", "still a draft");
    } finally { r.close(); }
  });

  await test("players: an edit to someone on stream shows on stream; a pin goes through the picker", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      r.Dock.showTab("players");
      const rows = () => r.page.$$("#players-list .pl-row");
      await until(() => rows().length === 1, "the scoreboard's player who's in the list");
      const row = () => rows()[0];
      assert.match(texts(row().querySelector(".pl-name")).join(" "), /Player2.*On stream/);
      assert.strictEqual(row().querySelector(".char img").src, "/assets/icons/chara_2_fox_02.png", "the learned main");
      assert.strictEqual(row().querySelectorAll(".pl-learned img").length, 2);

      fire(row().querySelector(".pl-name"), "click");
      const inputs = row().querySelectorAll(".pl-edit input"); // team, pronouns, twitter
      inputs[1].value = "she/her";
      fire(r.button(row(), "Save"), "click");
      await until(() => r.store.scoreboard().sides[0].players[0].pronoun === "she/her", "on stream at once");
      assert.strictEqual(r.db.find({ tag: "Player2" }).pronoun, "she/her", "and in the player list");
      await until(() => !row().querySelector(".pl-edit"), "the editor closes");

      fire(row().querySelector(".char"), "click");
      assert.strictEqual(r.page.$("#picker-title").textContent, "Pinned main");
      const marth = r.page.$$("#picker-grid .tile").find((t) => t.dataset.codename === "marth");
      fire(marth, "click");
      await until(() => r.db.find({ tag: "Player2" }).pinnedMain, "pinned in the DB");
      assert.deepStrictEqual(r.db.find({ tag: "Player2" }).pinnedMain, ["Marth", 0]);
      await until(() => !r.page.$("#picker").classList.contains("open"), "the picker closes");
      assert.ok(row().querySelector(".char").classList.contains("pinned"));
      assert.deepStrictEqual(r.store.scoreboard().sides[0].players[0].character, null,
        "pinning is for the next set — the one on stream keeps its character");

      r.page.$("#player-search").value = "play";
      fire(r.page.$("#player-search"), "input");
      await until(() => rows().length === 2, "a search");
      assert.deepStrictEqual(rows().map((x) => x.querySelector(".pl-tag").textContent), ["Player2", "xPlayer"],
        "tags starting with it, then containing it");

      // A ref from a search that no longer means that player.
      const stale = await fetch(`${r.base}/api/players/update`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: 1, tag: "Player2", pronoun: "x" }),
      });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(r.db.find({ tag: "Commentator" }).pronoun, "he/him");
    } finally { r.close(); }
  });

  await test("setup: full overlay urls, the bound hotkeys, and their chords on the strip's keys", async () => {
    const r = await rig();
    try {
      r.store.loadSet(fresh(LOSERS_FINAL));
      r.Dock.showTab("setup");
      await until(() => r.page.$$("#setup-overlays .u-url").length >= 6, "the overlays");
      assert.strictEqual(r.page.$$("#setup-overlays .u-url")[0].value, "http://localhost:5001/o/scoreboard");
      assert.strictEqual(r.page.$("#setup-theme").textContent, "Theme: hundred-acres");
      assert.deepStrictEqual(r.page.$$("#setup-hotkeys .hk-row").map((x) => texts(x).join("")),
        ["Swap portsCtrlShiftS", "Left +1CtrlShift1"]);
      assert.match(texts(r.page.$("#hotkeys-hint")).join(""), /Shift\+X.*needs Ctrl/, "a chord that didn't bind says why");
      assert.strictEqual(r.page.$$("#setup-lan .u-url")[0].value, "http://100.70.1.2:5001/dock");
      assert.match(texts(r.page.$("#setup-files")).join(" "), /No token/);

      await until(() => /\(Ctrl\+Shift\+S\)$/.test(r.page.$("#btn-ports").title), "the swap key names its chord");
      assert.match(r.keys(0)[1].title, /\(Ctrl\+Shift\+1\)$/);
      assert.doesNotMatch(r.keys(1)[1].title, /Ctrl/, "an unbound action names none");
    } finally { r.close(); }
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed === 0 ? "dock: all passed" : `dock: ${failed} failed`);
  // The dock's polls would keep Node alive.
  process.exit(failed === 0 ? 0 : 1);
})();
