# 009 (idea A) — Header hairlines draw outward from their label

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–007 applied)
- **Severity**: LOW
- **Category**: Missed opportunities (delight)
- **Estimated scope**: 2 files, ~35 lines

## Problem

Each side-panel section header ("Current Run", "Recent Results", "Head to
Head"'s "Recent Sets", "Just Finished") is a label between two hairlines
drawn by `::before` / `::after`; the LuckyStats credit has the same pair:

```css
/* overlays/side-panel/side-panel.css:398-419 — current */
.panel-header::before,
.panel-header::after {
  content:    "";
  flex:       1;
  height:     1px;
  background: linear-gradient( … );
}

/* overlays/side-panel/side-panel.css:720-726 — current */
.lucky-credit::before,
.lucky-credit::after {
  content:    "";
  width:      28px;
  height:     1px;
  background: rgba(var(--trim-rgb, var(--text-color-rgb)), 0.4);
}
```

After plans 003–007, a header arrives as one beat of the cascade, lines and
all. The lines are the natural second rhythm of the cascade: they should
draw outward from the label once it lands, marking each section as the wave
passes.

## Target

- When a `.panel-header` or `.lucky-credit` beat comes in, its `::before` grows from its right end (next to the label) and its `::after` from its left end: `transform: scaleX(0)` → `scaleX(1)`, **560ms** (tempo 1) on `--ease-out`, starting `delay + ms(BEAT_IN_MS) × 0.3` (once the label is visibly arriving), `fill: backwards` (held at 0 until then).
- Web Animations' `pseudoElement` option (Chromium 84+; OBS's CEF is Chromium 103).
- `stopAnims(el)` must also cancel `el`'s own `::before`/`::after` animations — but never its children's (cancelling a child's `Overlay.swap()` animation from outside would wedge it). In a browser, `el.getAnimations()` excludes pseudo-element animations; `getAnimations({ subtree: true })` includes them and the children's, so filter to `a.effect.target === el` (a pseudo-element animation's effect target is its originating element). The test sandbox's animations have no `effect`, and its `getAnimations()` returns only the element's own — keep those.

## Repo conventions to follow

- The beat hooks live in `beatsIn()` in `overlays/side-panel/side-panel.js`; durations are tempo-1 constants in the constants block, passed through `ms()`.

## Steps

1. `overlays/side-panel/side-panel.css`:
   - After the `.panel-header::after { background: linear-gradient(to left, … ); }` rule (ends line 419), add:
     ```css

     /* Origins for the hairlines' draw-in (side-panel.js): each grows outward
        from the label it frames. */
     .panel-header::before, .lucky-credit::before { transform-origin: right center; }
     .panel-header::after,  .lucky-credit::after  { transform-origin: left center; }
     ```

2. `overlays/side-panel/side-panel.js`:
   - In the constants block, after `const BEAT_IN      = { y: 10, blur: 3 };`, add:
     ```js
       const RULE_MS      = 560;     // a header's hairlines drawing out from its label
     ```
   - Replace `stopAnims`:
     ```js
       function stopAnims(el) {
         if (el?.getAnimations) el.getAnimations().forEach((a) => a.cancel());
       }
     ```
     with:
     ```js
       /**
        * Cancel what's animating on `el` itself — its ::before / ::after included
        * (getAnimations() alone leaves those out), never its children's: an
        * Overlay.swap() cancelled from outside would never draw its new content.
        */
       function stopAnims(el) {
         if (!el?.getAnimations) return;
         el.getAnimations({ subtree: true }).forEach((a) => {
           if (!a.effect || a.effect.target === el) a.cancel();
         });
       }
     ```
   - In `beatsIn`, after the `tween(b, …);` statement inside the `forEach`, add:
     ```js
           if (b.classList.contains("panel-header") || b.classList.contains("lucky-credit")) drawRules(b, delays[i]);
     ```
   - Directly after `beatsIn`, add:
     ```js

       /** A header's hairlines draw outward from its label, once the label is arriving. */
       function drawRules(el, delay) {
         for (const pseudoElement of ["::before", "::after"]) {
           el.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
             { pseudoElement, duration: ms(RULE_MS), delay: delay + ms(BEAT_IN_MS) * 0.3, easing: ease("out"), fill: "backwards" });
         }
       }
     ```

## Boundaries

- Only the two files above. Do NOT change the hairlines' look, the header layout, or other beats.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted block doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes.
- **Feel check** (`/o/side-panel?panel=player-1`, reload to replay): as "Current Run" rises in, its two lines grow out from the words to the card edges; same for "Recent Results" and the credit's short dashes. At 10% in DevTools → Animations each header shows two extra animations on `::before` / `::after`. Hidden-then-shown again (full rotation), the lines draw again each time; they are never missing at rest.
- **Done when**: header and credit lines draw outward on every entrance, tests pass.
