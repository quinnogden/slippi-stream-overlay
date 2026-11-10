# Animation plans

Written by `improve-animations` on 2026-11-10 at commit `ada0741`, from an
audit of `overlays/` focused on clean fades and the side panel's cascade.
Each plan is self-contained; run one with `/improve-animations execute plans/NNN-….md`.

Durations in the plans are at tempo 1. On air they're multiplied by
`--motion-tempo` in `overlays/shared/overlay.css` (currently **2**).

| # | Plan | Severity | Finding / idea | Status |
|---|---|---|---|---|
| 001 | [Every exit on --ease-out; retire --ease-in](001-exits-on-ease-out.md) | HIGH | 4 | DONE |
| 002 | [One tint layer that stays put](002-persistent-panel-surface.md) | MEDIUM | 5 | DONE |
| 003 | [A panel stands still; its rows are the entrance](003-panel-rows-are-the-entrance.md) | HIGH | 2 | DONE |
| 004 | [A stagger that speeds up](004-decaying-stagger.md) | MEDIUM | 6 | DONE |
| 005 | [Cascade the rows out too](005-exit-cascade.md) | HIGH | 3 | DONE |
| 006 | [Hand the card over row by row](006-rolling-handoff.md) | HIGH | 1 | DONE |
| 007 | [New data on screen cascades instead of popping](007-rerender-on-screen-cascades.md) | MEDIUM | 7 | DONE |
| 008 | [Bracket: crossfade in sequence, no full-canvas blur](008-bracket-crossfade-in-sequence.md) | MEDIUM | 8 | DONE |
| 009 | [Header hairlines draw outward](009-header-hairlines-draw-outward.md) | LOW | idea A | DONE |
| 010 | [Projection bar fills to the odds](010-projection-bar-fills.md) | LOW | idea B | DONE |
| 011 | [Win/loss edges wipe in](011-win-loss-edges-wipe-in.md) | LOW | idea C | DONE |
| 012 | [Crew stock counts roll](012-crew-stocks-roll.md) | LOW | idea D | DONE |

## Order and dependencies

Run in number order. Each side-panel plan quotes the code as the plan before
it leaves it, so they must go in sequence:

```
001 ──┬── 002 → 003 → 004 → 005 → 006 → 007 ──┬── 009 → 010 → 011
      │                                        └── 012
      └── 008 (bracket only; needs just 001)
```

- 001 first: every later plan assumes `--ease-in` is gone.
- 003–007 rebuild the side panel's rotation step by step (beats → decaying stagger → exit cascade → handoff → on-screen re-render).
- 009 changes `stopAnims()` to reach pseudo-elements; 010 and 011 rely on that.
- 012 needs 007's `renderIfChanged(…, patch)`.

## Not covered

- Docs: CLAUDE.md's motion and side-panel sections (and the `--motion-tempo` value it states, 1.5 vs the file's 2) are updated once all plans have landed, not per plan.
- `?animate=false` still doesn't stop the side panel's rotation animations (it never did; unchanged).
