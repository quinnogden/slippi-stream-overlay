# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Branch `tsh-replacement`** is the Melee-only replacement for TournamentStreamHelper (plan: `~/.claude/plans/i-want-to-start-abundant-walrus.md`, milestones M0–M8). This file describes it as of the M8 cutover. `master` still runs TSH + the old bridge until this branch merges; a leftover `TournamentStreamHelper-*/` folder beside the repo is a rollback only — gitignored, unused by the app.

## What This Repo Is

One Node app that runs a Melee tournament stream: it reads live Slippi games, owns the scoreboard, runs the event from start.gg, keeps the player DB, serves every OBS overlay, and gives the operator one dock to drive it from.

1. **`slippi-bridge/`** — the app (the folder kept its old name). `index.js` is the composition root; everything else is in `lib/`. The dock is `public/dock/`.
2. **`overlays/`** — every OBS browser source, the shared overlay runtime, the theme packs and the stock character icons. Served at `/o/` and `/assets/`.
3. **`start.bat`** — the launcher (installs dependencies on first run).
4. **`obs-scripts/`** — Python scripts that run *inside* OBS (Tools → Scripts). Just `auto_replays.py`, the break-scene clip playlist. Not required by the app.
5. **`tests/`** — `node tests/run.js`. No framework; each `*.test.js` is a plain Node script that exits non-zero. Deliberately narrow: only failures that are invisible until they are on stream. Read [tests/README.md](tests/README.md) before adding one — the sandbox has gotchas, and hand-written state produces tests that pass without exercising anything.

### Companion docs — read the relevant one before working, don't re-derive it

- **[docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md)** — setting up a machine, a fresh OBS profile, or moving one over from TSH. **When the user says "run the fresh-install checklist", work that document.** Start with `node slippi-bridge/scripts/preflight.js`, which automates its mechanical half (deps, config, hotkeys, the player file, icons, overlay pages, theme pack, then live probes of the app, start.gg and OBS). Read-only; exits non-zero on any failure.
- **[docs/TESTING.md](docs/TESTING.md)** — verifying a change with no bracket running: the automated checks, replaying `.slp` files *faithfully* (a finished replay does **not** reproduce live conditions — see the `rawDataLength` note there), booting the app against a past event, screenshotting overlays, and the regression checklist.
- **[docs/BRIDGE-API.md](docs/BRIDGE-API.md)** — the state sections, event payloads and `/api/*` routes, with the traps in each. Consult it before changing anything a browser consumes; nothing on either side validates, so a shape change fails silently in a browser source.

---

## Running

`start.bat` at the repo root, or `cd slippi-bridge && node index.js`. One port (default **5001**) serves the dock (`/dock`; `/` and `/control` redirect there), every overlay (`/o/…`), the icons (`/assets/icons/`), the API and Socket.io.

Config is [slippi-bridge/config.js](slippi-bridge/config.js) (committed defaults), with the gitignored `slippi-bridge/config.local.js` merged over it by a **shallow** `Object.assign`:

- `SLP_FOLDER` — the Slippi spectate folder. The app exits at startup if it doesn't exist.
- `BRIDGE_PORT` — every OBS source names it.
- `HOTKEYS` — global chords per action, merged **per action** over `lib/hotkey.js`'s defaults.
- `CLIPPER` — starting values only; the dock's Clips tab writes the gitignored `clipper-settings.json`, which wins.
- `BRACKETS` — the series' start.gg short link (**hyphenated**) and keyword `match` + `fallbackSlug` per kind.
- `PLAYERS_FILE` — the player DB; `null` = `slippi-bridge/data/local_players.json`.
- `SET_TEXT` — `{ topN, topLabel, defaultLabel }`: "Bo5" once the set's loser is guaranteed top 8, "Flex" before.
- `STARTGG_TOKEN` — **never in `config.js`**. Missing token: brackets still load (keyless fallback), Start/Report/stats are off.

