# 005 — Cascade the rows out too

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–004 applied)
- **Severity**: HIGH
- **Category**: Missed opportunities / interruptibility
- **Estimated scope**: 1 file, ~70 lines

## Problem

After plan 004 an info panel's rows cascade in, but it still leaves as one
slab — the whole container lifts away:

```js
/* overlays/side-panel/side-panel.js — current (after plan 004), in _transitionTo */
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
```

The show is a cascade but the hide isn't, so every rotation reads as "list
disappears, list builds" rather than one motion. The pills should leave the
way they came: top first, in a quick wave.

## Target

- An outgoing **info panel** stays at opacity 1 while its beats leave: each beat from where it is to `{ y: -8px, blur: 2px, opacity: 0 }`, **200ms** (tempo 1) on `--ease-out`, `fill: both`, in the same top-to-bottom order, with a faster cascade: `CASCADE_OUT = { gap: 36, min: 14, max: 240 }` through the existing `cascadeOffsets()` (offsets for 14 rows: 0, 35, 65, 90, 111, 129, 145, 159, 172, 186, 199, 213, 226, 240).
- When **all** its beats have finished leaving, the panel is settled hidden: container `opacity: 0`, then each beat's inline style reset to rest (`opacity: 1`) for the next time it shows — in the same task, so nothing flashes.
- The incoming starts when the outgoing is gone: after the last outgoing beat finishes (panel), or half-way through the logo's 300ms exit (logo — ~97% gone by then on `--ease-out`). Plan 006 overlaps this more cleverly.
- A panel taken over mid-exit (shown again, or hidden outright by a restart) must not be settled late by the stale exit: each exit gets a token in `this._busy[id]`, and only the matching token settles it.
- `PANEL_OUT_MS` / `PANEL_OUT` are removed.

## Repo conventions to follow

- Exemplars: `beatsIn()` and `cascadeOffsets()` under `// ── Beats ──` in the same file.
- The "stranded panels" test in `tests/side-panel.test.js` (`loading a set with a player card on screen restarts once`) requires that, ~30ms later at the sandbox's 0.01 time scale, the panel that left has `style.opacity !== "1"` and no animation on the panel element itself. Settling on the beats' `finished` promises (which the sandbox resolves on its scaled timer) satisfies that; a plain `setTimeout` of the real duration would not.

## Steps

1. `overlays/side-panel/side-panel.js` — replace these lines in the constants block:
   ```js
     // An outgoing info panel still leaves whole, lifting away.
     const PANEL_OUT_MS = 300;
     const PANEL_OUT    = { y: -12, blur: 6 };
   ```
   with:
   ```js
     // They leave the same way, top first, quicker: each drifts up and away.
     const BEAT_OUT_MS = 200;
     const BEAT_OUT    = { y: -8, blur: 2 };
     const CASCADE_OUT = { gap: 36, min: 14, max: 240 };
   ```

2. Same file — directly after `cascadeOffsets()`, add:
   ```js

     /**
      * Take beats out, beat i starting at delays[i] (ms, already at tempo), each
      * from wherever it is now. They hold invisible (fill: both) until the
      * caller hides their panel. Returns the animations.
      */
     function beatsOut(beats, delays) {
       return beats.map((b, i) => {
         const from = getComputedStyle(b).opacity;
         stopAnims(b);
         const rest = restOf(b);
         return b.animate([pose(rest, { opacity: from }), pose(rest, { ...BEAT_OUT, opacity: 0 })],
           { duration: ms(BEAT_OUT_MS), delay: delays[i], easing: ease("out"), fill: "both" });
       });
     }
   ```

3. In `class Rotator`'s constructor, after `this._run = 0; …`, add:
   ```js
         this._busy    = {};  // panel id → a token while its beats are leaving
   ```

4. Replace `_hideAllExcept(keep) { … }` (the whole method, with its doc comment kept) with:
   ```js
       _hideAllExcept(keep) {
         for (const id of PANEL_ORDER) {
           if (keep.includes(id)) continue;
           const el = this._el(id);
           if (el) this._settleHidden(id, el);
         }
       }

       /** A panel off screen: hidden outright, then its beats back at rest for the next time it shows. */
       _settleHidden(id, el) {
         delete this._busy[id];
         setStyle(el, HIDDEN);
         beatsOf(el).forEach((b) => setStyle(b, SHOWN));
       }
   ```

5. In `_transitionTo`, replace the whole `// Out. …` block (from the comment `// Out. The incoming starts half-way through: …` through the closing `}` of `if (outgoing && outgoing !== incoming) { … }`) with:
   ```js
         // Out: a logo drifts away whole; an info panel stays put while its beats
         // cascade out, top first. The incoming starts once the outgoing is gone
         // (a logo: half-way, when --ease-out has it ~97% gone).
         let start = 0;
         if (outgoing && outgoing !== incoming) {
           const token = this._busy[leaving] = {};
           let anims;
           if (this._isLogo(leaving)) {
             const from = getComputedStyle(outgoing).opacity;
             stopAnims(outgoing);
             const rest = restOf(outgoing);
             anims = [outgoing.animate([pose(rest, { opacity: from }), pose(rest, { ...LOGO_OUT, opacity: 0 })],
               { duration: ms(LOGO_OUT_MS), easing: ease("out"), fill: "forwards" })];
             start = ms(LOGO_OUT_MS) * 0.5;
           } else {
             const beats = beatsOf(outgoing);
             const delays = cascadeOffsets(beats.length, CASCADE_OUT).map(ms);
             anims = beatsOut(beats, delays);
             start = delays.length ? delays[delays.length - 1] + ms(BEAT_OUT_MS) : 0;
           }
           // Settled once everything has gone — unless the panel was taken over
           // meanwhile (shown again, or hidden outright by a restart).
           Promise.all(anims.map((a) => a.finished)).then(() => {
             if (this._busy[leaving] === token) this._settleHidden(leaving, outgoing);
           }, () => {});
         }
         delete this._busy[id];
   ```
   (The `// In. …` block that follows is unchanged.)

6. Confirm `PANEL_OUT` appears nowhere.

## Boundaries

- Only `side-panel.js`. Do NOT change the entrance, the logo poses, the surface, rendering, or the toast.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted block doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes — in particular `side-panel.test.js`'s "restarts once (that card can't stay up)" and its stranded-panel assertion.
- **Feel check** (full rotation at `/o/side-panel`): a panel's rows now leave top-first in a quick upward wave (~0.9s on air at tempo 2), and only then does the next panel cascade in — no instant where two panels' text overlaps. Logo → panel: the logo drifts forward and the rows start as it fades. At 10% in DevTools → Animations: the leaving container itself never animates; the last leaving row is gone before the container's opacity flips to 0.
- **Done when**: both directions cascade, `PANEL_OUT*` are gone, tests pass.
