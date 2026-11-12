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
 * bottom); up → down (everything out at once, quicker than any entrance or
 * swap — CLOSE — the rows barely staggered, the portraits back out the way
 * they came, the window going with them); up → up with something different (a new
 * layout or style from the dock, the next game's numbers, the other reading)
 * swaps the window's insides without taking the window down — so the
 * operator can mix and match live. Portraits that would be drawn the same
 * stay where they are; a layout with another skin fades its background in
 * over the old one; a layout with its own window box (the Lower third) goes
 * down and comes back up in it.
 *
 * Each layout moves like its scene (LAYOUTS[].motion, plus data-fx on its
 * pieces — see FX): the glass windows rise out of the players bar; the field
 * notes are written and printed rather than slid (the portraits uncovered
 * from their margin, the title and notes written left to right with their
 * strokes drawn after, stamps pressed, ruled lines drawn down the page, the
 * clipboard's clip settling first); the polaroids are tossed onto the page and
 * develop; the Tale of the tape's fighters walk out first and each row's
 * numbers close in from their own side; the Lower third opens from its middle;
 * the Condensed pieces come from the outside in (out of the players bar's
 * cards, down from the top edge, in from the sides) and go back the same way.
 * A swap leaves the old layout's way and arrives the new one's.
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

  const PIN = { layout: O.param("layout"), style: O.param("style"), pack: O.param("pack"), stages: O.param("stages"), show: O.param("show") === "1" };
  const HOLD = 6500; // a rotating section's dwell: not animation speed, so not the tempo's
  const CASCADE_IN = { gap: 70, min: 28, max: 480 };
  const CASCADE_OUT = { gap: 36, min: 14, max: 240 };
  // Going down is quicker than any entrance or swap: the popup gets out of the
  // way. The rows barely stagger, everything fades faster, and the window
  // leaves with its insides rather than after them (about a third of the time
  // a swap's way out takes). scoreboard.js's LOGO.backDelay is timed to it.
  const CLOSE = { cascade: { gap: 12, min: 5, max: 60 }, textMs: 120, porMs: 200, fadeMs: 160, winDelay: 20, winMs: 200 };
  // The logo's head start (it sinks in scoreboard.js's LOGO.outMs, 280).
  const WINDOW_IN_DELAY = 120;
  // Portraits travel from their side's outer edge: a share of their own width,
  // in their own frame (the right one is mirrored, so -x is outward for both).
  const POR = { travel: "-26%", inMs: 900, fadeInMs: 520, outMs: 320, fadeOutMs: 240 };
  // The portraits' ways in, per layout (LAYOUTS[].motion.por):
  //   slide    the default above: in through the window's edge
  //   walkout  the Tale of the tape's fighters: further, sooner, first
  //   wipe     the field notes: printed — uncovered from their margin, no travel
  //   develop  the Polaroids: the photo comes up from a pale, washed print
  //   ride     inside a card that carries them (the Players rails): no motion of their own
  const WALKOUT = { travel: "-40%", inMs: 760, fadeInMs: 360 };
  const WIPE = { inMs: 820, outMs: 300 };
  const DEVELOP = { inMs: 1200, fadeInMs: 600, from: "sepia(0.7) brightness(1.55) contrast(0.6)", to: "sepia(0) brightness(1) contrast(1)" };
  const SKIN_FADE_MS = 420;
  // clip-path boxes for the reveals. Negative insets leave room for text
  // shadows and a note's arrow; `L0` is the same box closed to its left edge.
  const CLIP = { full: "inset(-30% -40px -30% -40px)", L0: "inset(-30% 100% -30% -40px)", top0: "inset(0px 0px 100% 0px)", all: "inset(0px 0px 0px 0px)", mid0: "inset(0px 50% 0px 50%)" };
  // The Lower third's window opens from its middle line (the box reaches past
  // the window for its shadow).
  const WIN_WIPE = { full: "inset(-80px -80px -80px -80px)", mid: "inset(-80px 50% -80px 50%)", inMs: 640 };

  let data = null;
  let cfg = { layout: "spotlight", style: "auto" };
  let shot = { shown: false, mode: "game" };
  let up = false;
  let drawn = null; // the signature of what's on screen
  let motion = {}; // the drawn layout's LAYOUTS[].motion, so a swap leaves its way

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
      clipPath: cs.clipPath && cs.clipPath !== "none" ? cs.clipPath : null,
    };
  }
  /**
   * `el` out from `from` (now()) to `to`; one still invisible just stays hidden.
   * A reveal cut into mid-way keeps its clip as it goes, rather than flash whole.
   */
  function leave(el, from, to, opts) {
    if (from.opacity < 0.02) { el.style.visibility = "hidden"; return; }
    const { clipPath, ...rest } = from;
    const clip = clipPath ? { clipPath } : {};
    if (!("filter" in to)) delete rest.filter;
    animate(el, [{ ...rest, ...clip, opacity: String(from.opacity) }, { ...to, ...clip }], { fill: "forwards", ...opts });
  }

  // ── Each layout's own motion ────────────────────────────────────────────────
  // A piece marked data-fx="<name>" arrives its own way instead of the text
  // lift; data-delay adds to its turn (ms at tempo 1). Every one goes through
  // animate(), so ?animate=false still draws them at rest.

  /** A stroke (an SVG path with pathLength="1" and data-draw, dashed 1 1 in the stylesheet) drawn along its length. */
  function drawStroke(p, delay) {
    animate(p, [{ strokeDashoffset: "1", opacity: "0" }, { strokeDashoffset: "0.96", opacity: "1", offset: 0.04 }, { strokeDashoffset: "0", opacity: "1" }],
      { duration: ms(520), delay: ms(delay), fill: "backwards" });
  }
  const moved = (el, { x = 0, y = 0, scale = 1, rotate = 0 } = {}) => `${restOf(el).transform} translate(${x}px, ${y}px) rotate(${rotate}deg) scale(${scale})`.trim();
  const FX = {
    /** Handwriting: uncovered left to right, then any stroke in it (an underline, a note's arrow) drawn. */
    write(el, delay) {
      animate(el, [{ clipPath: CLIP.L0, opacity: "0" }, { clipPath: CLIP.L0, opacity: "1", offset: 0.04 }, { clipPath: CLIP.full, opacity: "1" }],
        { duration: ms(640), delay: ms(delay), fill: "backwards" });
      el.querySelectorAll("[data-draw]").forEach((p, i) => drawStroke(p, delay + 420 + i * 120));
    },
    /** A stroke on the page (a field note's circle round a number): only its lines, drawn. */
    draw(el, delay) {
      el.querySelectorAll("[data-draw]").forEach((p, i) => drawStroke(p, delay + i * 120));
    },
    /** A stamp: pressed down onto the page, from a little above it. */
    press(el, delay) {
      animate(el, [{ opacity: "0", transform: moved(el, { scale: 1.12 }) }, { opacity: "1", transform: moved(el, { scale: 1.02 }), offset: 0.45 }, { opacity: "1", transform: moved(el) }],
        { duration: ms(380), delay: ms(delay), fill: "backwards" });
    },
    /** A photo tossed onto the page: from above, turned further than it lands, settling (the spring curve) at its angle. */
    toss(el, delay) {
      const r = parseFloat(el.dataset.toss) || 0;
      const turn = (r < 0 ? -1 : 1) * 7;
      animate(el, [{ opacity: "0", transform: moved(el, { y: -48, rotate: turn, scale: 1.05 }) }, { opacity: "1", transform: moved(el, { y: -14, rotate: turn * 0.35, scale: 1.015 }), offset: 0.3 }, { opacity: "1", transform: moved(el) }],
        { duration: ms(760), delay: ms(delay), fill: "backwards", easing: ease("spring") });
    },
    /** A card standing up out of the players bar below. */
    rise(el, delay) {
      animate(el, [{ opacity: "0", transform: moved(el, { y: 56 }) }, { opacity: "1", transform: moved(el) }],
        { duration: ms(640), delay: ms(delay), fill: "backwards" });
    },
    /** A tape row: each player's number closes in from their own side, the label rises between. */
    converge(el, delay) {
      el.querySelectorAll(".tv").forEach((v) => {
        const x = v.classList.contains("r") ? 44 : -44;
        animate(v, [{ opacity: "0", transform: moved(v, { x }) }, { opacity: "1", transform: moved(v) }], { duration: ms(520), delay: ms(delay), fill: "backwards" });
      });
      el.querySelectorAll(".tk").forEach((k) => liftIn(k, delay + 60));
    },
    /** Ruled lines and margin rules drawn down the page. */
    rule(el, delay) {
      animate(el, [{ clipPath: CLIP.top0 }, { clipPath: CLIP.all }], { duration: ms(760), delay: ms(delay), fill: "backwards" });
    },
    /** The clipboard's clip: dropped into place first, with a little give. */
    settle(el, delay) {
      animate(el, [{ opacity: "0", transform: moved(el, { y: -22 }) }, { opacity: "1", transform: moved(el) }],
        { duration: ms(520), delay: ms(delay), fill: "backwards", easing: ease("spring") });
    },
    /**
     * Up out of what's under it (the Condensed pieces on the bar's cards): it
     * rises from behind its own foot, the clip holding that line still while
     * it moves, so it comes out of the card rather than across it.
     */
    emerge(el, delay) {
      const d = emergeBy(el);
      animate(el, [{ transform: moved(el, { y: d }), clipPath: footClip(d), opacity: "0" }, { opacity: "1", offset: 0.3 }, { transform: moved(el), clipPath: footClip(0), opacity: "1" }],
        { duration: ms(600), delay: ms(delay), fill: "backwards" });
    },
    /** In from the frame's edge it's nearest (data-from: t, l or r), outside in. */
    inward(el, delay) {
      animate(el, [{ opacity: "0", transform: moved(el, edgeOffset(el)) }, { opacity: "1", transform: moved(el) }],
        { duration: ms(520), delay: ms(delay), fill: "backwards" });
    },
  };
  // How far a piece rises out of its card: its whole height (and the gap to the card) unless it says.
  const emergeBy = (el) => parseFloat(el.dataset.travel) || Math.min(240, el.offsetHeight + 10);
  const footClip = (d) => `inset(-40px -40px ${d}px -40px)`;
  const edgeOffset = (el) => ({ t: { y: -24 }, l: { x: -28 }, r: { x: 28 }, b: { y: 24 } }[el.dataset.from] || { y: -24 });
  /**
   * A piece with its own way in leaves the same way back (from where it is,
   * now()), instead of the text lift: back into its card, back out to its edge.
   */
  const FX_OUT = {
    emerge(el, from, opts) {
      const d = emergeBy(el);
      animate(el, [{ transform: from.transform, clipPath: from.clipPath || footClip(0), opacity: String(from.opacity) }, { transform: moved(el, { y: d }), clipPath: footClip(d), opacity: "0" }], { fill: "forwards", ...opts });
    },
    inward(el, from, opts) {
      animate(el, [{ transform: from.transform, opacity: String(from.opacity) }, { transform: moved(el, edgeOffset(el)), opacity: "0" }], { fill: "forwards", ...opts });
    },
  };
  /** A beat (a row, a title) in: its own way if it has one, else the layout's rows (`slide`: from the left) or the text lift. */
  function beatIn(el, delay, m) {
    const fx = FX[el.dataset.fx];
    if (fx) return fx(el, delay);
    if (m.rows === "slide") {
      const rest = restOf(el);
      return animate(el, [pose(rest, { x: -18, blur: TEXT.in.blur, opacity: 0 }), pose(rest)], { duration: ms(TEXT.inMs), delay: ms(delay), fill: "backwards" });
    }
    return liftIn(el, delay);
  }
  /** A card (a ledger's glass, a strip) in: its own way, else from a little below (`slide` layouts: from the left). */
  function cardIn(el, delay, m) {
    const fx = FX[el.dataset.fx];
    if (fx) return fx(el, delay);
    const rest = restOf(el);
    const from = m.rows === "slide" ? { x: -24, scale: 0.985, opacity: 0 } : { y: 12, scale: 0.985, opacity: 0 };
    return animate(el, [pose(rest, from), pose(rest)], { duration: ms(560), delay: ms(delay), fill: "backwards" });
  }
  /** A share bar (who had more of it) fills out from its middle once its row is in. */
  function shareIn(el, delay) {
    animate(el, [{ clipPath: CLIP.mid0 }, { clipPath: CLIP.all }], { duration: ms(520), delay: ms(delay), fill: "backwards" });
  }

  // ── Fitting text ────────────────────────────────────────────────────────────
  // One-line values shrink to their width (Overlay.fitText); a sentence in a
  // fixed box steps its size down until it fits the box.

  const BOXES = ".strip, .mini, .stamp-in, .box-in, .reel-in, [data-rot], .foot-story, .pcap, .an, .cz";
  // Every box it sits in, not just the nearest: a rotating section grows with
  // its sentence (and is centred), so only the card round it says it's too big.
  function fitBox(el) {
    const boxes = [];
    for (let b = el.closest(BOXES); b && boxes.length < 3; b = b.parentElement && b.parentElement.closest(BOXES)) boxes.push(b);
    if (!boxes.length && el.parentElement) boxes.push(el.parentElement);
    if (!boxes.length) return;
    el.style.fontSize = "";
    const base = parseFloat(getComputedStyle(el).fontSize) || 16;
    const floor = Math.max(base * 0.6, Math.min(base, 11));
    const over = () => {
      const r = el.getBoundingClientRect();
      return boxes.some((b) => {
        const B = b.getBoundingClientRect();
        return b.scrollHeight > b.clientHeight + 1 || r.bottom > B.bottom + 1 || r.top < B.top - 1;
      });
    };
    let size = base;
    for (let i = 0; i < 14 && over() && size > floor; i++) {
      size = Math.max(floor, size * 0.93);
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
    // "auto": the layout the app picked for this show (statsShot.layout).
    const layout = PIN.layout || (cfg.layout === "auto" || cfg.layout === "random" ? shot && shot.layout : cfg.layout) || "spotlight";
    // The layout's saved combo rides along: style / pack "auto" draw it (layouts.js bestFit).
    const combos = cfg.combos && cfg.combos[layout] ? { [layout]: cfg.combos[layout] } : {};
    // Pack "random": the show's seed picks the poses (layouts.js randomPair), the same in every source.
    const seed = (shot && shot.seed) || 0;
    // The stage pictures: the first installed set's, unless the source pins one (or "none").
    return { layout, style: PIN.style || cfg.style, pack: PIN.pack || cfg.pack, stages: PIN.stages || undefined, mode, combos, seed };
  }
  const sigOf = (w) => JSON.stringify([w.layout, w.style, w.pack, w.stages, w.mode, w.combos, w.seed, data]);

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
    motion = r.motion || {};
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

  /**
   * Portraits in, the layout's way (see POR): through their outer edge — the
   * window's clip (or their card's) is the doorway — or uncovered from it, or
   * developing in place.
   */
  function portraitsIn(delay, scope = win, kind = "slide") {
    if (!scope) return;
    scope.querySelectorAll("[data-por]").forEach((el) => {
      const base = restOf(el).transform;
      const op = getComputedStyle(el).opacity;
      if (kind === "ride") {
        // Its card carries it in; only the style's touch is its own.
      } else if (kind === "wipe") {
        // In the portrait's own frame (the right one is mirrored), so the left edge is the outer one for both.
        animate(el, [{ clipPath: "inset(0px 100% 0px 0px)", opacity: "0" }, { clipPath: "inset(0px 88% 0px 0px)", opacity: op, offset: 0.12 }, { clipPath: CLIP.all, opacity: op }],
          { duration: ms(WIPE.inMs), delay: ms(delay), fill: "backwards" });
      } else if (kind === "develop") {
        animate(el, [{ filter: DEVELOP.from }, { filter: DEVELOP.to }], { duration: ms(DEVELOP.inMs), delay: ms(delay), fill: "backwards" });
        animate(el, [{ opacity: "0" }, { opacity: op }], { duration: ms(DEVELOP.fadeInMs), delay: ms(delay), fill: "backwards" });
      } else {
        const p = kind === "walkout" ? { ...POR, ...WALKOUT } : POR;
        animate(el, [{ transform: `${base} translateX(${p.travel})`.trim() }, { transform: base || "none" }], { duration: ms(p.inMs), delay: ms(delay), fill: "backwards" });
        animate(el, [{ opacity: "0" }, { opacity: op }], { duration: ms(p.fadeInMs), delay: ms(delay), fill: "backwards" });
      }
      piecesIn(el, delay);
    });
  }

  /**
   * The picture style's own touch, in any layout (STYLES[].pieces[].fx): riso's
   * second ink slides into register, a silhouette's rim catches the light a
   * beat after its figure, the scan lines roll down the picture.
   */
  function piecesIn(por, delay) {
    por.querySelectorAll("[data-pc]").forEach((pc) => {
      const kind = pc.dataset.pc;
      if (kind === "reg") {
        const [x, y] = String(pc.dataset.off || "0,0").split(",").map(Number);
        animate(pc, [{ transform: `translate(${x * 4}px, ${y * 4}px)` }, { transform: `translate(${x}px, ${y}px)` }], { duration: ms(900), delay: ms(delay + 160), fill: "backwards" });
      } else if (kind === "rim") {
        const op = getComputedStyle(pc).opacity;
        animate(pc, [{ opacity: "0" }, { opacity: op }], { duration: ms(480), delay: ms(delay + 260), fill: "backwards" });
      } else if (kind === "scan") {
        animate(pc, [{ clipPath: CLIP.top0 }, { clipPath: CLIP.all }], { duration: ms(700), delay: ms(delay + 120), fill: "backwards" });
      }
    });
  }

  /** The window's insides in: portraits from the outer edges, the cards, the corners, the rows top to bottom. */
  function enterInsides(delay = 0, { keepPor = false } = {}) {
    const m = motion;
    // The Tale of the tape's fighters walk out first; everything else waits `lead` for them.
    const lead = m.lead || 0;
    const own = (el) => parseFloat(el.dataset.delay) || 0;
    // Kept: only the window's portraits stay; those inside cards were redrawn with them.
    portraitsIn(delay + (m.por === "walkout" ? 40 : 120), keepPor ? win.querySelector(".content") : win, m.por);
    // The page's own furniture first (ruled lines, the clipboard's clip).
    win.querySelectorAll("[data-fx]").forEach((el) => {
      if (el.hasAttribute("data-beat") || el.hasAttribute("data-beat-card")) return;
      const fx = FX[el.dataset.fx];
      if (fx) fx(el, delay + 80 + own(el));
    });
    win.querySelectorAll("[data-beat-card]").forEach((el) => cardIn(el, delay + lead + 200 + own(el), m));
    win.querySelectorAll("[data-corner]").forEach((el) => { if (!el.dataset.fx) liftIn(el, delay + lead + 200); });
    // A plate that carries its insides (data-carry) is their one entrance.
    const beats = [...win.querySelectorAll("[data-beat]")].filter((el) => !el.closest("[data-carry]"));
    const off = cascadeOffsets(beats.length, CASCADE_IN);
    beats.forEach((el, i) => {
      const t = delay + lead + 240 + off[i] + own(el);
      beatIn(el, t, m);
      el.querySelectorAll(".share").forEach((s) => shareIn(s, t + 260));
    });
    ROT.start(rots);
  }

  /**
   * The window's insides out: rows top first, quickly, with the corners, and
   * the portraits back out to their edges (unless `keepPor`). Each starts from
   * where it is, so a hide in the middle of an entrance doesn't flash.
   */
  function exitInsides({ keepPor = false, quick = false } = {}) {
    ROT.stop();
    const content = win.querySelector(".content");
    const m = motion;
    // What a plate carries (data-carry) leaves with it.
    const beats = content ? [...new Set(content.querySelectorAll("[data-beat], [data-corner], [data-beat-card], [data-fx]"))].filter((el) => !(el.parentElement && el.parentElement.closest("[data-carry]"))) : [];
    const porScope = keepPor ? content : win; // kept: only the window's portraits stay
    // Portraits that ride in a card leave with it.
    const pors = porScope && m.por !== "ride" ? [...porScope.querySelectorAll("[data-por]")] : [];
    const from = new Map([...beats, ...pors].map((el) => [el, now(el)]));
    stopScripted(content);
    pors.forEach((el) => stopScripted(el, { subtree: false }));

    const off = cascadeOffsets(beats.length, quick ? CLOSE.cascade : CASCADE_OUT);
    const textMs = quick ? CLOSE.textMs : TEXT.outMs;
    const porMs = quick ? CLOSE.porMs : POR.outMs;
    const fadeMs = quick ? CLOSE.fadeMs : POR.fadeOutMs;
    beats.forEach((el, i) => {
      const back = FX_OUT[el.dataset.fx];
      if (back) {
        const f = from.get(el);
        if (f.opacity < 0.02) el.style.visibility = "hidden";
        else back(el, f, { duration: ms(textMs), delay: ms(off[i]) });
        return;
      }
      const rest = restOf(el);
      // Text drifts up out of focus; a card (glass, whose backdrop a blur
      // would smear — and too big a layer to blur) and the page's furniture
      // leave as they came, without one.
      const card = el.hasAttribute("data-beat-card") || (el.hasAttribute("data-fx") && !el.hasAttribute("data-beat"));
      const to = card ? pose(rest, { y: -6, scale: 0.985, opacity: 0 }) : pose(rest, { ...TEXT.out, opacity: 0 });
      if (card) delete to.filter;
      leave(el, from.get(el), to, { duration: ms(textMs), delay: ms(off[i]) });
    });
    pors.forEach((el) => {
      const f = from.get(el);
      if (f.opacity < 0.02) { el.style.visibility = "hidden"; return; }
      const base = restOf(el).transform;
      if (m.por === "wipe") {
        // Back into their margin: covered from the inner edge out.
        animate(el, [{ clipPath: f.clipPath || CLIP.all, opacity: String(f.opacity) }, { clipPath: "inset(0px 100% 0px 0px)", opacity: "0" }], { duration: ms(quick ? porMs : WIPE.outMs), fill: "forwards" });
        return;
      }
      if (m.por === "develop") {
        animate(el, [{ opacity: String(f.opacity) }, { opacity: "0" }], { duration: ms(fadeMs), fill: "forwards" });
        return;
      }
      const travel = m.por === "walkout" ? WALKOUT.travel : POR.travel;
      animate(el, [{ transform: f.transform }, { transform: `${base} translateX(${travel})`.trim() }], { duration: ms(porMs), fill: "forwards" });
      animate(el, [{ opacity: String(f.opacity) }, { opacity: "0" }], { duration: ms(fadeMs), fill: "forwards" });
    });
    const lastOff = off[off.length - 1] || 0;
    return { lastOff, ms: Math.max(ms(lastOff + textMs), pors.length ? ms(porMs) : 0) };
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
    if (motion.win === "none") {
      // The whole frame, no background (the Condensed pieces): only its pieces move.
    } else if (motion.win === "wipe") {
      // The Lower third opens out from its middle, like a bar run across the screen.
      animate(win, [{ clipPath: WIN_WIPE.mid, opacity: "0" }, { clipPath: "inset(-80px 48% -80px 48%)", opacity: "1", offset: 0.06 }, { clipPath: WIN_WIPE.full, opacity: "1" }],
        { duration: ms(WIN_WIPE.inMs), delay: ms(delay), fill: "backwards" });
    } else {
      animate(win, [lift(rest, { y: 24, scale: 0.97, opacity: 0 }), lift(rest, {})], { duration: ms(560), delay: ms(delay), fill: "backwards" });
    }
    enterInsides(delay); // not awaited: a Hide or a swap cuts straight into an entrance
  }

  async function exit() {
    const winFrom = now(win);
    const { lastOff, ms: insides } = exitInsides({ quick: true });
    stopScripted(win, { subtree: false });
    const rest = restOf(win);
    const winMs = CLOSE.winMs;
    const winDelay = lastOff + CLOSE.winDelay;
    if (motion.win === "none") {
      animate(win, [{ opacity: String(winFrom.opacity) }, { opacity: "0" }], { duration: ms(winMs), delay: ms(winDelay), fill: "forwards" });
    } else if (motion.win === "wipe") {
      animate(win, [{ clipPath: winFrom.clipPath || WIN_WIPE.full, opacity: String(winFrom.opacity) }, { clipPath: "inset(-80px 46% -80px 46%)", opacity: String(winFrom.opacity), offset: 0.8 }, { clipPath: WIN_WIPE.mid, opacity: "0" }],
        { duration: ms(winMs), delay: ms(winDelay), fill: "forwards" });
    } else {
      animate(win, [{ opacity: String(winFrom.opacity), transform: winFrom.transform }, lift(rest, { y: -12, scale: 0.985, opacity: 0 })],
        { duration: ms(winMs), delay: ms(winDelay), fill: "forwards" });
    }
    await wait(Math.max(insides, ms(winDelay + winMs)) + 30);
    up = false;
    drawn = null;
    portraitsDrawn = null;
    motion = {};
    stopScripted(win);
    win.className = "win";
    delete win.dataset.skin;
    win.innerHTML = "";
  }

  /** Something different while up: the insides out, redrawn, back in; the window stays. */
  async function swap(w) {
    const r = Layouts.render(data, w);
    // Portraits stay only if they'd be drawn the same and the new layout doesn't bring them in its own way.
    const keepPor = r.portraits === portraitsDrawn && (r.motion || {}).por === motion.por;
    const out = exitInsides({ keepPor }); // the old layout's way out; build() then takes the new one's
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
      // Never leave half a popup on stream: clear the window back to down, so the
      // next change draws from scratch (and a Hide still works).
      console.error("[set-stats] draw failed", err);
      reset();
    } finally {
      running = false;
    }
    // A change that came in while the failed draw ran still gets its turn.
    if (again) setTimeout(reconcile, 0);
  }

  /** Down, now, with nothing animating and nothing left over. */
  function reset() {
    try { ROT.stop(); } catch (_) { /* nothing to stop */ }
    try { stopScripted(win); } catch (_) { /* nothing animating */ }
    up = false;
    drawn = null;
    drawnBox = null;
    portraitsDrawn = null;
    motion = {};
    win.className = "win";
    delete win.dataset.skin;
    placeWindow(null);
    win.innerHTML = "";
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
    /** The rotating sections on screen ({ id, items }), and the fitting a rotation runs on each item. */
    get rots() { return rots; },
    fit,
    reconcile,
  };
})();
