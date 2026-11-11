# 013 — Every text swap, chip and icon leaves and arrives the same way

- **Status**: DONE (2026-11-10, uncommitted)
- **Commit**: 4e8ba78
- **Severity**: HIGH
- **Category**: Cohesion & tokens
- **Estimated scope**: 4 source files (~30 lines), 1 test file, 2 docs

## Problem

The overlays have four different ways for text to leave, so two changes landing together move in different directions. A name change rises out. A pronoun chip being cleared at the same moment **sinks and shrinks**. A character icon shrinks away and pops back in oversized. Side-panel rows rise, but by a different distance and speed. On stream it reads as unrelated animations instead of one broadcast.

All durations below are written at tempo 1. On air every one is multiplied by `--motion-tempo` (currently `3`, in `overlays/shared/overlay.css:56`) through `Overlay.motion.ms()`. Do not change the tempo.

```js
// overlays/shared/overlay-client.js:257-270 — current
  // A swap is out → draw → in. Three characters, by what's changing:
  //   lift — text (names, rounds, titles): a short drift up and a re-focus
  //   roll — a score, inside its clipped box: an odometer tick
  //   pop  — an icon: shrinks away, the new one lands from slightly large
  const SWAPS = {
    lift: { out: { y: -6, blur: 3 },        in: { y: 8, blur: 4 } },
    roll: { out: { y: -22, blur: 2 },       in: { y: 26, blur: 2 } },
    pop:  { out: { scale: 0.82, blur: 4 },  in: { scale: 1.16, blur: 6 } },
  };
  const SWAP_OUT_MS = 160;
  const SWAP_IN_MS  = 480;

  // presence(): something that comes and goes whole (a chip, a pill, a card).
  const SHOW = { from: { y: 10, scale: 0.94, blur: 6 }, ms: 560 };
  const HIDE = { to:   { y: 6,  scale: 0.96, blur: 4 }, ms: 220 };
```

`HIDE` moves **down** (`y: 6`) and scales, while `lift` moves **up** (`y: -6`). That mismatch is the main complaint.

```js
// overlays/scoreboard/scoreboard.js:86 — the character icon uses "pop"
    }, { motion: "pop" });
```

```js
// overlays/side-panel/side-panel.js:57-75 — side-panel rows ("beats"): near-identical, hand-typed values
  const BEAT_IN_MS   = 440;
  const BEAT_IN      = { y: 10, blur: 3 };
  ...
  const BEAT_OUT_MS = 200;
  const BEAT_OUT    = { y: -8, blur: 2 };
```

## Target

There is one text motion, defined once in `overlay-client.js`, exported, and used by `swap()`, `presence()` and the side panel's rows. The character icon uses it too.

| | Movement | Blur | Opacity | Duration (tempo 1) | Easing |
|---|---|---|---|---|---|
| **Out** | up 6px (`y: -6`) | to 3px | to 0 | 160ms | `ease("out")` = `cubic-bezier(0.16, 1, 0.3, 1)` |
| **In** | from 8px below (`y: 8`) | from 4px | from 0 | 480ms | `ease("out")` |

- **No scale anywhere in it.** A chip no longer shrinks as it goes, and an icon no longer shrinks or pops.
- **Direction is always the same**: everything leaves upward and arrives from below, so a change reads as the next line coming up.
- **`roll` stays as it is for now.** Plan 014 replaces it with a reel. Do not touch it here.

```js
// target — overlays/shared/overlay-client.js
  // The one text motion: everything that changes or comes and goes — text,
  // a chip, a pill, a card, a character icon, a side-panel row — leaves
  // drifting up and out of focus, and arrives rising from below into focus.
  // One vocabulary, so two changes landing together move as one.
  const TEXT = Object.freeze({
    out:   Object.freeze({ y: -6, blur: 3 }),
    in:    Object.freeze({ y: 8, blur: 4 }),
    outMs: 160,
    inMs:  480,
  });

  // A swap is out → draw → in:
  //   lift — the text motion (names, rounds, titles, icons)
  //   roll — a score, inside its clipped box: an odometer tick
  const SWAPS = {
    lift: { out: TEXT.out, in: TEXT.in },
    roll: { out: { y: -22, blur: 2 },       in: { y: 26, blur: 2 } },
  };
  const SWAP_OUT_MS = TEXT.outMs;
  const SWAP_IN_MS  = TEXT.inMs;

  // presence(): something that comes and goes whole (a chip, a pill, a card) —
  // the same motion as a swap's two halves.
  const SHOW = { from: TEXT.in,  ms: TEXT.inMs };
  const HIDE = { to:   TEXT.out, ms: TEXT.outMs };
```

## Repo conventions to follow

- Durations are written at tempo 1 and always go through `ms()`. Curves always come from `ease("out")`, which reads `--ease-out` from `overlay.css`. Never hand-type a cubic-bezier or a scaled duration.
- Keyframes are always built with `pose(rest, {...})` on `restOf(el)`, never with raw transform strings. `presence()` (`overlay-client.js:381-420`) is the exemplar.
- Page scripts get motion helpers from `Overlay.motion` (`side-panel.js:31`: `const { ease, ms, restOf, pose } = Overlay.motion;`).

## Steps

1. **`overlays/shared/overlay-client.js:257-270`**: replace the block quoted in Problem with the target block above, exactly. `SWAPS` loses `pop`. `SHOW`/`HIDE` keep their shape (`from`/`to` + `ms`), so `presence()` itself needs no change.
2. **`overlays/shared/overlay-client.js`**, the JSDoc on `swap()` (around line 322): change `@param {{ motion?: "lift"|"roll"|"pop" }} [opts]` to `@param {{ motion?: "lift"|"roll" }} [opts]`.
3. **`overlays/shared/overlay-client.js:593`**: export the constant. Change
   `const motion = { ease, ms, restOf, pose };`
   to
   `const motion = { ease, ms, restOf, pose, TEXT };`
