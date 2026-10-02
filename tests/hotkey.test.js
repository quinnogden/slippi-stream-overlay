/**
 * hotkey.test.js
 *
 * The global hotkeys (app/lib/hotkey.js). They act on the live
 * scoreboard from whatever window has focus, so a mistake here is a score
 * changing on stream with nobody at the dock having touched it:
 *
 *   - modifiers match exactly — "take a game away" (Ctrl+Shift+Alt+1) must not
 *     also fire "give a game" (Ctrl+Shift+1);
 *   - a held key fires once — Windows repeats keydown with no keyup between;
 *   - a chord with no Ctrl/Alt/Win is refused, since the listener sees every
 *     keystroke typed anywhere on the machine;
 *   - a bad or clashing config entry is reported and left unbound, never
 *     thrown (a typo must not stop the app at a venue);
 *   - config overrides merge per action over the defaults.
 *
 * Runs against a small fake of uiohook's key table, plus the real one when the
 * native module loads, so the defaults are known to parse.
 *
 * Usage: node tests/hotkey.test.js
 */

const assert = require("assert");

const { compileHotkeys, createDispatcher, parseChord, DEFAULTS } = require("../app/lib/hotkey");

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

// uiohook-napi's names, a few of its codes.
const KEYS = { 0: 11, 1: 2, 2: 3, Q: 16, S: 31, X: 45, F9: 67, ArrowUp: 57416, Escape: 1 };

/** A uiohook keyboard event. */
const ev = (keycode, mods = "") => ({
  keycode,
  ctrlKey: mods.includes("c"), shiftKey: mods.includes("s"), altKey: mods.includes("a"), metaKey: mods.includes("m"),
});

function rig(overrides) {
  const { bindings, errors } = compileHotkeys(overrides, KEYS);
  const fired = [];
  const d = createDispatcher(bindings, (action) => fired.push(action));
  return { bindings, errors, fired, d };
}

console.log("hotkey");

test("the defaults bind every action", () => {
  const { bindings, errors } = rig();
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(bindings.map((b) => b.action).sort(), Object.keys(DEFAULTS).sort());
  assert.strictEqual(bindings.find((b) => b.action === "swapPorts").chord, "Ctrl+Shift+S", "the swap stays where operators know it");
});

test("modifiers match exactly: Alt+ takes a game away without also giving one", () => {
  const { d, fired } = rig();
  d.keydown(ev(KEYS[1], "csa"));
  d.keyup(ev(KEYS[1]));
  assert.deepStrictEqual(fired, ["leftMinus"]);
  d.keydown(ev(KEYS[1], "cs"));
  d.keyup(ev(KEYS[1]));
  assert.deepStrictEqual(fired, ["leftMinus", "leftPlus"]);
  d.keydown(ev(KEYS[1], "c"));  // Ctrl+1 — a browser's first tab, not ours
  d.keyup(ev(KEYS[1]));
  d.keydown(ev(KEYS[1], "csm")); // an extra modifier is a different chord
  d.keyup(ev(KEYS[1]));
  d.keydown(ev(KEYS.S));        // the letter, typed
  assert.deepStrictEqual(fired, ["leftMinus", "leftPlus"]);
});

test("a held key fires once; the next press fires again", () => {
  const { d, fired } = rig();
  for (let n = 0; n < 5; n++) d.keydown(ev(KEYS[2], "cs")); // auto-repeat
  assert.deepStrictEqual(fired, ["rightPlus"]);
  d.keyup(ev(KEYS[2]));
  d.keydown(ev(KEYS[2], "cs"));
  assert.deepStrictEqual(fired, ["rightPlus", "rightPlus"]);
});

test("a chord with no Ctrl, Alt or Win is refused, and left unbound", () => {
  for (const chord of ["S", "Shift+S"]) {
    assert.throws(() => parseChord(chord, KEYS), /needs Ctrl, Alt or Win/);
  }
  const { bindings, errors, d, fired } = rig({ switchSides: "Shift+X" });
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /switchSides/);
  assert.ok(!bindings.some((b) => b.action === "switchSides"));
  d.keydown(ev(KEYS.X, "s"));
  assert.deepStrictEqual(fired, []);
});

test("overrides merge per action; null turns one off; bad entries are reported, not thrown", () => {
  const { bindings, errors } = rig({
    leftPlus: "ctrl+alt+up",    // case and the arrow alias
    rightMinus: null,
    rightPlus: "Ctrl+Shift+NoSuchKey",
    leftMinus: "Ctrl+Shift+S",  // already swapPorts
    bogus: "Ctrl+Q",
  });
  const by = Object.fromEntries(bindings.map((b) => [b.action, b.chord]));
  assert.strictEqual(by.leftPlus, "Ctrl+Alt+ArrowUp");
  assert.strictEqual(by.swapPorts, "Ctrl+Shift+S", "untouched actions keep their defaults");
  assert.ok(!("rightMinus" in by) && !("rightPlus" in by) && !("leftMinus" in by));
  assert.strictEqual(errors.length, 3, errors.join(" | "));
  assert.ok(errors.some((e) => /unknown key "NoSuchKey"/.test(e)));
  assert.ok(errors.some((e) => /already swapPorts/.test(e)));
  assert.ok(errors.some((e) => /bogus: not an action/.test(e)));
});

test("the defaults parse against uiohook-napi's real key table", () => {
  let real;
  try {
    real = require("../app/node_modules/uiohook-napi").UiohookKey;
  } catch {
    console.log("       (uiohook-napi didn't load here — skipped)");
    return;
  }
  const { bindings, errors } = compileHotkeys(undefined, real);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(bindings.length, Object.keys(DEFAULTS).length);
});

console.log(failed === 0 ? "hotkey: all passed" : `hotkey: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
