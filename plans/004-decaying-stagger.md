# 004 — Replace the uniform stagger with one that speeds up

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–003 applied)
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens (stagger)
- **Estimated scope**: 1 file, ~25 lines

## Problem

After plan 003 every beat of a side-panel info panel starts the same 55ms
(tempo 1) after the one before:

```js
/* overlays/side-panel/side-panel.js — current (after plan 003) */
  const BEAT_STAGGER = 55;       // between beats
  …
        const delays = beats.map((_, i) => start + ms(i * BEAT_STAGGER));
```

A uniform stagger moves a group like a metronome — the way `linear` easing
moves one element. It also grows without limit: a 14-row player card takes
13 × 55 = 715ms (1.43s on air at `--motion-tempo: 2`) before its last row
even starts.

## Target

A cascade whose gaps shrink: the first gap is `gap`, each next one is 0.85×
the last, never below `min`; if the last start would exceed `max`, every
offset is scaled down to fit. It reads as one wave that accelerates down the
card, and every panel's cascade takes about the same time however many rows
it has.

```js
const CASCADE_IN = { gap: 70, min: 28, max: 480 };   // tempo-1 ms
const GAP_DECAY  = 0.85;
```

Resulting start offsets (tempo 1, before `ms()`):

| rows | offsets (ms) |
|---|---|
| 3 | 0, 70, 130 |
| 7 | 0, 70, 130, 180, 223, 260, 291 |
| 14 | 0, 69, 128, 178, 220, 256, 287, 314, 342, 370, 397, 425, 452, 480 |

## Repo conventions to follow

- Tempo-1 constants near the top of `side-panel.js`, passed through `ms()` where used.
- Pure helpers live with the beat helpers (`beatsOf`, `beatsIn`) under `// ── Beats ──`.

## Steps

1. `overlays/side-panel/side-panel.js` — replace the line
   `  const BEAT_STAGGER = 55;       // between beats`
   with:
   ```js
     // The stagger speeds up: each gap is GAP_DECAY of the last, down to a
     // floor, and a long panel's cascade is squeezed to fit its cap — a wave,
     // not a metronome, and about as long on every panel.
     const CASCADE_IN = { gap: 70, min: 28, max: 480 };
     const GAP_DECAY  = 0.85;
   ```

2. Same file — directly after the `beatsIn` function, add:
   ```js

     /** When each of n beats starts, from the first (tempo-1 ms). */
     function cascadeOffsets(n, { gap, min, max }) {
       const raw = [];
       let t = 0;
       let g = gap;
       for (let i = 0; i < n; i++) {
         raw.push(t);
         t += g;
         g = Math.max(min, g * GAP_DECAY);
       }
       const last = raw.length ? raw[raw.length - 1] : 0;
       const k = last > max ? max / last : 1;
       return raw.map((x) => x * k);
     }
   ```

3. Same file, in `_transitionTo`, replace:
   ```js
           const delays = beats.map((_, i) => start + ms(i * BEAT_STAGGER));
   ```
   with:
   ```js
           const delays = cascadeOffsets(beats.length, CASCADE_IN).map((d) => start + ms(d));
   ```

4. Add `cascadeOffsets` to the `root.SidePanel = { … }` export at the bottom of the file (append it to the list), so it can be inspected from OBS's devtools.

5. Confirm `BEAT_STAGGER` no longer appears anywhere.

## Boundaries

- Only `side-panel.js`. Do NOT change beat durations, poses, or the transition's `start`.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted line doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes. In Node, sanity-check the table: paste `cascadeOffsets` into a REPL with `GAP_DECAY = 0.85` and confirm `cascadeOffsets(14, { gap: 70, min: 28, max: 480 }).map(Math.round)` equals `[0,69,128,178,220,256,287,314,342,370,397,425,452,480]`.
- **Feel check**: on a player card, the first rows arrive distinctly one after another and the lower pills arrive faster — one accelerating sweep down the card, not a tick-tick-tick. A short panel (Just Finished with 3 sets) still clearly cascades.
- **Done when**: the uniform stagger is gone and the offsets match the table.
