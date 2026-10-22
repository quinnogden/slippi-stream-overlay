/**
 * Crew battles: the stocks, driven through the real game-mode handlers, store
 * and PortMap.
 *
 * Every way this goes wrong looks healthy on stream — a number in the score
 * box, a lit roster — while saying something untrue: a winner credited with a
 * stock they SD'd, a loser left in, a game applied to whoever was in the game
 * before, or a crew battle leaking into the normal flow (a game recorded, a
 * score cleared, a battle that outlives the set loaded over it). Pinned here:
 *
 *   - starting one replaces the set (it closes like any other), and the
 *     scoreboard shows each crew's stocks left, the crew's name, "Crew Battle";
 *   - at game end the winner keeps their last-frame stocks — never more than
 *     they carried in, never fewer than one — the loser is out and their side
 *     unpicked; nothing is applied (and the dock is told) with a side nobody
 *     was sent in for, or a handwarmer;
 *   - ± is one stock for the player in; the set's own commands do nothing;
 *     Switch Sides moves each crew with its column;
 *   - a live roster edit can't take off someone who has played;
 *   - the battle survives a restart, and a set load ends it;
 *   - saved crews round-trip, keyed by name in any case.
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createPersist } = require("../app/lib/scoreboard/persist");
const { PortMap } = require("../app/lib/ports/port-map");
const { createState } = require("../app/lib/state");
const { createModes } = require("../app/lib/modes");
const { stocksByPort } = require("../app/lib/game-source");
const { mainsPlayed } = require("../app/lib/players/mains-learning");
const { SavedCrews } = require("../app/lib/crew/saved-crews");
const { CHAR_MAP } = require("../app/lib/char_map");

const log = console.log.bind(console);
console.log = () => {};   // the modes' own logging; failures still print
console.warn = () => {};

let failed = 0;
function test(name, fn) {
  try {
    fn();
    log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-"));
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const id = (codename) => Number(Object.keys(CHAR_MAP).find((k) => CHAR_MAP[k].codename === codename));
const char = (codename, skin = 0) => ({ codename, name: CHAR_MAP[id(codename)].display, skin });
/** A slippi-js player entry. Port is 0-based, as slippi-js has it. */
const raw = (port, codename, skin = 0, teamId) => ({ playerIndex: port, characterId: id(codename), characterColor: skin, teamId });

function rig() {
  const emitted = [];
  const ctx = {
    store: new ScoreboardStore(),
    portMap: new PortMap(),
    state: createState(),
    io: { emit: (ev, data) => emitted.push([ev, data]) },
  };
  const modes = createModes(ctx);
  const notices = () => emitted.filter(([ev]) => ev === "crew_notice").map(([, n]) => n.text);
  return { ...ctx, modes, emitted, notices };
}

/** ACRES (Zodd on Fox, Redd on Falco) vs SALTY (Nav on Marth, Yung John on Sheik). */
const BATTLE = (stocksEach = 4) => ({
  stocksEach,
  teams: [
    { name: "ACRES", members: [{ tag: "Zodd", main: char("fox") }, { tag: "Redd", main: char("falco") }] },
    { name: "SALTY", members: [{ tag: "Nav", main: char("marth") }, { tag: "Yung John", main: char("sheik") }] },
  ],
});

const sbOf = (store) => store.scoreboard();
const scores = (store) => sbOf(store).sides.map((s) => s.score);
const member = (store, side, tag) => sbOf(store).crew.teams[side].members.find((m) => m.tag === tag);
const pick = (store, side, tag) => store.crewPick(side, member(store, side, tag).id);
const end = (modes, port, stocks, isHandwarmer = false) => modes.onGameEnd({ winnerPlayerIndex: port, isHandwarmer, stocks });

log("crew");

