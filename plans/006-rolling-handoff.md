# 006 — Hand the card over row by row (no double exposure, no dead air)

- **Status**: DONE
- **Commit**: ada0741 (assumes plans 001–005 applied)
- **Severity**: HIGH
- **Category**: Easing & duration (crossfade)
- **Estimated scope**: 1 file, ~60 lines

## Problem

Before these plans, the side panel's rotation started the new panel while
the old one was still ~83% opaque, so for ~300ms both panels' text was on
screen at 35–75% (the "double exposure"). Plan 005 fixed that by waiting for
the whole exit before anything comes in:

```js
/* overlays/side-panel/side-panel.js — current (after plan 005), in _transitionTo */
          start = delays.length ? delays[delays.length - 1] + ms(BEAT_OUT_MS) : 0;
  …
        const delays = cascadeOffsets(beats.length, CASCADE_IN).map((d) => start + ms(d));
```

Clean, but sequential: the top of the card sits empty while the bottom rows
are still leaving. The new rows should follow the old ones down the card —
a row comes in as soon as the old rows it would be drawn over have gone — so
the exit and entrance read as one continuous sweep, and still no row is ever
drawn over another.

## Target

- Measure each outgoing beat's vertical extent **before** it starts moving (`getBoundingClientRect`), and record when each one has gone (`outEnds[j]` = its delay + `ms(BEAT_OUT_MS)`). An outgoing **logo** counts as covering the whole card and as gone half-way through its 300ms exit.
- For each incoming beat: `wait[i]` = the latest `outEnds[j]` over outgoing beats whose extent overlaps it (±4px). The cascade then runs from the first beat: `delay[i] = max(delay[i-1], wait[0] + own[i], wait[i])`, where `own` = `cascadeOffsets(n, CASCADE_IN)` at tempo. Never out of reading order.
- Where anything can't be measured (no layout, zero height), every incoming beat waits for the whole exit — exactly plan 005's behaviour. (The test sandbox reports the same 200×100 box for every element, so there everything overlaps and waits for the whole exit: deterministic.)
- An incoming **logo** waits for everything to have gone.
- The surface fades in with the first incoming beat (`delays[0]`), and out at once under an incoming logo.

## Repo conventions to follow

- Pure helpers under `// ── Beats ──` next to `beatsOf`, `cascadeOffsets`, `beatsOut`.
- `tests/helpers/overlay-sandbox.js:234` — the sandbox's `getBoundingClientRect()` returns `{ top: 0, bottom: 100, height: 100, … }` for every element.

## Steps

1. `overlays/side-panel/side-panel.js` — directly after `beatsOut()`, add:
   ```js

     /** A node's vertical extent, or null where nothing is laid out. */
     function spanOf(el) {
       const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
       return r && r.height > 0 ? { top: r.top, bottom: r.bottom } : null;
     }

     /**
      * When each incoming beat starts, given where the outgoing rows were
      * (outSpans) and when each has gone (outEnds, ms at tempo): a beat waits
      * until every old row it would be drawn over has gone, and the cascade
      * (own: its offsets, ms at tempo) carries on from the first beat's start,
      * never out of reading order. Where anything can't be measured, every
      * beat waits for the whole exit.
      */
     function handoff(beats, own, outSpans, outEnds) {
       const allGone = outEnds.length ? Math.max(...outEnds) : 0;
       const blind = outSpans.some((s) => !s);
       const waits = beats.map((b) => {
         const s = blind ? null : spanOf(b);
         if (!s) return allGone;
         let w = 0;
         outSpans.forEach((o, j) => {
           if (o.top < s.bottom + 4 && o.bottom > s.top - 4) w = Math.max(w, outEnds[j]);
         });
         return w;
       });
       const base = waits.length ? waits[0] : allGone;
       let prev = 0;
       return beats.map((_, i) => (prev = Math.max(prev, base + own[i], waits[i])));
     }
   ```

