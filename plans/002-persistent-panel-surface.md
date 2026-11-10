# 002 — Give the info panels one tint layer that stays put

- **Status**: DONE
- **Commit**: ada0741 (assumes plan 001 applied)
- **Severity**: MEDIUM
- **Category**: Physicality & origin
- **Estimated scope**: 3 files, ~35 lines

## Problem

Each rotating info panel paints its own tint, on the same element whose
opacity the rotation animates:

```css
/* overlays/side-panel/side-panel.css:344-357 — current */
/* Base panel — hidden by default; side-panel.js animates opacity/scale */
.info-panel {
  position:   absolute;
  inset:      0;
  opacity:    0;
  display:    flex;
  flex-direction: column;
  gap:        8px;
  padding:    20px 18px;
  background: rgba(var(--score-bg-color-rgb), 0.65);
  border-radius: var(--border-radius);
  overflow:   hidden;
  pointer-events: none;
}
```

So on every panel-to-panel rotation the card's colour fades out and back
(and the two tints stack while the panels overlap). The surface should be
the stage, not part of the performance: it stays put from panel to panel and
only fades when the rotation goes between a logo (no tint) and an info panel.
This also frees later plans to animate a panel's rows on their own, with
nothing behind them blinking.

## Target

- A new element `.panel-surface` (first child of `.panel-slot-content`) carries the tint: `rgba(var(--score-bg-color-rgb), 0.65)`, `border-radius: var(--border-radius)`, `position: absolute; inset: 0; opacity: 0; pointer-events: none`.
- `.info-panel` has no `background`.
- The rotation fades the surface **in** (`SURFACE_IN_MS` = 440, `--ease-out`, starting when the incoming panel starts) when an info panel comes in over a logo, and **out** (`SURFACE_OUT_MS` = 300, `--ease-out`, at once) when a logo comes in. Panel → panel and logo → logo leave it untouched.

## Repo conventions to follow

- Motion is Web Animations through the file's own `tween(el, frames, rest, { duration, delay, easing })` (`side-panel.js:228`), which commits the resting style when it finishes. Durations are tempo-1 constants passed through `ms()`; curves come from `ease("out")`.
- Exemplar: the incoming panel's tween in `_transitionTo` (`side-panel.js:349-351`).

## Steps

1. `overlays/side-panel/index.html` — line 46 is `      <div class="panel-slot-content">`. Directly after it, insert:

   ```html

        <!-- The tint every info panel sits on: one layer that stays put from
             panel to panel and fades only between a logo and a panel. -->
        <div class="panel-surface"></div>
   ```

2. `overlays/side-panel/side-panel.css`:
   - In the `.info-panel` rule (lines 344-357) delete the line `  background: rgba(var(--score-bg-color-rgb), 0.65);`, and change the comment above it to `/* Base panel — hidden by default; side-panel.js shows it and animates its rows */`.
   - Directly after the `.panel-slot-content { … }` rule (ends line 342), add:

   ```css

   /* The info panels' shared tint. Not on .info-panel itself: a panel's own
      opacity is animated, and the card's colour would blink with it. */
   .panel-surface {
     position:       absolute;
     inset:          0;
     opacity:        0;
     background:     rgba(var(--score-bg-color-rgb), 0.65);
     border-radius:  var(--border-radius);
     pointer-events: none;
   }
   ```

3. `overlays/side-panel/side-panel.js`:
   - After the line `const PILL_STAGGER   = 55;      // between pills` (line 41), add:
     ```js
     const SURFACE_IN_MS  = 440;     // the panels' shared tint, under a panel coming in…
     const SURFACE_OUT_MS = 300;     // …and away as a logo comes in
     ```
   - In `class Rotator`, add this method directly after `_isLogo(id) { … }` (before the class's closing brace):
     ```js
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
     ```
   - In `_transitionTo`, the line `const logo = this._isLogo(id);` (line 348). Directly after it, add:
     ```js
           this._surface(!logo, delay);
     ```

## Boundaries

- Do NOT change `_hideAllExcept` or `restart()`: the surface is never "stranded" — the next transition always sets it to the right state.
- Do NOT touch the logos, the pills, the toast, or any other overlay.
- Do NOT add dependencies. Do NOT edit docs.
- If a quoted line doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes; `node tests/side-panel.test.js` shows every test `ok`.
- **Feel check** (`http://localhost:5001/o/side-panel` with a set loaded so player cards rotate; or `?panel=player-1` to hold one): over a full rotation, panel → panel the card's colour does not change at all; logo → panel the tint rises with the panel; panel → logo it drains away as the logo arrives. In DevTools → Animations at 10%, no frame shows the tint darker than at rest (no stacking).
- **Done when**: `.info-panel` has no background, `.panel-surface` exists and only animates on logo↔panel transitions.
