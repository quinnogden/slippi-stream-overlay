/**
 * The pre-event check (app/scripts/preflight.js) runs, and its
 * checks of what's in the repo pass.
 *
 * preflight requires most of what it checks lazily, inside the check — it has
 * to run before `npm install` — so a module that moved or a renamed export
 * isn't a startup error anywhere: it surfaces as a FAIL ("could not check") the
 * night before an event, or as a crash that prints nothing useful. Running it
 * here, offline, catches both. The checks that depend on this machine (the
 * Slippi folder, the token, the player file) are left alone: they are allowed
 * to warn or fail on a dev box.
 */

const assert = require("assert");
const path   = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "app", "scripts", "preflight.js");

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

console.log("preflight");

const run = spawnSync(process.execPath, [SCRIPT, "--offline", "--json"], { encoding: "utf8", timeout: 30000 });
let report = null;
try { report = JSON.parse(run.stdout); } catch { /* asserted below */ }
const find = (label) => report?.results.filter((r) => r.label === label) ?? [];

test("runs to the end and reports JSON", () => {
  assert.ok(report, `no JSON on stdout (exit ${run.status})\n${(run.stderr || run.stdout || "").slice(0, 600)}`);
  assert.ok(Array.isArray(report.results) && report.results.length > 10, "too few results");
});

test("every lazy require resolves (nothing reads 'could not check' / 'could not load')", () => {
  const broken = (report?.results ?? []).filter((r) => /could not (check|load)|failed to load/.test(r.detail));
  assert.deepStrictEqual(broken.map((r) => `${r.label}: ${r.detail}`), []);
});

test("the repo's own files pass: theme pack, its logos, icons, overlay pages, hotkey defaults", () => {
  for (const label of ["config.js", "Theme pack", "Theme logos", "Character icons", "Overlay pages"]) {
    const hits = find(label);
    assert.ok(hits.length, `${label}: not checked`);
    for (const r of hits) assert.strictEqual(r.status, "PASS", `${label}: ${r.status} ${r.detail}`);
  }
  // SKIP only when uiohook-napi can't load on this machine.
  for (const r of find("Hotkeys")) assert.ok(["PASS", "SKIP"].includes(r.status), `Hotkeys: ${r.status} ${r.detail}`);
});

test("--offline touches nothing live", () => {
  const live = (report?.results ?? []).filter((r) => /\(live\)$/.test(r.section));
  assert.deepStrictEqual(live, []);
});

console.log(failed === 0 ? "preflight: all passed" : `preflight: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
