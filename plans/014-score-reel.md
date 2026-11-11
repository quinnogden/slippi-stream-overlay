# 014 — The score turns like a slot-machine reel: up for a point, down for one taken back

- **Status**: DONE (2026-11-10, uncommitted)
- **Commit**: 4e8ba78 (apply after plan 013)
- **Severity**: HIGH
- **Category**: Physicality & origin / Missed opportunity
- **Estimated scope**: 3 source files + 1 stylesheet (~90 lines), 1 test file, 2 docs

## Problem

The score doesn't turn. It is two separate animations run back to back, so it reads as "goes up and disappears":

1. The old digit drifts up 22px and **fades to nothing** (160ms).
2. Only once that finishes does the new digit rise 26px from below and fade in (480ms).

The two numbers are never on screen together, there's a visible empty box in between (on air, at `--motion-tempo: 3`, the exit alone is 480ms), and it **always moves up**, even when a game is taken back with −.

```js
// overlays/shared/overlay-client.js — current (after plan 013), in SWAPS
    roll: { out: { y: -22, blur: 2 },       in: { y: 26, blur: 2 } },
```

```js
// overlays/scoreboard/scoreboard.js:88-92 — current
    // The score box clips, so the old digit rolls up out of it and the new
    // one up into it.
    swap(q(el.card, ".score .text"), side.score, (node) => {
      node.replaceChildren(...scoreDigits(side.score));
    }, { motion: "roll" });
```

```js
// overlays/side-panel/side-panel.js:836-837 — current: a crew's stock counts use the same roll
  /** A count that rolls when it changes, like the scoreboard's score (a new element's first draw is instant). */
  const rollNum = (el, n) => swap(el, String(n), (node) => { node.textContent = String(n); }, { motion: "roll" });
```

The boxes that clip already exist:

- `overlays/scoreboard/scoreboard.css:505-517`: `.score { … overflow: hidden; display: flex; align-items: center; justify-content: center; }`. The digits are `.score .text`, a flex child, and each digit is a `span.digit[data-d]` with a per-digit vertical nudge (`scoreDigits()` at `scoreboard.js:158`).
- `overlays/side-panel/side-panel.css:1204-1212`: `.crew-stocks, .crew-total-num { overflow: hidden; padding-block: 0.12em; margin-block: -0.12em; }`.

## Target

A new helper, **`Overlay.reel(el, value, build, { clip })`**, replaces `roll`:

- **Old and new move together in one strip**: one cell per value, stacked, sliding as one by exactly one box height per step inside the clipping box. Nothing fades. The clip is the exit.
- **Direction follows the number**:
  - Increase: the strip moves **up**. The new value comes up from below, and the old one leaves out the top.
  - Decrease: the strip moves **down**. The new value comes down from above.
- **A jump passes the values in between**, as a reel does. 0→3 shows 0, 1, 2, 3 going by. A jump of more than 6 shows the first value, then the last six.
- **Non-numbers** (an empty score) just turn up one step.
- **Timing at tempo 1**:
  - 260ms for one step, plus 70ms per extra step, capped at 520ms.
  - Easing is `ease("out")` (`cubic-bezier(0.16, 1, 0.3, 1)`): fast start, long settle, like a reel stopping.
  - On air at tempo 3, one step takes 780ms, against today's 1920ms (480 + 1440).
- **Interrupted mid-turn** (a double-tapped hotkey): the running turn is cancelled, the reel snaps to the value it was heading for, and a new turn runs from there. It always ends on the newest score with no leftover cells.
- **`body.no-animate`, or the first draw**: instant.
- **Layout never moves**:
  - An invisible "hold" copy of the final value stays in flow, so the element keeps its final size.
  - The cells are absolutely positioned over it, inheriting its padding and alignment, so each digit sits exactly where the resting digit does.

