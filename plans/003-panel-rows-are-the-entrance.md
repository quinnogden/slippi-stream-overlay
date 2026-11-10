# 003 — An info panel stands still; its rows ("beats") are the entrance

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001 and 002 applied)
- **Severity**: HIGH
- **Category**: Cohesion & tokens (choreography)
- **Estimated scope**: 1 file (`overlays/side-panel/side-panel.js`), two blocks replaced, ~120 lines

## Problem

The incoming info panel animates as a container **and** its pills stagger
inside it: two layers of entrance. The container rises 16px out of a 10px
blur over 760ms (tempo 1), while only `.panel-pill`s cascade, starting 120ms
in, 55ms apart:

```js
/* overlays/side-panel/side-panel.js — current (after plan 001) */
  const PANEL_IN   = { y: 16, scale: 0.985, blur: 10 };
  const PILL_IN    = { y: 14, blur: 4 };
  …
      stopAnims(incoming);
      const rest = restOf(incoming);
      const logo = this._isLogo(id);
      this._surface(!logo, delay);
      tween(incoming, [pose(rest, { ...(logo ? LOGO_IN : PANEL_IN), opacity: 0 }), pose(rest)], SHOWN,
        { duration: ms(IN_MS), delay, easing: ease("out") })
        .finished.then(() => { if (run === this._run) onDone(); }, () => {});

      // The pills rise in top to bottom as the panel settles.
      if (!logo) {
        incoming.querySelectorAll(".panel-pill").forEach((pill, i) => {
          stopAnims(pill);
          const pr = restOf(pill);
          tween(pill, [pose(pr, { ...PILL_IN, opacity: 0 }), pose(pr)], SHOWN,
            { duration: ms(PILL_MS), delay: delay + ms(PILL_DELAY + i * PILL_STAGGER), easing: ease("out") });
        });
      }
```

Consequences on stream: the player's name, the "Current Run" / "Recent
Results" headers, the head-to-head header and projection, and the LuckyStats
credit all arrive with the panel in one blurred lump; the pills' cascade is
smeared under the container's own rise and blur; and a 10px blur over the
whole ~587×700 panel, with each pill blurring inside it, is the most
expensive thing the side panel draws.

## Target

- The info panel container **never moves**: when it becomes current it is set to opacity 1 at once (it has no tint of its own since plan 002).
- Everything it shows comes in as **beats**, in reading order: each visible child of the panel, except that the lists (`.run-list`, `.history-list`, `.sets-list`, `.completed-list`, `.crew-list`) and the head-to-head header block (`.h2h-header`) are opened up into their own children. A child with inline `display: none` (an empty list and its header, a hidden credit, a hidden rank) is skipped.
  - Player card → identity · header · run pills · header · result pills · credit
  - Head-to-head → header · `.h2h-row` · `.h2h-projection` · set pills · credit
- Each beat: from `{ y: 10px, blur: 3px, opacity: 0 }` to rest, **440ms** (tempo 1) on `--ease-out`, held invisible until its turn (`fill: both`), its rest (opacity 1) committed when done.
- Beat *i* starts at `start + ms(i × 55)` for now (plan 004 replaces this uniform stagger). `start` is half the outgoing animation's duration (on `--ease-out` the old one is ~97% gone by then).
- The outgoing info panel still leaves whole for now (`PANEL_OUT` = `{ y: -12, blur: 6 }`, 300ms) — plan 005 replaces that.
- Logos unchanged: in `{ scale: 0.92, blur: 12 }` over 760ms, out `{ scale: 1.04, blur: 8 }` over 300ms.
- The rotation's "done" (which arms the 20s dwell) fires on a timer at the moment the last beat (or the logo) lands — not on an animation promise, so a later plan cancelling a beat can never stall the rotation.

## Repo conventions to follow

