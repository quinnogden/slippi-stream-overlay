/**
 * side-panel-rotation.test.js
 *
 * Guards the side panel's rotation against the logo-flash bug: loading a set or
 * pressing Swap Teams made the logo panel appear 3-5 times in a row before the
 * rotation settled.
 *
 * Why it happened, and why this test exists at all:
 *
 * Loading a set is not one TSH state push, it is six or more. ChangeSetData
 * clears the names, then last_sets.1, history_sets.1, last_sets.2,
 * history_sets.2 and recent_sets each land as a separate async provider reply
 * (TSHStatsUtil.py), and each is its own StateManager write, so each dispatches
 * its own tsh_update. Every push that flips a slot predicate changes the slot
 * list. buildSlots() used to restart the whole rotation on any such change, and
 * restart() rotates from the top where slot 0 is always logo-primary — so each
 * one was a fresh logo.
 *
 * The fix: restart only when the *visible* panel has actually dropped out of the
 * rotation. That case still must restart (a panel left mid-fade is stranded on
 * screen at partial opacity — see commit 9ccfd24), which is what the
 * `load-set-mid` scenario below pins down.
 *
 * Usage:
 *   node tests/side-panel-rotation.test.js            # all scenarios
 *   node tests/side-panel-rotation.test.js load-set   # one, verbose
 */

const { loadLayout, fixture, clone, sleep } = require("./helpers/layout-sandbox");

const SB = "1"; // SCOREBOARD_NUM in side-panel.js
const PUSH_GAP_MS = 30; // TSH writes state far faster than the 20s rotation

const PANEL_IDS = ["logo-primary", "player-1", "player-2",
                   "recent-sets", "logo-sponsor", "completed-sets", "queue"];

const BASE = fixture("program-state");
const sb = (s) => s.score[SB];

// ── Push sequences, built by mutating the fixture the way TSH mutates state ──

function loadSetPushes() {
  const pushes = [clone(BASE)]; // previous set, fully populated

  // ChangeSetData: names + scores cleared, stats wiped, new set id
  const cleared = clone(BASE);
  const c = sb(cleared);
  c.team["1"].player["1"].name = "";
  c.team["2"].player["1"].name = "";
  c.team["1"].score = 0;
  c.team["2"].score = 0;
  c.last_sets = { 1: {}, 2: {} };
  c.history_sets = { 1: {}, 2: {} };
  c.recent_sets = { state: "done", sets: [] };
  c.set_id = "900000002";
  pushes.push(cleared);

  // The new set's names land
  const named = clone(cleared);
  sb(named).team["1"].player["1"].name = "CASEY";
  sb(named).team["2"].player["1"].name = "DREW";
  pushes.push(named);

  // TSHStatsUtil.GetRecentSets: recent_sets -> loading
  const loading = clone(named);
  sb(loading).recent_sets = { state: "loading", sets: [] };
  pushes.push(loading);

  // Each stats reply is an independent write => an independent tsh_update
  const lastP1 = clone(loading);
  sb(lastP1).last_sets["1"] = clone(sb(BASE).last_sets["1"]);
  pushes.push(lastP1);

  const histP1 = clone(lastP1);
  sb(histP1).history_sets["1"] = clone(sb(BASE).history_sets["1"]);
  pushes.push(histP1);

  const lastP2 = clone(histP1);
  sb(lastP2).last_sets["2"] = clone(sb(BASE).last_sets["2"]);
  pushes.push(lastP2);

  const histP2 = clone(lastP2);
  sb(histP2).history_sets["2"] = clone(sb(BASE).history_sets["2"]);
  pushes.push(histP2);

  // TSHStatsUtil.UpdateRecentSets: recent_sets -> done, with results
  const recentDone = clone(histP2);
  sb(recentDone).recent_sets = clone(sb(BASE).recent_sets);
  pushes.push(recentDone);

  return pushes;
}

function swapSidesPushes() {
  const pushes = [clone(BASE)];

  // TSHScoreboardWidget.SwapTeams(): one batched write (BlockSaving), columns
  // exchanged. Stats follow the players across.
  const swapped = clone(BASE);
  const s = sb(swapped);
  [s.team["1"], s.team["2"]] = [s.team["2"], s.team["1"]];
  s.history_sets = { 1: s.history_sets["2"], 2: s.history_sets["1"] };
  s.last_sets = { 1: s.last_sets["2"], 2: s.last_sets["1"] };
  s.teamsSwapped = true;
  pushes.push(clone(swapped));

  // playerId_changed fires => stats refetch. recent_sets goes loading first,
  // which drops the recent-sets slot out of the list and back in again.
  const loading = clone(swapped);
  sb(loading).recent_sets = { state: "loading", sets: [] };
  pushes.push(loading);

  const lastP1 = clone(loading);
  sb(lastP1).last_sets["1"] = clone(sb(swapped).last_sets["1"]);
  pushes.push(lastP1);

  const histP1 = clone(lastP1);
  sb(histP1).history_sets["1"] = clone(sb(swapped).history_sets["1"]);
  pushes.push(histP1);

  const recentDone = clone(histP1);
  sb(recentDone).recent_sets = clone(sb(BASE).recent_sets);
  pushes.push(recentDone);

  return pushes;
}