```js
// target — overlays/shared/overlay-client.js, a new section after presence() and before text()

  // ── Reel ────────────────────────────────────────────────────────────────────
  //
  // A number that turns like a slot-machine reel. The old and new values sit
  // in one strip inside a box that clips and move together by the box's
  // height per step: up when the number grows (the next value comes up from
  // below), down when it shrinks. A jump passes the values in between. No
  // fade — the clip is the exit. An invisible copy of the final value holds
  // the element's size, so nothing around it moves.

  const REEL_STEP_MS   = 260; // one step, tempo 1
  const REEL_EXTRA_MS  = 70;  // each further step
  const REEL_MAX_MS    = 520;
  const REEL_MAX_CELLS = 7;   // a longer jump shows its first value, then the last six

  /** The values a turn passes, first to last, and which way it turns. */
  function reelValues(from, to) {
    const a = Number(from), b = Number(to);
    if (from === "" || to === "" || !Number.isInteger(a) || !Number.isInteger(b)) {
      return { values: [from, to], up: true };
    }
    const up = b > a;
    const step = up ? 1 : -1;
    const all = [];
    for (let v = a; v !== b + step; v += step) all.push(String(v));
    const values = all.length <= REEL_MAX_CELLS ? all : [all[0], ...all.slice(-(REEL_MAX_CELLS - 1))];
    return { values, up };
  }

  function stopReel(el) {
    const r = el.__ovReel;
    if (!r) return;
    el.__ovReel = null;
    for (const a of r.anims) a.cancel();
  }

  /**
   * Show `value` in `el`, turning from the value it showed like a reel. The
   * first draw is instant.
   *
   * @param {Element} el — holds the number; it or `opts.clip` must clip (overflow: hidden)
   * @param {number|string} value
   * @param {(value: string) => Array<Node|string>} build — the content for one value
   * @param {{ clip?: Element }} [opts] — the clipping box, whose height is one step (default `el`)
   * @returns {boolean} whether anything changed
   */
  function reel(el, value, build, opts = {}) {
    if (!el) return false;
    const key = String(value);
    if (el.__ovReelKey === key) return false;
    const from = el.__ovReelKey;
    el.__ovReelKey = key;
    stopReel(el);
    el.classList.remove("ov-reeling");

    const box = opts.clip || el;
    const step = box.clientHeight || 0;
    if (from === undefined || !canAnimate(el) || !step) {
      el.replaceChildren(...build(key));
      return true;
    }

    const { values, up } = reelValues(from, key);
    const n = values.length;
    const sign = up ? 1 : -1;
    const hold = h("span", "ov-reel-hold");
    hold.append(...build(key));
    const cells = values.map((v) => {
      const cell = h("span", "ov-reel-cell");
      cell.append(...build(v));
      return cell;
    });
    el.replaceChildren(hold, ...cells);
    el.classList.add("ov-reeling");

    // Cell i starts i steps from the window (the first value in it) and ends
    // n-1-i steps away on the other side (the last value in it).
    const duration = ms(Math.min(REEL_MAX_MS, REEL_STEP_MS + REEL_EXTRA_MS * (n - 2)));
    const anims = cells.map((cell, i) => cell.animate([
      { transform: `translateY(${sign * i * step}px)` },
      { transform: `translateY(${sign * (i - n + 1) * step}px)` },
    ], { duration, easing: ease("out"), fill: "both" }));

    const turn = { anims };
    el.__ovReel = turn;
    anims[anims.length - 1].finished.then(() => {
      if (el.__ovReel !== turn) return;
      el.__ovReel = null;
      el.classList.remove("ov-reeling");
      el.replaceChildren(...build(key));
    }, () => {});
    return true;
  }
```

```css
/* target — overlays/shared/overlay.css, appended after the .no-animate rule at the end of the Entrances section */

/* Overlay.reel(): a number turning like a slot-machine reel. The hold keeps
   the element at its final size; one cell per value sits over it — same
   padding, same alignment, so a digit rests exactly where the plain one
   does — and the element or its box clips them. */
.ov-reeling   { position: relative; }
.ov-reel-hold { visibility: hidden; }
.ov-reel-cell {
  position: absolute;
  top: 0; right: 0; bottom: 0; left: 0;
  padding: inherit;
  box-sizing: border-box;
  text-align: inherit;
  white-space: nowrap;
}
```

## Repo conventions to follow

- Durations at tempo 1 through `ms()`, the curve from `ease("out")`. Never a literal cubic-bezier or a scaled number in script.
- Builders return nodes, as `scoreDigits()` (`scoreboard.js:158`) already does. Nodes are made with `h()`, never `innerHTML`.
- Only `transform` is animated (no layout properties). Use `transform`, not the `translate` property: OBS is Chromium 103.
- `canAnimate(el)` (`overlay-client.js`, near `restOf`) is the existing guard for `body.no-animate` and a missing `animate`.
- Exemplar of a helper that keeps its own state on the element and cancels on re-entry: `presence()` (`el.__ovPresAnim`).

## Steps

