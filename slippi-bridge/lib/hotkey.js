/**
 * Global hotkeys — the scoreboard's keys, reachable whichever window has focus
 * (OBS, Dolphin, a browser): swap the ports, switch sides, a game up or down
 * per side.
 *
 * The chords come from config.HOTKEYS, merged per action over DEFAULTS, so a
 * machine-local override can move one key without restating the rest; null
 * (or "") turns an action off.
 *
 * Three rules, each a way a global key goes wrong at a desk:
 *
 *   - **Modifiers match exactly.** Ctrl+Shift+Alt+1 is not also Ctrl+Shift+1,
 *     so "take a game away" can't also give one.
 *   - **A held key fires once.** Windows auto-repeats a held keydown with no
 *     keyup between; a score key held a beat too long must not add three games.
 *   - **No chord without Ctrl, Alt or Win.** The listener sees every keystroke
 *     on the machine and passes it through to the focused app — a bare key, or
 *     Shift+key, would fire whenever anyone typed that letter anywhere.
 *
 * uiohook-napi is a native module, so it is required lazily: on a machine
 * where it failed to build the app still starts, falling back to single
 * keypresses in its own terminal.
 */

const DEFAULTS = {
  swapPorts:   "Ctrl+Shift+S",
  switchSides: "Ctrl+Shift+X",
  leftPlus:    "Ctrl+Shift+1",
  rightPlus:   "Ctrl+Shift+2",
  leftMinus:   "Ctrl+Shift+Alt+1",
  rightMinus:  "Ctrl+Shift+Alt+2",
};

const LABELS = {
  swapPorts:   "Swap ports",
  switchSides: "Switch sides",
  leftPlus:    "Left +1",
  rightPlus:   "Right +1",
  leftMinus:   "Left −1",
  rightMinus:  "Right −1",
};

// The fallback when the global listener can't load: keys typed into the app's
// own terminal window. 1/2 add a game, q/w (under them) take one away.
const TERMINAL_KEYS = {
  s: "swapPorts", x: "switchSides",
  1: "leftPlus", 2: "rightPlus",
  q: "leftMinus", w: "rightMinus",
};

const MODIFIERS = {
  ctrl: "ctrl", control: "ctrl",
  shift: "shift",
  alt: "alt",
  meta: "meta", win: "meta", cmd: "meta", super: "meta",
};

const ALIASES = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", esc: "Escape" };

/**
 * "Ctrl+Shift+S" → { ctrl, shift, alt, meta, keycode, chord } against
 * uiohook's key table. Throws with a message fit for the startup log.
 * @param {string} text
 * @param {{ [name: string]: number }} keyTable — uiohook-napi's UiohookKey
 */
function parseChord(text, keyTable) {
  const parts = String(text).split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty chord");
  const mods = { ctrl: false, shift: false, alt: false, meta: false };
  const keyName = parts.pop();
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`"${p}" isn't a modifier (Ctrl, Shift, Alt, Win)`);
    mods[m] = true;
  }
  if (!mods.ctrl && !mods.alt && !mods.meta) {
    throw new Error("needs Ctrl, Alt or Win — a global key without one fires whenever anyone types it");
  }
  const want = (ALIASES[keyName.toLowerCase()] ?? keyName).toLowerCase();
  const name = Object.keys(keyTable).find((k) => k.toLowerCase() === want);
  if (!name) throw new Error(`unknown key "${keyName}"`);
  const chord = [mods.ctrl && "Ctrl", mods.shift && "Shift", mods.alt && "Alt", mods.meta && "Win", name]
    .filter(Boolean).join("+");
  return { ...mods, keycode: keyTable[name], chord };
}

/**
 * The bindings for a HOTKEYS config. A bad chord or a duplicate is reported
 * and that action left unbound, never thrown: a typo in config must not stop
 * the app at a venue.
 * @param {object|undefined} overrides — config.HOTKEYS
 * @param {object} keyTable
 * @returns {{ bindings: Array<{ action, label, chord, ctrl, shift, alt, meta, keycode }>, errors: string[] }}
 */
function compileHotkeys(overrides, keyTable) {
  const map = { ...DEFAULTS, ...(overrides ?? {}) };
  const bindings = [];
  const errors = [];
  for (const [action, text] of Object.entries(map)) {
    if (!LABELS[action]) { errors.push(`HOTKEYS.${action}: not an action (${Object.keys(LABELS).join(", ")})`); continue; }
    if (text == null || text === "") continue;
    let b;
    try {
      b = parseChord(text, keyTable);
    } catch (err) {
      errors.push(`HOTKEYS.${action} "${text}": ${err.message}`);
      continue;
    }
    const clash = bindings.find((x) => x.chord === b.chord);
    if (clash) { errors.push(`HOTKEYS.${action} "${text}": already ${clash.action}`); continue; }
    bindings.push({ action, label: LABELS[action], ...b });
  }
  return { bindings, errors };
}

/**
 * keydown/keyup handlers for uiohook events: exact modifiers, and one action
 * per press however long the key is held.
 * @param {Array} bindings — from compileHotkeys
 * @param {(action: string, binding: object) => void} onAction
 */
function createDispatcher(bindings, onAction) {
  const held = new Set();
  return {
    keydown(e) {
      if (held.has(e.keycode)) return; // auto-repeat
      held.add(e.keycode);
      const b = bindings.find((x) => x.keycode === e.keycode
        && x.ctrl === !!e.ctrlKey && x.shift === !!e.shiftKey && x.alt === !!e.altKey && x.meta === !!e.metaKey);
      if (b) onAction(b.action, b);
    },
    keyup(e) {
      held.delete(e.keycode);
    },
  };
}

/**
 * Install the listener.
 * @param {object|undefined} overrides — config.HOTKEYS
 * @param {{ [action: string]: () => void }} actions — one function per action name
 * @returns {{ mode: "global"|"terminal"|"none", bindings: Array, errors: string[] }}
 */
function installHotkeys(overrides, actions) {
  const run = (action) => {
    try {
      actions[action]?.();
    } catch (err) {
      console.warn(`[hotkey] ${action} failed: ${err.message}`);
    }
  };
  try {
    const { UiohookKey, uIOhook } = require("uiohook-napi");
    const { bindings, errors } = compileHotkeys(overrides, UiohookKey);
    const d = createDispatcher(bindings, (action) => run(action));
    uIOhook.on("keydown", d.keydown);
    uIOhook.on("keyup", d.keyup);
    uIOhook.start();
    return { mode: "global", bindings: bindings.map(publicBinding), errors };
  } catch {
    // uiohook-napi unavailable — fall back to terminal keypresses
    const bindings = Object.entries(TERMINAL_KEYS).map(([key, action]) => ({ action, label: LABELS[action], chord: key }));
    if (!process.stdin.isTTY) return { mode: "none", bindings: [], errors: [] };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      if (key === "\u0003") process.exit(); // Ctrl+C — raw mode swallows the default handler
      const action = TERMINAL_KEYS[key.toLowerCase()];
      if (action) run(action);
    });
    return { mode: "terminal", bindings, errors: [] };
  }
}

const publicBinding = ({ action, label, chord }) => ({ action, label, chord });

module.exports = { installHotkeys, compileHotkeys, createDispatcher, parseChord, DEFAULTS, LABELS, TERMINAL_KEYS };