- `tween()` / `setStyle()` / `stopAnims()` in this file; `pose()` / `restOf()` / `ease()` / `ms()` from `Overlay.motion` (`overlays/shared/overlay-client.js:204-254`). Durations written at tempo 1 and passed through `ms()`.
- `tests/side-panel.test.js` drives this in a fake DOM (`tests/helpers/overlay-sandbox.js`): its `children` array includes text nodes (hence `elementsOf()`), animations finish on a timer, and the "stranded panels" test asserts that after a restart no panel but the visible one has `style.opacity === "1"` or a running animation **on the panel element itself**.

## Steps

1. `overlays/side-panel/side-panel.js` — replace everything from the line
   `  // Animation durations are at tempo 1; Overlay.motion.ms() scales them by`
   through the line
   `  const PILL_IN    = { y: 14, blur: 4 };`
   (inclusive) with:

   ```js
     // Animation durations are at tempo 1; Overlay.motion.ms() scales them by
     // overlay.css's --motion-tempo. The interval is a dwell, and doesn't.
     const PANEL_INTERVAL = 20000;   // ms per slot, logos included
     const H2H_SHOWN      = 7;       // the pair's newest sets on the head-to-head (the app sends 7)
     const HOLD_PANEL     = param("panel");

     // A crew battle has only the logos and the crews; a set never has the crews.
     const PANEL_ORDER = [
       "logo-primary", "crew-1",
       "player-1", "player-2", "recent-sets",
       "logo-sponsor", "crew-2", "completed-sets",
     ];

     // Resting states, as inline style. Motion lives in the keyframes below.
     const HIDDEN = { opacity: "0", transform: "", filter: "" };
     const SHOWN  = { opacity: "1", transform: "", filter: "" };

     // A logo comes and goes whole: it focuses in from slightly small and leaves
     // drifting forward — artwork reads better growing than sliding.
     const LOGO_IN_MS  = 760;
     const LOGO_OUT_MS = 300;
     const LOGO_IN     = { scale: 0.92, blur: 12 };
     const LOGO_OUT    = { scale: 1.04, blur: 8 };

     // An info panel itself never moves. Its rows — "beats": the identity, each
     // header, each pill, the projection, the credit — come in one after another,
     // top to bottom, each rising a little out of a soft focus.
     const BEAT_IN_MS   = 440;
     const BEAT_IN      = { y: 10, blur: 3 };
     const BEAT_STAGGER = 55;       // between beats

     // An outgoing info panel still leaves whole, lifting away.
     const PANEL_OUT_MS = 300;
     const PANEL_OUT    = { y: -12, blur: 6 };

     // The panels' shared tint (.panel-surface).
     const SURFACE_IN_MS  = 440;
     const SURFACE_OUT_MS = 300;
   ```

