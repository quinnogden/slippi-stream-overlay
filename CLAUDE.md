# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This app replaced TournamentStreamHelper (TSH) on 2026-10-01. The last TSH-era commit is tagged **`tsh-final`**.

## What This Repo Is

One Node app that runs a Melee tournament stream: it reads live Slippi games, owns the scoreboard, runs the event from start.gg, keeps the player DB, serves every OBS overlay, and gives the operator one dock to drive it from.

1. **`app/`** — the app. `index.js` is the composition root; everything else is in `lib/`. The dock is `public/dock/`.
2. **`overlays/`** — every OBS browser source, the shared overlay runtime, the theme packs and the stock character icons; the stats popup's portraits and stage pictures are downloaded into `overlays/assets/packs/` (gitignored) from the dock, except the VS screen pack (`packs/full/`), which is committed upscaled 2×. Served at `/o/` and `/assets/`.
3. **`start.bat`** — the launcher (installs dependencies on first run).
4. **`obs-scripts/`** — Python scripts that run *inside* OBS (Tools → Scripts). Just `auto_replays.py`, the break-scene clip playlist. Not required by the app.
5. **`tests/`** — `node tests/run.js` (all files in parallel, ~4s; `node tests/run.js dock crew` runs only the files whose name matches). No framework; each `*.test.js` is a plain Node script that exits non-zero. Deliberately narrow: only failures that are invisible until they are on stream. Read [tests/README.md](tests/README.md) before adding one — extend the file that covers the area rather than starting a new one, the sandbox has gotchas, and hand-written state produces tests that pass without exercising anything.

### Companion docs — read the relevant one before working, don't re-derive it

