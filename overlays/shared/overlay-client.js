/**
 * overlay-client.js — the runtime every overlay page loads.
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
 * gets `.ready` once the first state has been drawn and the fonts have loaded,
 * so a page can't stay invisible waiting on a push it missed. `?animate=false` adds
 * `body.no-animate`, which overlay.css uses to skip every entrance.
 *
 * A theme switch from the dock (`theme`) fades the page out and reloads it,
 * so it comes back exactly as a freshly added source would in the new pack.
 * connect() follows it; a page that never connects calls followTheme().
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

  const api = { createMirror, icon };

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
      const namespace = opts.namespace || "/overlay";
      socket = root.io(namespace);
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
      // Overlays only: the dock hears `theme` too, and must not reload away a draft.
      if (namespace === "/overlay") socket.on("theme", reloadForTheme);
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

  /**
   * Fonts in, one frame painted, then fade the page in. connect() calls it on
   * the first state; a page with no state to wait for (highlights) calls it
   * itself.
   */
  async function reveal() {
    try { await document.fonts.ready; } catch (_) { /* draw anyway */ }
    await new Promise((r) => requestAnimationFrame(() => r()));
    onBody((b) => b.classList.add("ready"));
  }

  // ── Motion ──────────────────────────────────────────────────────────────────
  //
  // The script half of overlay.css's motion tokens: everything that appears
  // rises a few px, settles on --ease-out and pulls into focus from a slight
  // blur; everything that leaves accelerates away on --ease-in. Theme-agnostic
  // on purpose — a pack changes colours and type, never how things move.
  //
  // Every keyframe is built on the element's RESTING transform and filter, by
  // the same conventions as overlay.css's entrances: --base-transform if the
  // stylesheet sets one (it keeps a translate(-50%)'s percentages live while
  // the content changes width), else the inline transform (squeeze()'s
  // scaleX); and the computed filter, with the blur appended so the two lists
  // still interpolate. Both ends of a keyframe pair carry the same functions.

  const EASE_FALLBACK = {
    out:    "cubic-bezier(0.16, 1, 0.3, 1)",
    in:     "cubic-bezier(0.3, 0, 0.8, 0.15)",
    spring: "cubic-bezier(0.34, 1.4, 0.64, 1)",
  };

  /** overlay.css's --ease-<name>, so CSS and script move on the same curves. */
  function ease(name) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(`--ease-${name}`);
      if (v && v.trim()) return v.trim();
    } catch (_) { /* no stylesheet yet */ }
    return EASE_FALLBACK[name] || "ease";
  }

  const TEMPO_FALLBACK = 1.5;

  /**
   * A duration at overlay.css's --motion-tempo, so one token slows every
   * animation, CSS and script alike. Write durations at tempo 1.
   */
  function ms(n) {
    let t = NaN;
    try {
      t = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--motion-tempo"));
    } catch (_) { /* no stylesheet yet */ }
    return n * (t > 0 ? t : TEMPO_FALLBACK);
  }

  const still = () => !document.body || document.body.classList.contains("no-animate");
  const canAnimate = (el) => Boolean(el && el.animate) && !still();

  /** The transform and filter `el` rests at. Read it with nothing animating on it. */
  function restOf(el) {
    const cs = getComputedStyle(el);
    const base = cs.getPropertyValue ? String(cs.getPropertyValue("--base-transform") || "").trim() : "";
    const filter = cs.filter && cs.filter !== "none" ? cs.filter : "";
    return { transform: base || el.style.transform || "", filter };
  }

  /**
   * One keyframe: `el` at rest, moved by { x, y, scale, blur, opacity }.
   * @param {{ transform: string, filter: string }} rest — from restOf()
   */
  function pose(rest, { x = 0, y = 0, scale = 1, blur = 0, opacity = 1 } = {}) {
    return {
      opacity: String(opacity),
      transform: `${rest.transform} translate(${x}px, ${y}px) scale(${scale})`.trim(),
      filter: `${rest.filter} blur(${blur}px)`.trim(),
    };
  }

  // A swap is out → draw → in. Three characters, by what's changing:
  //   lift — text (names, rounds, titles): a short drift up and a re-focus
  //   roll — a score, inside its clipped box: an odometer tick
  //   pop  — an icon: shrinks away, the new one lands from slightly large
  const SWAPS = {
    lift: { out: { y: -6, blur: 3 },        in: { y: 8, blur: 4 } },
    roll: { out: { y: -22, blur: 2 },       in: { y: 26, blur: 2 } },
    pop:  { out: { scale: 0.82, blur: 4 },  in: { scale: 1.16, blur: 6 } },
  };
  const SWAP_OUT_MS = 200;
  const SWAP_IN_MS  = 480;

  // presence(): something that comes and goes whole (a chip, a pill, a card).
  const SHOW = { from: { y: 10, scale: 0.94, blur: 6 }, ms: 560 };
  const HIDE = { to:   { y: 6,  scale: 0.96, blur: 4 }, ms: 260 };

  function stopSwap(el) {
    if (el.__ovAnim) el.__ovAnim.cancel();
    el.__ovAnim = null;
    el.__ovPhase = null;
    el.__ovRender = null;
  }

  // ── Theme switch ────────────────────────────────────────────────────────────

  const THEME_FADE_MS = 450;
  let reloading = false;

  /**
   * Fade out, then reload. A reload rather than swapping stylesheets in place:
   * the old pack's tokens and @font-face would linger under the new one, and
   * every measured fit (squeeze, fitText, the bracket's scale) would be stale.
   * The /o/ files are served with max-age=0, so the reload revalidates
   * theme.css and gets the new @import.
   */
  function reloadForTheme() {
    if (reloading) return;
    reloading = true;
    const body = document.body;
    if (!body || !body.animate || body.classList.contains("no-animate")) return root.location.reload();
    body.animate([{ opacity: getComputedStyle(body).opacity }, { opacity: 0 }],
      { duration: ms(THEME_FADE_MS), easing: ease("in"), fill: "forwards" })
      .onfinish = () => root.location.reload();
  }

  /** For a page that never connects (highlights): listen for the theme alone. */
  function followTheme() {
    if (typeof root.io !== "function") return;
    root.io("/overlay").on("theme", reloadForTheme);
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  /**
   * Replace an element's content with an exit → render → entrance, but only
   * when `key` differs from what it last showed. The first render is instant
   * (the page's own entrance animation covers it).
   *
   * A change that lands while the old content is still leaving doesn't
   * restart anything: the exit already under way draws whatever is newest
   * when it ends, so a burst of pushes is one swap. One that lands during
   * the entrance leaves from wherever the opacity is.
   *
   * @param {Element} el
   * @param {string} key — identity of the content; same key = no-op
   * @param {(el: Element) => void} render
   * @param {{ motion?: "lift"|"roll"|"pop" }} [opts]
   * @returns {boolean} whether anything changed
   */
  function swap(el, key, render, opts = {}) {
    if (!el) return false;
    key = String(key);
    if (el.__ovKey === key) return false;
    const first = el.__ovKey === undefined;
    el.__ovKey = key;

    if (first || !canAnimate(el)) {
      stopSwap(el);
      render(el);
      return true;
    }
    el.__ovRender = render;
    if (el.__ovPhase === "out") return true;

    const m = SWAPS[opts.motion] || SWAPS.lift;
    const from = getComputedStyle(el).opacity;
    if (el.__ovAnim) el.__ovAnim.cancel();
    const rest = restOf(el);
    const out = el.__ovAnim = el.animate(
      [pose(rest, { opacity: from }), pose(rest, { ...m.out, opacity: 0 })],
      { duration: ms(SWAP_OUT_MS), easing: ease("in"), fill: "forwards" });
    el.__ovPhase = "out";

    out.finished.then(() => {
      if (el.__ovAnim !== out) return;
      const draw = el.__ovRender;
      el.__ovRender = null;
      if (draw) draw(el);
      // Off before reading the rest pose — it holds the blur. Same task as
      // the entrance below, so no frame is painted in between.
      out.cancel();
      const back = restOf(el); // the render may have re-squeezed it
      const enter = el.__ovAnim = el.animate(
        [pose(back, { ...m.in, opacity: 0 }), pose(back)],
        { duration: ms(SWAP_IN_MS), easing: ease("out") });
      el.__ovPhase = "in";
      enter.finished.then(() => { if (el.__ovAnim === enter) { el.__ovAnim = null; el.__ovPhase = null; } }, () => {});
    }, () => {});
    return true;
  }

  /**
   * Show or hide `el` whole — a chip, a pill, a card — by its `hiddenClass`
   * (whatever the stylesheet hides: display or visibility). It enters as
   * everything else does; it leaves before the class goes on, so the
   * stylesheet's hidden state is reached rather than cut to. The first call
   * only sets the class (the page entrance covers it).
   *
   * Reversing mid-way is safe: a hide that's overtaken never applies its
   * class or its onHidden.
   *
   * @param {Element} el
   * @param {boolean} on
   * @param {{ hiddenClass?: string, onHidden?: () => void }} [opts]
   */
  function presence(el, on, opts = {}) {
    if (!el) return;
    on = Boolean(on);
    const cls = opts.hiddenClass || "empty";
    const was = el.__ovShown;
    if (was === on) return;
    el.__ovShown = on;

    const from = el.__ovPresAnim ? Number(getComputedStyle(el).opacity) : null;
    if (el.__ovPresAnim) el.__ovPresAnim.cancel();
    el.__ovPresAnim = null;

    if (was === undefined || !canAnimate(el)) {
      el.classList.toggle(cls, !on);
      if (!on && opts.onHidden) opts.onHidden();
      return;
    }

    if (on) {
      el.classList.remove(cls);
      const rest = restOf(el);
      // Overtaking a hide: carry on from where it got to, in place.
      const start = from === null ? pose(rest, { ...SHOW.from, opacity: 0 }) : pose(rest, { opacity: from });
      const anim = el.__ovPresAnim = el.animate([start, pose(rest)], { duration: ms(SHOW.ms), easing: ease("out") });
      anim.finished.then(() => { if (el.__ovPresAnim === anim) el.__ovPresAnim = null; }, () => {});
      return;
    }

    const rest = restOf(el);
    const anim = el.__ovPresAnim = el.animate(
      [pose(rest, { opacity: from === null ? 1 : from }), pose(rest, { ...HIDE.to, opacity: 0 })],
      { duration: ms(HIDE.ms), easing: ease("in"), fill: "forwards" });
    anim.finished.then(() => {
      if (el.__ovPresAnim !== anim) return;
      el.classList.add(cls);
      if (opts.onHidden) opts.onHidden();
      anim.cancel();
      el.__ovPresAnim = null;
    }, () => {});
  }

  /**
   * Set plain text (never HTML) and mark the element `.empty` when blank.
   * A change of text swaps; with `opts.emptyOn` (a chip that should vanish
   * when blank) the chip itself enters and leaves through presence(), still
   * showing the old text on its way out.
   */
  function text(el, value, opts = {}) {
    if (!el) return false;
    const s = value == null ? "" : String(value);
    const draw = (node) => {
      node.textContent = s;
      node.classList.toggle("empty", s === "");
      if (opts.squeeze) squeeze(node);
    };
    const host = opts.emptyOn;
    if (!host) return swap(el, s, draw, opts);

    if (el.__ovKey === s) return false;
    const first = el.__ovKey === undefined;
    const showing = !first && el.__ovKey !== "";
    if (s === "") {
      el.__ovKey = s;
      presence(host, false, { onHidden: () => { stopSwap(el); draw(el); } });
      return true;
    }
    if (!showing) {
      el.__ovKey = s;
      stopSwap(el);
      draw(el);
      presence(host, true);
      return true;
    }
    presence(host, true);
    return swap(el, s, draw, opts);
  }

  /**
   * Squeeze `el` horizontally until it fits its parent — how every scoreboard
   * name is drawn. Measured again once the fonts load (a fallback face is a
   * different width), and whenever the parent changes width: the box a name
   * fits into is what its siblings leave, and they change on their own
   * schedule (the doubles swatch is drawn after the name, and is wider than
   * a character icon).
   */
  function squeeze(el) {
    if (!el || !el.parentElement) return;
    fitSqueeze(el);
    if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(() => fitSqueeze(el));
    if (squeezeObserver && squeezedIn.get(el.parentElement) !== el) {
      squeezedIn.set(el.parentElement, el);
      squeezeObserver.observe(el.parentElement);
    }
  }

  function fitSqueeze(el) {
    if (!el.parentElement) return;
    el.style.transform = "";
    const ps = getComputedStyle(el.parentElement);
    const avail = el.parentElement.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
    const need = el.scrollWidth;
    if (avail > 0 && need > avail) el.style.transform = `scaleX(${avail / need})`;
  }

  // parent → the element squeezed into it. A refit only changes a transform,
  // which never changes layout, so it can't resize what's observed and loop.
  const squeezedIn = new WeakMap();
  const squeezeObserver = typeof root.ResizeObserver === "function"
    ? new root.ResizeObserver((entries) => {
        for (const e of entries) {
          const el = squeezedIn.get(e.target);
          if (el && el.parentElement === e.target) fitSqueeze(el);
        }
      })
    : null;

  /**
   * Shrink single-line text's font size until it fits its box — the side
   * panel's way (squeeze() is the scoreboard's). The CSS ellipsis stays as
   * the fallback once `minPx` is reached; below that it stops being legible.
   *
   * Synchronous, so call it once the node is in the document. The node
   * remembers its floor in data-fit-min, and every fitted node is redone when
   * a web font lands: measured against the fallback face, the size is wrong.
   */
  function fitText(node, minPx = 13) {
    if (!node) return;
    node.dataset.fitMin = String(minPx);
    delete node.dataset.fitGroup;
    fitTextNow(node);
  }

  /**
   * fitText for rows that read as a set — a list's names, its event lines.
   * Each node is fitted alone, then the group takes the smallest of those
   * sizes, so one long name doesn't leave its row a different size from the
   * rest. Only down to `floorRatio` of the stylesheet size, though: a node
   * that needs less than that is an outlier and shrinks alone, as fitText
   * would, rather than taking the whole list down with it.
   *
   * Call it once every node is in the document AND the layout is final. A
   * list built row by row lays its first rows out taller (flex: 1 pills,
   * text in cqh), and a fit measured then freezes a size the finished list
   * doesn't use — rows of identical text came out at three sizes.
   */
  let fitGroupSeq = 0;
  function fitGroup(nodes, minPx = 13, floorRatio = 0.8) {
    nodes = Array.from(nodes).filter(Boolean);
    if (!nodes.length) return;
    const id = String(++fitGroupSeq);
    for (const n of nodes) {
      n.dataset.fitMin = String(minPx);
      n.dataset.fitGroup = id;
      n.dataset.fitFloor = String(floorRatio);
    }
    fitGroupNow(nodes);
  }

  function fitGroupNow(nodes) {
    const ratio = parseFloat(nodes[0].dataset.fitFloor) || 0.8;
    let floor = 0;
    const own = nodes.map((n) => {
      n.style.fontSize = "";
      floor = Math.max(floor, parseFloat(getComputedStyle(n).fontSize) * ratio);
      fitTextNow(n);
      return parseFloat(getComputedStyle(n).fontSize);
    });
    let shared = Infinity;
    for (const s of own) if (s >= floor) shared = Math.min(shared, s);
    nodes.forEach((n, i) => { if (own[i] > shared) n.style.fontSize = shared + "px"; });
  }

  function fitTextNow(node) {
    const minPx = parseFloat(node.dataset.fitMin) || 13;
    // From the stylesheet size, so a re-fit can grow back as well as shrink.
    node.style.fontSize = "";
    const width = node.clientWidth;
    if (!width || node.scrollWidth <= width) return;
    // Width scales ~linearly with font size (letter-spacing is in em), so jump
    // to the ratio and only nudge for rounding — not a reflow per half pixel.
    const base = parseFloat(getComputedStyle(node).fontSize);
    let size = Math.max(minPx, Math.floor(base * width / node.scrollWidth * 2) / 2);
    node.style.fontSize = size + "px";
    while (node.scrollWidth > width && size > minPx) {
      size = Math.max(minPx, size - 0.5);
      node.style.fontSize = size + "px";
    }
  }

  function refitAll() {
    const groups = new Map();
    document.querySelectorAll("[data-fit-min]").forEach((n) => {
      const g = n.dataset.fitGroup;
      if (!g) return fitTextNow(n);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    });
    groups.forEach(fitGroupNow);
  }
  if (document.fonts) {
    document.fonts.addEventListener?.("loadingdone", refitAll);
    document.fonts.ready.then(refitAll);
  }

  /** document.createElement with a class and optional text. */
  function h(tagName, className, textContent) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (textContent != null) node.textContent = textContent;
    return node;
  }

  const motion = { ease, ms, restOf, pose };

  root.Overlay = { ...api, connect, reveal, followTheme, swap, presence, text, motion, squeeze, fitText, fitGroup, h, param };
})(typeof window !== "undefined" ? window : globalThis);
