/**
 * The stats popup (/o/set-stats).
 *
 * Reads three state sections:
 *   setStats     the set's stats (lib/set-stats/set-view.js)
 *   statsConfig  the layout and picture style the dock picked
 *   statsShot    whether it's up, and which reading ("game" | "set")
 *
 * One state machine, run in turn so two quick changes can't interleave
 * (only the leaving half of a transition is waited for — an entrance is cut
 * into by whatever comes next):
 * down → up (the window grows up out of the players bar, the portraits slide
 * in from the window's outer edges, the cards, then the rows cascade top to
 * bottom); up → down (rows out top first, quickly, the portraits back out the
 * way they came, then the window); up → up with something different (a new
 * layout or style from the dock, the next game's numbers, the other reading)
 * swaps the window's insides without taking the window down — so the
 * operator can mix and match live. Portraits that would be drawn the same
 * stay where they are; a layout with another skin fades its background in
 * over the old one; a layout with its own window box (the Lower third) goes
 * down and comes back up in it.
 *
 * The players bar's logo stands where the window's foot lands. It sinks into
 * the round card as the popup is shown (scoreboard.js, LOGO), so the window
 * waits WINDOW_IN_DELAY for it; going down, the window clears and the logo
 * climbs back out behind it.
 *
 * It never goes up without stats: with none (doubles, a crew battle, no
 * Slippi games yet) the source stays empty and the dock says why.
 *
 * ?layout= / ?style= pin this source to a look; ?show=1 keeps it up.
 * Markup comes from layouts.js, whose html`` escapes every value.
 */