1. **`overlays/shared/overlay-client.js`**: insert the whole "Reel" section from Target immediately after the closing `}` of `function presence(...)` and before the JSDoc of `function text(...)`.
2. **`overlays/shared/overlay-client.js`**, the `SWAPS` block (as left by plan 013): delete the `roll:` line, and change the comment above it to:
   ```js
   // A swap is out → draw → in, in the text motion (`lift`). A number uses reel().
   ```
   In `swap()`'s JSDoc, change `@param {{ motion?: "lift"|"roll" }} [opts]` to `@param {{ motion?: "lift" }} [opts]`.
3. **`overlays/shared/overlay-client.js:595`**: add `reel` to the export:
   `root.Overlay = { ...api, connect, reveal, followTheme, swap, presence, text, reel, motion, squeeze, fitText, fitGroup, h, param };`
4. **`overlays/shared/overlay.css`**: append the CSS block from Target after the `.no-animate *, .no-animate *::before, .no-animate *::after { … }` rule.
5. **`overlays/scoreboard/scoreboard.js:12`**: change `const { h, text, swap, squeeze, fitText, icon } = Overlay;` to `const { h, text, swap, reel, squeeze, fitText, icon } = Overlay;`
6. **`overlays/scoreboard/scoreboard.js:88-92`**: replace the excerpt quoted in Problem with:
   ```js
   // The score turns like a reel in its clipped box: up for a game won,
   // down for one taken back.
   reel(q(el.card, ".score .text"), side.score, scoreDigits, { clip: q(el.card, ".score") });
   ```
7. **`overlays/side-panel/side-panel.js:30`**: add `reel` to `const { h, fitText, fitGroup, icon, param, swap } = Overlay;`.
8. **`overlays/side-panel/side-panel.js:836-837`**: replace with
   ```js
   /** A count that turns like the scoreboard's score (a new element's first draw is instant). */
   const rollNum = (el, n) => reel(el, n, (v) => [v]);
   ```
   The `.crew-stocks` / `.crew-total-num` elements clip themselves, so no `clip` option is needed.
9. **`overlays/side-panel/side-panel.css:1204-1206`**: change the comment to `/* Clipped so a change turns like the scoreboard's score (Overlay.reel); the padding keeps the glyph and its shadow inside the clip without moving it. */`. Leave the rule itself unchanged.
10. **`tests/overlay-motion.test.js`**: replace the first test ("a score bumped twice inside one swap ends on the newest score") with the four below. Add the helpers next to `scoreText`. The sandbox gives every element `clientHeight` 100, so one step is `100px`. Keyframe arrays come from the page's realm, so compare them through `JSON.parse(JSON.stringify(…))` (tests/README.md, sandbox gotcha 5).
    ```js
    const REEL_DONE = 900 * TIME_SCALE; // past the longest turn: 520ms × TEMPO_FALLBACK 1.5 = 780ms
    const reelCells = (page) => page.$$('.player[data-side="0"] .score .ov-reel-cell');
    /** The transforms each reel cell started since `before` runs through. */
    const turns = (page, before) => JSON.parse(JSON.stringify(page.animations.slice(before)
      .filter(({ el }) => el.classList.contains("ov-reel-cell"))
      .map(({ anim }) => anim.keyframes.map((k) => k.transform))));

    await test("a game won turns the score up: the new score comes from below, the old leaves out the top", async () => {
      const { store, page } = await setup("scoreboard", (s) => s.loadSet(unplayed()));
      const before = page.animations.length;
      store.bump(0, 1);
      await settle();
      assert.deepStrictEqual(turns(page, before), [
        ["translateY(0px)", "translateY(-100px)"],
        ["translateY(100px)", "translateY(0px)"],
      ]);
      await sleep(REEL_DONE);
      assert.strictEqual(scoreText(page), "1");
      assert.strictEqual(reelCells(page).length, 0, "cells left behind");
    });

    await test("a game taken back turns the score down: the new score comes from above", async () => {
      const { store, page } = await setup("scoreboard", (s) => { s.loadSet(unplayed()); s.bump(0, 1); s.bump(0, 1); });
      const before = page.animations.length;
      store.bump(0, -1);
      await settle();
      assert.deepStrictEqual(turns(page, before), [
        ["translateY(0px)", "translateY(100px)"],
        ["translateY(-100px)", "translateY(0px)"],
      ]);
      await sleep(REEL_DONE);
      assert.strictEqual(scoreText(page), "1");
    });

    await test("a jump turns through the scores in between", async () => {
      const { store, page } = await setup("scoreboard", (s) => s.loadSet(unplayed()));
      const before = page.animations.length;
      store.setScore(0, 3);
      await settle();
      const t = turns(page, before);
      assert.strictEqual(t.length, 4, "0, 1, 2, 3");
      assert.deepStrictEqual(t[3], ["translateY(300px)", "translateY(0px)"]);
      await sleep(REEL_DONE);
      assert.strictEqual(scoreText(page), "3");
    });

    await test("a second game mid-turn ends on the newest score, nothing left over", async () => {
      const { store, page } = await setup("scoreboard", (s) => s.loadSet(unplayed()));
      store.bump(0, 1);
      await settle();
      store.bump(0, 1); // lands mid-turn
      await settle();
      await sleep(REEL_DONE);
      assert.strictEqual(scoreText(page), "2");
      assert.strictEqual(reelCells(page).length, 0);
    });
    ```
    `store.setScore(0, 3)` (`app/lib/scoreboard/store.js:451`) bumps three times inside one command, so the page sees a single 0→3 change in one patch: that's the jump.
