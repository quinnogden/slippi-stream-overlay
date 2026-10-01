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
| `side-panel-singles-filter.test.js` | Doubles sets stay off the head-to-head card. start.gg's recent-sets query filters on player ids, not on event, so a doubles set the two also played arrives shaped exactly like a singles one — it renders as a pill *and* skews the H2H record, which is the part that is wrong rather than merely noisy. Pins the event-name rule, the slot predicate (nothing left after filtering means skip the panel, not show it blank) and what the renderer actually draws. |
| `side-panel-bridge-stats.test.js` | The side panel with the bridge's `player_stats` as its source. Records are oriented by start.gg player id against the columns *as they are now* (so Swap Teams flips them), a snapshot for any other pair — the previous set's, arriving late — shows nothing, TSH's head-to-head never fills a gap while the bridge is live, winner-only sets read W/L on the winner's side, the bridge going away falls back to TSH, and the stream queue is read in TSH's real shape without the on-air set. |
| `player-stats.test.js` | The bridge's head-to-head rules (`lib/stats/normalize.js`), each the shape of a set that broke a hand-verified record: a set played under an old tag (the slot carries the *old* player id), a Project M set in a Melee history, doubles, DQs, the same set seen from both histories. Also that the saved-history top-up stops at the first page it already holds, that a page start.gg refuses as too large is re-read smaller rather than counted as empty (TSH's bug), and that background requests wait for rate budget. |
| `combo-detector.test.js` | The combo clipper's qualifying thresholds, and `comboWindowSec` in particular — the closing window is measured from `endFrame`, is strictly stricter than judging the whole conversion, and falls back rather than rejecting when there is no move data. Every way it can be wrong is silent: too tight and the clipper banks nothing all night while OBS, the bridge and the dock all look healthy. Pure logic, no sandbox. |
| `bracket-target.test.js` | The Singles/Doubles buttons resolve to the right start.gg event (`lib/event/event-target.js`), and refuse rather than guess when a keyword matches two. A wrong pick is silent: the wrong bracket on the broadcast, every set id downstream mis-targeted. Also covers the shallow-merge trap in `config.local.js`. |
| `event-service.test.js` | The event service that replaced TSH's start.gg provider, on captured tournaments: Singles/Doubles load the right event (a second press re-reads it) and never touch the set on air; the picker offers playable sets first; a set load re-reads the set (and still loads, with a warning, when it can't), takes pronoun and main from the player DB and adds new players to it; a refresh still in flight for the previous event can't overwrite the new one; a restart reloads the saved event; the stats pre-fetch the next playable sets' players. |
| `start-set.test.js` | The Start Set button's gating answers from a per-set cache instead of querying start.gg on the 2s tick. Thirty ticks must cost one request — otherwise the bridge burns start.gg's 80/60s rate limit on a value that changes twice a set, and the thing that breaks mid-stream is *reporting*, nowhere near the cause. Also pins that an already-running, finished or preview set is refused rather than defaulting to startable. |
| `port-map.test.js` | Which scoreboard side gets the point, through the real game-mode handlers, store and `PortMap`: backwards ports matched by the players' mains, positional flagged when nothing matches, the same ports keeping a manual correction for the rest of the set, moved ports matched against the last game, and the winner read at game end — so a port swap, a set loaded mid-game or Switch Sides during the game all credit the player who won. Doubles teams map as wholes, non-adjacent ports included. A wrong answer is a healthy-looking scoreboard crediting the wrong player. |
| `game-winner.test.js` | Which port gets the point when a game ends: GAME!, RESOLVED (how most doubles games end), the stock fallback, and a rage quit — which in doubles must go to the *other* team, never the quitter's partner. A wrong answer here looks like a healthy scoreboard crediting the wrong player. |
| `control-status-shape.test.js` | The `control_status` seed a panel gets before the first tick has exactly the fields a rebuilt one has, and a failed rebuild resolves rather than rejects. Also that start.gg's token gate holds for every method that needs the token (reads fall back instead — see `startgg-fallback`). |
| `control-panel-static.test.js` | Every id the control panel's script looks up exists in its markup. `render()` runs on a 2s tick with no try/catch, so one missing id throws, kills the interval, and freezes the dock while it still *looks* fine. Run it after touching `public/control-panel.html`. |
| `bracket-model.test.js` | The TSH replacement's bracket graph (`lib/event/bracket-model.js`), against real captures: grand final and reset found (and the reset shown as only a maybe until GF 1 is decided), byes as edges to sets that don't exist, DQs, drop-in labels, every edge joining both ways, and the five overlay views — top 8 must be exactly the sets whose loser is guaranteed 8th or better. A wrong answer here is a bracket that draws fine and says something untrue. |
| `set-text.test.js` | What loading a set puts on the scoreboard: "Flex" outside top 8 and "Bo5" in it, [L] on the grand-finals player from losers (both in the reset), overrides winning; and the set picker offering playable sets first, since that's how a set gets chosen for stream. |
| `startgg-fallback.test.js` | Reads fall back to start.gg's keyless web endpoint (no token, 429, 5xx); mutations and a rejected token never do; a paged read doesn't stall 30s between pages after a 429, on the operator's path or the timed refresh. Each widening of the fallback would be silent. |
| `scoreboard-store.test.js` | The report names the entrant who actually won — set and every game — after any number of Switch Sides (each side carries its entrant id; TSH's swapped-column inversion is gone), and a restart restores the scoreboard from `data/live-state.json` while a corrupt or other-version save is ignored. Built on real set-model payloads. |
| `player-db.test.js` | `local_players.json` stays a file TSH can take back: an unchanged save is byte-identical to TSH's own (ASCII escapes, CRLF), unknown fields and TSH's odd shapes (`mains: "{}"`, null prefix, the `{}` stub) round-trip, and start.gg data never overwrites a hand-typed field. |
| `icons.test.js` | Every character and costume Slippi can report has a stock icon in `overlays/assets/icons/`, under `char_map`'s codename. |
| `helpers/fake-startgg.js` | Loads captured tournaments from `fixtures/startgg/` (`loadCapture`, `eventFrom`) and stands in for `StartggClient` with captured answers (`fakeStartgg`). Not a test. |
| `helpers/layout-sandbox.js` | Shared machinery: loads a real layout script into a `vm` with a fake DOM + GSAP. Not a test. |
| `fixtures/program-state.json` | A pruned, scrubbed `program_state.json`. |
| `fixtures/startgg/*.json` | Real start.gg tournaments, scrubbed, captured by `slippi-bridge/scripts/capture-startgg.js`. Raw material for the TSH replacement's bracket model — see below. |

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

`streamQueue` is the one exception — it's populated by hand here, because the live capture had an empty queue and the `queue` slot is worth being able to exercise. It follows TSH's real shape as `StartGGDataProvider.ProcessFutureSet` builds it (objects keyed `"1"`, `"2"`…, `team` → `player`). The first hand-written version invented an array shape instead, and the side panel was written against it — so on a real bracket the queue panel never showed, and every test passed. The same trap as above, one level down.

The fixture's player `id`s are bare strings; TSH really writes `[playerId, userId]`. The side panel accepts both, and `side-panel-bridge-stats.test.js` exercises the array form explicitly.

## The start.gg captures

`fixtures/startgg/<tournament>[.<label>].json` are real start.gg responses: the tournament, every Melee event's phases and phase groups, every set (with the `slots.prereqType/prereqId` edges a bracket is built from), and the stream queue. Captured with:

```bash
cd slippi-bridge
node scripts/capture-startgg.js                  # whatever config.BRACKETS.shortLink points at now
node scripts/capture-startgg.js --label live-r2  # a named snapshot of the same
node scripts/capture-startgg.js --past 3         # plus the series' last 3 tournaments
```

Scrubbed the same way and for the same reason as the TSH fixture, with one addition: **every id goes through a single table**, so a `prereqId` still points at the set (or seed) it named and the graph still joins up. Tags become `Player<n>`, prefixes `Team<n>`; tournament, event, phase, round and stream names are kept.

An existing capture is **never overwritten** — the same tournament before it starts, mid-event and after are three different test cases. A repeat run without `--label` lands as `<slug>.<HHMM>.json`.

What the set covers, and what it doesn't yet:

| Case | Where |
|---|---|
| Unstarted bracket (`preview_` set ids — they do carry prereq edges and `lPlacement`) | `hundred-acres-51.json` |
| Grand Final reset played | `hundred-acres-49.json` |
| Grand Final with no reset | `hundred-acres-47.json`, `-48.json` |
| DQs | `-47`, `-49` |
| Doubles; single-elimination (redemption) | all; `-47` |
| **Set in progress** | **missing** — only exists during an event; capture mid-event with `--label live` |

The stream queue is captured too, but it is normally empty: this series picks whichever set is playable rather than assigning sets to the stream on start.gg, so nothing downstream should depend on it.
