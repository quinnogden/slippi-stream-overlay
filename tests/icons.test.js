/**
 * Every character Slippi can report has a stock icon, for every costume.
 *
 * A missing icon is a broken image on the scoreboard the first time someone
 * picks that character or colour on stream — the kind of failure nobody sees
 * until a Game & Watch main gets on stream (which is how the `game_&_watch`
 * spelling mismatch with TSH's files went unnoticed).
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const { CHAR_MAP } = require("../slippi-bridge/lib/char_map");

const DIR = path.join(__dirname, "..", "overlays", "assets", "icons");

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

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".png"));
const byCode = {};
for (const f of files) {
  const m = f.match(/^chara_2_(.+)_(\d\d)\.png$/);
  if (m) (byCode[m[1]] = byCode[m[1]] ?? []).push(Number(m[2]));
}

console.log("icons");

test("every char_map character has costumes 00..N with no gaps (Melee has 4-6 each)", () => {
  for (const { codename } of Object.values(CHAR_MAP)) {
    const skins = (byCode[codename] ?? []).sort((a, b) => a - b);
    assert.ok(skins.length >= 4 && skins.length <= 6, `${codename}: ${skins.length} costumes`);
    assert.deepStrictEqual(skins, skins.map((_, i) => i), `${codename}: costumes not contiguous from 00`);
  }
});

test("nothing in the folder that char_map can't name", () => {
  const known = new Set(Object.values(CHAR_MAP).map((c) => c.codename));
  const strays = files.filter((f) => !/^chara_2_(.+)_\d\d\.png$/.test(f) || !known.has(f.match(/^chara_2_(.+)_\d\d\.png$/)[1]));
  assert.deepStrictEqual(strays, []);
});

console.log(failed === 0 ? "icons: all passed" : `icons: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