// advance:  steps to take before the burst, so it can land while a data panel
//           (not the logo) is the visible one.
// maxLogo:  acceptable logo-primary appearances during the burst.
const SCENARIOS = {
  // Control: identical pushes must not disturb the rotation at all.
  "steady": {
    build: () => [clone(BASE), clone(BASE), clone(BASE)],
    advance: 0, maxLogo: 0,
  },
  "load-set":   { build: loadSetPushes,   advance: 0, maxLogo: 0 },
  "swap-sides": { build: swapSidesPushes, advance: 0, maxLogo: 0 },
  // Here the visible panel is player-1, which the set load empties out. It
  // cannot stay on screen, so exactly one fallback to the logo is correct —
  // and a restart *must* happen, or the card is stranded at partial opacity
  // under the next one (the bug commit 9ccfd24 fixed).
  "load-set-mid": {
    build: loadSetPushes, advance: 1, maxLogo: 1, expectRestart: true,
  },
};

// ── Runner ──────────────────────────────────────────────────────────────────

async function runScenario(name, verbose) {
  const spec = SCENARIOS[name];
  const pushes = spec.build();

  const transitions = []; // every panel actually faded in, in order
  const restarts = [];

  const env = await loadLayout({
    file: "TournamentStreamHelper-5.972/layout/side-panel/side-panel.js",
    ids: PANEL_IDS.filter((id) => !id.startsWith("logo-")).map((id) => "panel-" + id),
    selectors: [".logo-primary", ".logo-sponsor", ".tournament-name", ".clip-toast"],
    expose: ["rotator"],
  }).ready();

  const rotator = env.exposed.rotator;

  const origTransition = rotator._transitionTo.bind(rotator);
  rotator._transitionTo = (id, onDone) => {
    transitions.push({ id, slots: rotator._slots.join(",") });
    return origTransition(id, onDone);
  };
  const origRestart = rotator.restart.bind(rotator);
  rotator.restart = () => { restarts.push(1); return origRestart(); };

  // Boot into the settled state, exactly as it is on stream when the operator
  // loads the next set.
  await env.sandbox.Update({ data: pushes[0] });
  await env.sandbox.Start();
  await sleep(60);

  for (let i = 0; i < spec.advance; i++) {
    rotator._advance();
    await sleep(60);
  }

  if (transitions.length === 0) {
    throw new Error("no boot transition recorded — the test is not driving the rotator");
  }

  const settledSlots = rotator._slots.join(", ");
  const visible = rotator._current;
  const baseline = transitions.length;
  const baseRestarts = restarts.length;

  for (const push of pushes.slice(1)) {
    await env.sandbox.Update({ data: push });
    await sleep(PUSH_GAP_MS);
  }
  await sleep(200); // let queued timelines finish

  const during = transitions.slice(baseline);
  const logoShows = during.filter((t) => t.id === "logo-primary").length;
  const restartCount = restarts.length - baseRestarts;

  const failures = [];
  if (logoShows > spec.maxLogo) {
    failures.push(`logo-primary faded in ${logoShows}× during ${pushes.length - 1} state pushes ` +
                  `(max ${spec.maxLogo}) — this is the flash`);
  }
  if (spec.expectRestart && restartCount === 0) {
    failures.push("the visible panel left the slot list but the rotation never restarted — " +
                  "it would stay stranded on screen (regression of 9ccfd24)");
  }

  if (verbose) {
    console.log(`  settled slots:    ${settledSlots}`);
    console.log(`  visible at burst: ${visible}`);
    console.log(`  panels faded in during the burst (${during.length}):`);
    during.forEach((t, i) => console.log(`    ${i + 1}. ${t.id.padEnd(15)} slots: ${t.slots}`));
    console.log(`  restarts: ${restartCount}   logo-primary: ${logoShows} (max ${spec.maxLogo})`);
  }

  return { name, pushes: pushes.length - 1, logoShows, restartCount, failures };
}

(async () => {
  const only = process.argv[2];
  if (only && !SCENARIOS[only]) {
    console.error(`unknown scenario "${only}" — have: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
  const names = only ? [only] : Object.keys(SCENARIOS);

  console.log("side-panel rotation — no extra logo flashes on a burst of TSH state pushes");
  let failed = 0;

  for (const name of names) {
    // Each scenario needs its own rotator, and side-panel.js keeps module-level
    // state (tshData, completedSets), so every run gets a fresh sandbox.
    const r = await runScenario(name, Boolean(only));
    if (r.failures.length) {
      failed++;
      console.log(`  FAIL  ${name.padEnd(13)} ${r.failures.join("\n                      ")}`);
    } else {
      console.log(`  ok    ${name.padEnd(13)} ${r.pushes} pushes, ` +
                  `${r.logoShows} logo show(s), ${r.restartCount} restart(s)`);
    }
  }

  console.log(failed ? `\n${failed} scenario(s) failed.` : "\nRotation holds.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
