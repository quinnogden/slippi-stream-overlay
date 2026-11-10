# 001 — Every exit on --ease-out; retire --ease-in

- **Status**: DONE
- **Commit**: ada0741
- **Severity**: HIGH
- **Category**: Easing & duration
- **Estimated scope**: 5 files, ~25 lines

## Problem

Every exit on stream (a name or score swap leaving, a chip hiding, the side
panel's outgoing panel, the clip toast leaving, the bracket's old board, the
theme-switch fade) runs on `--ease-in`, a curve that barely moves at first:

```css
/* overlays/shared/overlay.css:46-48 — current */
  --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in:     cubic-bezier(0.3, 0, 0.8, 0.15);
  --ease-spring: cubic-bezier(0.34, 1.4, 0.64, 1);
```

At 25% / 50% / 75% of its time it has covered only 4% / 15% / 41% of the
distance. So every hide reads as a pause and then a snap, and in a crossfade
the old content is still ~85–90% opaque when the new content starts arriving.
The fix is to leave on the same strong ease-out curve things arrive on: it
answers at once and is ~97% gone half-way through.

Call sites (all `ease("in")`):

- `overlays/shared/overlay-client.js:297` — theme fade (`reloadForTheme`)
- `overlays/shared/overlay-client.js:346` — `swap()`'s exit
- `overlays/shared/overlay-client.js:412` — `presence()`'s hide
- `overlays/side-panel/side-panel.js:342` — the rotation's outgoing panel
- `overlays/side-panel/side-panel.js:691` — the clip toast's exit keyframe
- `overlays/bracket/bracket.js:377` — the old board in `crossfade()`

## Target

- `--ease-in` no longer exists. Every exit uses `ease("out")` / `var(--ease-out)`.
- Exit durations shortened slightly (tempo-1 values; `Overlay.motion.ms()` multiplies them by `--motion-tempo`):
  - `swap()` exit: `SWAP_OUT_MS` 200 → **160**
  - `presence()` hide: `HIDE.ms` 260 → **220**
  - side panel outgoing panel: `OUT_MS` 380 → **300**
  - clip toast exit: `TOAST_OUT` 360 → **300**
  - theme fade and bracket old board: durations unchanged, curve only.
- Entrances, `--ease-spring`, and every other duration unchanged.

## Repo conventions to follow

- Curves live once in `overlays/shared/overlay.css` `:root` and are read by script through `Overlay.motion.ease(name)` (`overlay-client.js:211`), with `EASE_FALLBACK` (`overlay-client.js:204`) as the copy used when no stylesheet is readable (the test sandbox). Keep the two in sync.
- Durations in scripts are written at tempo 1 and wrapped in `ms()`.

## Steps

1. `overlays/shared/overlay.css` — replace lines 37-48 (the `/* ── Motion ──` comment through `--ease-spring`) with:

   ```css
     /* ── Motion ──────────────────────────────────────────────────
        One vocabulary for every overlay, whatever the pack. overlay-client.js
        reads these curves from here, so a JS animation and a CSS one can't
        drift apart.

          out     starts at full speed and settles long — everything that
                  appears AND everything that goes. An exit on it answers at
                  once and is ~97% gone half-way through, so a hide never
                  lingers and two states never read on top of each other.
          spring  a little overshoot, for the one thing that should pop (the
                  clip toast) */
     --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
     --ease-spring: cubic-bezier(0.34, 1.4, 0.64, 1);
   ```

2. `overlays/shared/overlay-client.js`:
   - Lines 192-196 of the Motion comment currently read:
     ```js
     // The script half of overlay.css's motion tokens: everything that appears
     // rises a few px, settles on --ease-out and pulls into focus from a slight
     // blur; everything that leaves accelerates away on --ease-in. Theme-agnostic
     // on purpose — a pack changes colours and type, never how things move.
     ```
     Replace with:
     ```js
     // The script half of overlay.css's motion tokens: everything that appears
     // rises a few px, settles on --ease-out and pulls into focus from a slight
     // blur; everything that leaves goes on the same curve, quickly — fast
     // first, so a hide answers at once. Theme-agnostic on purpose — a pack
     // changes colours and type, never how things move.
     ```
   - `EASE_FALLBACK` (line 204-208): delete the `in:` line, leaving `out` and `spring`.
   - Line 265: `const SWAP_OUT_MS = 200;` → `const SWAP_OUT_MS = 160;`
   - Line 270: `const HIDE = { to:   { y: 6,  scale: 0.96, blur: 4 }, ms: 260 };` → `ms: 220`.
   - Lines 297, 346, 412: `easing: ease("in")` → `easing: ease("out")`.

3. `overlays/side-panel/side-panel.js`:
   - Line 36: `const OUT_MS         = 380;     // the outgoing panel lifts away…` → `const OUT_MS         = 300;     // the outgoing panel lifts away…`
   - Line 342: `{ duration: ms(OUT_MS), easing: ease("in") });` → `{ duration: ms(OUT_MS), easing: ease("out") });`
   - Line 666: `const TOAST_IN = 520, TOAST_HOLD = 3200, TOAST_OUT = 360;` → `TOAST_OUT = 300;`
   - Line 691: `{ ...shown, offset: (tIn + TOAST_HOLD) / total, easing: ease("in") },` → `easing: ease("out")`.

4. `overlays/bracket/bracket.js` line 377: `easing: ease("in")` → `easing: ease("out")`. (Plan 008 reworks this function further; this step only changes the curve.)

5. `tests/overlay-motion.test.js` lines 45-47, the comment above `SWAP_DONE`:
   ```js
   // Comfortably past each animation (overlay-client.js: exit 200 + entrance
   // 480 for a swap, 260 for a hide — each × --motion-tempo, which the sandbox
   // can't read from overlay.css and so takes as TEMPO_FALLBACK, 1.5).
   ```
   → change `exit 200` to `exit 160` and `260 for a hide` to `220 for a hide`. Do not change `SWAP_DONE` / `HIDE_DONE`.

6. Search `overlays/` and `app/public/` for `ease("in")` and `--ease-in` (not `ease-in-out`, which is a different, built-in keyword used by flair loops — leave those). There must be zero hits.

## Boundaries

- Do NOT touch the theme packs, `ease-in-out` loops, entrance durations, or `--ease-spring`.
- Do NOT edit CLAUDE.md or other docs (the reviewer updates docs).
- Do NOT add dependencies.
- If a quoted line doesn't match what you find, STOP and report instead of improvising.

## Verification

- **Mechanical**: `node tests/run.js` passes (run from the repo root). `grep -rn 'ease("in")\|--ease-in\b' overlays app/public` prints nothing.
- **Feel check** (app running, OBS or Chrome on `http://localhost:5001/o/scoreboard`): bump a score with the dock's +. The old digit should start leaving the instant you press, not hang for a beat. Clear a pronoun: the chip leaves immediately. In DevTools → Animations at 10% speed: every exit's opacity drops steeply at the start and creeps to 0 at the end.
- **Done when**: no `--ease-in` / `ease("in")` remains, tests pass, and the six call sites above use `ease("out")`.