test("starting a crew battle replaces the set: it closes, and the scoreboard shows the crews", () => {
  const { store } = rig();
  store.loadSet({ setId: "1001", roundName: "Winners Final", sides: [{ players: [{ tag: "A" }] }, { players: [{ tag: "B" }] }] });
  store.recordGame({ winnerSide: 0 });
  const closing = [];
  const loaded = [];
  store.on("set-closing", (sb) => closing.push([sb.setId, sb.sides.map((s) => s.score)]));
  store.on("set-loaded", (x) => loaded.push(x));
  store.startCrew(BATTLE());

  assert.deepStrictEqual(closing, [["1001", [1, 0]]], "the outgoing set closed, with its score");
  assert.strictEqual(loaded.length, 1, "the port map starts over");
  const sb = sbOf(store);
  assert.strictEqual(sb.setId, null);
  assert.deepStrictEqual(sb.games, []);
  assert.deepStrictEqual(scores(store), [8, 8], "each crew's stocks left");
  assert.strictEqual(sb.round, "Crew Battle");
  assert.strictEqual(sb.bestOfLabel, "", "no best-of pill");
  // Nobody sent in: the crew's name alone, in the tag (the overlay hides a blank tag).
  assert.deepStrictEqual(sb.sides.map((s) => [s.players[0].prefix, s.players[0].tag]), [["", "ACRES"], ["", "SALTY"]]);
  assert.deepStrictEqual(sb.crew.active, [null, null], "nobody goes in by themselves");
});

test("sent in: the player's tag with the crew's name as the prefix, on their main until Slippi says", () => {
  const { store } = rig();
  store.startCrew(BATTLE());
  pick(store, 0, "Zodd");
  const p = sbOf(store).sides[0].players[0];
  assert.deepStrictEqual([p.prefix, p.tag, p.playerId], ["ACRES", "Zodd", null]);
  assert.strictEqual(p.character.codename, "fox");
  assert.strictEqual(member(store, 0, "Zodd").status, "active");
  assert.strictEqual(sbOf(store).sides[1].players[0].tag, "SALTY");
});

test("game end: the winner keeps their last-frame stocks, the loser is out and their side unpicked", () => {
  const { store, modes, emitted } = rig();
  store.startCrew(BATTLE());
  pick(store, 0, "Zodd");
  pick(store, 1, "Nav");
  modes.onGameStart([raw(0, "marth"), raw(3, "fox", 2)]);   // backwards ports, matched by the mains
  end(modes, 3, { 0: 0, 3: 2 });

  assert.deepStrictEqual(scores(store), [6, 4]);
  const zodd = member(store, 0, "Zodd");
  const nav = member(store, 1, "Nav");
  assert.deepStrictEqual([zodd.stocks, zodd.status, zodd.played], [2, "active", true], "the winner stays in");
  assert.deepStrictEqual([nav.stocks, nav.status, nav.played], [0, "out", true]);
  assert.deepStrictEqual(sbOf(store).crew.active, [zodd.id, null], "the loser's side waits for a pick");
  assert.deepStrictEqual(zodd.icon, char("fox", 2), "the roster shows what they played");
  assert.deepStrictEqual(sbOf(store).games, [], "no game recorded — a crew game moves stocks");
  assert.deepStrictEqual(emitted.filter(([ev]) => ev === "slippi_game_end").map(([, d]) => d.winner), [1]);
});

test("game end: never more stocks than carried in (a forgotten SD), never fewer than one", () => {
  const { store, modes } = rig();
  store.startCrew(BATTLE());
  pick(store, 0, "Zodd");
  pick(store, 1, "Nav");
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  end(modes, 0, { 0: 1, 1: 0 });               // Zodd stays in on 1
  pick(store, 1, "Yung John");
  modes.onGameStart([raw(0, "fox"), raw(1, "sheik")]);
  end(modes, 0, { 0: 3, 1: 0 });               // he didn't SD to match: the game says 3
  assert.strictEqual(member(store, 0, "Zodd").stocks, 1, "a forgotten SD gained a stock");
  assert.deepStrictEqual(scores(store), [5, 0]);
  assert.strictEqual(store.crewPick(1, member(store, 1, "Nav").id).ok, false, "an eliminated player was sent in");

  const b = rig();
  b.store.startCrew(BATTLE());
  pick(b.store, 0, "Zodd");
  pick(b.store, 1, "Nav");
  b.modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  end(b.modes, 0, { 0: 0, 1: 0 });             // a last frame that says the winner has none
  assert.strictEqual(member(b.store, 0, "Zodd").stocks, 1, "the winner went out");
  assert.strictEqual(member(b.store, 0, "Zodd").status, "active");
});

