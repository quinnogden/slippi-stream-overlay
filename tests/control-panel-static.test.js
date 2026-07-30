/**
 * Every id the control panel's script looks up exists in its markup.
 *
 * render() runs on a 2s tick and has no try/catch, so a `$("id")` that returns
 * null throws, kills the handler, and freezes the whole dock — while the panel
 * still *looks* fine, showing stale values with no error visible to the
 * operator. That is exactly the "invisible until it's on stream" failure this
 * suite exists for, and the one most easily introduced by adding a card.
 *
 * Also asserts the CLIP_FIELDS ids are generated rather than hand-written,
 * since those are the ones a naive check would false-positive on.
 */

const assert = require("assert");
const fs   = require("fs");
const path = require("path");

const PANEL = path.join(__dirname, "..", "slippi-bridge", "public", "control-panel.html");
const html = fs.readFileSync(PANEL, "utf8");

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

console.log("control-panel-static");

/** Every id="..." present in the markup. */
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// The clipper's per-field ids are built as `"clip-" + f.key` on both the
// generating and the reading side, so they never appear as literals and need no
// allowlist here. Their invariant is checked separately below.
const CLIP_FIELD_KEYS = [...html.matchAll(/\bkey:\s*"([^"]+)"/g)].map((m) => m[1]);

// $("x") and document.getElementById("x") — literal lookups only. A
// concatenated or variable id can't be checked statically and is skipped.
const looked = new Set([
  ...[...html.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]),
  ...[...html.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
]);

test("the script looks up a plausible number of ids", () => {
  assert.ok(looked.size > 20, `only found ${looked.size} id lookups — did the regex stop matching?`);
});

test("every literal id lookup exists in the markup", () => {
  const missing = [...looked].filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, [], `these ids are read but never declared: ${missing.join(", ")}`);
});

// The clipper form exists so its ids can't drift from the JS that reads them.
// A field id hand-written into the markup would duplicate the generated one.
test("no CLIP_FIELDS id is also hand-written into the markup", () => {
  assert.ok(CLIP_FIELD_KEYS.length > 5, `only found ${CLIP_FIELD_KEYS.length} CLIP_FIELDS keys`);
  assert.ok(declared.has("clip-fields"), "the generated clipper form has no container");
  const duplicated = CLIP_FIELD_KEYS.filter((k) => declared.has("clip-" + k));
  assert.deepStrictEqual(duplicated, [],
    `these clipper fields are generated AND in the markup: ${duplicated.join(", ")}`);
});

test("every card carries a data-section key, and they are unique", () => {
  const cards    = [...html.matchAll(/class="card"\s+data-section="([^"]+)"/g)].map((m) => m[1]);
  const anyCards = [...html.matchAll(/<div class="card"/g)].length;
  assert.strictEqual(cards.length, anyCards,
    "a .card without data-section won't collapse or persist with the others");
  assert.strictEqual(new Set(cards).size, cards.length, `duplicate data-section keys: ${cards.join(", ")}`);
});

console.log(failed === 0 ? "control-panel-static: all passed" : `control-panel-static: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
