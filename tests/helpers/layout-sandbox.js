/**
 * layout-sandbox.js — run a real layout script headlessly.
 *
 * The layouts under `TournamentStreamHelper-5.972/layout/` are browser scripts
 * with no module boundary: they read the DOM, drive GSAP, and hang their logic
 * off TSH's `Start()` / `Update()` hooks inside a `LoadEverything().then()`
 * closure. That makes them untestable by `require()` and, historically,
 * untestable at all — which is how a rotation bug reached the broadcast.
 *
 * This loads one into a `vm` context with a fake DOM, a fake GSAP and stubs for
 * TSH's globals, so a test can drive `Update()` with real-shaped state and
 * assert on what the layout did.
 *
 * What it deliberately does NOT do: lay anything out. There is no geometry, no
 * cascade, no real animation. It answers "did the script do the right thing",
 * not "does it look right" — visual checks stay manual (see docs/TESTING.md).
 *
 * Usage:
 *
 *   const { loadLayout } = require("./helpers/layout-sandbox");
 *   const env = loadLayout({
 *     file: "TournamentStreamHelper-5.972/layout/side-panel/side-panel.js",
 *     selectors: [".logo-primary", ".tournament-name"],
 *     ids: ["panel-player-1", "panel-player-2"],
 *     expose: ["rotator"],
 *   });
 *   await env.ready();               // Start/Update exist after one microtask
 *   await env.sandbox.Update({ data: state });
 *   env.exposed.rotator._slots;
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * A DOM node stub.
 *
 * `querySelector` returns a memoised child stub rather than null, so the
 * layout's render functions actually run instead of throwing straight into
 * their catch blocks and hiding a real failure.
 */
function makeEl(name) {
  const kids = new Map();
  const el = {
    _name: name,
    style: {}, dataset: {}, children: [],
    textContent: "", innerHTML: "", src: "", className: "",
    scrollWidth: 100, clientWidth: 200,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {},
    querySelector(sel) {
      if (!kids.has(sel)) kids.set(sel, makeEl(name + " > " + sel));
      return kids.get(sel);
    },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 500, height: 200, top: 0, left: 0 }; },
    closest() { return null; },
    cloneNode() { return makeEl(name + "-clone"); },
  };
  // side-panel.js reads `histList.previousElementSibling` to find its header
  el.previousElementSibling = { style: {} };
  return el;
}

/**
 * GSAP stub. Timelines complete on a real timer rather than synchronously, so
 * ordering matches a browser — a transition that gets killed mid-flight must
 * not fire its onComplete, which is exactly the kind of bug worth catching.
 */
function makeGsap(tweenMs) {
  return {
    config() {},
    set() {}, killTweensOf() {},
    to() { return { kill() {} }; },
    fromTo() { return { kill() {} }; },
    timeline(opts = {}) {
      let killed = false;
      const tl = {
        to() { return tl; }, fromTo() { return tl; }, set() { return tl; },
        kill() { killed = true; },
      };
      if (opts.onComplete) {
        setTimeout(() => { if (!killed) opts.onComplete(); }, tweenMs);
      }
      return tl;
    },
  };
}

/**
 * @param {object}   opts
 * @param {string}   opts.file       layout script, relative to the repo root
 * @param {string[]} opts.ids        getElementById keys to pre-create
 * @param {string[]} opts.selectors  document.querySelector keys to pre-create
 * @param {string[]} opts.expose     top-level `const`/`let` names to publish.
 *                                   Lexical bindings never land on the sandbox
 *                                   global, so they are unreachable otherwise.
 * @param {object}   opts.globals    extra sandbox globals / stub overrides
 * @param {number}   opts.tweenMs    fake tween duration (default 5)
 */
function loadLayout(opts) {
  const { file, ids = [], selectors = [], expose = [], globals = {}, tweenMs = 5 } = opts;

  const elements = new Map();
  const getEl = (key) => {
    if (!elements.has(key)) elements.set(key, makeEl(key));
    return elements.get(key);
  };
  [...ids, ...selectors].forEach(getEl);

  const document = {
    body: makeEl("body"),
    head: { appendChild() {} },
    documentElement: makeEl("html"),
    getElementById: (id) => elements.get(id) || null,
    querySelector: (sel) => elements.get(sel) || null,
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ _text: t }),
    createDocumentFragment: () => makeEl("#fragment"),
    addEventListener() {},
    visibilityState: "visible",
  };

  const gsap = makeGsap(tweenMs);

  const sandbox = {
    document, gsap, console,
    location: { search: "" },
    URLSearchParams: class { constructor() {} get() { return null; } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: () => ({ fontSize: "20px" }),
    Date, Math, JSON, Number, String, Boolean, Array, Object, Set, Map, RegExp,
    Promise, Error, parseFloat, parseInt, isNaN,
    // Network is off by default: a layout must degrade, not depend on it.
    fetch: async () => ({ ok: false, json: async () => [], text: async () => "" }),
    // TSH + repo globals the layouts expect to already be on the page
    LoadEverything: () => Promise.resolve(),
    SlippiBridge: { connectBridge() {} },
    TshAssets: { charIconSrc: () => "icon.png", charIconFile: () => "icon.png" },
    Start: null, Update: null,
    ...globals,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  const publish = expose.map((n) => `;globalThis.__exposed.${n} = ${n};`).join("");
  sandbox.__exposed = {};
  vm.runInContext(src + "\n" + publish, sandbox, { filename: path.basename(file) });

  for (const name of expose) {
    if (sandbox.__exposed[name] === undefined) {
      throw new Error(`layout-sandbox: ${file} did not expose \`${name}\``);
    }
  }

  return {
    sandbox,
    document,
    gsap,
    elements,
    getEl,
    exposed: sandbox.__exposed,
    /** Start/Update are assigned inside LoadEverything().then() — wait for it. */
    async ready() {
      await sleep(20);
      if (typeof sandbox.Start !== "function" || typeof sandbox.Update !== "function") {
        throw new Error(`layout-sandbox: ${file} never assigned Start/Update — bootstrap threw?`);
      }
      return this;
    },
  };
}

/** Load a JSON fixture from tests/fixtures/. */
function fixture(name) {
  const file = path.join(__dirname, "..", "fixtures", name.endsWith(".json") ? name : name + ".json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { loadLayout, fixture, clone, sleep, makeEl, REPO_ROOT };
