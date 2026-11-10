# 007 — New data on the visible panel cascades instead of popping

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–006 applied)
- **Severity**: MEDIUM
- **Category**: Missed opportunities (state changes that teleport)
- **Estimated scope**: 1 file, ~60 lines

## Problem

When the data behind the panel **on screen** changes mid-dwell — luckystats
answering late, a new result in the player's run, Switch Sides changing the
names — the panel is rebuilt in place and its new rows simply appear:

```js
/* overlays/side-panel/side-panel.js — current */
  const lastRendered = {};
  function renderIfChanged(key, slice, render) {
    const json = JSON.stringify(slice === undefined ? null : slice);
    if (lastRendered[key] === json) return;
    lastRendered[key] = json;
    render();
  }
```

(`renderPlayerCard` etc. `replaceChildren()` their lists; a new pill has no
inline opacity, so it's visible the instant it's appended.) And a panel that
is mid-exit gets its new content swapped in under the exit.

## Target

All panel renders go through the rotator, which decides when to draw:

- **Off screen** (not the current panel, not leaving): draw at once (as today).
- **Leaving** (its beats are cascading out — `this._busy[id]` set): hold the newest render; draw it when the panel is settled hidden.
- **On screen**: first try `patch()` if the caller gave one (it updates rows in place and returns `true` — plan D uses this for crew stocks); otherwise cascade the current beats out (`CASCADE_OUT`, as a rotation exit), draw, and cascade the new beats in (`CASCADE_IN`, from 0). Renders landing during that exit replace the held one (newest wins). The panel stays current throughout; the rotation is not restarted and `_transitionTo` is not called.
- Whenever a panel becomes current, a held render is drawn first.
- A transition or restart that takes the panel over mid re-render wins: the re-render's continuation checks its token and does nothing.

## Repo conventions to follow

- `this._busy[id]` tokens and `_settleHidden()` (from plan 005) are the existing "leaving" mechanism; reuse them, don't add a parallel one.
- `tests/side-panel.test.js` "Switch Sides changes no slot, so it moves nothing in the rotation" holds `player-1` on screen and swaps sides: the re-render must not call `_transitionTo` or `restart`.

## Steps

1. `overlays/side-panel/side-panel.js`, `class Rotator` constructor — after the `this._busy = {};` line add:
   ```js
         this._pending = {};  // panel id → its newest render, held while the panel's rows are leaving
   ```

2. `_settleHidden(id, el)` — append `this._flush(id);` as its last line, and change its doc comment to:
   `/** A panel off screen: hidden outright, its beats back at rest, and any render it was holding drawn now. */`

3. In `_transitionTo`, replace the line `      delete this._busy[id];` with:
   ```js
         delete this._busy[id];
         this._flush(id); // a render held while it was leaving is drawn before it shows
   ```

4. Add these methods to `class Rotator`, directly after `_settleHidden`:
   ```js
       /**
        * Draw a panel's new content. Off screen: at once. Leaving: once it's
        * hidden. On screen: `patch` first, if given (true = it updated the rows
        * in place); else between two cascades — the rows leave, the new ones are
        * drawn and come in — so data landing mid-dwell never pops.
        */
       render(id, fn, patch) {
         if (this._busy[id]) { this._pending[id] = fn; return; }
         if (id !== this._current) { delete this._pending[id]; fn(); return; }
         if (patch && patch()) return;

         const el = this._el(id);
         const token = this._busy[id] = {};
         this._pending[id] = fn;
         const beats = beatsOf(el);
         const anims = beatsOut(beats, cascadeOffsets(beats.length, CASCADE_OUT).map(ms));
         Promise.all(anims.map((a) => a.finished)).then(() => {
           if (this._busy[id] !== token) return; // a transition or restart took it over
           delete this._busy[id];
           this._flush(id);
           const fresh = beatsOf(el);
           beatsIn(fresh, cascadeOffsets(fresh.length, CASCADE_IN).map(ms));
         }, () => {});
       }

       _flush(id) {
         const fn = this._pending[id];
         if (!fn) return;
         delete this._pending[id];
         fn();
       }
   ```

5. Replace `renderIfChanged` (and the comment block above it, which begins `// Each panel remembers the slice it last drew`) with:
   ```js
     // Each panel remembers the slice it last drew and skips the rebuild when
     // that slice is unchanged — a score bump must not re-cascade the visible
     // panel, nor re-run fitText's measuring. A change goes through the rotator,
     // which draws it at once off screen and between two cascades on screen.
     const lastRendered = {};
     function renderIfChanged(key, slice, render, patch) {
       const json = JSON.stringify(slice === undefined ? null : slice);
       if (lastRendered[key] === json) return;
       lastRendered[key] = json;
       rotator.render(key, render, patch);
     }
   ```
   (`refresh()` keeps calling it with three arguments; plan D adds the fourth for the crews.)

## Boundaries

- Only `side-panel.js`. Do NOT change the render functions, the views, the transition timing, or any constant.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted block doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes — especially "Switch Sides changes no slot…" and "loading a set with a player card on screen restarts once".
- **Feel check**: hold a card with `/o/side-panel?panel=player-1`, then press Switch Sides in the dock: the card's rows leave top-first and the other player's rows cascade in, no pop. With the full rotation running, load a new set while a player card is up: that card leaves once (as before) and never shows the new player's rows on its way out.
- **Done when**: every render goes through `rotator.render`, and on-screen changes cascade.