(function () {
  "use strict";

  const O = window.Overlay;
  const Layouts = window.SetStatsLayouts;
  const { ms, ease, restOf, pose, TEXT } = O.motion;
  const win = document.getElementById("win");

  const PIN = { layout: O.param("layout"), style: O.param("style"), show: O.param("show") === "1" };
  const HOLD = 6500; // a rotating section's dwell: not animation speed, so not the tempo's
  const CASCADE_IN = { gap: 70, min: 28, max: 480 };
  const CASCADE_OUT = { gap: 36, min: 14, max: 240 };
  // The logo's head start (it sinks in scoreboard.js's LOGO.outMs, 280).
  const WINDOW_IN_DELAY = 120;
  // Portraits travel from their side's outer edge: a share of their own width,
  // in their own frame (the right one is mirrored, so -x is outward for both).
  const POR = { travel: "-26%", inMs: 900, fadeInMs: 520, outMs: 320, fadeOutMs: 240 };
  const SKIN_FADE_MS = 420;

  let data = null;
  let cfg = { layout: "spotlight", style: "auto" };
  let shot = { shown: false, mode: "game" };
  let up = false;
  let drawn = null; // the signature of what's on screen

  const still = () => document.body.classList.contains("no-animate");

  function cascadeOffsets(n, { gap, min, max }) {
    const raw = [];
    let t = 0, g = gap;
    for (let i = 0; i < n; i++) { raw.push(t); t += g; g = Math.max(min, g * 0.85); }
    const last = raw.length ? raw[raw.length - 1] : 0;
    const k = last > max ? max / last : 1;
    return raw.map((x) => x * k);
  }

  // Every wait is a timer, never an animation's promise: a browser source that
  // isn't painting (another scene, a hidden source) doesn't advance its
  // animations, and a transition waiting on one would never end (the side
  // panel's rotation learned the same).
  const wait = (t) => new Promise((r) => setTimeout(r, still() ? 0 : Math.max(0, t)));
  function animate(el, frames, opts) {
    if (still() || !el.animate) return null;
    return el.animate(frames, { easing: ease("out"), ...opts });
  }
  function liftIn(el, delay = 0) {
    const rest = restOf(el);
    return animate(el, [pose(rest, { ...TEXT.in, opacity: 0 }), pose(rest)], { duration: ms(TEXT.inMs), delay: ms(delay), fill: "backwards" });
  }
  function liftOut(el, delay = 0) {
    const rest = restOf(el);
    return animate(el, [pose(rest), pose(rest, { ...TEXT.out, opacity: 0 })], { duration: ms(TEXT.outMs), delay: ms(delay), fill: "forwards" });
  }
  const scripted = (a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation);
  function stopScripted(root, { subtree = true } = {}) {
    if (root) root.getAnimations({ subtree }).forEach((a) => { if (scripted(a)) a.cancel(); });
  }
  /**
   * Where `el` is on screen right now, as a keyframe. An exit that cuts into an
   * entrance starts from here, not from rest: cancelling the entrance first
   * would pop everything to full view for a frame.
   */
  function now(el) {
    const cs = getComputedStyle(el);
    const op = parseFloat(cs.opacity);
    return {
      opacity: Number.isFinite(op) ? op : 1,
      transform: cs.transform && cs.transform !== "none" ? cs.transform : (restOf(el).transform || "none"),
      filter: cs.filter && cs.filter !== "none" ? cs.filter : "none",
    };
  }
  /** `el` out from `from` (now()) to `to`; one still invisible just stays hidden. */
  function leave(el, from, to, opts) {
    if (from.opacity < 0.02) { el.style.visibility = "hidden"; return; }
    animate(el, [{ ...from, opacity: String(from.opacity) }, to], { fill: "forwards", ...opts });
  }

  // ── Fitting text ────────────────────────────────────────────────────────────
  // One-line values shrink to their width (Overlay.fitText); a sentence in a
  // fixed box steps its size down until it fits the box.

  const BOXES = ".strip, .mini, .stamp-in, .box-in, .reel-in, [data-rot], .foot-story, .pcap";
  function fitBox(el) {
    const box = el.closest(BOXES) || el.parentElement;
    if (!box) return;
    el.style.fontSize = "";
    const base = parseFloat(getComputedStyle(el).fontSize) || 16;
    let size = base;
    for (let i = 0; i < 12; i++) {
      const over = box.scrollHeight > box.clientHeight + 1 || el.getBoundingClientRect().bottom > box.getBoundingClientRect().bottom + 1;
      if (!over || size <= base * 0.6) break;
      size *= 0.93;
      el.style.fontSize = `${size.toFixed(1)}px`;
    }
  }
  function fit(root = win) {
    root.querySelectorAll("[data-fit]").forEach((el) => O.fitText(el, 11));
    root.querySelectorAll("[data-fitbox]").forEach(fitBox);
  }

  // ── The small rotating sections ─────────────────────────────────────────────
  // Each [data-rot=id] turns through its items every HOLD: its rows out (top
  // first, quick) → the next item → rows in; [data-dots] and [data-prog] follow.

  const ROT = {
    timers: [], gen: 0,
    stop() { this.timers.forEach(clearTimeout); this.timers = []; this.gen++; },
    start(list) { this.stop(); list.forEach((r) => this.run(r)); },
    run(r) {
      const gen = this.gen;
      let i = 0;
      const el = win.querySelector(`[data-rot="${r.id}"]`);
      if (!el || r.items.length < 2) return;
      const progress = () => {
        win.querySelectorAll(`[data-prog="${r.id}"]`).forEach((p) => {
          p.getAnimations().forEach((a) => a.cancel());
          if (!still()) p.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: HOLD, easing: "linear", fill: "forwards" });
        });
        win.querySelectorAll(`[data-dots="${r.id}"] i`).forEach((d, k) => { d.classList.toggle("on", k === i); d.classList.toggle("done", k < i); });
      };
      const step = () => {
        if (gen !== this.gen) return;
        const out = [...el.querySelectorAll("[data-beat]")];
        const off = cascadeOffsets(out.length, CASCADE_OUT);
        out.forEach((x, k) => liftOut(x, off[k]));
        wait(ms((off[off.length - 1] || 0) + TEXT.outMs) + 30).then(() => {
          if (gen !== this.gen) return;
          i = (i + 1) % r.items.length;
          el.innerHTML = r.items[i];
          fit(el);
          const fresh = [...el.querySelectorAll("[data-beat]")];
          const offIn = cascadeOffsets(fresh.length, CASCADE_IN);
          el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
          fresh.forEach((x, k) => liftIn(x, offIn[k]));
          progress();
          this.timers.push(setTimeout(step, HOLD));
        });
      };
      progress();
      this.timers.push(setTimeout(step, HOLD + ms(700)));
    },
  };

  // ── Drawing ─────────────────────────────────────────────────────────────────

  /** What should be on screen now, or null for nothing. */
  function wanted() {
    if (!data || !data.available) return null;
    if (!(PIN.show || (shot && shot.shown))) return null;
    const mode = shot && (shot.mode === "set" || shot.mode === "game") ? shot.mode : (data.over ? "set" : "game");
    return { layout: PIN.layout || cfg.layout, style: PIN.style || cfg.style, mode };
  }
  const sigOf = (w) => JSON.stringify([w.layout, w.style, w.mode, data]);

  let rots = [];
  let portraitsDrawn = null; // the portraits' markup on screen, to keep them through a swap

  /**
   * Draw `r` (Layouts.render) into the window. The first draw builds it whole;
   * a swap replaces the insides, keeps the portraits when `keepPor`, and fades
   * a background of another skin in over the old one.
   */
  function build(w, r, { keepPor = false } = {}) {
    const skin = r.skin || "";
    const oldBg = win.querySelector(".win-bg");
    win.className = ["win", up ? "shown" : "", skin ? `skin-${skin}` : "", w.mode === "set" && data.over ? "over" : ""].filter(Boolean).join(" ");
    win.dataset.layout = w.layout;
    win.dataset.style = r.style;
    win.dataset.mode = w.mode;
    // layouts.js escapes every value it puts in this markup.
    if (!oldBg) {
      win.innerHTML = `<div class="win-bg${skin ? ` bg-${skin}` : ""}"></div><div class="win-clip">${r.portraits}</div><div class="hairline"></div><div class="content">${r.content}</div>`;
    } else {
      if (!keepPor) win.querySelector(".win-clip").innerHTML = r.portraits;
      win.querySelector(".content").innerHTML = r.content;
      if (win.dataset.skin !== skin) crossfadeBg(skin);
    }
    win.dataset.skin = skin;
    portraitsDrawn = r.portraits;
    rots = r.rots;
    fit();
  }

  /** The next skin's background fades in over the old, which goes once it's covered. */
  function crossfadeBg(skin) {
    win.querySelectorAll(".win-bg.next").forEach((b) => b.remove()); // one still fading in from a quick swap
    const bg = document.createElement("div");
    bg.className = `win-bg next${skin ? ` bg-${skin}` : ""}`;
    win.appendChild(bg);
    const fade = animate(bg, [{ opacity: "0" }, { opacity: "1" }], { duration: ms(SKIN_FADE_MS) });
    // The old one goes once the new one covers it. A timer that looks, not the
    // fade's promise: in a source that isn't painting the fade waits, and so
    // does the old background, rather than leaving the window bare.
    const sweep = () => {
      if (!bg.parentNode) return;
      if (fade && fade.playState === "running") { setTimeout(sweep, 250); return; }
      win.querySelectorAll(".win-bg").forEach((b) => { if (b !== bg) b.remove(); });
      bg.classList.remove("next");
    };
    setTimeout(sweep, still() ? 0 : ms(SKIN_FADE_MS) + 30);
  }

  /** Portraits slide in from their outer edge; the window's clip (or their card's) is the doorway. */
  function portraitsIn(delay, scope = win) {
    if (scope) scope.querySelectorAll("[data-por]").forEach((el) => {
      const base = restOf(el).transform;
      const op = getComputedStyle(el).opacity;
      animate(el, [{ transform: `${base} translateX(${POR.travel})`.trim() }, { transform: base || "none" }], { duration: ms(POR.inMs), delay: ms(delay), fill: "backwards" });
      animate(el, [{ opacity: "0" }, { opacity: op }], { duration: ms(POR.fadeInMs), delay: ms(delay), fill: "backwards" });
    });
  }

  /** The window's insides in: portraits from the outer edges, the cards, the corners, the rows top to bottom. */
  function enterInsides(delay = 0, { keepPor = false } = {}) {
    // Kept: only the window's portraits stay; those inside cards were redrawn with them.
    portraitsIn(delay + 120, keepPor ? win.querySelector(".content") : win);
    win.querySelectorAll("[data-beat-card]").forEach((el) => {
      const rest = restOf(el);
      animate(el, [pose(rest, { y: 12, scale: 0.985, opacity: 0 }), pose(rest)], { duration: ms(560), delay: ms(delay + 200), fill: "backwards" });
    });
    win.querySelectorAll("[data-corner]").forEach((el) => liftIn(el, delay + 200));
    const beats = [...win.querySelectorAll("[data-beat]")];
    const off = cascadeOffsets(beats.length, CASCADE_IN);
    beats.forEach((el, i) => liftIn(el, delay + 240 + off[i]));
    ROT.start(rots);
  }

  /**
   * The window's insides out: rows top first, quickly, with the corners, and
   * the portraits back out to their edges (unless `keepPor`). Each starts from
   * where it is, so a hide in the middle of an entrance doesn't flash.
   */
  function exitInsides({ keepPor = false } = {}) {
    ROT.stop();
    const content = win.querySelector(".content");
    const beats = content ? [...content.querySelectorAll("[data-beat], [data-corner], [data-beat-card]")] : [];
    const porScope = keepPor ? content : win; // kept: only the window's portraits stay
    const pors = porScope ? [...porScope.querySelectorAll("[data-por]")] : [];
    const from = new Map([...beats, ...pors].map((el) => [el, now(el)]));
    stopScripted(content);
    pors.forEach((el) => stopScripted(el, { subtree: false }));

    const off = cascadeOffsets(beats.length, CASCADE_OUT);
    beats.forEach((el, i) => {
      leave(el, from.get(el), pose(restOf(el), { ...TEXT.out, opacity: 0 }), { duration: ms(TEXT.outMs), delay: ms(off[i]) });
    });
    pors.forEach((el) => {
      const f = from.get(el);
      if (f.opacity < 0.02) { el.style.visibility = "hidden"; return; }
      const base = restOf(el).transform;
      animate(el, [{ transform: f.transform }, { transform: `${base} translateX(${POR.travel})`.trim() }], { duration: ms(POR.outMs), fill: "forwards" });
      animate(el, [{ opacity: String(f.opacity) }, { opacity: "0" }], { duration: ms(POR.fadeOutMs), fill: "forwards" });
    });
    const lastOff = off[off.length - 1] || 0;
    return { lastOff, ms: Math.max(ms(lastOff + TEXT.outMs), pors.length ? ms(POR.outMs) : 0) };
  }

  // The window moves on transform and opacity only: no blur on a layer this
  // size (the bracket's boards don't blur either), and a filter over the glass
  // cards would change what their backdrop-filter sees mid-entrance.
  const lift = (rest, { y = 0, scale = 1, opacity = 1 }) => ({
    opacity: String(opacity),
    transform: `${rest.transform} translate(0px, ${y}px) scale(${scale})`.trim(),
  });

  // The window's box: a layout may have its own (the Lower third), else the
  // stylesheet's full one. A swap to another box goes down and comes back up
  // in it, rather than resizing a window with content in it.
  const boxOf = (w) => JSON.stringify((Layouts.LAYOUTS[w.layout] || {}).win || null);
  let drawnBox = null;
  function placeWindow(box) {
    win.style.left = box ? `${box.l}px` : "";
    win.style.top = box ? `${box.t}px` : "";
    win.style.width = box ? `${box.w}px` : "";
    win.style.height = box ? `${box.h}px` : "";
  }

  /** `reboxed`: back up in another box (a swap), with the logo already down: no head start to give it. */
  async function enter(w, { reboxed = false } = {}) {
    up = true;
    const r = Layouts.render(data, w);
    placeWindow(r.win);
    drawnBox = boxOf(w);
    build(w, r);
    win.classList.add("shown");
    const rest = restOf(win);
    const delay = reboxed ? 0 : WINDOW_IN_DELAY;
    animate(win, [lift(rest, { y: 24, scale: 0.97, opacity: 0 }), lift(rest, {})], { duration: ms(560), delay: ms(delay), fill: "backwards" });
    enterInsides(delay); // not awaited: a Hide or a swap cuts straight into an entrance
  }

  async function exit() {
    const winFrom = now(win);
    const { lastOff, ms: insides } = exitInsides();
    stopScripted(win, { subtree: false });
    const rest = restOf(win);
    animate(win, [{ opacity: String(winFrom.opacity), transform: winFrom.transform }, lift(rest, { y: -12, scale: 0.985, opacity: 0 })],
      { duration: ms(320), delay: ms(lastOff + 60), fill: "forwards" });
    await wait(Math.max(insides, ms(lastOff + 60 + 320)) + 30);
    up = false;
    drawn = null;
    portraitsDrawn = null;
    stopScripted(win);
    win.className = "win";
    delete win.dataset.skin;
    win.innerHTML = "";
  }

  /** Something different while up: the insides out, redrawn, back in; the window stays. */
  async function swap(w) {
    const r = Layouts.render(data, w);
    const keepPor = r.portraits === portraitsDrawn;
    const out = exitInsides({ keepPor });
    await wait(out.ms + 30);
    stopScripted(win.querySelector(".content"));
    if (!keepPor) stopScripted(win.querySelector(".win-clip"));
    build(w, r, { keepPor });
    enterInsides(-120, { keepPor });
  }

  // Transitions run one at a time; whatever changed meanwhile is caught up after.
  let running = false;
  let again = false;
  async function reconcile() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const w = wanted();
        if (!w) {
          if (up) await exit();
          continue;
        }
        const sig = sigOf(w);
        if (!up) { await enter(w); drawn = sig; continue; }
        if (sig !== drawn && boxOf(w) !== drawnBox) { await exit(); await enter(w, { reboxed: true }); drawn = sig; continue; }
        if (sig !== drawn) { drawn = sig; await swap(w); }
      } while (again);
    } catch (err) {
      console.error("[set-stats] draw failed", err);
    } finally {
      running = false;
    }
  }

  const ov = Overlay.connect({ tag: "set-stats" });
  ov.select("setStats", (d) => { data = d; reconcile(); });
  ov.select("statsConfig", (c) => { if (c) cfg = c; reconcile(); });
  ov.select("statsShot", (s) => { if (s) shot = s; reconcile(); });
  // Web fonts change every measurement: refit once they're in.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (up) fit(); });

  // For tests and the browser console.
  window.SetStats = {
    get up() { return up; },
    get data() { return data; },
    get drawn() { return drawn; },
    reconcile,
  };
})();
