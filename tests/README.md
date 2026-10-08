# tests/

```bash
node tests/run.js                 # run everything
node tests/side-panel.test.js     # run one file, with full output
```

**No framework, no dependencies, nothing to configure.** Each `*.test.js` is a plain Node script that prints a summary and exits non-zero on failure. `run.js` runs them all and only shows output from the ones that fail.

> [!IMPORTANT]
> **This is not a general test suite, and it isn't trying to become one.**
>
> Almost everything in this repo is checked by hand against a live bracket (see [docs/TESTING.md](../docs/TESTING.md)). What belongs here is the narrow set of failures that are **invisible until they're on stream**: a browser source that renders but behaves wrong, a layout that silently stops updating, a rotation that flashes. They're worth automating because the manual way to catch them is "run a tournament".

## Contents

- [What's here](#whats-here)
- [Writing an overlay test](#writing-an-overlay-test)
- [The start.gg captures](#the-startgg-captures)

---

## What's here

The one-line summaries below are grouped by area. Open **Full details** under each table to see exactly what every rule pins down.

### 🖥️ Overlays

| File | Guards |
|---|---|
| `side-panel.test.js` | The side panel's rotation doesn't flash, and its stats and win projection follow the players through Switch Sides. |
| `bracket-overlay.test.js` | The bracket overlay's layout, fit-or-pan and live feed, on every capture. |
| `overlay-patch.test.js` | Every browser source's copy of the state stays equal to the app's. |
| `overlay-motion.test.js` | Show/hide and swap animations end on the right content. |
| `overlays-static.test.js` | Every URL an overlay page loads resolves. |
| `icons.test.js` | Every character and costume has a stock icon. |

<details>
<summary><b>Full details</b></summary>

- **`side-panel.test.js`**: the side panel (`overlays/side-panel/`) run against the real store, channel and overlay client. Its rotation must not flash the logo when a set load lands as a burst (the scoreboard, then the stats' "loading", cards and head-to-head), and must still restart when the panel on screen drops out — or that panel is stranded under the next one. Its stats are oriented by start.gg player id against the columns *now* (Switch Sides flips the tally), a record for any other pair shows nothing, winner-only sets read W/L on the winner's side, doubles drops the cards, and clip toasts queue. luckystats: the win projection sits on the head-to-head only for exactly this pair (with the "Powered by Lucky Stats" credit, hidden without it), its percentages and bar follow Switch Sides, two players who have never met get no card even with a projection, the player cards put the Lucky Rank under the character and box Class and Region (each with the app's copy of its image; a pin for a region without artwork; the region rank beside its name) beside the tag with the credit — none of it without luckystats data, and whatever is missing takes no room (no rank line, row or box) while an image that fails to load leaves no broken icon — and doubles shows no projection. All three rotation rules, the pair check, the never-met rule, the bar position, the region artwork, the region rank, the empty box, the empty rank line and the failed image are mutation-checked.
- **`bracket-overlay.test.js`**: the bracket overlay end to end on every capture. The layout (`overlays/bracket/layout.js`, pure): every set has a card, no two in a column overlap, every winner's path inside a side is a connector to the row it fills, a set sits between its two feeders, drop-ins and the grand final's losers slot are tagged rather than lined. The fit: Top 8 always fits whole, a big full bracket stops at the legibility floor and pans, starting from the live round or the set finished last. The feed (`lib/event/bracket-feed.js`): the dock's group, else the on-air set's; the on-air set's live score and characters; DB mains for everyone else; never saved. The page: draws the dock's view, crossfades on a switch without leaving the old board, `?view=` pins it, a data change redraws in place.
- **`overlay-patch.test.js`**: every browser source's copy of the state stays equal to the store's, through the real store, channel (`lib/overlay/channel.js`) and client mirror (`overlays/shared/overlay-client.js`, which loads under Node). A source that misses a patch must resync rather than keep drawing the old score; one that connects mid-burst must not; a restarted app's lower rev is still taken. A burst of commands is one patch, and only the selectors whose part changed run, so a casters edit can't re-animate the scoreboard. Game, clip and stats events reach the overlays under the channel's names, with the live game replayed to a late source until the game ends. A theme switch reloads every source once — highlights, which reads no state, included.
- **`overlay-motion.test.js`**: the overlays' show/hide and swap animations end on the right content, on the real scoreboard and casters pages at real animation speed: a score bumped again while the old one is still leaving ends on the newest score (not the one before), a pronoun cleared and refilled before its chip has gone keeps the chip with the new text (the overtaken hide must never apply), a cleared chip leaves and then hides, and a caster added after load is shown. A wrong answer is a healthy-looking source showing the score before last, or a chip gone for the rest of the set. Mutation-checked.
- **`overlays-static.test.js`**: every url an overlay page loads (scripts, stylesheets, every `url()` and `@import` down to the active theme pack, every pack's logo from an overlay stylesheet, since the dock switches packs on air) resolves through `lib/server/overlays.js`'s own tables, with or without a trailing slash; scripts load in order and parse; every page has a socket that follows a theme switch; and the icon url the overlays build names a real file for every character and costume. A mistyped url is a blank or unstyled OBS source with no error anywhere.
- **`icons.test.js`**: every character and costume Slippi can report has a stock icon in `overlays/assets/icons/`, under `char_map`'s codename.

</details>

### 🎛️ Dock and hotkeys

| File | Guards |
|---|---|
| `dock.test.js` | The dock, run against a real app: the strip, the tabs, input that survives pushes, autocomplete. |
| `dock-static.test.js` | The dock's wiring: every id, route and file it uses exists. |
| `hotkey.test.js` | Global hotkeys match exactly, fire once, and never crash the app. |

<details>
<summary><b>Full details</b></summary>

- **`dock.test.js`**: the dock (`public/dock/`) in the sandbox against the real store and channel **and a real Express app from `registerRoutes`**, so a key goes through the actual route and store command and what the dock then shows is the actual patch. The strip follows the scoreboard and its keys change it; a name being typed survives a push mid-word and commits on change (Escape sends nothing); the character picker is in select-screen order, a tap sets (and keeps the costume of the character already shown), a hold opens costumes; the [L] toggle sends both sides; Report and a load over a set with games ask first and Cancel stays cancelled; a status that makes a renderer throw is caught inside the dock. The casters are a draft until Put on stream and a push doesn't undo one (a tag from the player list fills the rest in place, without taking the focus); a player-list edit to someone on stream shows on stream, a pin goes through the same picker into the DB, and a stale search's ref is refused; the Setup tab hands out full urls and puts the bound chords on the strip's keys, and its theme select repoints only `theme.css`'s `@import` (still the first rule), refuses a pack that isn't a folder under `themes/`, and tells the overlays — without reloading the dock. The autocomplete: with an event loaded the player suggestions are only its entrants (the DB otherwise), a pick fills the whole slot — start.gg id and main included, the main shown only between games — Enter on a partial name still commits the text, and a lookup queued while typing survives the focus lookup coming back empty. Nine rules mutation-checked, plus the event-only suggestions and that race.
- **`dock-static.test.js`**: the dock's wiring without running it: every id it looks up exists, every `/api` route it calls exists with the method it uses, it loads nothing from off the app (fonts self-hosted, every file present), every tab has a panel, the clipper form covers every setting, every overlay url the Setup tab offers is served, and no `innerHTML`.
- **`hotkey.test.js`**: the global hotkeys (`lib/hotkey.js`), which change the live score from whatever window has focus: modifiers match exactly (Ctrl+Shift+Alt+1 takes a game away without also giving one), a held key fires once, a chord with no Ctrl/Alt/Win is refused, and a bad or clashing `HOTKEYS` entry is reported and left unbound rather than stopping the app. Also parses the defaults against uiohook-napi's real key table when it loads.

</details>

### 🏁 Scoring, ports and players

| File | Guards |
|---|---|
| `port-map.test.js` | The point goes to the right side, however the ports were matched or corrected. |
| `game-winner.test.js` | The right port wins each game, including rage quits in doubles. |
| `scoreboard-store.test.js` | Reports name the real winner after any Switch Sides; the scoreboard survives a restart. |
| `set-text.test.js` | Flex / Bo5, [L] marks and the set picker's order. |
| `mains-learning.test.js` | What players played is learned into the DB, and only when it should be. |
| `player-db.test.js` | `local_players.json` stays a file TSH can take back, byte for byte. |

<details>
<summary><b>Full details</b></summary>

- **`port-map.test.js`**: which scoreboard side gets the point, through the real game-mode handlers, store and `PortMap`: backwards ports matched by the players' mains, positional flagged when nothing matches, the same ports keeping a manual correction for the rest of the set, moved ports matched against the last game, and the winner read at game end — so a port swap, a set loaded mid-game or Switch Sides during the game all credit the player who won. Doubles teams map as wholes, non-adjacent ports included. A wrong answer is a healthy-looking scoreboard crediting the wrong player.
- **`game-winner.test.js`**: which port gets the point when a game ends: GAME!, RESOLVED (how most doubles games end), the stock fallback, and a rage quit — which in doubles must go to the *other* team, never the quitter's partner. A wrong answer here looks like a healthy scoreboard crediting the wrong player.
- **`scoreboard-store.test.js`**: the report names the entrant who actually won — set and every game — after any number of Switch Sides (each side carries its entrant id; TSH's swapped-column inversion is gone), and a restart restores the scoreboard from `data/live-state.json` while a corrupt or other-version save is ignored. Built on real set-model payloads.
- **`set-text.test.js`**: what loading a set puts on the scoreboard: "Flex" outside top 6 and "Bo5" in it, [L] on the grand-finals player from losers (both in the reset), overrides winning; and the set picker offering playable sets first, since that's how a set gets chosen for stream.
- **`mains-learning.test.js`**: what players played, learned into the player DB when their set ends (`lib/players/mains-learning.js`), through the real modes, port map, store and `PlayerDb`: a port swap mid-game teaches the corrected players, handwarmers/manual games/doubles/unknown typed names teach nothing, report-then-load learns once, and the loop closes — the next set opens on the learned main and game 1's backwards ports are matched by it.
- **`player-db.test.js`**: `local_players.json` stays a file TSH can take back: an unchanged save is byte-identical to TSH's own (ASCII escapes, CRLF), unknown fields and TSH's odd shapes (`mains: "{}"`, null prefix, the `{}` stub) round-trip, and start.gg data never overwrites a hand-typed field.

</details>

### 🏆 start.gg, events and stats

| File | Guards |
|---|---|
| `event-service.test.js` | Loading events and sets from start.gg, on real captured tournaments. |
| `bracket-model.test.js` | The bracket graph: grand final and reset, byes, DQs, the five views. |
| `bracket-target.test.js` | Singles / Doubles pick the right event, and refuse to guess. |
| `start-set.test.js` | The Start button doesn't spend start.gg's rate limit. |
| `startgg-fallback.test.js` | Reads fall back to the keyless endpoint; mutations never do. |
| `player-stats.test.js` | Head-to-head rules, checked against hand-verified records; luckystats answers land on the right player. |

<details>
<summary><b>Full details</b></summary>

- **`event-service.test.js`**: the event service that replaced TSH's start.gg provider, on captured tournaments: Singles/Doubles load the right event (a second press re-reads it) and never touch the set on air; the picker offers playable sets first; a set load re-reads the set (and still loads, with a warning, when it can't), closes the outgoing set *before* reading the incoming players' mains (so back-to-back players open on what they just played), takes pronoun and main from the player DB and adds new players to it; a refresh still in flight for the previous event can't overwrite the new one; a restart reloads the saved event; the refresh that first sees a bracket completed still reads its sets (or its last set, the GF reset, stays live in the picker); the stats pre-fetch the next playable sets' players.
- **`bracket-model.test.js`**: the bracket graph (`lib/event/bracket-model.js`), against real captures: grand final and reset found (and the reset shown as only a maybe until GF 1 is decided), byes as edges to sets that don't exist, DQs, drop-in labels, every edge joining both ways, and the five overlay views — top 8 must be exactly the sets whose loser is guaranteed 8th or better. A wrong answer here is a bracket that draws fine and says something untrue.
- **`bracket-target.test.js`**: the Singles/Doubles buttons resolve to the right start.gg event (`lib/event/event-target.js`), and refuse rather than guess when a keyword matches two. A wrong pick is silent: the wrong bracket on the broadcast, every set id downstream mis-targeted. Also covers the shallow-merge trap in `config.local.js`.
- **`start-set.test.js`**: the Start Set button's gating answers from a per-set cache instead of querying start.gg on the 2s tick. Thirty ticks must cost one request — otherwise the app burns start.gg's 80/60s rate limit on a value that changes twice a set, and the thing that breaks mid-stream is *reporting*, nowhere near the cause. Also pins that an already-running, finished or preview set is refused rather than defaulting to startable.
- **`startgg-fallback.test.js`**: reads fall back to start.gg's keyless web endpoint (no token, 429, 5xx); mutations and a rejected token never do; a paged read doesn't stall 30s between pages after a 429, on the operator's path or the timed refresh. Each widening of the fallback would be silent.
- **`player-stats.test.js`**: the head-to-head rules (`lib/stats/normalize.js`), each the shape of a set that broke a hand-verified record: a set played under an old tag (the slot carries the *old* player id), a Project M set in a Melee history, doubles, DQs, the same set seen from both histories. Also that the saved-history top-up stops at the first page it already holds, that a page start.gg refuses as too large is re-read smaller rather than counted as empty, and that background requests wait for rate budget. luckystats.gg (asked by start.gg *user* id, and a player id answers with somebody else): every answer is placed by the user id it came back with, one for a user we didn't ask about is dropped along with the matchup, the matchup's probabilities follow its own `order`, the region is the player's public Region (with its artwork and rank) else their own and never a crew, a malformed value (rank 0, a blank name) is dropped rather than shown, Region artwork is saved once under its own type and only from luckystats' hosts, the probability is ratings-only rather than blended with luckystats' head-to-head; end to end, the cards request's user ids are what luckystats is asked, a late answer for the previous pair is dropped, a player with no account is left out, no luckystats url reaches the snapshot, and with no key nothing is asked. Eight of these mutation-checked.

</details>

### ⚙️ App plumbing

| File | Guards |
|---|---|
| `combo-detector.test.js` | The clipper's thresholds and combo window. |
| `control-status-shape.test.js` | The dock's status has the same shape from the first tick, and never rejects. |
| `preflight.test.js` | The pre-event check runs to the end offline. |

<details>
<summary><b>Full details</b></summary>

- **`combo-detector.test.js`**: the combo clipper's qualifying thresholds, and `comboWindowSec` in particular — the closing window is measured from `endFrame`, is strictly stricter than judging the whole conversion, and falls back rather than rejecting when there is no move data. Every way it can be wrong is silent: too tight and the clipper banks nothing all night while OBS, the app and the dock all look healthy. Pure logic, no sandbox.
- **`control-status-shape.test.js`**: the `control_status` seed a panel gets before the first tick has exactly the fields a rebuilt one has, and a failed rebuild resolves rather than rejects. Also that start.gg's token gate holds for every method that needs the token (reads fall back instead — see `startgg-fallback`).
- **`preflight.test.js`**: the pre-event check (`app/scripts/preflight.js`) runs to the end offline, and its checks of what's in the repo — the theme pack and its logos, the icons, the overlay pages, the default hotkeys — pass. It requires what it checks lazily (it has to run before `npm install`), so a moved module is no startup error anywhere: without this it would surface as a FAIL the night before an event. Five mutations checked.

</details>

### 🧰 Helpers and fixtures *(not tests)*

| File | What it is |
|---|---|
| `helpers/fake-startgg.js` | Loads captured tournaments from `fixtures/startgg/` (`loadCapture`, `eventFrom`) and stands in for `StartggClient` with captured answers (`fakeStartgg`). |
| `helpers/overlay-sandbox.js` | Runs a real overlay page, or the dock, in a `vm`: its own `index.html` parsed into a small fake DOM, its scripts (overlay-client.js included), connected to a real channel. `fire(el, type)` clicks and types. |
| `fixtures/luckystats/pair.json` | A real luckystats.gg `/api/stream/players` answer for a pair, scrubbed like the start.gg captures: tags, user ids and region replaced, numbers kept. Its players are start.gg users 9001 and 9002. |
| `fixtures/startgg/*.json` | Real start.gg tournaments, scrubbed, captured by `app/scripts/capture-startgg.js`. See [The start.gg captures](#the-startgg-captures). |

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

1. **The DOM is the page's own markup.** `index.html` is parsed into the fake DOM, so `querySelector` finds what the page really has, and returns `null` for what it doesn't. A `null` is a real bug in the page, not in the sandbox.
2. **Animations finish on a timer:** `timeScale` (default 0.01) × their real length, in browser order. A cancelled one never finishes. There is no geometry (every element is 200px wide with 100px of content, so nothing is ever fitted), no cascade and no paint.
3. **Events don't bubble.** `fire(el, "click")` reaches that element's own listeners and nothing else (a disabled element ignores a click, as in a browser). To type, set `el.value = …`, then `fire(el, "input")` and `fire(el, "change")`. `focus()` and `blur()` move `document.activeElement`.
4. **Never `assert.strictEqual(node, …)`.** A failing assert inspects its operands with getters on, and a fake DOM node drags the whole document in: the test hangs instead of failing. Assert on a boolean or a string.
5. **The page's arrays come from another realm.** `assert.deepStrictEqual(page.window.X.list, [...])` fails on the prototype alone. Compare `JSON.parse(JSON.stringify(…))` instead.
6. **Build state with the app's own models, never by hand.** Use a store loaded from a captured set, and stats from `lib/stats/normalize.js` over the captured event. Hand-written TSH state is how the old side-panel tests came to pass while exercising nothing: their slot predicates read shapes no real state had.

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
| ⚠️ **Set in progress** | **Missing.** It only exists during an event, so capture mid-event with `--label live`. |
