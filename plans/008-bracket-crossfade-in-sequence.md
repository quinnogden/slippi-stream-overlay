# 008 — Bracket: crossfade in sequence, without full-canvas blur

- **Status**: DONE
- **Commit**: ada0741 (assumes plan 001 applied)
- **Severity**: MEDIUM
- **Category**: Performance / easing (crossfade)
- **Estimated scope**: 1 file, ~20 lines

## Problem

```js
/* overlays/bracket/bracket.js:366-382 — current (after plan 001) */
  function crossfade(old, layer) {
    if (old && animated()) {
      // Scale and blur on the layer, never the board: the board's transform
      // is the camera's. The blur is light — the layer is most of the canvas.
      layer.el.animate([
        { opacity: 0, transform: "scale(1.02)", filter: "blur(6px)" },
        { opacity: 1, transform: "scale(1)",    filter: "blur(0px)" },
      ], { duration: ms(FADE_IN_MS), delay: ms(FADE_OUT_MS / 2), easing: ease("out"), fill: "backwards" });
      old.el.animate([
        { opacity: 1, transform: "scale(1)",     filter: "blur(0px)" },
        { opacity: 0, transform: "scale(0.985)", filter: "blur(4px)" },
      ], { duration: ms(FADE_OUT_MS), easing: ease("out"), fill: "forwards" })
        .finished.then(() => old.el.remove(), () => {});
    } else if (old) {
      old.el.remove();
    }
  }
```

Two issues:

1. **Cost.** Both layers are ~1824×912 (most of the 1920×1080 canvas) and both animate `filter: blur()` at once — the most expensive thing to ask of OBS's Chromium 103 compositor, on every page turn of the bracket tour and every view switch.
2. **Order.** The incoming starts at half the outgoing's duration, and the incoming is drawn *above* the outgoing (it's appended later). With plan 001's `--ease-out` exit the old board is ~97% gone at that point, so the overlap is now small — but the scale-up of the new board (1.02) still pushes its cards over the old ones' positions for a moment.

## Target

```js
  function crossfade(old, layer) {
    if (old && animated()) {
      // One after the other, not on top of each other: on --ease-out the old
      // board is ~97% gone half-way through its fade, and only then does the
      // new one come in. No blur — these layers are most of the canvas, and a
      // full-canvas blur is the costliest thing OBS's browser can be asked for.
      // Scale on the layer, never the board: the board's transform is the camera's.
      old.el.animate([
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.985)" },
      ], { duration: ms(FADE_OUT_MS), easing: ease("out"), fill: "forwards" })
        .finished.then(() => old.el.remove(), () => {});
      layer.el.animate([
        { opacity: 0, transform: "scale(1.01)" },
        { opacity: 1, transform: "scale(1)" },
      ], { duration: ms(FADE_IN_MS), delay: ms(FADE_OUT_MS) * 0.5, easing: ease("out"), fill: "backwards" });
    } else if (old) {
      old.el.remove();
    }
  }
```

`FADE_IN_MS` (760) and `FADE_OUT_MS` (380) stay as they are: `tests/bracket-overlay.test.js` ("switching views crossfades to a new board and removes the old one") checks that 5ms after a switch, at the sandbox's 0.01 time scale and tempo 1.5, both layers still exist (380 × 1.5 × 0.01 = 5.7ms) and that 60ms later only one does.

## Repo conventions to follow

- `ms()` / `ease()` from `Overlay.motion` (already destructured at `bracket.js:26`).
- The board's transform belongs to the camera (`place()`, `bracket.js:257`); animate only the `.layer`.

## Steps

1. `overlays/bracket/bracket.js` — replace the whole `crossfade(old, layer)` function (lines 366-382) with the Target code above.
2. The file's header comment (lines ~14 and ~19) mentions crossfading "through depth"; leave it unless it mentions blur — if it does, drop the word "blur".

## Boundaries

- Only `crossfade()` in `bracket.js`. Do NOT change `FADE_IN_MS` / `FADE_OUT_MS` / `GLIDE_MS`, the camera, or any CSS.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If the quoted function doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes (especially `bracket-overlay.test.js`). `grep -n "blur" overlays/bracket/bracket.js` shows no `filter: "blur` in `crossfade`.
- **Feel check** (`/o/bracket`, switch views from the dock's Bracket tab; or let the tour turn pages): the old page dims away quickly, then the new page settles in from very slightly larger. Never two pages' cards readable at once. In DevTools → Performance, a page turn shows no long "Paint" / raster spikes from filters.
- **Done when**: no blur in the crossfade, tests pass.
