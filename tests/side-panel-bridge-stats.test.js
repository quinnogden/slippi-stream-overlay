/**
 * side-panel-bridge-stats.test.js
 *
 * The side panel's stats come from the bridge's `player_stats` when it is
 * running (slippi-bridge/lib/stats/), and from TSH's own state otherwise. Every
 * way this goes wrong renders a perfectly healthy-looking card with the wrong
 * numbers on it:
 *
 *   - **Orientation.** The bridge keys everything by start.gg player id; the
 *     panel places it by the ids TSH shows in each column *now*. Get that
 *     backwards, or cache it, and Swap Teams puts one player's record under the
 *     other's name.
 *   - **A snapshot for another pair.** Loading a set is several TSH pushes and
 *     the bridge answers seconds later, so a snapshot for the *previous* pair is
 *     routinely on hand while the new names are up. It must show nothing.
 *   - **No mixing.** While the bridge is live, TSH's head-to-head (the one that
 *     was wrong) must not fill in for a pair the bridge hasn't finished.
 *   - **Winner-only results.** A set reported without game counts must read
 *     W/L on the winner's side — TSH hands over "L"/"W" on the wrong sides.
 *   - **The stream queue** in TSH's real shape, minus the set that's on air.
 *
 * Usage: node tests/side-panel-bridge-stats.test.js
 */

const { loadLayout, fixture, clone } = require("./helpers/layout-sandbox");

const SB = "1";
const BASE = fixture("program-state");
const P1 = String(BASE.score[SB].team["1"].player["1"].id); // AVERY
const P2 = String(BASE.score[SB].team["2"].player["1"].id); // BLAKE

function texts(el, out = []) {
  if (!el) return out;
  if (el.textContent) out.push(el.textContent);
  (el.children || []).forEach((c) => texts(c, out));
  return out;
}

/** A snapshot as lib/stats/index.js emits it: AVERY leads BLAKE 22-8. */
function snapshot(over = {}) {
  return {
    enabled: true,
    event: null,
    players: {
      [P1]: { playerId: P1, state: "done", history: [{ tournament: "HA #50", event: "Melee Singles", placement: 1, entrants: 51 }], run: [] },
      [P2]: { playerId: P2, state: "done", history: [], run: [{ opponent: "CASEY", round: "Winners Final", myScore: 3, oppScore: 1, won: true }] },
    },
    h2h: {
      players: [P2, P1], // deliberately not in column order
      state: "done",
      wins: { [P1]: 22, [P2]: 8 },
      total: 30,
      recent: [
        { tournament: "HA #50", round: "Grand Final", completedAt: 1789701909, winner: P1, scores: { [P1]: 3, [P2]: 1 } },
        { tournament: "HA #37", round: "Winners Final", completedAt: 1781000000, winner: P2, scores: { [P1]: null, [P2]: null } },
      ],
    },
    completedSets: { state: "done", sets: [{ names: ["ZODD-01", "Redd"], scores: [3, 1], winner: 0, round: "Grand Final" }] },
    ...over,
  };
}