4. **`overlays/scoreboard/scoreboard.js:86`**: change `}, { motion: "pop" });` to `});`. With no option, `swap()` uses `lift`. Leave the render callback above it untouched.
5. **`overlays/side-panel/side-panel.js:31`**: change to
   `const { ease, ms, restOf, pose, TEXT } = Overlay.motion;`
6. **`overlays/side-panel/side-panel.js:57-61`**: replace
   ```js
   const BEAT_IN_MS   = 440;
   const BEAT_IN      = { y: 10, blur: 3 };
   ```
   with
   ```js
   const BEAT_IN_MS   = TEXT.inMs;   // the overlays' one text motion (overlay-client.js)
   const BEAT_IN      = TEXT.in;
   ```
   Keep the comment above them. Leave `BAR_MS`, `EDGE_MS`, `RULE_MS` and `CASCADE_IN` alone.
7. **`overlays/side-panel/side-panel.js:73-74`**: replace
   ```js
   const BEAT_OUT_MS = 200;
   const BEAT_OUT    = { y: -8, blur: 2 };
   ```
   with
   ```js
   const BEAT_OUT_MS = TEXT.outMs;
   const BEAT_OUT    = TEXT.out;
   ```
   Every use (lines 293-294, 305, 316, 323, 352-353, 547, 577) spreads or reads these, so nothing else changes. `LOGO_IN`/`LOGO_OUT` are artwork, not text, so leave them.
8. **`tests/overlay-motion.test.js`**: add one test before the final `console.log`, in the file's existing `await test(...)` style:
   ```js
   await test("a name, a cleared chip and a character icon all leave the same way: up, unscaled", async () => {
     const { store, page } = await setup("scoreboard", (s) => {
       s.loadSet(unplayed());
       s.setPlayer(0, 0, { pronoun: "he/him" });
       s.setCharacter(0, 0, { codename: "fox", name: "Fox", skin: 0 });
     });
     const before = page.animations.length;
     store.setPlayer(0, 0, { tag: "Renamed", pronoun: "" });
     store.setCharacter(0, 0, { codename: "marth", name: "Marth", skin: 0 });
     await settle();
     const exits = page.animations.slice(before).map(({ anim }) => anim.keyframes[anim.keyframes.length - 1].transform);
     assert.ok(exits.length >= 3, `only ${exits.length} exits started`);
     for (const t of exits) {
       assert.match(t, /translate\(0px, -6px\) scale\(1\)$/, `an exit that isn't the text motion: ${t}`);
     }
   });
   ```
   If `setCharacter`'s signature in `app/lib/scoreboard/store.js` differs from `(side, slot, character)`, read it and adapt the two calls. Keep the assertion.
9. **`CLAUDE.md`**, the bullet that starts "**`Overlay.swap(el, key, render, { motion })`**" (around line 189): replace "`lift` (text), `roll` (the score, an odometer tick inside its clipped box), `pop` (the character icon)." with "`lift` — the one text motion, `Overlay.motion.TEXT` (out up 6px + blur 3, 160ms; in from 8px below + blur 4, 480ms), which `presence()`, the character icon and the side panel's rows also use — and `roll` (the score)." In the **`Overlay.presence`** bullet, add after its first sentence: "It moves exactly like a swap's two halves (`TEXT`): out upward, in from below, no scale."
10. **`tests/README.md`**: no change (its overlay-motion line still holds).

## Boundaries

- Do NOT change `--motion-tempo`, `--ease-out`, or any CSS entrance (`ov-fade`, `ov-up`, … in `overlay.css`). The page's first-load entrance is a different moment and is out of scope.
- Do NOT touch `roll` or the score; plan 014 does.
- Do NOT touch the side panel's logos (`LOGO_IN`/`LOGO_OUT`), the clip toast, the bracket board's cascade, or the cascade stagger values.
- Do NOT add dependencies or change markup.
- If any quoted excerpt doesn't match the file (drift since `4e8ba78`), STOP and report rather than improvise.

## Verification

- **Mechanical**: `node tests/run.js` → `All 25 passed` (26 if a file was added since). Then `node tests/overlay-motion.test.js` shows the new test as `ok`. Mutation-check the new test once: temporarily put `y: 6` back into `HIDE`, see it fail, and restore it.
- **Feel check**: start the app (`cd app && node index.js`), open `http://localhost:5001/o/scoreboard` in Chrome at 1920×1080, and use the dock (`http://localhost:5001/dock`):
  - Change a player's tag and clear their pronoun in one go (type a new tag, empty the pronoun in the Players tab). The name and the chip leave **together and upward**, and nothing shrinks.
  - Pick a new character from the strip. The icon drifts up and out, and the new one rises into focus. No shrink, no oversized landing.
  - Set best-of to "None", then back. The pill leaves upward and returns from below.
  - Watch the side panel (`/o/side-panel`) rotate. The rows still cascade out upward and in from below, now at the same distance as the scoreboard's text.
  - In DevTools → Animations, set playback to 10%. Each exit's last frame is `translate(0px, -6px) scale(1)` with blur 3px. Each entrance starts at `translate(0px, 8px)` with blur 4px.
- **Done when**: no `pop`, no `scale` in `SHOW`/`HIDE`, every text and chip animation in the scoreboard, casters, bracket title and side-panel rows uses `TEXT`, and all tests pass.