`CLIPPER` and `BRACKETS` overridden in `config.local.js` replace the whole object; their readers (`clipper-settings.js`, `event-target.js`'s `normalizeBrackets`) fill missing keys from their own defaults for that reason.

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
```

### `slippi-bridge/`

```
index.js                   composition root
config.js                  committed defaults     config.local.js  gitignored (token, per-machine paths)
clipper-settings.json      gitignored, written by the Clips tab — must stay at this path
data/                      gitignored: live-state.json, and local_players.json by default
stats-cache/               gitignored, one start.gg set history per player
public/dock/               the operator dock (index.html, dock.js, dock.css, fonts/)
scripts/                   preflight.js  capture-startgg.js
lib/
  scoreboard/              store.js  persist.js  set-text.js
  ports/                   port-map.js
  players/                 player-db.js  mains-learning.js
  event/                   event-service.js  event-target.js  bracket-model.js  bracket-feed.js
                           set-model.js  queries.js
  overlay/                 channel.js
  modes/                   index.js  singles.js  doubles.js  game-end.js
  server/                  app.js  routes.js  overlays.js  control-status.js  report-set.js
                           start-set.js  set-gate.js
    api/                   status  scoreboard  event  players  casters  clipper  setup
  stats/                   index.js  set-history.js  normalize.js  queries.js
  game-source.js  combo-detector.js  clip-recorder.js  obs-client.js  clipper-settings.js
  startgg-client.js  hotkey.js  lan-urls.js  port-guard.js  handwarmer.js  char_map.js
  players.js  state.js
```

**`index.js` is a composition root, not a god object.** It builds the services and hands a single `ctx` to each feature factory: `{ config, io, state, store, portMap, playerDb, startgg, clipperSettings, comboDetector, obs, event }`, where `io` is the overlay channel's `emit()`. Wiring is a DAG — store (+persist) → channel → event service → bracket feed, mains learning → modes → control status → clip recorder → stats → report/start → hotkeys → routes — so nothing needs a late binding. `modes` subscribes to the store's events, which is why it comes before anything that shows its port map.

**`lib/state.js`** holds what isn't the scoreboard: the live game (`currentGameState`, `currentRawPlayers`), the clipper's counters, `lastControlStatus`, `source`. **The file documents which module writes which field — keep that current.**

### The scoreboard — `lib/scoreboard/`

**`store.js` (`ScoreboardStore`) is the one owner of live state**: the set on the scoreboard, the loaded tournament, the casters, the overlays' view settings (`bracketView`, `bracketPhaseGroupId`) and the bracket section. Every change is a command (`loadSet`, `closeSet`, `clearSet`, `recordGame`, `bump`, `setScore`, `setPlayer`, `setCharacter`, `setSideColor`, `switchSides`, `setOverrides`, `setTournament`, `setCasters`, `setBracketView`, `setBracketPhaseGroup`, `setBracket`) that bumps `rev` and emits `change` with the sections it touched. Nothing outside the file mutates state.

Two decisions remove whole classes of TSH-era bugs:

- **A side carries its start.gg entrant id.** `sides[0]` is the left column; `switchSides()` reverses the array, so the entrant id travels with the name. Reporting reads `sides[w].entrantId` — no "which slot is column 1 while swapped" inversion, nothing to poll.
- **The score is derived from the game list.** A Slippi game end appends a game (with the characters each side played); ± appends or removes a manual one. The per-game list a report sends can never disagree with the scoreboard, and Switch Sides flips both at once by construction.

Store events besides `change`: **`set-closing`** (the outgoing set, before anything replaces it — `closeSet()`, which `loadSet`/`clearSet` call), **`set-loaded`**, **`sides-switched`**. `reportable()` answers whether the loaded set can be reported and with what.

- **`persist.js`** — every `change` schedules a debounced, atomic write (temp + rename) to `data/live-state.json`; `restore()` on boot. A missing, corrupt or other-version save leaves the store empty — a stale shape is worse than a blank scoreboard. The `bracket` section is never saved (re-read on boot), so a bracket refresh never writes the file. `index.js` flushes pending writes on `exit`.
- **`set-text.js`** — pure. `bestOfLabel` from `lPlacement` (works on preview sets and whether top 8 is its own phase or not); `losersMarks`: [L] on the grand-finals player from losers, both in the reset. Operator overrides always win.

### Ports — `lib/ports/port-map.js` + `lib/modes/`

`PortMap` says which side (0 left, 1 right) — and in doubles which slot — each Slippi port plays for. One chain, at each game start:

1. **Continuity** — the same ports as the last game of this set keep their mapping *and* the method that chose it. This is what makes a manual swap stick for the rest of the set.
2. **Characters** — each port's character against a reference per side: the last recorded game's characters when the ports moved mid-set, the players' DB mains at the start of a set or on a re-detect. Costume only breaks a tie between identical characters; in doubles the assignment with more hits across both sides wins.
3. **Positional** — lower port (doubles: the group holding the lowest port) on the left. Flagged amber in the dock.

`portMap.method` is `character | positional | manual`. Pure apart from logging; the caller passes the reference characters in.

**`lib/modes/index.js`** dispatches singles/doubles (`players.js#isDoubles`: 4 active players with Slippi team ids), runs the chain, and writes live characters into the store. It also reacts to the store: **`set-loaded`** clears the map and, if a game is running, re-detects at once (this replaced the old 0-0 late-bind and most uses of the Re-detect button); **`sides-switched`** flips the map and re-emits the live game. `swapPorts()` (⇄ / `Ctrl+Shift+S`) flips the map with method `manual` and re-applies the live characters; `reresolvePorts()` (↻) re-runs the chain against mains only and needs a live game.

**`game-end.js` reads the winner's side from the port map at game end**, not game start, so anything corrected during the game decides who gets the point. A handwarmer records nothing; an unmapped winner records nothing and says so. Doubles team colours (`MELEE_TEAM_COLORS` in `doubles.js`) go onto the sides as `color`.

### Players — `lib/players/`

- **`player-db.js` (`PlayerDb`)** — TSH's `local_players.json` format, edited in place, so it can always be handed back. Unknown fields round-trip; the app's additions are keys TSH ignores (`startggPlayerId`, `learnedMains`, `pinnedMain`); the `{}` stub and TSH's odd shapes (`mains: "{}"`, null prefix) are tolerated, not fixed. Writes are debounced, atomic, and **byte-identical to TSH's own** for unchanged records (Python's `ensure_ascii` `\uXXXX` escapes, the file's CRLF) — checked against the real 208-player file. Mains are `[displayName, skin]` (display names from `char_map`). `search` / `refOf` / `at` back the dock's Players tab: a record is addressed by `ref` (its index, stable for the process) **plus its tag**, and a mismatch is a 409, so a stale search can't edit someone else.
- **`mains-learning.js`** — what each singles player played, from the set's game list, into the DB **when the set is over**: on a successful report, and on `set-closing`. Least-played first into `learnMain`, so the most-played ends up first. Committing the same set twice is skipped (report-then-load learns once). Never learned: handwarmers and manual games (no characters), doubles (which player of a side a port is is a guess), a typed name with no DB record. start.gg players are upserted; typed names are only found. A pinned main always wins on load.
- **Order matters in the event service:** `loadSet` calls `store.closeSet()` *before* it reads the incoming players' mains, so back-to-back players open on what they just played. `tests/event-service.test.js` pins it.

### The event — `lib/event/`

**`event-service.js` (`EventService`)** owns the loaded start.gg event and replaced TSH's provider:

```
short link → this week's tournament → its singles/doubles event   switchEvent(kind)
event → phases → phase groups → every set, as bracket graphs     loadEvent / refresh
graphs → the picker, playable sets first                          openSets()
one set, re-read fresh → enriched from the player DB → the store  loadSet(setId)
```

- **Reads only, budgeted in the background.** The graphs refresh every 90s through `startgg.backgroundQuery()`; a completed phase group is read once. What the operator presses (a switch, ↻, a load) goes straight out. A generation counter drops a refresh still in flight for the previous event.
- **Every read falls back to start.gg's keyless web endpoint**, so the dock works without a token.
- **The loaded event is part of the store** (`tournament`), so it survives a restart and reloads on boot.
- **`loadSet`** re-reads the set (and still loads, with a warning, when it can't), fills pronoun and main from the DB (pinned → learned → stored mains), and upserts new start.gg players.
- **No stream queue.** The series picks whatever set is playable, so the picker sorts playable (both entrants known, not started) first, then live, then waiting; and the stats pre-fetch the next playable sets' players.

**`event-target.js`** — pure: `normalizeBrackets`, `pickEvent` (exactly one event must contain all of a kind's keywords — **ambiguity is refused, never guessed**), `sameEvent`, `normalizeEventUrl`. The short link is resolved by `startgg.resolveShortLink()` through start.gg's **web redirect**, by hand (`maxRedirects: 0`), because the API returns `null` for a short slug. The event is looked up, not appended: a renamed event under a stale slug loads as an empty bracket with no error anywhere, so `fallbackSlug` is used only when the lookup can't run, and that sets a `warning`.

**`bracket-model.js`** — pure: a phase group's sets → a graph built from start.gg's own edges (`slots.prereqType/prereqId/prereqPlacement`), never from seed math. Losers rounds are negative and need not start at -1; **a bye is an edge to a set that isn't in the list**; the reset is the set whose two slots both come from the GF (start.gg deletes it once GF 1 is won from winners); preview (unstarted) sets carry edges and `lPlacement` too. `selectView(graph, view)` for `winners | losers | top8 | top16 | full` — Top N is the sets whose `lPlacement ≤ N−1`, plus GF.

**`bracket-feed.js`** publishes one phase group into the store's `bracket` section — the dock's pick, else the on-air set's group, else the furthest running — with all five views precomputed, the live score on the on-air set, and a character per singles entrant (Slippi's for the two on air, the DB main otherwise). **`set-model.js`** — pure: `loadPayload` (what loading a set puts on the scoreboard; the [L] fact comes from the graph) and `pickerList`. **`queries.js`** — the GraphQL, shared with `scripts/capture-startgg.js` so fixtures carry exactly the fields the app reads; sized against the 1000-object ceiling with `PAGE_SIZES = [40, 20, 10]`.

### start.gg — `lib/startgg-client.js`

**The only module that talks to start.gg**, which is the invariant worth keeping: two would mean two places handling token expiry, rate limits and timeouts. All GraphQL goes through one `_gql()`:

- **Reads marked `fallback: true` re-post to `www.start.gg/api/-/gql`** (keyless, TSH's headers) on no token, 429, 5xx or a network error. **Mutations never fall back** — they must carry the operator's token.
- **`backgroundQuery()`** — the budget: waits while the last 60s hold `BACKGROUND_BUDGET` (50) requests, and stands down 30s after a 429. The operator's calls (report, start, switch, load) are never delayed, so stats and refreshes can slow each other down but can't make a report fail.
- start.gg's 1000-object refusal is flagged `complexity: true` so a caller splits instead of reading it as empty.
- `resolveShortLink()` is deliberately neither GraphQL nor gated on the token.

### Reporting and starting — `lib/server/`

- **`report-set.js`** — `store.reportable()` → the winner's `entrantId` plus every game's winner as `gameData` (winners only — no stages or characters; start.gg has no score field without game data). Refuses with no token, no set, a preview set, or a tie. Manual only; the dock confirms first. A success (in `index.js`) learns mains, reloads stats, and refreshes the event 3s later.
- **`start-set.js`** — start.gg's `markSetInProgress`. `canStart` only for states **1** (created) / **6** (called). **`evaluateStartability()` is synchronous by contract**: it answers from a per-set-id cache and schedules the one lookup in the background — a query per 2s tick would spend 30 of start.gg's 80-per-60s on a value that changes twice a set, and reporting would be the first thing to break. The first tick after a load reads "Checking start.gg…". Not auto-fired from game 1: a handwarmer or a mis-loaded set would mark the wrong set. `tests/start-set.test.js` pins the caching.
- **`set-gate.js`** — the refusals both share (no token / no set / preview set), so the two buttons can't disagree about what a real set is.
- **Preview sets** (`preview_<phase>_<round>_<n>`) are what an unstarted event's sets are; they can be loaded and shown but never started or reported. Load the set again after the TO starts the bracket.

### The overlay channel and runtime

**`lib/overlay/channel.js`** — Socket.io namespaces `/overlay` and `/dock`. `state:full` on connect and on request; after that one `state:patch { from, rev, ops }` per tick (whole top-level sections), however many commands ran in it. **A patch carries the rev it was diffed from**: a client whose rev is behind `from` missed one and sends `state:resync` rather than keep drawing a score that has stopped changing; a patch it already has is ignored; `state:full` is always taken (the app may have restarted). The feature modules emit their own event names through `ctx.io`; `RELAY` maps each to `game:start`, `game:end`, `clip:saved`, `stats`, `status`, `clip:error` per namespace, and an event with no entry goes nowhere. Nothing is sent on the default namespace. `game:start` is sticky until `game:end`; the last `stats` and `status` are replayed to a new connection.

**`overlays/shared/overlay-client.js`** replaces TSH's `globals.js` (and jQuery, lodash, kuroshiro, the 30fps state poll): `Overlay.connect({ tag })` → `ov.select(path, (now, prev) => …)` (runs only when that path's JSON changed, so a casters edit can't re-animate the scoreboard), `ov.on(event)`, `ov.ready`. Plus `Overlay.h()` (node building), `Overlay.icon({ codename, skin })`, `Overlay.fitText()`, `Overlay.param()`, `Overlay.reveal()`. **The page fades in by itself**: `overlay.css` holds `body` at opacity 0 and `.ready` (first state drawn, fonts in) reveals it — `highlights.js`, which never connects, calls `Overlay.reveal()` itself. `?animate=false` adds `body.no-animate`. The state mirror has no DOM, so `tests/overlay-patch.test.js` runs the same file under Node.

**`lib/server/overlays.js`** — `PAGES` (url → file) and the `/o/` + `/assets/` mounts; `resolveOverlayPath()` is the same table the tests resolve through. **Every url a page uses is absolute** (`/o/shared/overlay.css`), so a source works with or without a trailing slash. **Every overlay stylesheet sits exactly one level under `/o/`**, because a theme pack's `--logo-url` is resolved against the stylesheet that uses the `var()` (see Theme packs).

### The dock — `slippi-bridge/public/dock/`

A pinned **live strip** (both sides' names, characters via a select-screen picker — tap sets, hold/right-click opens costumes — score ±, round / best-of / [L] overrides with Auto text, and ⇆ Sides · ⇄ Ports · ↻ Detect · Start · Report) over six tabs: **Set · Bracket · Casters · Players · Clips · Setup**. Fed by the `/dock` namespace's state plus `status`. Fonts (Saira, Martian Mono) are self-hosted — venue Wi-Fi is unreliable.

- **No `innerHTML`**: nodes are built with `Overlay.h()`. **Every renderer is wrapped in `guard()`**, so one that throws shows in the dock instead of freezing it. `tests/dock-static.test.js` checks every id the script looks up exists and every route it calls exists with that method.
- **Input survives pushes.** A name being typed isn't overwritten mid-word (commits on change; Escape sends nothing); the casters are a **draft until Put on stream**, kept across pushes unless unchanged and nobody is typing; the clipper form is generated from one `CLIP_FIELDS` spec and latches dirty.
- **Health:** `control_status` is sent on change plus a **5s heartbeat**; no status for ~12s dims the lights.
- **Autocomplete** (`autocomplete()` in `dock.js`, one shared `#ac-menu`, not a `<datalist>`) on the round, prefix, tag, pronoun and caster fields. The strip's tag suggests the **loaded event's entrants only** (the whole player DB with no event), and a pick fills the slot through `/api/players/assign`. A field's own keydown handler goes after `autocomplete()` and skips a `defaultPrevented` key, or Enter on a suggestion also commits the typed text.
- Report and a load over a set with games ask first. The active tab persists in `localStorage` (wrapped — it can throw).
- Layout: one column in an OBS dock, more from ~760px; usable from a phone. `lan-urls.js` lists the dock's url on every reachable address, **Tailscale (`100.64/10`) first** — it survives a venue network change and guest Wi-Fi client isolation; Hyper-V switches and `169.254` adapters are filtered out.

### Hotkeys — `lib/hotkey.js`

Global via `uiohook-napi` (native, required lazily). Defaults: `Ctrl+Shift+S` swap ports, `Ctrl+Shift+X` switch sides, `Ctrl+Shift+1`/`2` a game to left/right, `+Alt` takes one away. Three rules, each a way a global key goes wrong at a desk: **modifiers match exactly** (`Ctrl+Shift+Alt+1` isn't also `Ctrl+Shift+1`); **a held key fires once** (Windows auto-repeats keydown with no keyup); **no chord without Ctrl, Alt or Win** (the hook sees every keystroke on the machine and still passes it to the focused app). A bad or clashing `HOTKEYS` entry is reported and left unbound, never thrown. If the module won't load, single keys in the app's own terminal (`s x 1 2 q w`). Each press logs `[hotkey] …` with the resulting score — the operator is looking at OBS, not the dock. `installHotkeys` returns `{ mode, bindings, errors }` for the Setup tab and the dock's key hints.

### Control status — `lib/server/control-status.js`

The dock's status: health (`startgg` from the event service's last read, `slippi`), the port map and how it was chosen, the Current Set card (report/start gating), the tournament, the bracket overlay's view, the clipper. Everything is local — **no network call in a rebuild**. Rebuilt every 2s and on demand; concurrent `refresh()` callers share one in-flight rebuild, and `refresh()` never rejects. The object's shape is written once, in `compose()`, used for both the startup seed and every rebuild — a new field goes there and nowhere else (`tests/control-status-shape.test.js`).

### Port reclaim — `lib/port-guard.js`

`EADDRINUSE` on `BRIDGE_PORT` is the normal restart case (a window left open, a crash that left node running), so the new process takes the port back itself — wired in `lib/server/app.js`.

- **Identity gate.** It only kills a process that answers `GET /api/identity` with `{ app: "slippi-bridge", pid }` (the identity string is kept from the bridge era on purpose). An unidentified occupant is reported and left running — killing an unrelated program would be far worse than refusing to start.
- A legacy fallback recognises a pre-identity bridge by its `/api/status` shape and finds the pid with `netstat -ano`; remove it whenever those builds are gone.
- **Retry is bind-driven**: Windows releases a killed process's socket asynchronously, so `waitForPortFree()` polls by binding a throwaway server. One attempt only.
- The `listening` log is a `httpServer.once("listening")` handler, **not** a `listen()` callback: a failed `listen()` leaves its callback attached, and the retry would log twice.

### Handwarmer detection — `lib/handwarmer.js`

A weighted score ≥ 2 = handwarmer: each player's `totalDamage < 150` (+1/−1), LRAS end method 7 (+1/−1), both players > 1 stock in the last frame (+2), duration < 60s (+1). If `stats.overall` is empty, returns `false` (no vacuous-truth positives).

- **Score-only suppression:** characters still update; no game is recorded.
- **Rage quit:** LRAS + not a handwarmer + a valid `lrasInitiatorIndex` → the point goes to the other side (in doubles, someone on the other team by `teamId`, not the quitter's partner).
- Every game end prints one `[handwarmer]` line with the per-check deltas and the verdict.

Gotchas (do not regress): use `totalDamage`, not `totalDamageDealt`; read stocks from `getLatestFrame()`, not `stats.stocks` (empty on LRAS); in doubles **don't `filter(Boolean)` `lastFrame.players`** — that drops null dead-player entries and leaves only the winners, falsely flagging every doubles game (use `p?.post?.stocksRemaining ?? 0`); `killCount` is unreliable in 4-player games, so that check is singles only.

### Reading the live game — `lib/game-source.js`

`createFolderSource(config, detector?)` polls `SLP_FOLDER` every 500ms (a `knownFiles` set ignores files present at startup — **`fs.watch` is not used**, it misses new files on Windows/OneDrive paths) and emits `game-start` (`rawPlayers, stageId`), `game-end` (`{ winnerPlayerIndex, isHandwarmer }`) and `highlight`. Which port won is the pure `pickWinner()` (GAME!, RESOLVED — how most doubles games end — then a last-frame stock fallback), pinned by `tests/game-winner.test.js`.

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
- **Settings** — `DEFAULTS` → `config.CLIPPER` → `clipper-settings.json`, merged per key, validated and clamped (values come from a browser form), written atomically. Keys: `enabled`, `obsUrl`, `obsPassword`, `autoStartBuffer`, `minMoves` (4), `minDamage` (30), `requireKill`, `comboWindowSec` (0 = whole conversion), `maxComboDurationSec` (0), `cooldownSec` (8), `saveDelayMs` (2500), `maxClipsPerGame` (0), `clipFolder`, `notifySidePanel`.

`auto_replays.py` is descended from Melee-Ghost-Streamer's script, driven by `OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED` + `obs_frontend_get_last_replay()` (folder polling is opt-in), handles `ffmpeg_source` as well as `vlc_source`, and releases every `obs_data` handle. **Its interpreter is whatever OBS's Tools → Scripts → Python Settings points at.**

### Side panel stats — `lib/stats/`

The side panel's player cards, head-to-head and Just Finished. TSH's own stats were wrong in ways that changed set to set: start.gg refused most of its requests for exceeding **1000 objects per response** and it read each refusal as "no sets"; `workers = []` inside its loop discarded half its results; and it only read `user.events` (the account's own events: ZODD-01's reaches 276 events back to 2023, against 2,275 sets back to 2015).

- **`queries.js`** — sized against the ceiling (per-node counts noted); ids interpolated into aliased batches, `idList()` refuses anything that isn't a positive integer.
- **`set-history.js`** — `SetHistoryStore`: every set a player has played, from `Player.sets`, saved to `stats-cache/player-<id>.json`. Pages are newest first, so a **top-up** stops at the first page it already holds unchanged (normally one request); a copy older than 30 days is fully re-crawled (start.gg edits old sets). A refused page is re-read at half size (60 → 30 → 15), never counted as empty. Syncs per player are deduped.
- **`normalize.js`** — pure; the head-to-head rules, each checked against a hand-verified record (NAV 69–25, Yung John 29–3, Redd 22–8): **find the opponent by id, the other side is the player** (old-tag sets carry the *old* player id); **read both histories, union by set id**; **Melee only**, **singles only** (one participant per side), **finished, not DQ'd, with a winner**.
- **`index.js`** — `createPlayerStats(ctx)`, driven by the store: a new pair is acted on at once (a set load is one command, so no half-loaded pair). One request for both cards, then both histories and the five recent pills; a generation counter drops late answers. Just Finished comes from the event service's reads (no request, no token needed). Players in the next playable sets are pre-fetched while idle. Doubles: no cards or head-to-head. No token: `enabled: false`.
- **Costs, measured:** a pair with neither history saved is ~57 requests / ~70s for two long-time regulars; after that, 2 requests / ~1.5s.

### Overlays — `overlays/`

All pages load `/o/shared/overlay.css` and `/o/shared/overlay-client.js`; OBS's browser is **Chromium 103** (OBS < 31), so no `:has()`, `color-mix()` or container queries, and entrances animate `transform`, not the individual `translate` property (an element that already has a transform sets `--base-transform`).

- **Scoreboard** (`/o/scoreboard`, `/o/scoreboard/players`) — names, prefixes, pronouns, live characters, scores, round, best-of, [L]. The store holds the live character, so TSH's costume-patch hack is gone.
- **Casters** (`/o/casters[?i=N]`) — the port of TSH's `commentators/tag.html` (mic, prefix, tag, pronouns), restyled to the pack.
- **Bracket** (`/o/bracket[?view=]`) — laid out in the page by `bracket/layout.js` (pure: a column per round, each set centred on its feeders, SVG connectors, the winner's path in the accent, losers drop-ins tagged "from W-R2" instead of drawn), because positions depend on measured card size and the fit scale. Each view **scales to fit down to a legibility floor (~22px names), then pans** slowly from the live or latest round, holding at each end. The view comes from the store (`POST /api/bracket-view`) unless `?view=` pins it; a switch crossfades.
- **Highlights** (`/o/highlights`) — the replay-scene frame, **decoration only** (nothing knows which clip VLC is playing). Never connects; reveals itself. Each frame is one div whose **`border` is the plate** (`box-sizing: border-box`, so the padding box is the window and the footage shows through; `mask-composite` isn't safe in OBS). Geometry is `:root` variables that must equal the OBS source transforms, settable from the url: `?clip=x,y,w,h`, `?cam=y,w,h` (the cams share it — their centres must sit on the clip's line), `?camx=leftX,rightX`, `?pad=`; blank components are skipped. Cams flush to the canvas edge **bleed** off it (squared corners; the border stays declared — zeroing it would slide the hole by `--pad`). Each cam plate is open toward the clip and extends to meet it (`--join-l/-r`, derived with `max(0px, …)`); on the open side the border goes to 0, the corners square and all three shadow layers drop to three sides, or a gold hairline appears where the rail was. **`?guides=1`** outlines each hole with its *measured* rect (minus the overhang), which is the alignment check. The scrim is four edge bands, never a full-canvas wash (a browser source paints over every source beneath it). Keep `--title-gap` non-zero. The sheen is behind `@supports (background-clip: text)`.
- **Side panel** (`/o/side-panel[?panel=<id>]`) — 611×1080 beside the cam: four background bands, two floating cards, a transparent 587×330 cam cutout (`.cam-overlay` rounds it with an outward spread shadow). The header shows the tournament name from the store. The bottom card rotates (`PANEL_INTERVAL` 20s) through `logo-primary`, `player-1`, `player-2`, `recent-sets`, `logo-sponsor`, `completed-sets`; doubles drops the player cards and head-to-head.
  - **Stats from the app only, oriented by start.gg player id** against the ids in each column *now*, so Switch Sides needs no refetch and a late snapshot for the previous pair fails to match instead of labelling the old record with the new names. A pair still loading shows nothing. Winner-only sets render W/L from the winner.
  - **Rotation:** `Rotator._tl` holds the active timeline and `_transitionTo()` kills it first (stale `onComplete`s spawned duplicate timer chains). **A slot-list change restarts the rotation only when the visible panel left the list** — `restart()` rotates from the top and slot 0 is always the logo, so restarting per change flashed the logo on every set load. `tests/side-panel.test.js` pins both halves.
  - **Render only what changed** (per-panel view comparison), so a burst of pushes doesn't swap the visible panel's pills with no animation.
  - **Long text shrinks** (`fitText(node, minPx)`, synchronous — call it after the node is in the document; `rAF` never fires in a source that isn't painting), refit when web fonts land; ellipsis is only the fallback.
  - **Clip toast** slides over the bottom card's bottom edge; toasts queue (restarting a visible pill flickers on stream) and keep only the newest.
  - **Spotlights** are opt-in per pack (`--spotlight-display`, `--spotlight-rgb`, `--spotlight-strength`); clip-path + gradient + a horizontal mask (prefixed too) make the beam — drop any one and a flat wedge goes on stream.

### Theme packs

```
overlays/theme.css                   a SWITCH: one @import naming the active pack
overlays/themes/<pack>/theme.css     every token, the @font-face, the two logo urls
overlays/themes/<pack>/{logo,sponsor}.png, fonts/
```

Every overlay links `overlay.css`, which imports the switch. All packs live in the repo at once (`hundred-acres` — the default, on air most of the time — and `salty-suite`); re-skinning is the one `@import` line and a source refresh, and **switching it back afterwards is the step that's easy to forget**.

- **Two url rules in a pack.** A normal `url()` (the `@font-face src`) resolves against the pack file, so `./fonts/…`. A `url()` **inside a custom property** resolves where the `var()` is used, so `--logo-url` is written relative to an overlay stylesheet: `url("../themes/<pack>/logo.png")`. Copying a pack means editing those two paths; preflight and `tests/overlays-static.test.js` resolve them.
- `--logo-filter` / `--sponsor-filter` let a pack recolour artwork (`invert(1)` for black ink on a dark card). Logos are CSS-only (`background-image: var(--logo-url)`), never `<img>` — `getComputedStyle` returns the custom property's url verbatim.
- **`@import` must precede every other rule** in a file, or it is silently dropped.
- Fonts: the pack's brand font self-hosted; any Google Fonts fallback is a network request that fails on venue Wi-Fi.
- `--score-bg-color` is three surfaces (score boxes, the side panel's bottom card, the bracket title); `--score-box-bg` lets a pack diverge the score box alone.

### Character map — `lib/char_map.js`

Slippi character ids (0–25) → `{ codename, display }`; `CSS_ORDER` is Melee's select-screen order (the dock's picker); `characterByName` maps the DB's display names back. Icons are `overlays/assets/icons/chara_2_{codename}_{costume:02d}.png` — TSH's 123 stock icons, committed (Game & Watch's file is `game_and_watch`, matching the codename). No icon path is sent anywhere; pages build it with `Overlay.icon()`. `tests/icons.test.js` checks every character and costume has one.

---

## Known Gotchas

- `config.js` is git-tracked — never put secrets there. The start.gg token goes in the gitignored `config.local.js`.
- **`config.local.js` and `clipper-settings.json` stay at the `slippi-bridge/` root**, even though the code that reads them lives in `lib/`: `.gitignore` pins those exact paths, and moving either would start tracking the token or the OBS password.
- **`slippi-bridge/data/` holds the player DB by default** as well as `live-state.json`. When cleaning up after a test boot, delete `live-state.json`, never the folder.
- **Never run TSH against the app's player file.** TSH rewrites the whole file on save and never re-reads it. Copy the file, don't share it.
- `fs.watch` is intentionally not used — always poll.
- The parser is **persistent per file**: anything added to the poll loop must tolerate a live file and must not assume a fresh parse each tick.
- `stats.conversions` is **empty in doubles**, and a conversion's `playerIndex` is the player who was **hit**.
- **start.gg:** a response over 1000 objects is refused *whole* — split and retry, never "no results". `Player.sets(filters: …)` returns zero sets with any filter at all; fetch unfiltered and filter locally. `event.sets(filters: { playerIds: [a, b] })` is **OR**. `user.events` is not a player's history. The API returns `null` for a short slug — only the web redirect resolves it, and the link is **hyphenated** (`start.gg/100acres` is a hard 404).
- **Preview sets** (`preview_…`) exist until the TO starts the bracket: loadable, never startable or reportable.
- **A browser source whose page failed to load doesn't retry.** Start the app before OBS, or refresh the sources. A loaded page survives app restarts (socket.io reconnects and gets `state:full`).
- **OBS's CEF is Chromium 103.** Check any new CSS feature against it; headless Chrome being newer hides the failure.
- **Headless Chrome `--virtual-time-budget` screenshots run ahead of real time** — they miss a change made after load. Use the DevTools protocol for live-update checks.
- **Don't synthesise global keypresses to test the hotkeys** — they also type into whatever window has focus. Press them by hand.
- **`scripts/` is one level deeper than the app.** `preflight.js` resolves the app at `..` and the repo at `../..`, and requires most of what it checks **lazily** (it has to run before `npm install`). `tests/preflight.test.js` runs it offline so a moved module fails a test rather than a pre-event check.
- `slippi_game_start` / `slippi_clip_saved` keep a `teamNum` field (`side + 1`) — the payload's long-standing name for the side, not a TSH team.
- `TournamentStreamHelper-*/` beside the repo is gitignored wholesale: a rollback install, with its own `user_data/` (a real player DB). The app reads nothing from it; preflight only mentions it.
