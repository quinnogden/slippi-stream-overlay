/**
 * overlay-sandbox.js — run a real overlay page headlessly, fed by the real
 * overlay channel.
 *
 * Loads `overlays/<page>/index.html` into a small fake DOM (parsed from the
 * page's own markup, so a selector the script uses has to exist in the page),
 * runs the scripts the page lists — overlay-client.js included — in a `vm`,
 * and connects the page's socket to a channel built on fakeIo(). A test then
 * drives the store and the channel exactly as the app does and asserts on
 * what the page drew.
 *
 * What it does NOT do: lay anything out. There is no cascade and no geometry
 * (every element is 200px wide with 100px of content, so fitText never
 * shrinks). Animations finish on a timer, `timeScale` × their real length, so
 * their ordering is a browser's: a cancelled one never finishes. Events are
 * delivered to the element's own listeners only — nothing bubbles — and
 * fire(el, type) is how a test clicks or types. It answers "did the script do
 * the right thing", never "does it look right".
 *
 * The dock (app/public/dock/) runs here too: pass `htmlFile`, a
 * `resolve` for its /dock/ scripts, and a `fetch` that reaches the app.
 *
 *   const { io, nsps } = fakeIo();
 *   createOverlayChannel({ io, store });
 *   const page = await loadOverlay({ page: "side-panel", nsps });
 *   page.window.SidePanel.rotator;    // whatever the page exposes
 *   page.$(".tournament-name").textContent;
 */

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const { resolveOverlayPath } = require("../../app/lib/server/overlays");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OVERLAYS = path.join(REPO_ROOT, "overlays");
const SOCKET_IO = "/socket.io/socket.io.js";
const VOID = new Set(["meta", "link", "img", "br", "hr", "input", "source"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Socket.io, server side, as far as lib/overlay/channel.js uses it ──────────

function fakeIo() {
  const nsps = {};
  const io = {
    emitted: [],
    emit(event, payload) { io.emitted.push([event, payload]); },
    of(name) {
      if (!nsps[name]) {
        nsps[name] = {
          sockets: new Set(),
          handlers: {},
          on(event, fn) { this.handlers[event] = fn; },
          emit(event, payload) { for (const s of this.sockets) s.deliver(event, payload); },
        };
      }
      return nsps[name];
    },
  };
  return { io, nsps };
}

// ── A fake DOM ────────────────────────────────────────────────────────────────

function camel(attr) {
  return attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function makeStyle() {
  return {
    setProperty(k, v) { this[k] = String(v); },
    removeProperty(k) { delete this[k]; },
    getPropertyValue(k) { return this[k] ?? ""; },
  };
}

/** An event as a page's listener sees one. */
function makeEvent(type, props = {}) {
  return {
    type, defaultPrevented: false, target: null, currentTarget: null,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...props,
  };
}

/** Deliver an event to an element's listeners (click, input, change, contextmenu…). */
function fire(el, type, props = {}) {
  if (type === "click" && el.disabled) return false;
  return el.dispatchEvent(makeEvent(type, props));
}

function textNode(text) {
  return { nodeType: 3, parentNode: null, _text: String(text), get textContent() { return this._text; }, set textContent(v) { this._text = String(v); } };
}

function makeEl(doc, tag, ns = null) {
  let classes = [];
  const el = {
    nodeType: 1,
    ownerDocument: doc,
    namespaceURI: ns,
    tagName: tag.toUpperCase(),
    localName: tag.toLowerCase(),
    attrs: {},
    children: [],      // every child node, text included
    parentNode: null,
    style: makeStyle(),
    dataset: {},
    _anims: [],
    _listeners: {},
    clientWidth: 200,
    scrollWidth: 100,
    clientHeight: 100,

    get className() { return classes.join(" "); },
    set className(v) { classes = String(v ?? "").split(/\s+/).filter(Boolean); },
    classList: {
      add: (...c) => { for (const x of c) if (!classes.includes(x)) classes.push(x); },
      remove: (...c) => { classes = classes.filter((x) => !c.includes(x)); },
      toggle: (c, on) => {
        const want = on === undefined ? !classes.includes(c) : Boolean(on);
        if (want) el.classList.add(c); else el.classList.remove(c);
        return want;
      },
      contains: (c) => classes.includes(c),
    },
    get id() { return el.attrs.id ?? ""; },
    set id(v) { el.attrs.id = String(v); },
    get parentElement() { return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null; },
    get elementChildren() { return el.children.filter((c) => c.nodeType === 1); },
    get previousElementSibling() {
      const sibs = el.parentNode ? el.parentNode.elementChildren : [];
      return sibs[sibs.indexOf(el) - 1] ?? null;
    },
    get textContent() { return el.children.map((c) => c.textContent).join(""); },
    set textContent(v) { el.replaceChildren(); if (v !== "" && v != null) el.appendChild(textNode(v)); },
    set innerHTML(v) { if (v === "") el.replaceChildren(); else throw new Error("overlay-sandbox: innerHTML with markup isn't supported"); },
    set src(v) { el.attrs.src = String(v); },
    get src() { return el.attrs.src ?? ""; },

    setAttribute(k, v) {
      if (k === "class") el.className = v;
      else if (k.startsWith("data-")) el.dataset[camel(k)] = String(v);
      else el.attrs[k] = String(v);
    },
    getAttribute(k) {
      if (k === "class") return el.className || null;
      if (k.startsWith("data-")) return el.dataset[camel(k)] ?? null;
      return el.attrs[k] ?? null;
    },
    hasAttribute(k) { return el.getAttribute(k) !== null; },

    appendChild(c) {
      if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    append(...cs) { for (const c of cs) el.appendChild(typeof c === "string" ? textNode(c) : c); },
    replaceChildren(...cs) {
      for (const c of el.children) c.parentNode = null;
      el.children = [];
      el.append(...cs);
    },
    remove() { if (el.parentNode) { el.parentNode.children.splice(el.parentNode.children.indexOf(el), 1); el.parentNode = null; } },

    querySelector(sel) { return el.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.elementChildren) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    closest(sel) {
      for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n;
      return null;
    },

    animate(keyframes, opts) {
      const total = typeof opts === "number" ? opts : (opts?.duration ?? 0) + (opts?.delay ?? 0);
      let resolve;
      let reject;
      const finished = new Promise((res, rej) => { resolve = res; reject = rej; });
      finished.catch(() => {});
      const anim = {
        keyframes, opts, playState: "running", finished, onfinish: null,
        cancel() {
          if (anim.playState !== "running") return;
          anim.playState = "idle";
          clearTimeout(timer);
          el._anims.splice(el._anims.indexOf(anim), 1);
          reject(Object.assign(new Error("The animation was cancelled"), { name: "AbortError" }));
        },
      };
      const timer = setTimeout(() => {
        if (anim.playState !== "running") return;
        anim.playState = "finished";
        el._anims.splice(el._anims.indexOf(anim), 1);
        resolve(anim);
        if (anim.onfinish) anim.onfinish();
      }, Math.max(1, total * doc._timeScale));
      el._anims.push(anim);
      doc._animations.push({ el, anim });
      return anim;
    },
    getAnimations() { return [...el._anims]; },

    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = el._listeners[type] || [];
      if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
    },
    dispatchEvent(ev) {
      if (!ev.target) ev.target = el;
      ev.currentTarget = el;
      for (const fn of [...(el._listeners[ev.type] || [])]) fn.call(el, ev);
      return !ev.defaultPrevented;
    },
    click() { fire(el, "click"); },
    focus() { doc.activeElement = el; },
    blur() {
      if (doc.activeElement !== el) return;
      doc.activeElement = null;
      fire(el, "blur");
    },
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }; },
  };
  // A form control starts empty, as in a browser (not undefined).
  if (["input", "select", "textarea"].includes(el.localName)) {
    el.value = "";
    el.checked = false;
    el.disabled = false;
  }
  // No 2D context — a browser may answer null too, and a page must cope.
  if (el.localName === "canvas") el.getContext = () => null;
  return el;
}

/** One compound selector (`div.a.b#c`, `[data-x]`, `[data-x="1"]`) against one element. */
const SIMPLE = /[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\]/g;
function matchesCompound(el, compound) {
  const m = /^([a-z0-9-]*|\*)((?:[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(compound);
  if (!m) throw new Error(`overlay-sandbox: unsupported selector "${compound}"`);
  if (m[1] && m[1] !== "*" && el.localName !== m[1].toLowerCase()) return false;
  for (const part of m[2].match(SIMPLE) ?? []) {
    if (part[0] === "#" && el.id !== part.slice(1)) return false;
    if (part[0] === "." && !el.classList.contains(part.slice(1))) return false;
    if (part[0] === "[") {
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (!el.hasAttribute(name)) return false;
      if (value !== undefined && el.getAttribute(name) !== value) return false;
    }
  }
  return true;
}

/** Descendant combinators only — all the overlays use. */
function matches(el, selector) {
  return selector.split(",").some((sel) => {
    const parts = sel.trim().split(/\s+/);
    if (!matchesCompound(el, parts[parts.length - 1])) return false;
    let n = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (n && n.nodeType === 1 && !matchesCompound(n, parts[i])) n = n.parentNode;
      if (!n || n.nodeType !== 1) return false;
      n = n.parentNode;
    }
    return true;
  });
}

/** The page's markup into the fake DOM. Well-formed pages only — ours are. */
function parseInto(doc, html) {
  const root = doc.documentElement;
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toLowerCase();
      while (stack.length > 1 && stack.pop().localName !== tag) { /* unwind */ }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (tag === "html") { stack.push(root); continue; }
      const el = makeEl(doc, tag);
      for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] ?? "");
      top.appendChild(el);
      if (!VOID.has(tag) && !m[4]) stack.push(el);
    } else if (m[5] && m[5].trim()) {
      top.appendChild(textNode(m[5]));
    }
  }
}