2. Same file — replace everything from the line
   `  // ── Animation ───────────────────────────────────────────────────────────────`
   through the closing `  }` of `class Rotator` (the line just before `  const rotator = new Rotator();`) with:

   ```js
     // ── Animation ───────────────────────────────────────────────────────────────
     //
     // Web Animations, with the resting state committed to inline style when they
     // finish, so nothing is left filling and a panel's resting state is always
     // readable from its style. Only opacity is committed: the transform and
     // blur are motion, and a logo's own CSS filter must stay the stylesheet's.

     function stopAnims(el) {
       if (el?.getAnimations) el.getAnimations().forEach((a) => a.cancel());
     }

     function tween(el, frames, rest, { duration, delay = 0, easing }) {
       const anim = el.animate(frames, { duration, delay, easing, fill: "both" });
       anim.finished.then(() => { Object.assign(el.style, rest); anim.cancel(); }, () => {});
       return anim;
     }

     function setStyle(el, styles) {
       stopAnims(el);
       Object.assign(el.style, styles);
     }

     // ── Beats ───────────────────────────────────────────────────────────────────
     //
     // An info panel animates as its rows, never as a whole. Each row that's
     // showing is a beat; the lists (and the head-to-head's header block) open
     // up into their own rows.

     const BEAT_GROUPS = ["run-list", "history-list", "sets-list", "completed-list", "crew-list", "h2h-header"];

     /** Element children only (the test sandbox's `children` holds text nodes too). */
     const elementsOf = (el) => Array.from(el.children).filter((c) => c.nodeType === 1);

     /** A panel's beats, in reading order. */
     function beatsOf(el) {
       const out = [];
       for (const child of elementsOf(el)) {
         if (child.style.display === "none") continue;
         if (BEAT_GROUPS.some((c) => child.classList.contains(c))) out.push(...beatsOf(child));
         else out.push(child);
       }
       return out;
     }

     /**
      * Bring beats in, beat i starting at delays[i] (ms, already at tempo). Each
      * holds invisible until its turn (fill: both) and commits its rest once in.
      */
     function beatsIn(beats, delays) {
       beats.forEach((b, i) => {
         stopAnims(b);
         const rest = restOf(b);
         tween(b, [pose(rest, { ...BEAT_IN, opacity: 0 }), pose(rest)], SHOWN,
           { duration: ms(BEAT_IN_MS), delay: delays[i], easing: ease("out") });
       });
     }

     // ── Rotation ────────────────────────────────────────────────────────────────

     class Rotator {
       constructor() {
         this._slots   = ["logo-primary"];
         this._index   = 0;
         this._timer   = null;
         this._current = null;
         this._run     = 0;   // bumped per transition; a stale one's onDone is dropped
       }

       buildSlots() {
         const active = PANEL_ORDER.filter(slotHasContent);
         const next = active.length > 0 ? active : ["logo-primary"];
         const changed = next.length !== this._slots.length || next.some((id, i) => id !== this._slots[i]);
         this._slots = next;
         if (!changed || !this._current) return;

         // The visible panel survived: leave it on screen for its full dwell and
         // just re-aim the cursor at whatever follows it now. Restarting here
         // instead flashes the logo — slot 0 — on every stats answer.
         const pos = this._slots.indexOf(this._current);
         if (pos !== -1) {
           this._index = (pos + 1) % this._slots.length;
           return;
         }
         // The visible panel has dropped out. It must not stay on screen, and only
         // a restart guarantees nothing is left stacked underneath it.
         this.restart();
       }

       start() {
         this._advance();
       }

       /**
        * Cancel the pending advance and any transition in flight, force every
        * panel but the visible one hidden, and rotate from the top. The current
        * panel is kept so it still leaves rather than cutting.
        */
       restart() {
         clearTimeout(this._timer);
         this._run++;
         this._hideAllExcept([this._current]);
         this._index = 0;
         this._advance();
       }

       /**
        * Panels are absolutely stacked and only opacity separates them, so a
        * panel abandoned mid-fade would stay visible under the next one. This
        * sets the hidden state outright rather than trusting a fade to finish,
        * and puts its beats back at rest for the next time it shows.
        */
       _hideAllExcept(keep) {
         for (const id of PANEL_ORDER) {
           if (keep.includes(id)) continue;
           const el = this._el(id);
           if (!el) continue;
           setStyle(el, HIDDEN);
           beatsOf(el).forEach((b) => setStyle(b, SHOWN));
         }
       }

       _advance() {
         clearTimeout(this._timer);
         if (HOLD_PANEL) {
           this._transitionTo(HOLD_PANEL, () => {});
           return;
         }
         const id = this._slots[this._index];
         this._index = (this._index + 1) % this._slots.length;
         this._transitionTo(id, () => {
           this._timer = setTimeout(() => this._advance(), PANEL_INTERVAL);
         });
       }

       _el(id) {
         if (id === "logo-primary") return document.querySelector(".logo-primary");
         if (id === "logo-sponsor") return document.querySelector(".logo-sponsor");
         return document.getElementById("panel-" + id);
       }

       _transitionTo(id, onDone) {
         const incoming = this._el(id);
         if (!incoming) { onDone(); return; }
         const outgoing = this._current ? this._el(this._current) : null;
         // A one-slot rotation advancing onto itself: already showing, so no blink.
         if (outgoing === incoming && id === this._current) { onDone(); return; }

         // Nothing but these two may be on screen — so a stray panel can never
         // survive more than one transition.
         this._hideAllExcept([id, this._current]);
         const leaving = this._current;
         this._current = id;
         const run = ++this._run;

         // Out. The incoming starts half-way through: on --ease-out the old one
         // is ~97% gone by then, so the two never read on top of each other.
         let start = 0;
         if (outgoing && outgoing !== incoming) {
           const logoOut = this._isLogo(leaving);
           const dur = ms(logoOut ? LOGO_OUT_MS : PANEL_OUT_MS);
           const from = getComputedStyle(outgoing).opacity;
           stopAnims(outgoing);
           const rest = restOf(outgoing);
           tween(outgoing, [pose(rest, { opacity: from }), pose(rest, { ...(logoOut ? LOGO_OUT : PANEL_OUT), opacity: 0 })],
             HIDDEN, { duration: dur, easing: ease("out") });
           start = dur * 0.5;
         }

         // In. A logo arrives whole; an info panel appears at once (it has no
         // surface of its own) and its beats hold invisible until their turn.
         const logo = this._isLogo(id);
         this._surface(!logo, start);
         let end;
         if (logo) {
           stopAnims(incoming);
           const rest = restOf(incoming);
           tween(incoming, [pose(rest, { ...LOGO_IN, opacity: 0 }), pose(rest)], SHOWN,
             { duration: ms(LOGO_IN_MS), delay: start, easing: ease("out") });
           end = start + ms(LOGO_IN_MS);
         } else {
           setStyle(incoming, SHOWN);
           const beats = beatsOf(incoming);
           const delays = beats.map((_, i) => start + ms(i * BEAT_STAGGER));
           beatsIn(beats, delays);
           end = (delays.length ? delays[delays.length - 1] : start) + ms(BEAT_IN_MS);
         }
         // On a timer, not an animation's promise: a beat cancelled later (a
         // re-render) must never stall the rotation.
         setTimeout(() => { if (run === this._run) onDone(); }, end);
       }

       _isLogo(id) {
         return Boolean(id) && id.startsWith("logo-");
       }

       /**
        * The panels' shared tint: in under an info panel, out under a logo,
        * left alone between two of the same kind. `delay` lines its fade-in
        * up with the incoming panel.
        */
       _surface(on, delay) {
         const el = document.querySelector(".panel-surface");
         if (!el || el.__on === on) return;
         el.__on = on;
         const from = getComputedStyle(el).opacity;
         const to = on ? "1" : "0";
         stopAnims(el);
         tween(el, [{ opacity: from }, { opacity: to }], { opacity: to },
           { duration: ms(on ? SURFACE_IN_MS : SURFACE_OUT_MS), delay: on ? delay : 0, easing: ease("out") });
       }
     }
   ```