2. Same file, in `_transitionTo`: replace everything from the comment line
   `      // Out: a logo drifts away whole; an info panel stays put while its beats`
   through the line
   `      setTimeout(() => { if (run === this._run) onDone(); }, end);`
   (inclusive) with:
   ```js
         // Out: a logo drifts away whole; an info panel stays put while its beats
         // cascade out, top first. outSpans / outEnds: where each outgoing thing
         // was and when it has gone, for the handoff below.
         let outSpans = [];
         let outEnds = [];
         if (outgoing && outgoing !== incoming) {
           const token = this._busy[leaving] = {};
           let anims;
           if (this._isLogo(leaving)) {
             const from = getComputedStyle(outgoing).opacity;
             stopAnims(outgoing);
             const rest = restOf(outgoing);
             anims = [outgoing.animate([pose(rest, { opacity: from }), pose(rest, { ...LOGO_OUT, opacity: 0 })],
               { duration: ms(LOGO_OUT_MS), easing: ease("out"), fill: "forwards" })];
             // The logo stands for the whole card, gone half-way (--ease-out: ~97%).
             outSpans = [{ top: -Infinity, bottom: Infinity }];
             outEnds = [ms(LOGO_OUT_MS) * 0.5];
           } else {
             const beats = beatsOf(outgoing);
             outSpans = beats.map(spanOf); // before anything moves
             const delays = cascadeOffsets(beats.length, CASCADE_OUT).map(ms);
             anims = beatsOut(beats, delays);
             outEnds = delays.map((d) => d + ms(BEAT_OUT_MS));
           }
           // Settled once everything has gone — unless the panel was taken over
           // meanwhile (shown again, or hidden outright by a restart).
           Promise.all(anims.map((a) => a.finished)).then(() => {
             if (this._busy[leaving] === token) this._settleHidden(leaving, outgoing);
           }, () => {});
         }
         delete this._busy[id];
         const allGone = outEnds.length ? Math.max(...outEnds) : 0;

         // In. A logo arrives whole once everything has gone. An info panel
         // appears at once (it has no surface of its own) and each of its beats
         // takes its place as soon as the old rows there have left.
         const logo = this._isLogo(id);
         let end;
         if (logo) {
           this._surface(false, 0);
           stopAnims(incoming);
           const rest = restOf(incoming);
           tween(incoming, [pose(rest, { ...LOGO_IN, opacity: 0 }), pose(rest)], SHOWN,
             { duration: ms(LOGO_IN_MS), delay: allGone, easing: ease("out") });
           end = allGone + ms(LOGO_IN_MS);
         } else {
           setStyle(incoming, SHOWN);
           const beats = beatsOf(incoming);
           const delays = handoff(beats, cascadeOffsets(beats.length, CASCADE_IN).map(ms), outSpans, outEnds);
           this._surface(true, delays.length ? delays[0] : allGone);
           beatsIn(beats, delays);
           end = (delays.length ? delays[delays.length - 1] : allGone) + ms(BEAT_IN_MS);
         }
         // On a timer, not an animation's promise: a beat cancelled later (a
         // re-render) must never stall the rotation.
         setTimeout(() => { if (run === this._run) onDone(); }, end);
   ```

3. Confirm the variable `start` no longer appears in `_transitionTo`.

## Boundaries

- Only `side-panel.js`. Do NOT change any constant, pose, or `beatsIn` / `beatsOut` / `cascadeOffsets`.
- Do NOT add tests or dependencies. Do NOT edit docs.
- If a quoted block doesn't match, STOP and report.

## Verification

- **Mechanical**: `node tests/run.js` passes.
- **Feel check** (`/o/side-panel`, full rotation; DevTools → Animations at 10% helps): player card → head-to-head: as the name and "Current Run" lift away, the head-to-head's header and names come in at the top while the lower pills are still leaving below — one sweep down the card. Pause anywhere: no spot on the card shows an old row and a new row on top of each other. Logo → panel: rows start as the logo is all but gone. Panel → logo: the logo appears only after the last row has left.
- **Done when**: the handoff function drives every panel entrance, tests pass, and the feel check shows no overlap.
