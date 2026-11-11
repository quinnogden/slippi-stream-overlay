# tests/

```bash
node tests/run.js                 # everything, in parallel (~4s)
node tests/run.js dock crew       # only the files whose name contains "dock" or "crew"
node tests/side-panel.test.js     # one file, with full output
```

**No framework, no dependencies, nothing to configure.** Each `*.test.js` is a plain Node script that prints a summary and exits non-zero on failure. `run.js` runs them in parallel and only shows output from the ones that fail.

> [!IMPORTANT]
> **This is not a general test suite, and it isn't trying to become one.**
>
> Almost everything in this repo is checked by hand against a live bracket (see [docs/TESTING.md](../docs/TESTING.md)). What belongs here is the narrow set of failures that are **invisible until they're on stream**: a browser source that renders but behaves wrong, a layout that silently stops updating, a rotation that flashes, a point credited to the wrong player. They're worth automating because the manual way to catch them is "run a tournament".

## Contents

- [What's here](#whats-here)
- [Adding a test](#adding-a-test)
- [Writing an overlay test](#writing-an-overlay-test)
- [The start.gg captures](#the-startgg-captures)

---

## What's here

One line per file. **The file's own header comment says exactly what it pins and why** — read it before changing a rule it covers.

### 🖥️ Overlays

| File | Guards |
|---|---|
| `side-panel.test.js` | The side panel's rotation doesn't flash, its stats and win projection follow the players through Switch Sides, and a crew battle shows its rosters. |
| `bracket-overlay.test.js` | The bracket overlay's layout, pages, Board camera, tour, Up Next and live feed, on every capture. |
| `overlay-patch.test.js` | Every browser source's copy of the state stays equal to the app's. |
| `overlay-motion.test.js` | Show/hide and swap animations end on the right content; the score reel turns the right way. |
| `overlays-static.test.js` | Every URL an overlay page loads resolves, and every character and costume has an icon. |
| `set-stats.test.js` | The stats popup's numbers follow the players through Switch Sides; it comes up after a game, never into the next one; every layout draws in every style without letting a name inject markup; a hide ends in a source that isn't painting; the players bar's logo makes way for it; a layout with its own window box goes up in it. |

### 🎛️ Dock and hotkeys

| File | Guards |
|---|---|
| `dock.test.js` | The dock, run against a real app: the strip, the tabs, folding, input that survives pushes, autocomplete, a crew battle, the Replays tab. |
| `dock-static.test.js` | The dock's wiring: every id, route and file it uses exists. |
| `hotkey.test.js` | Global hotkeys match exactly, fire once, and never crash the app. |

### 🏁 Scoring, ports and players

| File | Guards |
|---|---|
| `port-map.test.js` | The point goes to the right side, however the ports were matched or corrected. |
| `game-winner.test.js` | The right port wins each game, including rage quits in doubles. |
| `scoreboard-store.test.js` | Reports name the real winner after any Switch Sides; the scoreboard survives a restart. |
| `crew.test.js` | A crew battle's stocks move right at game end, and it stays out of the normal flow. |
| `set-text.test.js` | Flex / Bo5 and the dock's rule for it, when a set is won by its format (Flex at 2–0 or 3), [L] marks and the set picker's order. |
| `mains-learning.test.js` | What players played is learned into the DB, and only when it should be. |
| `player-db.test.js` | `local_players.json` stays byte-identical to TSH's format for unchanged records. |

### 🏆 start.gg, events and stats

| File | Guards |
|---|---|
| `event-service.test.js` | Loading events and sets from start.gg, on real captured tournaments. |
| `bracket-model.test.js` | The bracket graph: grand final and reset, byes, DQs, the five views. |
| `bracket-target.test.js` | Singles / Doubles pick the right event, and refuse to guess. |
| `start-set.test.js` | The Start button doesn't spend start.gg's rate limit. |
| `startgg-fallback.test.js` | Reads fall back to the keyless endpoint; mutations never do. |
| `player-stats.test.js` | Head-to-head rules, checked against hand-verified records; luckystats answers land on the right player. |

### ⚙️ App plumbing

| File | Guards |
|---|---|
| `combo-detector.test.js` | The clipper's thresholds and combo window. |
| `control-status-shape.test.js` | The dock's status has the same shape from the first tick, and never rejects. |
| `preflight.test.js` | The pre-event check runs to the end offline, and the repo's own files (theme pack, icons, overlay pages) pass it. |
| `replays.test.js` | A stream set's context.json is Replay Reporter's, its history survives captures, and its upload resumes rather than doubles. |

### 🧰 Helpers and fixtures *(not tests)*

| File | What it is |
|---|---|
| `helpers/fake-startgg.js` | Loads captured tournaments from `fixtures/startgg/` (`loadCapture`, `eventFrom`, `rewind`) and stands in for `StartggClient` with captured answers (`fakeStartgg`). |
| `helpers/overlay-sandbox.js` | Runs a real overlay page, or the dock, in a `vm`: its own `index.html` parsed into a small fake DOM, its scripts (overlay-client.js included), connected to a real channel. `fire(el, type)` clicks and types. |
| `fixtures/luckystats/pair.json` | A real luckystats.gg `/api/stream/players` answer for a pair, scrubbed: tags, user ids and region replaced, numbers kept. Its players are start.gg users 9001 and 9002. |
| `fixtures/startgg/*.json` | Real start.gg tournaments, scrubbed, captured by `app/scripts/capture-startgg.js`. See [The start.gg captures](#the-startgg-captures). |

---

## Adding a test

- **Extend the file that already covers the area** before starting a new one. A new feature in the dock is a `test(…)` in `dock.test.js` using its `rig()`, not a new file.
- **Pin the rule, not the feature.** One assertion that would fail if the rule broke beats a walk through every button. Don't assert on something's absence after removing it — the code is gone, and git remembers.
- **Mutation-check it once**: break the rule in the source, see the test fail, put it back.
- **Keep it fast.** The files run in parallel, so the slowest file is the suite's wall time — `dock.test.js`, at ~4s. Wait on a condition (`dock.test.js`'s `until(cond)`) rather than a fixed `sleep()`, and keep animations at the sandbox's default `timeScale` unless the test is about timing (`overlay-motion.test.js` is, and says why its scale is what it is).
- **Own your state.** Each file makes its own temp dir (`fs.mkdtempSync`) and listens on port 0, so files can run side by side. Never write into `app/data/` or the real `overlays/theme.css`.

---

## Writing an overlay test

The overlays are browser scripts, so `require()` can't reach them. `helpers/overlay-sandbox.js` runs one the way OBS would, fed by the app's own channel:

```js
const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createOverlayChannel } = require("../app/lib/overlay/channel");
const { loadOverlay, fakeIo, texts, sleep } = require("./helpers/overlay-sandbox");

const store = new ScoreboardStore();
store.loadSet(loadPayload(graph, setId));         // a real set-model payload
const { io, nsps } = fakeIo();
const channel = createOverlayChannel({ io, store });
const page = await loadOverlay({ page: "side-panel", nsps, search: "?panel=player-1" });

store.switchSides();                              // drive the app, not the page
channel.emit("player_stats", snapshot);           // events under their original names
await sleep(15);                                  // patches flush on the next tick
texts(page.$("#panel-recent-sets"));              // assert on what the page drew
page.window.SidePanel.rotator;                    // whatever the page exposes on window
```

The dock runs the same way with `htmlFile`, a `resolve` for its `/dock/` scripts and a `fetch` aimed at an in-process app. `dock.test.js` is the worked example; it ends with `process.exit`, since the dock's polls keep Node alive.

### Sandbox gotchas

> [!WARNING]
> Each of these will otherwise cost you about an hour.

1. **The DOM is the page's own markup.** `index.html` is parsed into the fake DOM, so `querySelector` finds what the page really has, and returns `null` for what it doesn't. A `null` is a real bug in the page, not in the sandbox. Selectors are tag, `#id`, `.class`, `[attr]`, `[attr="v"]`, descendant combinators and commas — anything else throws.
2. **Animations finish on a timer:** `timeScale` (default 0.01) × their real length, in browser order. A cancelled one never finishes. There is no geometry (every element is 200px wide with 100px of content, so nothing is ever fitted), no cascade and no paint.
3. **Events don't bubble.** `fire(el, "click")` reaches that element's own listeners and nothing else (a disabled element ignores a click, as in a browser). To type, set `el.value = …`, then `fire(el, "input")` and `fire(el, "change")`. `focus()` and `blur()` move `document.activeElement`.
4. **Never `assert.strictEqual(node, …)`.** A failing assert inspects its operands with getters on, and a fake DOM node drags the whole document in: the test hangs instead of failing. Assert on a boolean or a string.
5. **The page's arrays come from another realm.** `assert.deepStrictEqual(page.window.X.list, [...])` fails on the prototype alone. Compare `JSON.parse(JSON.stringify(…))` instead.
6. **Build state with the app's own models, never by hand.** Use a store loaded from a captured set, and stats from `lib/stats/normalize.js` over the captured event. Hand-written state is how the old side-panel tests came to pass while exercising nothing: their slot predicates read shapes no real state had.

> [!NOTE]
> The sandbox answers *"did the script do the right thing?"*, never *"does it look right?"*. Anything visual stays in [docs/TESTING.md](../docs/TESTING.md): a headless Chrome screenshot of the page served by the running app.

---

## The start.gg captures

`fixtures/startgg/<tournament>[.<label>].json` are real start.gg responses: the tournament, every Melee event's phases and phase groups, and every set (with the `slots.prereqType/prereqId` edges a bracket is built from).

### Capturing one

```bash
cd app
node scripts/capture-startgg.js                  # whatever config.BRACKETS.shortLink points at now
node scripts/capture-startgg.js --label live-r2  # a named snapshot of the same
node scripts/capture-startgg.js --past 3         # plus the series' last 3 tournaments
```

- **Captures are scrubbed.** The live data carries real attendee data, and this repo is not the place for it. Tags become `Player<n>` and prefixes `Team<n>`; tournament, event, phase and round names are kept.
- **Every id goes through a single table**, so a `prereqId` still points at the set (or seed) it named, and the graph still joins up.
- **An existing capture is never overwritten.** The same tournament before it starts, mid-event and after are three different test cases. A repeat run without `--label` is saved as `<slug>.<HHMM>.json`.

### What's covered

| Case | Where |
|---|---|
| Unstarted bracket (`preview_` set ids, which do carry prereq edges and `lPlacement`) | `hundred-acres-51.json` |
| The same bracket unstarted and finished (ids don't carry over; each capture is scrubbed on its own) | `hundred-acres-51.json`, `-51.final.json` |
| Grand Final reset played | `hundred-acres-49.json`, `-51.final.json` |
| Grand Final with no reset | `hundred-acres-47.json`, `-48.json` |
| DQs | `-47`, `-49` |
| Doubles; single elimination (redemption) | all; `-47` |
| A big single bracket (51 entrants, 100 sets: 3884×3962 as one board) | `hundred-acres-50.json` (captured by slug, renamed) |
| Several pools at once, then a Top 16 phase (147 entrants, 4 pools) | `bair-necessities.json` (captured by slug, renamed) |
| Mid-event, from a finished capture | `rewind(capture, frac, { live })` in `helpers/fake-startgg.js`: unplays the sets finished after that point and empties the slots they fed — real structure, no invented sets |
| ⚠️ **Set in progress** | **Missing.** It only exists during an event, so capture mid-event with `--label live`. |
