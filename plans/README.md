# Animation plans

Written by `improve-animations` on 2026-11-10 at commit `4e8ba78`, from an audit of how text, chips, icons and the score change on the overlays. Each plan is self-contained; run one with `/improve-animations execute plans/NNN-….md`, or hand it to any agent.

Numbering continues from the earlier plans 001–012 (all done, removed in `4e8ba78`; they're in git history).

Durations in the plans are at tempo 1. On air they're multiplied by `--motion-tempo` in `overlays/shared/overlay.css` (currently **3**).

| # | Plan | Severity | Status |
|---|---|---|---|
| 013 | [Every text swap, chip and icon leaves and arrives the same way](013-one-text-motion.md) | HIGH | DONE |
| 014 | [The score turns like a slot-machine reel: up for a point, down for one taken back](014-score-reel.md) | HIGH | DONE |
| 015 | [Side-panel text that changes on screen swaps instead of cutting](015-side-panel-text-swaps.md) | MEDIUM | DONE |

## Order and dependencies

```
013 ──┬── 014
      └── 015
```

- **013 first.** It defines `Overlay.motion.TEXT` and rewrites the `SWAPS` block that 014 then edits, and 015's swaps are meant to move in that motion.
- **014 and 015 are independent of each other.** They touch different parts of the same files (`overlay-client.js`'s export line and `side-panel.js:30`'s destructuring). Run them one after the other, not in parallel.

## Not covered

- **The bracket's live score.** A data change redraws the board in place, so the on-air set's score on the bracket cuts (`overlays/bracket/bracket.js:89`). It could use 014's `Overlay.reel`. That's a separate plan if wanted.
- **Tempo.** At tempo 3 a text entrance is 1.44s. That's a deliberate setting and these plans leave it alone. Once 013 lands, watch a name change and a score change together on stream and decide whether text should move faster.
- **The page's first-load entrance** (`ov-fade` / `ov-up` … in `overlay.css`) is a different moment and keeps its own, larger motion.
