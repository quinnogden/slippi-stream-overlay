# 015 — Side-panel text that changes on screen swaps instead of cutting

- **Status**: DONE (2026-11-10, uncommitted)
- **Commit**: 4e8ba78 (apply after plan 013; independent of 014)
- **Severity**: MEDIUM
- **Category**: Missed opportunities / Cohesion
- **Estimated scope**: 2 source files (~25 lines), 1 test file, 1 doc

## Problem

Three pieces of side-panel text change while they're on screen and just **cut** to the new text, while every other piece of text on stream swaps with the overlays' text motion (plan 013's `Overlay.motion.TEXT`: out up 6px + blur 3 over 160ms, in from 8px below + blur 4 over 480ms, `ease("out")`, at tempo 1).

```js
// overlays/side-panel/side-panel.js:926-932 — the header's tournament name, always on screen
  function setTournamentName(name) {
    const el = document.querySelector(".tournament-name");
    const text = String(name ?? "").trim();
    if (!el || el.textContent === text) return;
    el.textContent = text;
    fitText(el, 18);
  }
```

```js
// overlays/side-panel/side-panel.js:882 and :889 — patchCrew(), which updates a crew card IN PLACE while it's on screen
    if (name.textContent !== team.name) { name.textContent = team.name; fitText(name, 24); }
    ...
      if (tag.textContent !== m.tag) tag.textContent = m.tag;
```

`renderCrew()` (`side-panel.js:840-866`) draws the same elements when the card is rebuilt. That happens off screen, or between the rows' exit and entrance cascade. There, drawing must stay **instant**: an animated swap would start while the rows are hidden, and the rows would cascade back in showing the old name mid-exit.

```js
// overlays/side-panel/side-panel.js:845 and :855 — current, in renderCrew()
    name.textContent = team.name;
    ...
      const tag = h("span", "pill-name", m.tag);
```

`swap()` decides whether to animate by comparing against the key it last drew (`el.__ovKey`). An instant draw that bypasses it leaves that key stale. The next `swap()` would then animate a change that isn't one (or, on a fresh element, skip a real one, since a first call is always instant). So the instant path needs a helper that also records the key.

## Target

- The tournament name swaps with the text motion when it changes. The first draw on load stays instant.
- In `patchCrew()`, a renamed crew or member swaps with the text motion, and the fit is re-run once the new text is in.
- In `renderCrew()`, drawing stays instant but records the key, through a new **`Overlay.draw(el, key, render)`**: "draw now, no animation, and remember `key` so a later `swap()` animates only a real change."

```js
// target — overlays/shared/overlay-client.js, immediately after function swap(...)
  /**
   * Draw now, with no animation, and remember `key` as what `el` shows, so a
   * later swap() animates only a real change. For content redrawn while it
   * can't be seen: a panel rebuilt off screen, or between its rows' exit and
   * entrance.
   * @param {Element} el
   * @param {string} key
   * @param {(el: Element) => void} render
   */
  function draw(el, key, render) {
    if (!el) return;
    stopSwap(el);
    el.__ovKey = String(key);
    render(el);
  }
```

## Repo conventions to follow

- Text is set with `textContent` (never HTML), inside a render callback passed to `swap()`. The exemplar is the scoreboard's round, `overlays/scoreboard/scoreboard.js:34-40`:
  ```js
  swap(roundEl, round, (node) => {
    node.textContent = round;
    node.classList.toggle("empty", !round);
    fitText(node, ROUND_MIN_PX);
  });
  ```
- `fitText(node, minPx)` must run after the new text is in the node, so it goes inside the render callback.
- `fitGroup(nodes, minPx)` is called once with the whole list (CLAUDE.md, side panel "Long text shrinks").

## Steps

1. **`overlays/shared/overlay-client.js`**: insert `draw()` from Target directly after the closing `}` of `function swap(...)`.
2. **`overlays/shared/overlay-client.js`**, the `root.Overlay = { … }` export line near the end: add `draw` after `swap`.
3. **`overlays/side-panel/side-panel.js:30`**: add `draw` to `const { h, fitText, fitGroup, icon, param, swap } = Overlay;`. If plan 014 already added `reel`, keep it.
4. **`overlays/side-panel/side-panel.js:926-932`**: replace `setTournamentName` with
   ```js
   function setTournamentName(name) {
     const text = String(name ?? "").trim();
     swap(document.querySelector(".tournament-name"), text, (node) => {
       node.textContent = text;
       fitText(node, 18);
     });
   }
   ```
   (`swap()` returns early for a missing element or an unchanged key.)
5. **`overlays/side-panel/side-panel.js:845`** (in `renderCrew`): replace `name.textContent = team.name;` with
   `draw(name, team.name, (node) => { node.textContent = team.name; });`
   Leave the `fitText(name, 24)` call at the end of `renderCrew` where it is.
6. **`overlays/side-panel/side-panel.js:855`** (in `renderCrew`): replace `const tag = h("span", "pill-name", m.tag);` with
   ```js
   const tag = h("span", "pill-name");
   draw(tag, m.tag, (node) => { node.textContent = m.tag; });
   ```
7. **`overlays/side-panel/side-panel.js:882`** (in `patchCrew`): replace the `if (name.textContent !== team.name) { … }` line with
   `swap(name, team.name, (node) => { node.textContent = team.name; fitText(node, 24); });`
8. **`overlays/side-panel/side-panel.js:889`** (in `patchCrew`): replace `if (tag.textContent !== m.tag) tag.textContent = m.tag;` with
   `swap(tag, m.tag, (node) => { node.textContent = m.tag; fitGroup(tags, 16); });`
   `tags` is the array the loop fills. The callback runs after the exit, by which time the loop has finished, so it fits the whole list with the new name in. Keep the existing `tags.push(tag)` and the `fitGroup(tags, 16)` after the loop.
9. **`tests/side-panel.test.js`**, the test "the header shows the tournament name, and follows a change" (around line 414): after the second `assert.strictEqual(...)`, add
   ```js
   assert.ok(env.page.animations.some(({ el }) => el.classList.contains("tournament-name")),
     "the name swapped rather than cut");
   ```
   (A boolean assertion, never `strictEqual` on a node: tests/README.md, sandbox gotcha 4.) If the second `strictEqual` now fails because the swap hasn't drawn within `env.settle()` (15ms), add `await sleep(30);` before it. `sleep` is already imported in that file; check the `require` at the top.
10. **`CLAUDE.md`**, "### The overlay channel and runtime": add a bullet after the `Overlay.swap` bullet: "**`Overlay.draw(el, key, render)`** — the same draw, now and unanimated, remembering `key` so a later `swap()` animates only a real change. For content rebuilt where it can't be seen (the side panel's `renderCrew`); text that changes on screen goes through `swap()`."

## Boundaries

- Do NOT change `renderIfChanged`, the rotator, `beatsOf`, or the cascade.
- Do NOT touch the player cards, head-to-head or results panels: they are rebuilt through the rotator's re-cascade, which is already their motion.
- Do NOT add markup, and do NOT change `.tournament-name`'s CSS.
- If an excerpt doesn't match (drift since `4e8ba78` plus plan 013/014), STOP and report.

## Verification

- **Mechanical**:
  - `node tests/run.js` → all pass. `node tests/side-panel.test.js` shows the tournament-name test `ok`.
  - Mutation-check once: put back `el.textContent = text;` in `setTournamentName` without the swap, see the new assertion fail, then restore it.
- **Feel check**: app running, `http://localhost:5001/o/side-panel` in Chrome at 611×1080:
  - Switch the event from the dock's Bracket tab (Singles ⇄ Doubles, or a different week's event). The header name drifts up and out and the new one rises in, matching the scoreboard's name swaps.
  - Start a crew battle, wait for a crew card to rotate on, then rename a member in the Crew tab. Only that tag swaps in place; the card doesn't re-cascade, and every tag in the list ends at the same size.
  - With the crew card *off* screen, rename a member, then let the card rotate on. It cascades in already showing the new name, with no swap animation playing inside the rows.
  - DevTools → Animations at 10%: the header's exit is `translate(0px, -6px)` with blur 3px, and the entrance is from `translate(0px, 8px)` with blur 4px.
- **Done when**: no on-screen side-panel text is set by a bare `textContent =` outside a render callback (except `renderCrew`'s instant `draw()`), and all tests pass.
