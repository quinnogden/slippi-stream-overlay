/**
 * overlay-client.js — the runtime every overlay page loads. Replaces TSH's
 * globals.js (and with it jQuery, lodash, kuroshiro and the 30fps
 * program_state.json poll).
 *
 *   <script src="/socket.io/socket.io.js"></script>
 *   <script src="/o/shared/overlay-client.js"></script>
 *
 *   const ov = Overlay.connect({ tag: "scoreboard" });
 *   ov.select("scoreboard", (sb, prev) => { … });   // runs when that path changes
 *   ov.on("game:start", (game) => { … });          // relayed events
 *   ov.ready.then(() => { … });                    // first state drawn, fonts in
 *
 * The page fades in by itself: `body` starts at opacity 0 (overlay.css) and
 * gets `.ready` once the first state has been drawn and the fonts have loaded.
 * That replaces globals.js's `fadeTo` — the trap where a page that never got
 * its first TSH push stayed invisible for good. `?animate=false` adds
 * `body.no-animate`, which overlay.css uses to skip every entrance.
 *
 * The state mirror at the top has no DOM in it, so tests/overlay-patch.test.js
 * runs this same file under Node.
 */
(function (root) {
  "use strict";

  // ── State mirror ────────────────────────────────────────────────────────────

  function getPath(obj, path) {
    if (!path) return obj;
    return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = String(path).split(".");
    let o = obj;
    for (const k of keys.slice(0, -1)) {
      if (o[k] == null || typeof o[k] !== "object") o[k] = {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = value;
  }

  /**
   * The client's copy of the app's state, fed by state:full / state:patch.
   * A selector runs only when the JSON of its path changes, so a casters
   * edit never re-runs (and re-animates) the scoreboard.
   *
   * @param {{ requestResync: () => void }} hooks
   */
  function createMirror(hooks) {
    let state = null;
    let rev = -1;
    const selectors = [];

    function run(sel) {
      const now = getPath(state, sel.path);
      const json = JSON.stringify(now === undefined ? null : now);
      if (json === sel.json) return;
      const prev = sel.value;
      sel.json = json;
      sel.value = now;
      try {
        sel.fn(now, prev);
      } catch (err) {
        // One broken renderer must not stop the others (or the next patch).
        console.error(`[overlay] selector "${sel.path}" threw`, err);
      }
    }

    return {
      get state() { return state; },
      get rev() { return rev; },

      /** A complete state. Always accepted — the server may have restarted. */
      full(msg) {
        state = msg;
        rev = msg.rev;
        selectors.forEach(run);
      },

      /** @returns {"applied"|"stale"|"gap"} */
      patch(msg) {
        if (state === null || msg.from > rev) {
          hooks.requestResync();
          return "gap";
        }
        if (msg.rev <= rev) return "stale"; // a state:full newer than this already landed
        state = { ...state, rev: msg.rev };
        for (const op of msg.ops) setPath(state, op.path, op.value);
        rev = msg.rev;
        selectors.forEach(run);
        return "applied";
      },

      select(path, fn) {
        const sel = { path, fn, json: undefined, value: undefined };
        selectors.push(sel);
        if (state !== null) run(sel);
      },
    };
  }

  // ── Assets ──────────────────────────────────────────────────────────────────

  /** A character's stock icon: { codename, skin } → url, or null. */
  function icon(character) {
    if (!character || !character.codename) return null;
    const skin = String(Number(character.skin) || 0).padStart(2, "0");
    return `/assets/icons/chara_2_${character.codename}_${skin}.png`;
  }

  const api = { createMirror, getPath, icon };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  // ── Browser ─────────────────────────────────────────────────────────────────

  const params = new URLSearchParams(root.location.search);
  const param = (name) => params.get(name);

  function onBody(fn) {
    if (document.body) fn(document.body);
    else document.addEventListener("DOMContentLoaded", () => fn(document.body));
  }

  if (param("animate") === "false") onBody((b) => b.classList.add("no-animate"));

  /**
   * @param {{ tag?: string, namespace?: string }} [opts]
   */
  function connect(opts = {}) {
    const tag = opts.tag || "overlay";
    const handlers = {};
    let socket = null;

    const mirror = createMirror({
      requestResync: () => socket && socket.emit("state:resync"),
    });

    let markReady;
    const ready = new Promise((r) => { markReady = r; });
    let drawn = false;

    if (typeof root.io !== "function") {
      console.error(`[${tag}] socket.io client missing — is the app running?`);
    } else {
      socket = root.io(opts.namespace || "/overlay");
      socket.on("state:full", (msg) => {
        mirror.full(msg);
        if (!drawn) {
          drawn = true;
          reveal().then(markReady);
        }
      });
      socket.on("state:patch", (msg) => {
        if (mirror.patch(msg) === "gap") console.warn(`[${tag}] missed an update — resyncing`);
      });
      socket.on("connect", () => console.log(`[${tag}] connected`));
      socket.on("disconnect", () => console.warn(`[${tag}] disconnected — keeping the last state`));
      socket.onAny((event, payload) => (handlers[event] || []).forEach((fn) => fn(payload)));
    }

    return {
      select: mirror.select,
      on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
      get state() { return mirror.state; },
      ready,
      socket,
    };
  }

  /** Fonts in, one frame painted, then fade the page in. */
  async function reveal() {
    try { await document.fonts.ready; } catch (_) { /* draw anyway */ }
    await new Promise((r) => requestAnimationFrame(() => r()));
    onBody((b) => b.classList.add("ready"));
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  const FADE_MS = 500; // TSH's SetInnerHtml: 0.5s out, 0.5s in

  /**
   * Replace an element's content with a fade out → render → fade in, but only
   * when `key` differs from what it last showed. The first render is instant
   * (the page's own entrance animation covers it). A swap started mid-fade
   * takes over from wherever the opacity is.
   *
   * @param {Element} el
   * @param {string} key — identity of the content; same key = no-op
   * @param {(el: Element) => void} render
   * @returns {boolean} whether anything changed
   */
  function swap(el, key, render, opts = {}) {
    if (!el) return false;
    key = String(key);
    if (el.__ovKey === key) return false;
    const first = el.__ovKey === undefined;
    el.__ovKey = key;

    const ms = opts.fadeMs ?? FADE_MS;
    if (first || !ms || !el.animate || document.body.classList.contains("no-animate")) {
      render(el);
      return true;
    }
    const from = getComputedStyle(el).opacity;
    if (el.__ovAnim) el.__ovAnim.cancel();
    const out = el.__ovAnim = el.animate([{ opacity: from }, { opacity: 0 }], { duration: ms, fill: "forwards" });
    out.onfinish = () => {
      render(el);
      el.__ovAnim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, fill: "forwards" });
    };
    return true;
  }

  /**
   * Set plain text (never HTML) with a crossfade, and mark the element — and
   * `opts.emptyOn`, e.g. a chip that should vanish — `.empty` when blank.
   */
  function text(el, value, opts = {}) {
    if (!el) return false;
    const s = value == null ? "" : String(value);
    return swap(el, s, (node) => {
      node.textContent = s;
      node.classList.toggle("empty", s === "");
      if (opts.emptyOn) opts.emptyOn.classList.toggle("empty", s === "");
      if (opts.squeeze) squeeze(node);
    }, opts);
  }

  /**
   * Squeeze `el` horizontally until it fits its parent — TSH's FitText, which
   * every scoreboard name has been drawn with. Measures after the fonts load,
   * since a fallback face is a different width.
   */
  function squeeze(el) {
    if (!el || !el.parentElement) return;
    const fit = () => {
      el.style.transform = "";
      const ps = getComputedStyle(el.parentElement);
      const avail = el.parentElement.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
      const need = el.scrollWidth;
      if (avail > 0 && need > avail) el.style.transform = `scaleX(${avail / need})`;
    };
    fit();
    if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(fit);
  }

  /** document.createElement with a class and optional text. */
  function h(tagName, className, textContent) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (textContent != null) node.textContent = textContent;
    return node;
  }

  root.Overlay = { ...api, connect, swap, text, squeeze, h, param };
})(typeof window !== "undefined" ? window : globalThis);