11. **`CLAUDE.md`**, "### The overlay channel and runtime":
    - change "Three helpers do every show/hide:" to "Four helpers do every show/hide:".
    - in the `Overlay.swap` bullet, remove "— and `roll` (the score)" (left by plan 013) so it describes `lift` only.
    - add a bullet after it: "**`Overlay.reel(el, value, build, { clip })`** — a number (the score, a crew's stocks) turning like a slot-machine reel: the old and new values move together by the clipping box's height, up for a bigger number and down for a smaller one, through the values in between (up to 7 cells). No fade, the clip is the exit. An invisible hold keeps the element's size. Interrupted, it snaps to the value it was heading for and turns again."
    - in the side panel's "Render only what changed" bullet, change "(the crews roll a stock count in place with `Overlay.swap` "roll")" to "(the crews turn a stock count in place with `Overlay.reel`)".
12. **`tests/README.md`**, the `overlay-motion.test.js` row: change the Guards text to "Show/hide and swap animations end on the right content; the score reel turns the right way."

## Boundaries

- Do NOT change `.score` / `.crew-stocks` / `.crew-total-num` sizing, the digit nudge rules, or `calibrateScoreDigits()`.
- Do NOT animate anything but `transform` in the reel (no opacity, no blur). The clip is the exit.
- Do NOT touch the bracket overlay's scores (a separate idea, not this plan).
- Do NOT change `--motion-tempo` or `--ease-out`.
- No dependencies, no markup changes.
- If an excerpt doesn't match (drift since `4e8ba78` plus plan 013), STOP and report.

## Verification

- **Mechanical**:
  - `node tests/run.js` → all pass.
  - `node tests/overlay-motion.test.js` lists the four new reel tests as `ok`.
  - Mutation-check once: swap the `1 : -1` in `const sign = up ? 1 : -1;` to `-1 : 1`, see the up and down tests fail, then restore it.
  - `node tests/side-panel.test.js`: the crew test still passes (its counts read `5`/`3` after settling).
- **Feel check**: start the app (`cd app && node index.js`), open `http://localhost:5001/o/scoreboard` in Chrome at 1920×1080 and the dock beside it:
  - **+** on a side: the old digit slides up out of the box *as* the new one slides up into it. They are on screen together and never fade, with no empty box between.
  - **−**: the same, downward.
  - Load a fresh set over a 3–2 score: each side turns down through the numbers to 0.
  - Double-tap `Ctrl+Shift+1` (by hand; never synthesize hotkeys). It ends on the right score with no stuck half-digit, though the second tap may snap the first turn to its end.
  - In DevTools → Animations at 10%: the digit stays perfectly centred horizontally throughout, and at rest sits exactly where a plain digit did (compare against a screenshot from before the change; the per-digit nudge must still apply). The box never changes width mid-turn except for a 9→10 change of digit count.
  - Try `easing: ease("spring")` (`cubic-bezier(0.34, 1.4, 0.64, 1)`) in place of `ease("out")` for one run: the reel overshoots slightly and settles back, like a reel catching. Keep whichever reads better on stream. If spring, the overshoot briefly shows the edge of the next value; judge that in OBS, not Chrome.
  - Side panel in a crew battle (`/o/side-panel` with a crew battle started from the dock, rotate to a crew card): a lost stock turns down in the count, and the total turns down too.
  - With `?animate=false` on the source URL, scores change instantly.
- **Done when**: no `roll` left in `overlay-client.js`, the score and crew counts use `Overlay.reel`, all tests pass, and the feel check shows a two-way reel with no gap.