async function main() {
  const handlers = {};
  const env = await loadLayout({
    file: "TournamentStreamHelper-5.972/layout/side-panel/side-panel.js",
    ids: ["panel-player-1", "panel-player-2", "panel-recent-sets", "panel-queue", "panel-completed-sets"],
    selectors: [".logo-primary", ".logo-sponsor", ".tournament-name", ".clip-toast"],
    expose: ["h2hView", "hasRecentSets", "historyView", "completedView", "queueView", "rotator"],
    globals: { SlippiBridge: { connectBridge(h) { Object.assign(handlers, h); } } },
  }).ready();

  const { h2hView, hasRecentSets, historyView, completedView, queueView } = env.exposed;
  const failures = [];
  const check = (ok, msg) => { if (!ok) failures.push(msg); };
  // The stub DOM never clears children on innerHTML = "", so each render appends
  // to the last. Everything below reads only what the latest render added.
  const list = () => env.getEl("panel-recent-sets").querySelector(".sets-list");
  let mark = 0;
  const update = async (data) => { mark = (list().children || []).length; await env.sandbox.Update({ data }); };
  const rendered = () => (list().children || []).slice(mark);
  const h2hTexts = () => rendered().flatMap((c) => texts(c));
  const scoreLabelsOf = (pill) => (pill && pill.children || [])
    .filter((c) => String(c.className).includes("pill-score-val")).map((c) => c.textContent);
  const resultPills = () => rendered().filter((c) => String(c.className).includes("recent-set-pill"));

  check(typeof handlers.player_stats === "function" && typeof handlers.disconnect === "function",
    "the side panel doesn't subscribe to player_stats / disconnect");

  // ── Oriented by id, and re-oriented by a swap ─────────────────────────────
  handlers.player_stats(snapshot());
  await update(clone(BASE));
  let v = h2hView(BASE);
  check(v && v.wins[0] === 22 && v.wins[1] === 8, `columns read ${v && v.wins} — want 22,8 (AVERY left)`);
  check(h2hTexts().includes("22 – 8"), `rendered tally ${JSON.stringify(h2hTexts().filter((t) => /–/.test(t)))} — want "22 – 8"`);

  const swapped = clone(BASE);
  [swapped.score[SB].team["1"], swapped.score[SB].team["2"]] = [swapped.score[SB].team["2"], swapped.score[SB].team["1"]];
  await update(swapped);
  v = h2hView(swapped);
  check(v && v.wins[0] === 8 && v.wins[1] === 22, `after Swap Teams the columns read ${v && v.wins} — want 8,22`);
  check(h2hTexts().includes("8 – 22"), "after Swap Teams the rendered tally didn't follow the names");

  // TSH's real id shape is [playerId, userId].
  const arrayIds = clone(BASE);
  arrayIds.score[SB].team["1"].player["1"].id = [Number(P1), 4384];
  arrayIds.score[SB].team["2"].player["1"].id = [Number(P2), 0];
  v = h2hView(arrayIds);
  check(v && v.wins[0] === 22, "[playerId, userId] ids don't match the bridge's player ids");

  // ── Winner-only results read W/L on the winner's side ──────────────────────
  await update(clone(BASE));
  const labels = resultPills().map(scoreLabelsOf);
  check(JSON.stringify(labels[1]) === JSON.stringify(["L", "W"]),
    `a winner-only set BLAKE won rendered ${JSON.stringify(labels[1])} — want ["L","W"] (AVERY left)`);

  // ── Another pair's snapshot shows nothing, and TSH doesn't fill in ─────────
  handlers.player_stats(snapshot({ h2h: { ...snapshot().h2h, players: [P1, "424242"] } }));
  check(!hasRecentSets(BASE), "a snapshot for a different pair drew a head-to-head under these names");
  handlers.player_stats(snapshot({ h2h: { players: [P1, P2], state: "loading", wins: {}, total: 0, recent: [] } }));
  check(!hasRecentSets(BASE),
    "while the bridge is still loading, TSH's recent_sets filled in — the two sources must not mix");
  check(historyView(BASE, 1).length === 1 && historyView(BASE, 1)[0].tournament === "HA #50",
    "player history isn't coming from the bridge while it's live");
  check(completedView().length === 1, "just-finished sets aren't coming from the bridge while it's live");

  // ── Bridge gone: TSH's stats come back ─────────────────────────────────────
  handlers.disconnect();
  check(hasRecentSets(BASE), "after the bridge disconnected the panel didn't fall back to TSH's head-to-head");

  // TSH's winner-only rows can carry W/L on the wrong sides; the winner decides.
  const tshWL = clone(BASE);
  tshWL.score[SB].recent_sets.sets[0].score = ["L", "W"]; // winner is 0 in the fixture
  await update(tshWL);
  const firstLabels = scoreLabelsOf(resultPills()[0]);
  check(JSON.stringify(firstLabels) === JSON.stringify(["W", "L"]),
    `TSH's "L"/"W" on a set player 1 won rendered ${JSON.stringify(firstLabels)} — want ["W","L"]`);

  // ── Stream queue: TSH's real shape, on-air set excluded ────────────────────
  const q = clone(BASE);
  q.score[SB].set_id = "1"; // the queue's first set is the one on air
  const rows = queueView(q);
  check(rows.length === 2 && rows[0].names[0] === "ELLIS",
    `queue rows ${JSON.stringify(rows.map((r) => r.names))} — want the on-air set dropped, ELLIS first`);
  check(queueView(BASE)[0].names[1] === "TSM DREW", "the queue lost the sponsor prefix");

  console.log("side-panel bridge stats — oriented by id, never mixed, falls back cleanly");
  if (failures.length) {
    failures.forEach((f) => console.log("  FAIL  " + f));
    console.log(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("  ok    swap orientation, stale pair, no mixing, W/L, fallback, queue");
}

main().catch((e) => { console.error(e); process.exit(1); });