test("nothing is applied with a side nobody was sent in for — and the dock is told, at start and at end", () => {
  const { store, modes, notices } = rig();
  store.startCrew(BATTLE());
  pick(store, 0, "Zodd");
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  assert.match(notices()[0], /nobody sent in for SALTY/);
  end(modes, 0, { 0: 3, 1: 0 });
  assert.deepStrictEqual(scores(store), [8, 8], "stocks moved with nobody in on the right");
  assert.match(notices()[1], /No one sent in for SALTY — no stocks changed/);
});

test("a handwarmer applies nothing, and the dock is told", () => {
  const { store, modes, notices } = rig();
  store.startCrew(BATTLE());
  pick(store, 0, "Zodd");
  pick(store, 1, "Nav");
  modes.onGameStart([raw(0, "fox"), raw(1, "marth")]);
  end(modes, 0, { 0: 4, 1: 3 }, true);
  assert.deepStrictEqual(scores(store), [8, 8]);
  assert.strictEqual(member(store, 1, "Nav").status, "active", "the loser of a handwarmer went out");
  assert.match(notices().pop(), /Handwarmer/);
});

test("± is one stock for the player in; the last one takes them out; nobody in, nothing moves", () => {
  const { store } = rig();
  store.startCrew(BATTLE(2));
  store.bump(0, -1);
  assert.deepStrictEqual(scores(store), [4, 4], "a stock moved with nobody in");
  pick(store, 0, "Zodd");
  store.bump(0, 1);
  assert.strictEqual(member(store, 0, "Zodd").stocks, 2, "above stocks each");
  store.bump(0, -1);
  store.bump(0, -1);
  assert.deepStrictEqual([member(store, 0, "Zodd").stocks, member(store, 0, "Zodd").status], [0, "out"]);
  assert.strictEqual(sbOf(store).crew.active[0], null);
  assert.strictEqual(sbOf(store).sides[0].players[0].tag, "ACRES");
  store.crewStock(0, member(store, 0, "Zodd").id, 1);   // the Crew tab's + brings him back
  assert.strictEqual(member(store, 0, "Zodd").status, "in");
});

test("the set's own commands do nothing to a crew battle", () => {
  const { store, modes } = rig();
  store.startCrew(BATTLE());
  const before = JSON.stringify(sbOf(store));
  store.recordGame({ winnerSide: 0 });
  store.clearScore();
  store.setScore(1, 3);
  store.setPlayer(0, 0, { tag: "Typed" });
  store.setDoubles(true);
  assert.strictEqual(JSON.stringify(sbOf(store)), before);
  // A 4-player teams game is still a singles crew game.
  pick(store, 0, "Zodd");
  pick(store, 1, "Nav");
  modes.onGameStart([raw(0, "fox", 0, 0), raw(1, "marth", 0, 1), raw(2, "falco", 0, 0), raw(3, "sheik", 0, 1)]);
  assert.strictEqual(sbOf(store).isDoubles, false);
  assert.deepStrictEqual(mainsPlayed(sbOf(store)), [], "a crew battle teaches the player DB nothing");
});

test("Switch Sides moves each crew, its total and who's in with its column", () => {
  const { store } = rig();
  store.startCrew(BATTLE());
  pick(store, 0, "Zodd");
  store.bump(0, -1);
  store.switchSides();
  const sb = sbOf(store);
  assert.deepStrictEqual(sb.crew.teams.map((t) => t.name), ["SALTY", "ACRES"]);
  assert.deepStrictEqual(scores(store), [8, 7]);
  assert.deepStrictEqual(sb.sides.map((s) => s.players[0].tag), ["SALTY", "Zodd"]);
  store.bump(1, -1);                                     // the right key is Zodd's now
  assert.strictEqual(member(store, 1, "Zodd").stocks, 2);
});