// ── A page ────────────────────────────────────────────────────────────────────

/**
 * @param {object}  opts
 * @param {string}  opts.page        folder under overlays/, e.g. "side-panel"
 * @param {object}  [opts.nsps]      fakeIo()'s namespaces, with a channel built on them;
 *                                   without, the page has no socket.io (as with highlights)
 * @param {string}  [opts.search]    the source url's query, e.g. "?view=top8"
 * @param {number}  [opts.timeScale] animation time multiplier (default 0.01)
 */
async function loadOverlay({
  page, nsps = null, search = "", timeScale = 0.01,
  htmlFile = path.join(OVERLAYS, page, "index.html"),
  resolve = (src) => resolveOverlayPath(src, { overlaysDir: OVERLAYS }),
  fetch = null,
}) {
  const html = fs.readFileSync(htmlFile, "utf8");

  const doc = { _timeScale: timeScale, _animations: [], activeElement: null };
  doc.documentElement = makeEl(doc, "html");
  parseInto(doc, html);
  const find = (sel) => doc.documentElement.querySelector(sel);
  Object.assign(doc, {
    get head() { return find("head"); },
    get body() { return find("body"); },
    createElement: (t) => makeEl(doc, t),
    createElementNS: (ns, t) => makeEl(doc, t, ns),
    createTextNode: (t) => textNode(t),
    getElementById: (id) => doc.documentElement.querySelectorAll(`#${id}`)[0] ?? null,
    querySelector: (s) => doc.documentElement.querySelector(s),
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
    addEventListener() {},
    fonts: { status: "loaded", ready: Promise.resolve(), addEventListener() {} },
    visibilityState: "visible",
  });

  // The page's side of Socket.io.
  const client = { socket: null, sent: [] };
  function io(ns) {
    const handlers = {};
    const any = [];
    const serverHandlers = {};
    const socket = {
      connected: false,
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
      onAny(fn) { any.push(fn); },
      emit(ev, payload) {
        client.sent.push([ev, payload]);
        (serverHandlers[ev] || []).forEach((fn) => fn(payload));
      },
      receive(ev, payload) {
        const msg = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)); // over the wire
        (handlers[ev] || []).forEach((fn) => fn(msg));
        any.forEach((fn) => fn(ev, msg));
      },
    };
    // What the channel sees on its side.
    const server = {
      on(ev, fn) { (serverHandlers[ev] = serverHandlers[ev] || []).push(fn); },
      emit(ev, payload) { socket.receive(ev, payload); },
      deliver(ev, payload) { socket.receive(ev, payload); },
    };
    socket.connect = () => {
      const nsp = nsps?.[ns];
      if (!nsp) throw new Error(`overlay-sandbox: no channel namespace ${ns} — build the channel on fakeIo() first`);
      nsp.sockets.add(server);
      socket.connected = true;
      socket.receive("connect");
      nsp.handlers.connection(server);
    };
    client.socket = socket;
    return socket;
  }

  const storage = new Map();
  const sandbox = {
    document: doc,
    fetch: fetch ?? (() => Promise.reject(new Error("overlay-sandbox: this page was given no fetch"))),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    // The client's "[tag] connected" chatter off; warnings and errors kept.
    console: { ...console, log() {}, info() {} },
    // reload() counts: a theme switch reloads a source rather than restyling it.
    location: { search, reloads: 0, reload() { this.reloads++; } },
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    getComputedStyle: (el) => ({
      opacity: el.style.opacity || "1",
      transform: el.style.transform || "none",
      fontSize: el.style.fontSize || "20px",
      paddingLeft: "0px",
      paddingRight: "0px",
      getPropertyValue: (k) => el.style[k] ?? "",
    }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  for (const src of scripts) {
    if (src === SOCKET_IO) {
      if (nsps) sandbox.io = io;
      continue;
    }
    const file = resolve(src);
    if (!file) throw new Error(`overlay-sandbox: ${page ?? htmlFile} loads ${src}, which doesn't resolve`);
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: path.relative(REPO_ROOT, file) });
  }

  // Socket.io connects asynchronously; so does this.
  if (client.socket) client.socket.connect();
  await sleep(10);

  return {
    window: sandbox,
    document: doc,
    socket: client.socket,
    sent: client.sent,
    $: (sel) => doc.querySelector(sel),
    $$: (sel) => doc.querySelectorAll(sel),
    /** Every animation started so far: [{ el, anim }]. */
    animations: doc._animations,
  };
}

/** Every piece of text under a node, in order. */
function texts(node, out = []) {
  if (!node) return out;
  if (node.nodeType === 3) { if (node.textContent.trim()) out.push(node.textContent); return out; }
  for (const c of node.children) texts(c, out);
  return out;
}

module.exports = { loadOverlay, fakeIo, texts, sleep, fire };