3. Search the file for `PILL_`, `PANEL_IN`, `IN_OVERLAP`, `OUT_MS` (other than `LOGO_OUT_MS`, `PANEL_OUT_MS`, `SURFACE_OUT_MS`) and `IN_MS` (other than `LOGO_IN_MS`, `BEAT_IN_MS`, `SURFACE_IN_MS`) — there must be no other references. Update the file's header comment only if it mentions pills rising; leave the rest.

## Boundaries

- Do NOT touch rendering functions (`renderPlayerCard`, etc.), the toast, the views, `refresh()`, or any CSS/HTML.
- Do NOT add new tests or dependencies. Do NOT edit docs.
- If a quoted line doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes (all of `side-panel.test.js` `ok`, especially "loading a set with a player card on screen restarts once").
- **Feel check** (`http://localhost:5001/o/side-panel?panel=player-1` with a set loaded, then plain `/o/side-panel` for a full rotation): the panel's tint never moves; the player's name lands first, then "Current Run", then each run pill, then "Recent Results" and its pills, then the credit — a visible top-to-bottom cascade. In DevTools → Animations at 10%: no animation runs on `.info-panel` elements themselves, only on their rows; no row is visible before its turn.
- **Done when**: info panels animate only through their beats, the old pill-only stagger is gone, tests pass.
