# tests/

```bash
node tests/run.js                          # everything
node tests/side-panel-rotation.test.js     # one file, with detail
```

No framework, no dependency to install, nothing to configure. Each `*.test.js` is a plain Node script that prints a summary and exits non-zero on failure; `run.js` spawns them all and only shows output for the ones that failed.

This is **not** a general test suite, and it is not trying to become one. Almost everything in this repo is verified by hand against a live bracket — see [docs/TESTING.md](../docs/TESTING.md). What lands here is the narrow set of failures that are **invisible until they are on stream**: a browser source that renders but behaves wrong, a layout that silently stops updating, a rotation that flashes. Those are worth automating precisely because the manual loop for them is "run a tournament".

## What's here

| File | Guards |
|---|---|
| `layout-static.test.js` | Every layout script parses; every `<script src>` / `<link href>` resolves; the `shared/` helpers are wired into the pages that need them; no layout rebuilds the `chara_2_` icon path by hand. Fast — run it after touching anything under `layout/`, and after a TSH update copies `layout/` back. |
| `side-panel-rotation.test.js` | The side panel's rotation does not flash the logo when TSH bursts state pushes at it (loading a set, Swap Teams), while still restarting when the visible panel genuinely drops out of the rotation. |
| `bracket-target.test.js` | The Singles/Doubles buttons resolve to the right start.gg event, and refuse rather than guess when a keyword matches two. TSH validates nothing about the event URL it accepts, so a wrong pick is silent: green toast, wrong bracket on the broadcast, every set id downstream mis-targeted. Also covers the shallow-merge trap in `config.local.js`. |
| `control-panel-static.test.js` | Every id the control panel's script looks up exists in its markup. `render()` runs on a 2s tick with no try/catch, so one missing id throws, kills the interval, and freezes the dock while it still *looks* fine. Run it after touching `public/control-panel.html`. |
| `helpers/layout-sandbox.js` | Shared machinery: loads a real layout script into a `vm` with a fake DOM + GSAP. Not a test. |
| `fixtures/program-state.json` | A pruned, scrubbed `program_state.json`. |

## Writing another layout test

The layouts are browser scripts with no module boundary — they read the DOM, drive GSAP, and hang their logic off TSH's `Start()` / `Update()` hooks inside a `LoadEverything().then()` closure, so `require()` cannot reach any of it. `helpers/layout-sandbox.js` exists to get around that:

```js
const { loadLayout, fixture, clone, sleep } = require("./helpers/layout-sandbox");

const env = await loadLayout({
  file: "TournamentStreamHelper-5.972/layout/side-panel/side-panel.js",
  ids: ["panel-player-1"],              // document.getElementById keys
  selectors: [".logo-primary"],         // document.querySelector keys
  expose: ["rotator"],                  // top-level consts to publish (see below)
}).ready();

await env.sandbox.Update({ data: fixture("program-state") });
env.exposed.rotator._slots;             // now assert on what the layout did
```

Four things about the sandbox that will otherwise cost you an hour each:

- **Lexical top-level bindings are unreachable.** A top-level `const rotator` never becomes a property of the sandbox global, so `expose: ["rotator"]` appends an explicit publish line to the source. `loadLayout` throws if the name doesn't materialise, rather than handing you a silent `undefined`.
- **`Start` / `Update` do not exist synchronously.** They are assigned inside `LoadEverything().then()`, so `await env.ready()` waits a microtask and fails loudly if the bootstrap threw.
- **`querySelector` returns a stub, never `null`.** The render functions are wrapped in bare `catch (_) {}`, so a `null` here would send them straight into the catch and quietly pass a test that exercised nothing.
- **`fetch` fails by default.** A layout must degrade when TSH or the bridge is down; if a test needs a response, stub it via `globals`.

The sandbox has **no geometry, no cascade and no real animation**. It answers "did the script do the right thing", never "does it look right". Anything visual stays in [docs/TESTING.md](../docs/TESTING.md).

## The fixture

`fixtures/program-state.json` is a real TSH `program_state.json` — pruned to the subtrees the layouts read, then scrubbed: every player tag, real name, birthday, twitter handle, city/country and start.gg id replaced with a synthetic value. The structure is untouched.

Both parts matter:

- **It is scrubbed** because the live file carries real attendee data pulled from start.gg, and this repo is not the place for it.
- **It is vendored** because `TournamentStreamHelper-*/out/` is gitignored, so a fresh clone has no live state to read.

Hand-writing this file is a trap worth naming: the side panel's slot predicates (`hasPlayerCardContent`, `hasRecentSets`, `hasQueue`) dig into `history_sets` / `last_sets` / `recent_sets` / `streamQueue`, all in shapes that are not obvious. The first attempt at the rotation test used invented state, and it could not fail — the predicates all returned false, the slot list never changed, and the bug it was written to catch never fired. If you need a state shape that isn't in the fixture, take it from a live `out/program_state.json` and scrub it; don't invent it.

`streamQueue` is the one exception — it's populated by hand here, because the live capture had an empty queue and the `queue` slot is worth being able to exercise.