- **[docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md)** — setting up a machine or a fresh OBS profile. **When the user says "run the fresh-install checklist", work that document.** Start with `node app/scripts/preflight.js`, which automates its mechanical half (deps, config, hotkeys, the player file, icons, overlay pages, theme pack, the stats popup's art, then live probes of the app, start.gg and OBS). Read-only; exits non-zero on any failure.
- **[docs/TESTING.md](docs/TESTING.md)** — verifying a change with no bracket running: the automated checks, replaying `.slp` files *faithfully* (a finished replay does **not** reproduce live conditions — see the `rawDataLength` note there), booting the app against a past event, screenshotting overlays, and the regression checklist.
- **[docs/BRIDGE-API.md](docs/BRIDGE-API.md)** — the state sections, event payloads and `/api/*` routes, with the traps in each. Consult it before changing anything a browser consumes; nothing on either side validates, so a shape change fails silently in a browser source.
- **[docs/STATS-POPUP.md](docs/STATS-POPUP.md)** — the stats popup, from reading the replays to the art packs, portraits, layouts, their motion and the rigs.
- **[docs/OVERLAYS.md](docs/OVERLAYS.md)** — each overlay page in detail (the side panel's rotation, the bracket's pages and camera, the scoreboard, the highlights frame), the motion helpers, and the theme packs' tokens and flair.
- **[docs/DOCK.md](docs/DOCK.md)** — the operator dock tab by tab: the strip's modes, folding, and the Crew, Bracket, Stats, Set, Players and Setup tabs.
- **[docs/REPLAYS.md](docs/REPLAYS.md)** — stream-set replays: the modules, Replay Reporter's `context.json` rules, the LuckyStats upload protocol, the Replays tab, and what's unverified until the first live use.

---

## Running

`start.bat` at the repo root, or `cd app && node index.js`. One port (default **5001**) serves the dock (`/dock`; `/` and `/control` redirect there), every overlay (`/o/…`), the icons (`/assets/icons/`), the API and Socket.io.

Config is [app/config.js](app/config.js) (committed defaults), with the gitignored `app/config.local.js` merged over it by a **shallow** `Object.assign`:

- `SLP_FOLDER` — the Slippi spectate folder. The app exits at startup if it doesn't exist.
- `BRIDGE_PORT` — every OBS source names it.
- `BRACKETS` — the series' start.gg short link (**hyphenated**) and keyword `match` + `fallbackSlug` per kind.
- `PLAYERS_FILE` — the player DB; `null` = `app/data/local_players.json`.
- `STARTGG_TOKEN` — **never in `config.js`**. Missing token: brackets still load (keyless fallback), Start/Report/stats are off.
- `LUCKYSTATS_KEY` — **never in `config.js`**. A luckystats.gg API key (from a claimed account's settings). Missing key: no Lucky Rank, Elo or win projection on the side panel; nothing else changes.
- `LUCKYSTATS_UPLOAD_KEY` — **never in `config.js`**. A luckystats.gg *upload* key (`l7u_…`, Account → API → App uploads; a player-data key can't upload). Missing key: stream sets are still kept (and archived), just not uploaded.
- `REPLAY_ARCHIVE_FOLDER` — where each stream set's replays + context.json are copied, one folder per set. `null` = no copy.

Three keys have their defaults in their module, not `config.js`, and are only set from `config.local.js`, merged per key: `HOTKEYS` (`lib/hotkey.js`), `CLIPPER` (`lib/clipper-settings.js`; starting values only — the Clips tab's gitignored `clipper-settings.json` wins) and `SET_TEXT` (`lib/scoreboard/set-text.js`: "Bo5" once the set's loser is guaranteed top 6, "Flex" before; starting values only — the Set tab's **Best-of** card saves `setRules` in `live-state.json`, which wins). `BRACKETS` overridden in `config.local.js` replaces the whole object, so `event-target.js`'s `normalizeBrackets` fills missing keys. A `config.local.js` that fails to load throws rather than being skipped.

---

## Architecture

```
Slippi Desktop App → live .slp in SLP_FOLDER
        ↓  (polled every 500ms — game-source.js)
modes/ ─ port-map ─→ ScoreboardStore ←── dock commands (/api/*), hotkeys, event service (loadSet)
                          │  change
          ┌───────────────┼──────────────────┬───────────────┐
   overlay channel     persist.js        stats/          mains-learning
   (/overlay, /dock)   data/live-state   (player_stats)  (player DB, at set end)
          ↓
   overlays/ (OBS)  +  the dock
start.gg ←→ startgg-client.js  (event service reads, stats, Start, Report)
OBS      ←→ obs-client.js      (replay buffer saves)
LuckyStats ← replays/uploader.js (each stream set's .slp + context.json, after Report)
```

### `app/`

```
index.js                   composition root
config.js                  committed defaults     config.local.js  gitignored (token, per-machine paths)
clipper-settings.json      gitignored, written by the Clips tab — must stay at this path
data/                      gitignored: live-state.json, crews.json, stream-sets.json, and local_players.json by default
*.example.*                tracked samples of the per-machine files (config.local, clipper-settings,
                           data/local_players) — docs/FRESH-INSTALL.md "Starting from scratch"
stats-cache/               gitignored, one start.gg set history per player
public/dock/               the operator dock (index.html, dock.js, dock.css, fonts/)
scripts/                   preflight.js  capture-startgg.js  spoof-stats.js  screenshots/ (the README images)
lib/
  scoreboard/              store.js  persist.js  set-text.js
  ports/                   port-map.js
  players/                 player-db.js  mains-learning.js
  crew/                    crew-model.js  saved-crews.js
  event/                   event-service.js  event-target.js  bracket-model.js  bracket-feed.js
                           bracket-director.js  set-model.js  queries.js
  overlay/                 channel.js
  modes/                   index.js  singles.js  doubles.js  game-end.js
  server/                  app.js  routes.js  overlays.js  control-status.js  report-set.js
                           start-set.js  set-gate.js
    api/                   status  scoreboard  crew  event  players  casters  clipper  replays  set-stats  setup
  stats/                   index.js  set-history.js  normalize.js  queries.js  luckystats.js
  set-stats/               index.js  game-stats.js  worker.js  set-view.js  director.js  portraits.js
                           art-packs.js  catalog.js  stages.js  fun-stats.js  accolades.js  stories.js
  replays/                 index.js  stream-sets.js  context.js  bundle.js  archive.js  uploader.js  slp-file.js
  game-source.js  combo-detector.js  clip-recorder.js  obs-client.js  clipper-settings.js  safe-emitter.js
  startgg-client.js  hotkey.js  lan-urls.js  port-guard.js  handwarmer.js  char_map.js
  players.js  state.js
```

**`index.js` is a composition root, not a god object.** It builds the services and hands a single `ctx` to each feature factory: `{ config, io, state, store, portMap, playerDb, startgg, clipperSettings, comboDetector, obs, event }`, where `io` is the overlay channel's `emit()`. Wiring is a DAG — store (+persist) → channel → event service → bracket feed, mains learning → modes → control status → clip recorder → stats → replays → set stats → report/start → hotkeys → routes — so nothing needs a late binding. `modes` subscribes to the store's events, which is why it comes before anything that shows its port map.

**`lib/state.js`** holds what isn't the scoreboard: the live game (`currentGameState`, `currentRawPlayers`), the clipper's counters, `lastControlStatus`, `source`. **The file documents which module writes which field — keep that current.**

### The scoreboard — `lib/scoreboard/`

**`store.js` (`ScoreboardStore`) is the one owner of live state**: the set on the scoreboard, the loaded tournament, the casters, the overlays' view settings (`bracketView`, `bracketPhaseGroupId`), the bracket section and the bracket overlay's shot (`bracketShot`, not saved), the best-of rule (`setRules`, saved) and the stats popup's sections. Every change is a command (`loadSet`, `closeSet`, `clearSet`, `detachSet`, `recordGame`, `bump`, `clearScore`, `setScore`, `setPlayer`, `setDoubles`, `setCharacter`, `setSideColor`, `switchSides`, `setOverrides`, `setTournament`, `setCasters`, `setBracketView`, `setBracketPhaseGroup`, `setBracket`, `setBracketShot`, `setSetRules`, `setStatsConfig`, `setSetStats`, `setStatsShot`) that bumps `rev` and emits `change` with the sections it touched. Nothing outside the file mutates state.

Two decisions remove whole classes of bugs:

- **A side carries its start.gg entrant id.** `sides[0]` is the left column; `switchSides()` reverses the array, so the entrant id travels with the name. Reporting reads `sides[w].entrantId` — no "which slot is column 1 while swapped" inversion, nothing to poll.
- **The score is derived from the game list.** A Slippi game end appends a game (with the characters each side played); ± appends or removes a manual one. The per-game list a report sends can never disagree with the scoreboard, and Switch Sides flips both at once by construction.

Store events besides `change`: **`set-closing`** (the outgoing set, before anything replaces it — `closeSet()`, which `loadSet`/`clearSet`/`startCrew` call), **`set-loaded`**, **`sides-switched`**. **Every listener runs on its own** (`lib/safe-emitter.js`, which the game source uses too): one that throws is logged, and neither stops the others (the overlay channel, the save) nor comes back out of the command — a stats bug thrown out of `recordGame` used to reach the game source and leave it on the finished file, no game recorded for the rest of the session. `reportable()` answers whether the loaded set can be reported and with what. A crew battle is a set too (see Crew battles), with its own commands (`startCrew`, `crewPick`, `crewStock`, `crewApplyGame`, `crewRoster`).

- **`persist.js`** — every `change` schedules a debounced, atomic write (temp + rename) to `data/live-state.json`; `restore()` on boot. A missing, corrupt or other-version save leaves the store empty — a stale shape is worse than a blank scoreboard. The `bracket` section is never saved (re-read on boot), so a bracket refresh never writes the file. `index.js` flushes pending writes on `exit`.
- **`set-text.js`** — pure. `bestOfLabel` from `lPlacement` (works on preview sets and whether top 8 is its own phase or not) and the **rule** — `defaultLabel` until the set's loser is guaranteed top `topN`, `topLabel` from there (`topN` 0 = never; any of Flex/Bo3/Bo5 either side), because the switch point moves with the bracket and some events run Bo3 into Bo5. The rule is the store's `setRules` (the dock's Set tab → Best-of, `POST /api/set-rules`). **`setIsWon(label, score)`** — when a set is over by its format: BoN first to ceil(N/2), **Flex at 2–0 or first to 3** (a Bo3 that became a Bo5 at 1–1: 2–1 goes on); any other label never is. `losersMarks`: [L] on the grand-finals player from losers, both in the reset. Operator overrides always win.

### Ports — `lib/ports/port-map.js` + `lib/modes/`

`PortMap` says which side (0 left, 1 right) — and in doubles which slot — each Slippi port plays for. One chain, at each game start:

1. **Continuity** — the same ports as the last game of this set keep their mapping *and* the method that chose it. This is what makes a manual swap stick for the rest of the set.
2. **Characters** — each port's character against a reference per side: the last recorded game's characters when the ports moved mid-set, the players' DB mains at the start of a set or on a re-detect. Costume only breaks a tie between identical characters; in doubles the assignment with more hits across both sides wins.
3. **Positional** — lower port (doubles: the group holding the lowest port) on the left. Flagged amber in the dock.

`portMap.method` is `character | positional | manual`. Pure apart from logging; the caller passes the reference characters in.

**`lib/modes/index.js`** dispatches singles/doubles (`players.js#isDoubles`: 4 active players with Slippi team ids), runs the chain, and writes live characters into the store. It also reacts to the store: **`set-loaded`** clears the map and, if a game is running, re-detects at once; **`sides-switched`** flips the map and re-emits the live game. `swapPorts()` (⇄ / `Ctrl+Shift+S`) flips the map with method `manual` and re-applies the live characters; `reresolvePorts()` (↻) re-runs the chain against mains only and needs a live game.

**`game-end.js` reads the winner's side from the port map at game end**, not game start, so anything corrected during the game decides who gets the point. **A game — its point, characters and `.slp` — belongs to the set on the scoreboard when it ends**, so a set loaded during game 1 gets game 1. One that ends while a load from start.gg is still in flight (`event.loadingSet`, the re-read) is **held** (`modes/index.js`) until the event service's `set-load-settled`, then recorded on the set it brought against its re-detected ports — never on the set being replaced; a hold ends at 30s or the next game start. A game that ends *before* the operator presses load is the old set's: ✕ it there on the Replays tab, ± the new set's score on the strip, and Attach… its file to the new set once that's off the scoreboard. A handwarmer records nothing; an unmapped winner records nothing and says so. Doubles team colours (`MELEE_TEAM_COLORS` in `doubles.js`) go onto the sides as `color`.

### Players — `lib/players/`

- **`player-db.js` (`PlayerDb`)** — TSH's `local_players.json` format, edited in place, so it can always be handed back. Unknown fields round-trip; the app's additions are keys TSH ignores (`startggPlayerId`, `learnedMains`), and a main set in the dock is TSH's own `mains.ssbm`, first entry (`setMain`) — below what Slippi learned (a `pinnedMain` from before is folded into it on load); the `{}` stub and TSH's odd shapes (`mains: "{}"`, null prefix) are tolerated, not fixed. Writes are debounced, atomic, and **byte-identical to TSH's own** for unchanged records (Python's `ensure_ascii` `\uXXXX` escapes, the file's CRLF) — checked against the real 208-player file. Mains are `[displayName, skin]` (display names from `char_map`). `search` / `refOf` / `at` back the dock's Players tab: a record is addressed by `ref` (its index, stable for the process) **plus its tag**, and a mismatch is a 409, so a stale search can't edit someone else.
- **`mains-learning.js`** — what each singles player played, from the set's game list, into the DB **when the set is over**: on a successful report, and on `set-closing`. Least-played first into `learnMain`, so the most-played ends up first. Committing the same set twice is skipped (report-then-load learns once). Never learned: handwarmers and manual games (no characters), doubles (which player of a side a port is is a guess), a typed name with no DB record. start.gg players are upserted; typed names are only found. What's learned beats a main set by hand on load.
- **Order matters in the event service:** `loadSet` calls `store.closeSet()` *before* it reads the incoming players' mains, so back-to-back players open on what they just played. `tests/event-service.test.js` pins it.

### Crew battles — `lib/crew/`

Two crews of 1–10 play 1v1 games; each player starts on `stocksEach` (default 4, 1–9) and the winner stays in with what they have left. Kept apart from the normal flow by construction:

- **A crew battle is a set with `crew`** (`set.crew` in the store; the rules are pure functions in `crew-model.js`). `startCrew` closes the set on the scoreboard like a load does, and `loadSet`/`clearSet` end the battle the same way — there is no separate mode flag to drift. It persists with the set (no `STATE_VERSION` bump: restore merges over `emptySet()`).
- **`scoreboard()` derives the sides from it**, so the scoreboard overlay, the port map and the dock's names need no crew branch: the score is each crew's stocks left, the name card is the player in with their own sponsor (the crew's name alone, in the tag, with nobody in — the overlay hides a blank tag), the round "Crew Battle", no best-of, never doubles. `crewView()` adds the `crew` section the side panel and the Crew tab draw.
- **Nobody goes in by themselves.** The operator sends each crew's player in (`crewPick`), starters included. At game end (`game-end.js`, with `stocks` per port from the last frame) the winner keeps `max(1, min(carried, lastFrame))` — "SD to match" means the last frame is the truth, and a forgotten SD can't gain a stock — the loser goes to 0 and their side is unpicked. The usual checks still decide the game; a handwarmer, an unmapped winner or a side with nobody in applies nothing and sends `crew_notice` (dock only).
- **The set's commands are no-ops in one** (`recordGame`, `clearScore`, `setScore`, `setPlayer`, `setDoubles`), and `/api/player`, `/api/doubles`, `/api/players/assign` and `/api/clear-score` are 409s. `bump` (the strip's ±, the score hotkeys) is one stock for the player in. `switchSides` reverses the crews with the sides.
- **No stats and no learning**: `playerId` is null, `stats/index.js` reads no target and `mains-learning.js` learns nothing from a crew battle.
- **`saved-crews.js`** — `app/data/crews.json`, written only on the Crew tab's Save (atomic; keyed by name in any case; tag/prefix/pronoun only — mains are looked up at start). An unreadable file is moved to `crews.json.bad`, not overwritten.
- **Roster edits are live** (`crewRoster`: rename, reorder, add, remove), but someone who has played, lost a stock or is in can't be taken off.

### The event — `lib/event/`

**`event-service.js` (`EventService`)** owns the loaded start.gg event:

```
short link → this week's tournament → its singles/doubles event   switchEvent(kind)
event → phases → phase groups → every set, as bracket graphs     loadEvent / refresh
graphs → the picker, playable sets first                          openSets()
one set, re-read fresh → enriched from the player DB → the store  loadSet(setId)
```

- **Reads only, budgeted in the background.** The graphs refresh every 90s through `startgg.backgroundQuery()`; a completed phase group is read once. What the operator presses (a switch, ↻, a load) goes straight out. A generation counter drops a refresh still in flight for the previous event. The same timer keeps retrying a saved event start.gg couldn't be reached for at boot.
- **Every read falls back to start.gg's keyless web endpoint**, so the dock works without a token.
- **The loaded event is part of the store** (`tournament`), so it survives a restart and reloads on boot.
- **`loadSet`** re-reads the set (and still loads, with a warning, when it can't), fills pronoun and main from the DB (learned → stored mains), and upserts new start.gg players. While it's out, `loadingSet` is true; `set-load-settled` says it's over (see game-end above).
- **No stream queue.** The series picks whatever set is playable, so the picker sorts playable (both entrants known, not started) first, then live, then waiting; and the stats pre-fetch the next playable sets' players.

**`event-target.js`** — pure: `normalizeBrackets`, `pickEvent` (exactly one event must contain all of a kind's keywords — **ambiguity is refused, never guessed**), `sameEvent`, `normalizeEventUrl`. The short link is resolved by `startgg.resolveShortLink()` through start.gg's **web redirect**, by hand (`maxRedirects: 0`), because the API returns `null` for a short slug. The event is looked up, not appended: a renamed event under a stale slug loads as an empty bracket with no error anywhere, so `fallbackSlug` is used only when the lookup can't run, and that sets a `warning`.

**`bracket-model.js`** — pure: a phase group's sets → a graph built from start.gg's own edges (`slots.prereqType/prereqId/prereqPlacement`), never from seed math. Losers rounds are negative and need not start at -1; **a bye is an edge to a set that isn't in the list**; the reset is the set whose two slots both come from the GF (start.gg deletes it once GF 1 is won from winners); preview (unstarted) sets carry edges and `lPlacement` too. `selectView(graph, view)` for `winners | losers | top8 | top16 | full` — Top N is the sets whose `lPlacement ≤ N−1`, plus GF.

**`bracket-feed.js`** publishes one phase group into the store's `bracket` section (the dock's pick, else the on-air set's group, else the furthest running): all five views, the **pages** (cut with the overlay's own `layout.js` `paginate`, required from Node and cached by structure, so the dock and every source agree and a score bump doesn't recut) and **Up Next** across every group. **`bracket-director.js`** owns `bracketShot` (not saved): the tour's clock, a held page or the Board camera; a view or group switch opens on the action page, **held unless it was touring** (the camera never starts touring behind the operator). Both sections' shapes and rules are in [docs/BRIDGE-API.md](docs/BRIDGE-API.md). **`set-model.js`** — pure: `loadPayload` (what loading a set puts on the scoreboard; the [L] fact comes from the graph) and `pickerList`. **`queries.js`** — the GraphQL, shared with `scripts/capture-startgg.js` so fixtures carry exactly the fields the app reads; sized against the 1000-object ceiling with `PAGE_SIZES = [40, 20, 10]`.

### start.gg — `lib/startgg-client.js`

**The only module that talks to start.gg**, which is the invariant worth keeping: two would mean two places handling token expiry, rate limits and timeouts. All GraphQL goes through one `_gql()`:

- **Reads marked `fallback: true` re-post to `www.start.gg/api/-/gql`** (keyless, TSH's headers) on no token, 429, 5xx or a network error. **Mutations never fall back** — they must carry the operator's token.
- **`backgroundQuery()`** — the budget: waits while the last 60s hold `BACKGROUND_BUDGET` (50) requests, and stands down 30s after a 429. The operator's calls (report, start, switch, load) are never delayed, so stats and refreshes can slow each other down but can't make a report fail.
- start.gg's 1000-object refusal is flagged `complexity: true` so a caller splits instead of reading it as empty.
- `resolveShortLink()` is deliberately neither GraphQL nor gated on the token.

### Reporting and starting — `lib/server/`

- **`report-set.js`** — `store.reportable()` → the winner's `entrantId` plus every game's winner as `gameData` (winners only — no stages or characters; start.gg has no score field without game data). Refuses with no token, no set, a preview set, or a tie. Manual only; the dock confirms first. A success (in `index.js`) learns mains, reloads stats, and refreshes the event 3s later.
- **`start-set.js`** — start.gg's `markSetInProgress`. `canStart` only for states **1** (created) / **6** (called). **`evaluateStartability()` is synchronous by contract**: it answers from a per-set-id cache and schedules the one lookup in the background — a query per 2s tick would spend 30 of start.gg's 80-per-60s on a value that changes twice a set, and reporting would be the first thing to break. The first tick after a load reads "Checking start.gg…". A failed lookup is asked again after 15s — a reload of the same set is the same id, so it would never miss the cache. Not auto-fired from game 1: a handwarmer or a mis-loaded set would mark the wrong set. `tests/start-set.test.js` pins the caching.
- **`set-gate.js`** — the refusals both share (no token / no set / preview set), so the two buttons can't disagree about what a real set is.
- **Preview sets** (`preview_<phase>_<round>_<n>`) are what an unstarted event's sets are; they can be loaded and shown but never started or reported. Load the set again after the TO starts the bracket.

### The overlay channel and runtime

**`lib/overlay/channel.js`** — Socket.io namespaces `/overlay` and `/dock`: `state:full` on connect and on request, then one `state:patch { from, rev, ops }` per tick (whole top-level sections); a client whose rev is behind `from` missed one and sends `state:resync`. The feature modules emit their own event names through `ctx.io` and `RELAY` maps each per namespace; an event with no entry goes nowhere, and nothing is sent on the default namespace. The events, which are sticky, and the patch rules are in [docs/BRIDGE-API.md](docs/BRIDGE-API.md).

**`overlays/shared/overlay-client.js`** is every page's runtime: `Overlay.connect({ tag })` → `ov.select(path, (now, prev) => …)` (runs only when that path's JSON changed, so a casters edit can't re-animate the scoreboard), `ov.on(event)`, `ov.ready`. Plus `Overlay.h()` (node building), `Overlay.icon({ codename, skin })`, `Overlay.fitText()` / `fitGroup()` (fit text to its box: see the side panel below), `Overlay.squeeze()` (the scoreboard's and casters' names: smaller, then squeezed horizontally), `Overlay.param()`, `Overlay.reveal()`. **The page fades in by itself**: `overlay.css` holds `body` at opacity 0 and `.ready` (first state drawn, fonts in) reveals it — `highlights.js`, which never connects, calls `Overlay.reveal()` itself. `?animate=false` adds `body.no-animate`. **A theme switch reloads the page**: `theme` on `/overlay` fades it out and calls `location.reload()` (a reload, not a stylesheet swap — the old pack's tokens and fonts would linger and every measured fit would be stale); `highlights.js` hears it through `Overlay.followTheme()`, its socket's only job. The dock's client ignores it. The state mirror has no DOM, so `tests/overlay-patch.test.js` runs the same file under Node.

**Motion is the layout's, never the pack's.** `overlay.css` holds the vocabulary (`--ease-out` for anything arriving **and** anything leaving, with no `--ease-in`; `--ease-spring` for the clip toast; `--enter-*` for the entrances), and `Overlay.motion.ease()` reads the same curves, so CSS and script can't drift apart. **`--motion-tempo` (3; the test sandbox can't read it and uses `TEMPO_FALLBACK`, 1.5) sets the speed of all of it**: every CSS duration is `calc(… * var(--motion-tempo))` and every script duration goes through `Overlay.motion.ms()`. Dwell times aren't animation speed and ignore it. **Every show/hide goes through these helpers** (how each moves is in [docs/OVERLAYS.md](docs/OVERLAYS.md) and their comments in `overlay-client.js`):

- **`Overlay.swap(el, key, render)`**: out → render → in, only when `key` changed (`Overlay.draw()` for content rebuilt where it can't be seen). **`Overlay.reel(el, value, build)`**: a number turning like a slot-machine reel. **`Overlay.presence(el, on)`**: a chip, pill or card that comes and goes whole, animating out *before* its hiding class goes on. **`Overlay.glide(...nodes)`**: content pushed aside slides, on `left`/`top`, because Chromium 103 has no `translate` property and a transform slide would be replaced by any swap or presence on the same box. **`Overlay.motion.pose()`**: one keyframe for a page's own animations.
- **`Overlay.motion.play(el, frames, opts)`** is what every pose goes through. **Chrome composites no animation with a `blur()` in its filter**, so `play()` gives the blur an animation of its own; calling `el.animate()` with a pose puts the whole move back on the main thread.

`tests/overlay-motion.test.js` pins that they end on the right content, that every exit is the text motion, and that the reel turns the right way.

**`lib/server/overlays.js`** — `PAGES` (url → file) and the `/o/` + `/assets/` mounts (plus `/assets/luckystats/` → the saved luckystats images); `resolveOverlayPath()` is the same table the tests resolve through. **Every url a page uses is absolute** (`/o/shared/overlay.css`), so a source works with or without a trailing slash. **Every overlay stylesheet sits exactly one level under `/o/`**, because a theme pack's `--logo-url` is resolved against the stylesheet that uses the `var()` (see Theme packs).

### The dock — `app/public/dock/`

A pinned **live strip** (both sides' names, characters, score ±, round / best-of / [L] overrides with Auto text, ⇆ Sides · ⇄ Ports · ↻ Detect · Start · Report · Stats, Clear score · Clear set) over nine tabs: **Set · Bracket · Stats · Casters · Players · Clips · Replays · Crew · Setup**, fed by the `/dock` namespace's state plus `status`. **What the strip's modes and each tab do is in [docs/DOCK.md](docs/DOCK.md)**; the rules every change keeps:

- **No `innerHTML`**: nodes are built with `Overlay.h()`. **Every renderer is wrapped in `guard()`**, so one that throws shows in the dock instead of freezing it. `tests/dock-static.test.js` checks every id the script looks up exists and every route it calls exists with that method.
- **Input survives pushes.** A name being typed isn't overwritten mid-word (commits on change; Escape sends nothing); the casters are a **draft until Put on stream**, kept across pushes unless unchanged and nobody is typing; the clipper form is generated from one `CLIP_FIELDS` spec and latches dirty.
- **Changing a tag or prefix on the strip (typed or picked) unlinks the set** (`store.detachSet()`: set id, entrants, seeds, team name); capitalisation alone doesn't, nor does a Players-tab edit; reload the set from Up next to relink. **Start and Report exist only for a set loaded from start.gg** (`setId`).
- **A folded key is a proxy** (`data-proxy="<id>"`): it clicks the real key and `syncProxies()`, run after every `guard()`ed render, copies its `disabled`, `gone`, `lit` and title, so there is one handler and one set of rules.
- **Tooltips are the dock's own** (`tooltips()`, `#tip`): OBS's dock browser cuts native ones off. A hovered element's `title` moves to `data-tip` and back when the pointer leaves, so code reading `.title` sees what it set; mouse only.
- **Autocomplete** is one shared `#ac-menu`, not a `<datalist>`. A field's own keydown handler goes after `autocomplete()` and skips a `defaultPrevented` key, or Enter on a suggestion also commits the typed text.
- **Health:** `control_status` is sent on change plus a **5s heartbeat**; no status for ~12s dims the lights.
- `localStorage` is wrapped (it can throw). Fonts (Saira, Martian Mono) are self-hosted: venue Wi-Fi is unreliable. `lan-urls.js` lists the dock's url on every reachable address, **Tailscale (`100.64/10`) first**: it survives a venue network change and guest Wi-Fi client isolation.

### Hotkeys — `lib/hotkey.js`

Global via `uiohook-napi` (native, required lazily). Defaults: `Ctrl+Shift+S` swap ports, `Ctrl+Shift+X` switch sides, `Ctrl+Shift+1`/`2` a game to left/right, `+Alt` takes one away, `Ctrl+Shift+0` clears the score, `Ctrl+Shift+G` puts the stats popup up or down. Three rules, each a way a global key goes wrong at a desk: **modifiers match exactly** (`Ctrl+Shift+Alt+1` isn't also `Ctrl+Shift+1`); **a held key fires once** (Windows auto-repeats keydown with no keyup); **no chord without Ctrl, Alt or Win** (the hook sees every keystroke on the machine and still passes it to the focused app). A bad or clashing `HOTKEYS` entry is reported and left unbound, never thrown. If the module won't load, single keys in the app's own terminal (`s x 1 2 q w 0 g`). Each press logs `[hotkey] …` with the resulting score — the operator is looking at OBS, not the dock. In a crew battle ± is a stock for that side's player in (the log names them) and clear-score does nothing. `installHotkeys` returns `{ mode, bindings, errors }` for the Setup tab and the dock's key hints.

### Control status — `lib/server/control-status.js`

The dock's status: health (`startgg` from the event service's last read, `slippi`), the port map and how it was chosen, the Current Set card (report/start gating), the clipper, and the tournament and token state preflight reads. A field nothing reads doesn't belong — the scoreboard reaches the dock as state. Everything is local — **no network call in a rebuild**. Rebuilt every 2s and on demand; concurrent `refresh()` callers share one in-flight rebuild, and `refresh()` never rejects. The object's shape is written once, in `compose()`, used for both the startup seed and every rebuild — a new field goes there and nowhere else (`tests/control-status-shape.test.js`).

### Port reclaim — `lib/port-guard.js`

`EADDRINUSE` on `BRIDGE_PORT` is the normal restart case (a window left open, a crash that left node running), so the new process takes the port back itself — wired in `lib/server/app.js`.

- **Identity gate.** It only kills a process that answers `GET /api/identity` with `{ app: "slippi-bridge", pid }` (the identity string is kept from the bridge era on purpose). An unidentified occupant is reported and left running — killing an unrelated program would be far worse than refusing to start.
- An occupant that answers as the app but reports no pid is refused, not hunted for with `netstat`.
- **Retry is bind-driven**: Windows releases a killed process's socket asynchronously, so `waitForPortFree()` polls by binding a throwaway server. One attempt only.
- The `listening` log is a `httpServer.once("listening")` handler, **not** a `listen()` callback: a failed `listen()` leaves its callback attached, and the retry would log twice.

### Handwarmer detection — `lib/handwarmer.js`

A weighted score ≥ 2 = handwarmer: each player's `totalDamage < 150` (+1/−1), LRAS end method 7 (+1/−1), both players > 1 stock in the last frame (+2), duration < 60s (+1). If `stats.overall` is empty, returns `false` (no vacuous-truth positives).

- **Score-only suppression:** characters still update; no game is recorded.
- **Rage quit:** LRAS + not a handwarmer + a valid `lrasInitiatorIndex` → the point goes to the other side (in doubles, someone on the other team by `teamId`, not the quitter's partner).
- Every game end prints one `[handwarmer]` line with the per-check deltas and the verdict.

Gotchas (do not regress): use `totalDamage`, not `totalDamageDealt`; read stocks from `getLatestFrame()`, not `stats.stocks` (empty on LRAS); in doubles **don't `filter(Boolean)` `lastFrame.players`** — that drops null dead-player entries and leaves only the winners, falsely flagging every doubles game (use `p?.post?.stocksRemaining ?? 0`); `killCount` is unreliable in 4-player games, so that check is singles only.

### Reading the live game — `lib/game-source.js`

`createFolderSource(config, detector?)` polls `SLP_FOLDER` every 500ms (a `knownFiles` set ignores files present at startup — **`fs.watch` is not used**, it misses new files on Windows/OneDrive paths) and emits `game-start` (`rawPlayers, stageId`), `game-end` (`{ winnerPlayerIndex, isHandwarmer, stocks }` — `stocks` is each port's last-frame count, `stocksByPort()`, for crew battles) and `highlight`. Which port won is the pure `pickWinner()` (GAME!, RESOLVED — how most doubles games end — then a last-frame stock fallback), pinned by `tests/game-winner.test.js`.

- **A finished file is let go before `game-end` is emitted**, and the emitter is a `SafeEmitter`: nothing a listener does can keep the watcher on that file.
- **One `SlippiGame` per file, not per tick**, so `processOnTheFly` parses only appended bytes (~4× cheaper across a game) — what makes a 500ms conversion scan affordable.
- **The parser can be poisoned, and it's guarded.** A live `.slp` has `rawDataLength = 0` in its header until Slippi closes it. A file whose header already declares its full length while bytes are still arriving (a finished replay landing via OneDrive sync) makes `iterateEvents` leave `readPosition` past EOF permanently: no `game-end`, the rest of the set unscored. `game-source.js` compares `readPosition` with the file size each tick and rebuilds the parser when it's past EOF; there's also an `errorStreak` rebuild after ~5s of read failures.

### Combo clipper — OBS replay buffer

Detects notable combos **live, mid-game** and asks OBS to save its replay buffer, so the clip exists by the time the point is over (the buffer only holds the last N seconds, so a scan at game end is too late). `obs-scripts/auto_replays.py` collects the clips into a break-scene playlist.

**Pipeline:** `game-source.js` (tick) → `combo-detector.js` (qualify; pure, no clock) → `clip-recorder.js` (cooldown, per-game cap, save delay, the recent-clips ring) → `obs-client.js` (`SaveReplayBuffer`; the only module that talks to OBS; lazy connect with backoff, never throws upward, `getStatus()` synchronous) → `slippi_clip_saved` → the dock and the side panel's toast. Clip errors go to the dock only, never the broadcast.

- **`slippi_clip_saved` carries the attacker.** slippi-js's `conversion.playerIndex` is the player who got **hit**; the attacker is `lastHitBy`.
- **Buffer ≥ 20s.** Conversions run 6–9s and `saveDelayMs` adds ~2.5s.
- **`comboWindowSec` is anchored at the END of the conversion, and that is the whole point.** A conversion stays open until the victim regains neutral or dies, so an offstage chase is one 30s+ conversion that qualifies on an opening burst which, by the time `saveDelayMs` elapses, has left the buffer. With a window, `minMoves`/`minDamage` are measured over the last N seconds — what qualifies and what's captured are the same footage. Strictly stricter than unwindowed. **Not `maxComboDurationSec`**, which caps total span; leave that `0` once a window is set. Window damage is the sum of in-window `moves[].damage` (undercounts, so conservative); no move array falls back to whole-conversion judging rather than rejecting.
- The `[clipper] Combo by …` log includes the window figures — the operator's only feedback while tuning; without it a too-tight window looks like a broken OBS chain.
- **Singles only, upstream and unfixable:** `getSinglesPlayerPermutationsFromSettings` returns `[]` unless 2 players, so `stats.conversions` is permanently empty in doubles. The dock says so.
- **Settings** — `DEFAULTS` → `config.CLIPPER` → `clipper-settings.json`, merged per key, validated and clamped (values come from a browser form), written atomically.

`auto_replays.py` is driven by `OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED` + `obs_frontend_get_last_replay()` (folder polling is opt-in), handles `ffmpeg_source` as well as `vlc_source`, and releases every `obs_data` handle. **Its interpreter is whatever OBS's Tools → Scripts → Python Settings points at.**

### Stream-set replays — `lib/replays/`

Replay Reporter for Slippi's job (github.com/jmlee337/replay-manager-for-slippi), for the sets played on stream: each set's `.slp` files and a `context.json` in **Replay Reporter's own format**, as one folder, copied to `REPLAY_ARCHIVE_FOLDER` and uploaded to LuckyStats.gg, whose importer reads exactly what Replay Reporter writes. **The modules, the format's rules, the upload protocol, the Replays tab, and what's unverified until the first live use are in [docs/REPLAYS.md](docs/REPLAYS.md): read it before touching `lib/replays/`.** What bites from anywhere:

- **Each game remembers its file.** `game-source.js` adds `replay: { file, startMs, lastFrame, stageId }` to `game-end`, and `game-end.js` adds each side's ports with what each played, read from the port map at game end like the winner; `switchSides` reverses it with the characters. A ± game has `replay: null`; a handwarmer records nothing, so its file never joins a set.
- **`uploader.js` is the only module that sends uploads to luckystats.gg** (`Authorization: Bearer <LUCKYSTATS_UPLOAD_KEY>` + `X-App-Id: replay-reporter`). The idempotency key and digest are journaled in `data/stream-sets.json` before the request, so a restart resumes the same upload.
- **`archive.js` copies, never moves**: `SLP_FOLDER` is Slippi's. `context.js`'s rules are pinned by `tests/replays.test.js`. Nothing reaches the broadcast.

### Side panel stats — `lib/stats/`

The side panel's player cards, head-to-head and Just Finished. A head-to-head goes wrong quietly: start.gg refuses any response over **1000 objects** (a refusal read as "no sets" loses them), and `user.events` is only the account's own events (ZODD-01's reaches 276 events back to 2023, against 2,275 sets back to 2015).

- **`queries.js`** — sized against the ceiling (per-node counts noted); ids interpolated into aliased batches, `idList()` refuses anything that isn't a positive integer.
- **`set-history.js`** — `SetHistoryStore`: every set a player has played, from `Player.sets`, saved to `stats-cache/player-<id>.json`. Pages are newest first, so a **top-up** stops at the first page it already holds unchanged (normally one request); a copy older than 30 days is fully re-crawled (start.gg edits old sets). A refused page is re-read at half size (60 → 30 → 15), never counted as empty. Syncs per player are deduped.
- **`normalize.js`** — pure; the head-to-head rules, each checked against a hand-verified record (NAV 69–25, Yung John 29–3, Redd 22–8): **find the opponent by id, the other side is the player** (old-tag sets carry the *old* player id); **read both histories, union by set id**; **Melee only**, **singles only** (one participant per side), **finished, not DQ'd, with a winner**.
- **`index.js`** — `createPlayerStats(ctx)`, driven by the store: a new pair is acted on at once (a set load is one command, so no half-loaded pair). One request for both cards, then both histories and the seven recent pills; a generation counter drops late answers, and either part failing reloads the pair after 60s. Just Finished comes from the event service's reads (no request, no token needed). Players in a **singles** event's next playable sets are pre-fetched while idle — a doubles event's never are. **Singles only**: a doubles set (or crew battle) on the scoreboard has no pair, so no cards, head-to-head or luckystats request; Just Finished, which names teams, still shows. No token: `enabled: false`. **Every async path ends in a catch** — Node ends the process on a rejection nobody hears (`player-stats.test.js` dies with it): an answer of a shape the code didn't expect puts whatever of the pair wasn't loaded yet in `error` (`failPair`; the side panel draws nothing for it) and the pair is retried like a failed read; luckystats failing is `lucky.state: "error"`; the event's finished sets failing is none rather than a stale list.
- **`luckystats.js`** — the only module that talks to luckystats.gg (`GET /api/stream/players?ids=`, Bearer `LUCKYSTATS_KEY`; no key = disabled, no `lucky` section). Its own request per pair, alongside the histories rather than after them. **It takes start.gg USER ids, not player ids — and a player id isn't refused, it answers with someone else** (ZODD-01's player id 1097 is "Captain Crunch"). The user id rides on the cards request (`player { user { id } }`), and `normalize.luckyFromResponse` places every answer by the `startggUserId` it came back with, never by position. **Where luckystats and start.gg overlap, start.gg wins**: its head-to-head undercounts (ZODD-01 vs NAV 60–23 against start.gg's 69–25), so the cards show start.gg's, and the win probability is `glickoOnly` (`blended` mixes in luckystats' head-to-head). Luckystats supplies only what start.gg has no answer for: Lucky Rank, class, region and the win probability. Which region and place show (a public Region, never a crew) is `normalize.luckyFromResponse`'s comment. Images — class badges, and Region artwork (rasters only, recognised by their bytes, and only from luckystats' own hosts: the urls come from a response body) — are saved once into `stats-cache/luckystats/` and served at `/assets/luckystats/`; no source loads from the web, and no luckystats url reaches one.
- **Costs, measured:** a pair with neither history saved is ~57 requests / ~70s for two long-time regulars; after that, 2 requests / ~1.5s. Plus one luckystats request (~0.7s) per pair.

### The stats popup — `lib/set-stats/` + `/o/set-stats`

After a game, the game just played against the set so far; once the set is won, the wrap-up. Each counted game's `.slp` is read off the main thread (`worker.js`), `set-view.js` (pure) builds `setStats`, `director.js` puts it up and down (`statsShot`), the dock's Stats tab sets `statsConfig`, and `/o/set-stats` draws it. **The pipeline, the art packs and portraits, the layouts and their motion, and the rigs are in [docs/STATS-POPUP.md](docs/STATS-POPUP.md): read it before touching `lib/set-stats/` or `overlays/set-stats/`**, and [docs/research/melee-stat-accolades.md](docs/research/melee-stat-accolades.md) before adding an accolade or a story. What bites from anywhere:

- **Singles sets loaded from start.gg only** (`index.js hasStats()`): doubles, crew battles and a set with no `setId` have no stats, their replays are never read and their games start no automatic show.
- **A view that can't be built publishes none** (`set-view.js unavailable()`, never the last one, which may be the previous set's), and a popup that's up comes down (`dropIfEmpty`).
- **The Players bar draws it too** (a full-frame `<iframe class="stats-frame">` in `/o/scoreboard/players`; `?stats=0` leaves it out for a scene that keeps `/o/set-stats` as its own source). Never both, or it draws twice.
- **Every wait is a timer, never an animation's promise**: a source that isn't painting never finishes an animation, and an awaited exit would leave the popup up forever.
- **The art isn't in the repo** (Setup → Art packs downloads it into `overlays/assets/packs/`), except the VS screen pack, committed upscaled 2× (`packs/full/`): a newer release in the dock's Download all replaces it with the low-res art, and `git checkout -- overlays/assets/packs/full` puts it back.

### Overlays — `overlays/`

All pages load `/o/shared/overlay.css` and `/o/shared/overlay-client.js`; the bracket and highlights also load `/o/shared/atmosphere.css` (the title bars' light, grain and vignette — theme tokens only, loaded between `overlay.css` and the page's own stylesheet). OBS's browser is **Chromium 103** (OBS < 31), so no `:has()`, `color-mix()` or container queries, and entrances animate `transform`, not the individual `translate` property. **An element that already has a transform sets `--base-transform`** (every animation — the CSS entrances, `swap()`, `presence()` — composes on it); it's registered `inherits: false`, or a centred pill's `translate(-50%, -50%)` would be applied again to the text inside it mid-swap. **An element with its own `filter` sets `--enter-filter` to that filter**: a `blur()` against a different filter list can't interpolate and flips halfway. Entrances stagger by `--enter-order` × `--enter-stagger`, set per page.

- **Scoreboard** (`/o/scoreboard`, `/o/scoreboard/players`) — names, prefixes, pronouns, live characters, scores, round, best-of, [L]; the best-of pill is on `/o/scoreboard` only. The players bar's logo rises out of the round card, and sinks back into it while the stats popup is up. Its layers, the crew chip and the round card are in [docs/OVERLAYS.md](docs/OVERLAYS.md).
- **Casters** (`/o/casters[?i=N]`) — mic, prefix, tag, pronouns, styled to the pack. A cleared caster's card leaves through `presence()`; one added after load animates in.
- **Bracket** (`/o/bracket[?view=]`) — laid out by `bracket/layout.js` (pure, and loaded by the page, the dock and Node alike, so all three agree on the pages). **Nothing pans**: a view that doesn't fit at the legibility floor (`layout.VIEWPORT`, pinned to `bracket.css`) is pruned, then cut into pages. Three modes from `bracketShot` (tour, page, board); **Up Next** is `?view=upnext`; `?view=` pins a source to a view, which then tours its own pages. Paging, the Board camera and the cascade are in [docs/OVERLAYS.md](docs/OVERLAYS.md).
- **Highlights** (`/o/highlights`) — the replay-scene frame, **decoration only** (nothing knows which clip VLC is playing); reads no state. Its geometry is `:root` variables that must equal the OBS source transforms, settable from the url (`?clip=`, `?cam=`, `?camx=`, `?pad=`); **`?guides=1`** outlines each hole with its *measured* rect, which is the alignment check. How the plates, bleeds and scrim are built, and why, is in [docs/OVERLAYS.md](docs/OVERLAYS.md).
- **Side panel** (`/o/side-panel[?panel=<id>]`) — 611×1080 beside the cam: the tournament name in the header, and a bottom card that rotates (`PANEL_INTERVAL` 20s, the stats cards 25s) through the logos, each player's card, the head-to-head, Last Game, Set Recap and Just Finished; doubles drops the player cards and head-to-head, and a crew battle rotates the logos and each crew's roster. **Its rotation, the stats cards, the luckystats rows, text fitting, the clip toast and the flair slots are in [docs/OVERLAYS.md](docs/OVERLAYS.md): read it before touching `side-panel.js`** (`tests/side-panel.test.js` pins the rotation). What bites from anywhere:
  - **Stats from the app only, oriented by start.gg player id** against the ids in each column *now*, so Switch Sides needs no refetch and a late snapshot for the previous pair fails to match instead of labelling the old record with the new names.
  - **Every card showing luckystats data carries "Powered by LuckyStats.gg"** and the clover: the endpoint was given on that condition.
  - **A card that can't be populated never comes on**, and neither stats card shows while the popup is up (`statsShot.shown && setStats.available`, the players bar's own condition).
  - **`fitText(node, minPx)` is synchronous**: call it after the node is in the document (`rAF` never fires in a source that isn't painting). A list's rows use `fitGroup(nodes, minPx)` once, after the last row is appended.

### Theme packs

```
overlays/theme.css                   a SWITCH: one @import naming the active pack
overlays/themes/<pack>/theme.css     every token, the @font-face, the two logo urls; @imports flair.css
overlays/themes/<pack>/flair.css     the pack's background flair (optional)
overlays/themes/<pack>/{logo,sponsor}.png, fonts/, flair artwork
```

Every overlay links `overlay.css`, which imports the switch. All packs live in the repo at once (`hundred-acres`, on air, and `salty-suite`); re-skinning is the one `@import` line, which the dock's **Setup → Theme** select rewrites (`POST /api/theme`, `setThemePack()` in `lib/server/api/setup.js`): every overlay fades out and reloads in the new pack. The choice is the file itself, so it survives a restart and shows as a git change — **switching it back afterwards is the step that's easy to forget**. A hand edit still works (then refresh the sources). Each pack's tokens, flair and fonts are in [docs/OVERLAYS.md](docs/OVERLAYS.md).

- **Two url rules in a pack.** A normal `url()` (the `@font-face src`) resolves against the pack file, so `./fonts/…`. A `url()` **inside a custom property** resolves where the `var()` is used, so `--logo-url` is written relative to an overlay stylesheet: `url("../themes/<pack>/logo.png")`. Copying a pack means editing those two paths; preflight and `tests/overlays-static.test.js` resolve them.
- `--logo-filter` / `--sponsor-filter` let a pack recolour artwork (`invert(1)` for black ink on a dark card). Logos are CSS-only (`background-image: var(--logo-url)`), never `<img>` — `getComputedStyle` returns the custom property's url verbatim.
- **`@import` must precede every other rule** in a file, or it is silently dropped.
- Fonts: the pack's brand font self-hosted; any Google Fonts fallback is a network request that fails on venue Wi-Fi.
- **Background flair belongs to the pack.** A layout only provides empty slots (`<div class="flair flair-<context>">` with 8 `<i>`s) and the pack's `flair.css` draws in them; a pack with no `flair.css` has no flair. **`.flair` has no z-index on purpose** — it would become a stacking context and a slot's `mix-blend-mode` (Salty Suite's beams) would blend with nothing. A token no overlay reads doesn't go in a pack.

### Character map — `lib/char_map.js`

Slippi character ids (0–25) → `{ codename, display }`; `CSS_ORDER` is Melee's select-screen order (the dock's picker); `characterByName` maps the DB's display names back. Icons are `overlays/assets/icons/chara_2_{codename}_{costume:02d}.png` — TSH's 123 stock icons, committed (Game & Watch's file is `game_and_watch`, matching the codename). No icon path is sent anywhere; pages build it with `Overlay.icon()`. `tests/overlays-static.test.js` and preflight check every character and costume has one.

---

## Known Gotchas

- `config.js` is git-tracked — never put secrets there. The start.gg token and the luckystats key go in the gitignored `config.local.js`.
- **`config.local.js` and `clipper-settings.json` stay at the `app/` root**, even though the code that reads them lives in `lib/`: `.gitignore` pins those exact paths, and moving either would start tracking the token or the OBS password.
- **`app/data/` holds the player DB by default** as well as `live-state.json`, the saved crews (`crews.json`) and the stream-set history and upload journal (`stream-sets.json` — deleting it mid-event loses which sets were uploaded). When cleaning up after a test boot, delete `live-state.json`, never the folder.
- **Never run TSH against the app's player file.** TSH rewrites the whole file on save and never re-reads it. Copy the file, don't share it.
- The parser is **persistent per file**: anything added to the poll loop must tolerate a live file and must not assume a fresh parse each tick.
- **start.gg:** a response over 1000 objects is refused *whole* — split and retry, never "no results". `Player.sets(filters: …)` returns zero sets with any filter at all; fetch unfiltered and filter locally. `event.sets(filters: { playerIds: [a, b] })` is **OR**. `user.events` is not a player's history. The API returns `null` for a short slug — only the web redirect resolves it, and the link is **hyphenated** (`start.gg/100acres` is a hard 404).
- **A browser source whose page failed to load doesn't retry.** Start the app before OBS, or refresh the sources. A loaded page survives app restarts (socket.io reconnects and gets `state:full`).
- **OBS's CEF is Chromium 103.** Check any new CSS feature against it; headless Chrome being newer hides the failure.
- **Don't synthesise global keypresses to test the hotkeys** — they also type into whatever window has focus. Press them by hand.
- **`scripts/` is one level deeper than the app.** `preflight.js` resolves the app at `..` and the repo at `../..`, and requires most of what it checks **lazily** (it has to run before `npm install`). `tests/preflight.test.js` runs it offline so a moved module fails a test rather than a pre-event check.
- `slippi_game_start` / `slippi_clip_saved` keep a `teamNum` field (`side + 1`) — the payload's long-standing name for the side, not a TSH team.
- `TournamentStreamHelper-*/` is gitignored wholesale: an old TSH install left in or beside the repo, with its own `user_data/` (a real player DB). The app reads nothing from it; preflight only mentions it (and offers its `local_players.json` as a copy source on a machine with no player file).