test("a live roster edit: renamed, reordered, a member added — and someone who has played stays", () => {
  const { store } = rig();
  store.startCrew(BATTLE());
  const crew = () => sbOf(store).crew.teams[0];
  const body = () => crew().members.map(({ id: mid, tag, prefix, pronoun }) => ({ id: mid, tag, prefix, pronoun }));
  pick(store, 0, "Zodd");
  store.bump(0, -1);
  const [zodd, redd] = body();
  assert.ok(store.crewRoster(0, { name: "Acres", members: [redd, zodd, { tag: "Ploob" }] }).ok);
  assert.deepStrictEqual(crew().members.map((m) => [m.tag, m.stocks]), [["Redd", 4], ["Zodd", 3], ["Ploob", 4]]);
  assert.strictEqual(scores(store)[0], 11);
  assert.strictEqual(sbOf(store).sides[0].players[0].prefix, "Acres");
  const r = store.crewRoster(0, { name: "Acres", members: body().filter((m) => m.tag !== "Zodd") });
  assert.deepStrictEqual(r, { ok: false, error: "Zodd has played — they stay on the roster" });
  assert.ok(store.crewRoster(0, { name: "Acres", members: body().filter((m) => m.tag !== "Ploob") }).ok, "an untouched member can go");
  assert.strictEqual(store.crewRoster(0, { name: "Acres", members: [{ id: 999, tag: "Ghost" }] }).ok, false, "a stale id");
  assert.strictEqual(store.crewRoster(0, { name: "", members: body() }).ok, false, "no name");
});

test("the battle survives a restart, and loading a set ends it", () => {
  const { store } = rig();
  store.startCrew(BATTLE(3));
  pick(store, 0, "Zodd");
  pick(store, 1, "Nav");
  store.crewApplyGame({ winnerSide: 1, winnerStocks: 2, characters: [[char("fox")], [char("marth", 3)]] });
  const file = path.join(tmpDir, "live-state.json");
  assert.ok(createPersist(store, file).saveNow());

  const back = new ScoreboardStore();
  assert.ok(createPersist(back, file).restore());
  assert.deepStrictEqual(sbOf(back).crew, sbOf(store).crew);
  assert.deepStrictEqual(scores(back), [3, 5]);

  back.loadSet({ setId: "2002", roundName: "Losers Final", sides: [{ players: [{ tag: "C" }] }, { players: [{ tag: "D" }] }] });
  assert.strictEqual(sbOf(back).crew, null);
  assert.deepStrictEqual(scores(back), [0, 0]);
  assert.strictEqual(sbOf(back).round, "Losers Final");
});

test("the game end's stocks are read per port, null players (doubles' dead) skipped", () => {
  const frame = { players: { 0: { post: { stocksRemaining: 2 } }, 1: null, 2: { post: { stocksRemaining: 0 } }, 3: { post: {} } } };
  assert.deepStrictEqual(stocksByPort(frame), { 0: 2, 2: 0 });
  assert.deepStrictEqual(stocksByPort(null), {});
});

test("saved crews: one per name in any case, A–Z, typed fields only, and a bad file is moved aside", () => {
  const file = path.join(tmpDir, "crews.json");
  const saved = new SavedCrews(file);
  assert.deepStrictEqual(saved.list(), []);
  assert.deepStrictEqual(saved.save({ name: "Salty", members: [{ tag: "Nav", ref: 4 }] }), { ok: true, replaced: false });
  saved.save({ name: "acres", members: [{ tag: "Zodd", prefix: "HA", pronoun: "he/him", ref: 3 }] });
  assert.deepStrictEqual(saved.save({ name: "ACRES", members: [{ tag: "Zodd" }, { tag: "Redd" }] }), { ok: true, replaced: true });
  assert.deepStrictEqual(saved.list().map((c) => [c.name, c.members.length]), [["ACRES", 2], ["Salty", 1]]);
  assert.deepStrictEqual(saved.list()[1].members[0], { tag: "Nav", prefix: "", pronoun: "" });
  assert.strictEqual(saved.save({ name: "Empty", members: [] }).ok, false);
  assert.deepStrictEqual(new SavedCrews(file).list(), saved.list(), "read back from the file");
  assert.deepStrictEqual(saved.remove("salty"), { ok: true, removed: true });
  assert.deepStrictEqual(new SavedCrews(file).list().map((c) => c.name), ["ACRES"]);

  fs.writeFileSync(file, "{ not json");
  assert.deepStrictEqual(new SavedCrews(file).list(), []);
  assert.ok(fs.existsSync(`${file}.bad`), "the unreadable file was overwritten instead of kept");
});

log(failed === 0 ? "crew: all passed" : `crew: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
