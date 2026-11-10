# 010 (idea B) — The win-projection bar fills from even to the real odds

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–007 and 009 applied)
- **Severity**: LOW
- **Category**: Missed opportunities (delight)
- **Estimated scope**: 2 files, ~25 lines

## Problem

On the head-to-head card, luckystats' win projection is a gradient bar
whose colours meet at the left player's chance, set as `--p` by script:

```js
/* overlays/side-panel/side-panel.js — projectionRow(), current */
    const bar = h("div", "prob-bar");
    bar.style.setProperty("--p", pct(prob[0]));
    bar.appendChild(h("i", "prob-marker"));
```

```css
/* overlays/side-panel/side-panel.css:1022-1050 — current */
.prob-bar {
  --p:           50%;
  …
  background: linear-gradient(90deg,
    var(--prob-left)  0%,
    var(--prob-left)  calc(var(--p) - 12%),
    var(--prob-right) calc(var(--p) + 12%),
    var(--prob-right) 100%);
  …
}
.prob-marker {
  position:      absolute;
  …
  left:          var(--p);
  …
}
```

It simply appears at its value. The head-to-head card comes round about
every two minutes and the projection is its one "story" number — a moment
that can afford a little motion: the bar starting even and settling on the
real odds tells the viewer what it means.

## Target

- Register `--p` so it can animate: `@property --p { syntax: "<percentage>"; inherits: true; initial-value: 50%; }` (Chromium 85+). `inherits: true` keeps `.prob-marker`'s `left: var(--p)` following its parent.
- When the `.h2h-projection` beat comes in, its `.prob-bar` animates `--p` from `50%` to its inline value, **900ms** (tempo 1) on `--ease-out`, starting `delay + ms(BEAT_IN_MS) × 0.35`, `fill: backwards` (held at 50% until then). The inline `--p` stays the resting value (`tests/side-panel.test.js` reads `bar.style["--p"]`).
- Accepted cost: the marker's `left` animates (a layout property) — one 4px absolutely positioned element, for under a second, every ~2 minutes.

## Repo conventions to follow

- Beat hooks in `beatsIn()`, helpers right after it (see `drawRules()` from plan 009). Constants at tempo 1 in the constants block.
- `stopAnims(bar)` before animating it — `stopAnims` on the beat itself no longer reaches children (plan 009).

## Steps

1. `overlays/side-panel/side-panel.css` — directly above the `.prob-bar {` rule (and below the comment block that ends `…at the left player's chance (--p, set by side-panel.js). */`), add:
   ```css
   /* Registered so it can animate: side-panel.js fills the bar from 50% to the
      left player's chance as the row arrives. Inherited, so the marker follows. */
   @property --p {
     syntax:        "<percentage>";
     inherits:      true;
     initial-value: 50%;
   }

   ```

2. `overlays/side-panel/side-panel.js`:
   - Constants block, after `const RULE_MS …` add:
     ```js
       const BAR_MS       = 900;     // the projection bar filling from even to the odds
     ```
   - In `beatsIn`, after the `drawRules` line, add:
     ```js
           if (b.classList.contains("h2h-projection")) fillBar(b, delays[i]);
     ```
   - After `drawRules()`, add:
     ```js

       /** The projection bar fills from even to the left player's chance once its row is arriving. */
       function fillBar(row, delay) {
         const bar = row.querySelector(".prob-bar");
         const to = bar ? bar.style.getPropertyValue("--p") : "";
         if (!to) return;
         stopAnims(bar);
         bar.animate([{ "--p": "50%" }, { "--p": to }],
           { duration: ms(BAR_MS), delay: delay + ms(BEAT_IN_MS) * 0.35, easing: ease("out"), fill: "backwards" });
       }
     ```

## Boundaries

- Do NOT rename `--p` or change how `projectionRow()` sets it. Do NOT animate the percentages' text.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted block doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes (the projection tests read `bar.style["--p"]`, unchanged).
- **Feel check** (`/o/side-panel?panel=recent-sets` with a pair luckystats knows; reload to replay): the bar lands split down the middle, then the colour boundary and the marker glide to the real split as the row settles. Hidden and shown again in the rotation, it fills again. If a pack sets `--prob-left-color` / `--prob-right-color`, the colours are unaffected.
- **Done when**: the bar fills on every entrance and rests at the inline `--p`.
