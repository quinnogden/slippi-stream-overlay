# 011 (idea C) — Win/loss edges wipe down after their pill lands

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–007, 009, 010 applied)
- **Severity**: LOW
- **Category**: Missed opportunities (delight)
- **Estimated scope**: 2 files, ~50 lines

## Problem

Result pills mark wins and losses with 3px coloured **borders**, which can't
be animated apart from the pill:

```css
/* overlays/side-panel/side-panel.css — current */
.panel-pill.win  { border-left: 3px solid var(--win-color);  padding-left: 18px; }   /* :493 */
.panel-pill.loss { border-left: 3px solid var(--loss-color); padding-left: 18px; }   /* :494 */

.run-list .panel-pill.win,                                                           /* :841-847 */
.run-list .panel-pill.loss {
  border-right:  3px solid;
  padding-right: 18px;
}
.run-list .panel-pill.win  { border-right-color: var(--win-color); }
.run-list .panel-pill.loss { border-right-color: var(--loss-color); }

#panel-recent-sets .panel-pill.win  { border-right: 3px solid var(--loss-color); padding-right: 18px; }  /* :860 */
#panel-recent-sets .panel-pill.loss { border-right: 3px solid var(--win-color);  padding-right: 18px; }  /* :861 */

.completed-set-pill.p1win {                                                          /* :923-926 */
  border-left:   3px solid var(--win-color);  padding-left:  18px;
  border-right:  3px solid var(--loss-color); padding-right: 18px;
}
.completed-set-pill.p2win {                                                          /* :929-932 */
  border-left:   3px solid var(--loss-color); padding-left:  18px;
  border-right:  3px solid var(--win-color);  padding-right: 18px;
}
```

A second rhythm under the cascade: each pill's result colour wipes down its
edge just after the pill lands, so the W/L reads as the payoff of the row.

## Target

- The accents become 3px bars drawn by `.panel-pill::before` (left) and `::after` (right), coloured by custom properties `--edge-l` / `--edge-r` (transparent by default). Every `border-left/right: 3px` + `padding: 18px` above becomes the matching `--edge-*` + `padding: 21px` (3 + 18), so content doesn't move by a pixel. The pill's `overflow: hidden` + `border-radius: 10px` clips the bars as it clipped the borders.
- `.crew-member` keeps its own `border-left` (its `.active` state colours it) — not converted.
- When a pill with `win`, `loss`, `p1win` or `p2win` comes in as a beat, both bars animate `transform: scaleY(0)` → `scaleY(1)` from the top (`transform-origin: top`), **420ms** (tempo 1), `--ease-out`, starting `delay + ms(BEAT_IN_MS) × 0.5`, `fill: backwards`.

## Repo conventions to follow

- Beat hooks in `beatsIn()`, helpers after it (`drawRules()`, `fillBar()`). Pseudo-element animation via the `pseudoElement` option, as `drawRules()` does; `stopAnims(b)` already cancels a beat's own pseudo-element animations (plan 009).

## Steps

1. `overlays/side-panel/side-panel.css`:
   - In the `.panel-pill { … }` rule (line 367-381), add `  position:       relative;   /* for the W/L edge bars */` after `display: flex;`.
   - Replace lines 492-494:
     ```css
     /* W/L left-edge accent bars */
     .panel-pill.win  { border-left: 3px solid var(--win-color);  padding-left: 18px; }
     .panel-pill.loss { border-left: 3px solid var(--loss-color); padding-left: 18px; }
     ```
     with:
     ```css
     /* W/L edge accents: 3px bars, ::before on the left and ::after on the
        right, coloured by --edge-l / --edge-r (none where unset). Bars rather
        than borders so side-panel.js can wipe them down after their pill lands;
        each side's padding is the old 3px border + 18px. */
     .panel-pill::before,
     .panel-pill::after {
       content:          "";
       position:         absolute;
       top:              0;
       bottom:           0;
       width:            3px;
       transform-origin: top;
       pointer-events:   none;
     }
     .panel-pill::before { left:  0; background: var(--edge-l, transparent); }
     .panel-pill::after  { right: 0; background: var(--edge-r, transparent); }

     .panel-pill.win  { --edge-l: var(--win-color);  padding-left: 21px; }
     .panel-pill.loss { --edge-l: var(--loss-color); padding-left: 21px; }
     ```
   - Replace the `.run-list` block (lines 840-847, from `/* Run pills: accent on both left and right edges */`):
     ```css
     /* Run pills: accent on both left and right edges */
     .run-list .panel-pill.win,
     .run-list .panel-pill.loss { padding-right: 21px; }
     .run-list .panel-pill.win  { --edge-r: var(--win-color); }
     .run-list .panel-pill.loss { --edge-r: var(--loss-color); }
     ```
   - Replace lines 860-861:
     ```css
     #panel-recent-sets .panel-pill.win  { --edge-r: var(--loss-color); padding-right: 21px; }
     #panel-recent-sets .panel-pill.loss { --edge-r: var(--win-color);  padding-right: 21px; }
     ```
   - Replace the two `.completed-set-pill.p1win` / `.p2win` rules (lines 922-932, keep their comments):
     ```css
     /* p1 won: green left, red right */
     .completed-set-pill.p1win {
       --edge-l: var(--win-color);  padding-left:  21px;
       --edge-r: var(--loss-color); padding-right: 21px;
     }

     /* p2 won: red left, green right */
     .completed-set-pill.p2win {
       --edge-l: var(--loss-color); padding-left:  21px;
       --edge-r: var(--win-color);  padding-right: 21px;
     }
     ```
   - Confirm no `border-left: 3px` / `border-right: 3px` remains in the file except `.crew-member`'s `border-left: 3px solid transparent`.

2. `overlays/side-panel/side-panel.js`:
   - Constants block, after `const BAR_MS …` add:
     ```js
       const EDGE_MS      = 420;     // a result pill's W/L edges wiping down
       const EDGED        = ["win", "loss", "p1win", "p2win"];
     ```
   - In `beatsIn`, after the `fillBar` line, add:
     ```js
           if (EDGED.some((c) => b.classList.contains(c))) wipeEdges(b, delays[i]);
     ```
   - After `fillBar()`, add:
     ```js

       /** A result pill's W/L edges wipe down once the pill has landed. */
       function wipeEdges(pill, delay) {
         for (const pseudoElement of ["::before", "::after"]) {
           pill.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
             { pseudoElement, duration: ms(EDGE_MS), delay: delay + ms(BEAT_IN_MS) * 0.5, easing: ease("out"), fill: "backwards" });
         }
       }
     ```

## Boundaries

- Only these two files. Do NOT change `.crew-member`, the colours, or the pills' other padding/layout.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted block doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes.
- **Visual check first** (before motion): take a screenshot of `/o/side-panel?panel=player-1&animate=false`, `?panel=recent-sets`, `?panel=completed-sets` before and after the CSS change (docs/TESTING.md shows how) — the bars must sit exactly where the borders were, with the same colours and the same text positions.
- **Feel check**: on each result pill, the pill rises in first, then its coloured edge(s) draw from top to bottom. Pills without a result (Recent Results' placements) show no edge.
- **Done when**: no 3px result borders remain, the bars match the old look at rest, and they wipe in on entrance.
