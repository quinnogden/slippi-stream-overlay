# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A custom streaming overlay for Melee tournaments that bridges live Slippi game data into [Tournament Stream Helper (TSH)](https://github.com/nicholasgasior/TournamentStreamHelper). Two coupled parts:

1. **`slippi-bridge/`** — a Node.js backend that reads live `.slp` files, drives TSH via its HTTP API, emits Socket.io events to the OBS browser sources, and serves an operator control panel.
2. **`TournamentStreamHelper-5.972/layout/`** — customized TSH layouts (scoreboard, side panel, bracket) that consume both TSH state and slippi-bridge events, plus `highlights/`, a decoration-only frame for the replay scene that consumes neither.
3. **`obs-scripts/`** — Python scripts that run *inside* OBS (Tools → Scripts). Currently just `auto_replays.py`, the break-scene highlight playlist. Not part of the bridge and not required by it.
4. **`tests/`** — `node tests/run.js`. No framework and no dependency to install; each `*.test.js` is a plain Node script that exits non-zero. Deliberately narrow: only the failures that are invisible until they are on stream, where the manual reproduction step is "run a tournament". Everything else is verified by hand — [docs/TESTING.md](docs/TESTING.md) is still the primary document. See [tests/README.md](tests/README.md) before adding one; the sandbox has four non-obvious gotchas and hand-written TSH state produces tests that pass without exercising anything.

TSH itself (`TournamentStreamHelper-5.972/`) is a third-party Python app run as a local web server on port 5000. **Only edit files under `layout/`** — everything else in that folder is vendored and can be read for reference but not modified.

### Companion docs — read the relevant one before working, don't re-derive it

- **[docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md)** — setting up on a new machine, a fresh TSH extract, or a fresh OBS profile. Phase-by-phase, marking which steps you can do and which need the operator (GUI, credentials). Front-loads the two silent failures: TSH's `webserver_port` defaulting to 5500, and a TSH release zip overwriting the tracked `layout/`. **When the user says "run the fresh-install checklist", work that document.** Start by running `node slippi-bridge/scripts/preflight.js`, which automates its mechanical half (deps, config, TSH install + `user_data`, layout integrity, the four `general` settings, then live TSH/bridge/OBS probes). It is read-only and exits non-zero on any failure.
- **[docs/TESTING.md](docs/TESTING.md)** — how to verify a change with no bracket running: the automated checks in `tests/`, replaying `.slp` files *faithfully* (a finished replay does **not** reproduce live conditions — see the `rawDataLength` note there), driving the layouts from a stub Socket.io server on 5001, and the regression checklist for the paths that only fail on stream.
- **[docs/BRIDGE-API.md](docs/BRIDGE-API.md)** — the Socket.io event payloads and `/api/*` routes, with the traps in each. Consult it before changing anything a browser consumes; nothing on either side validates, so a shape change fails silently in a browser source.

---

## Running the Bridge

```bash
cd slippi-bridge
npm install       # first time only
node index.js
```

Launch options:
- **`start-bridge.bat`** — starts just the bridge (TSH must already be running). Uses `%~dp0` so it works regardless of clone location.
- **`start-all.bat` → `scripts/start-all.js`** — one-shot launcher: starts TSH (`TSH.exe`, falling back to `TSH_bat.bat`), polls `TSH_URL` until its HTTP API responds (60s timeout with a friendly failure message), then spawns the bridge with inherited stdio. Does **not** launch OBS and does **not** kill TSH on exit.

Config is in [slippi-bridge/config.js](slippi-bridge/config.js):
- `SLP_FOLDER`: path to the Slippi Spectate folder the live `.slp` is written into
- `TSH_URL`: TSH web server, default `http://localhost:5000`
- `SCOREBOARD_NUM`: TSH scoreboard to control (default `1`)
- `TSH_ROOT`: absolute path to the TSH install. Default `null` = auto-detect (see below).
- `BRIDGE_PORT`: Socket.io + control-panel port (default `5001`)
- `STARTGG_TOKEN`: start.gg personal access token for result reporting. **Never put the real value in config.js (git-tracked).** Set it in `slippi-bridge/config.local.js` (gitignored, copied from `config.local.example.js`); `config.js` merges it over itself at load via `Object.assign` in a try/catch. Missing token → reporting disables itself, the rest of the bridge runs normally.
- `BRACKETS`: the control panel's Singles/Doubles buttons — `shortLink` (the series' stable start.gg short link, **hyphenated**) plus a `match` keyword list and a `fallbackSlug` per format. Nothing here changes week to week; the TO re-points the short link at each new tournament. See [Bracket switcher](#bracket-switcher).
- `CLIPPER`: starting values for the combo clipper. Only defaults — the control panel writes operator edits to the gitignored `clipper-settings.json`, which wins. See [Combo Clipper](#combo-clipper--obs-replay-buffer).

**Locating TSH (`slippi-bridge/lib/tsh-root.js`):** TSH ships as a versioned folder, so the path is resolved at startup rather than hardcoded — `resolveTshRoot(baseDir, override)` scans the repo root for `TournamentStreamHelper*` directories, keeps only those that look like a real install (a `layout/` subfolder **plus** one of `TSH.exe` / `TSH_bat.bat` / `main.py`), and picks the highest version by **numeric** component-wise comparison (so `5.1001` > `5.972` > `5.99`). `config.TSH_ROOT` short-circuits the scan. Both `index.js` and `scripts/start-all.js` call it via `resolveOrExit()` and log the resolved root; failure exits with an actionable message. **Updating TSH is therefore: extract the new folder, copy `layout/` back, copy `user_data/` across — no code edits.**

**Keyboard shortcut:** `Ctrl+Shift+S` (global, via `uiohook-napi`) manually swaps the port→team assignment. Falls back to pressing `S` in the terminal if `uiohook-napi` fails to load.

**Operator control panel:** `http://localhost:5001/control`, served by the bridge from `slippi-bridge/public/control-panel.html`. Intended as an OBS Custom Browser Dock — an internal operator tool, not part of the broadcast. See [Control Panel](#control-panel--startgg-reporting).

---

## Architecture

### Data Flow

```
Slippi Desktop App → live .slp file in SLP_FOLDER
        ↓
slippi-bridge/index.js   (Node.js, port 5001)
  ├─ reads the live game file via @slippi/slippi-js
  ├─ pushes character+costume → TSH HTTP API  (POST /scoreboard1-update-team-N-1)
  ├─ pushes score increments  → TSH HTTP API  (GET /scoreboard1-teamN-scoreup)
  ├─ saves OBS replay clips   → obs-websocket v5 (combo clipper)
  ├─ emits Socket.io events   → layout browser sources
  └─ serves /control + /api/* → operator control panel (OBS dock)
        ↓
TournamentStreamHelper-5.972/  (Python app, port 5000)
  ├─ out/program_state.json    (live state — read by bridge and layouts)
  └─ layout/                   (OBS browser sources: scoreboard, side-panel, bracket)
```

### slippi-bridge layout

```
slippi-bridge/
  index.js                  composition root (~135 lines)
  config.js                 committed defaults    config.local.js  gitignored, holds the token
  clipper-settings.json     gitignored, written by the control panel — must stay at this path
  public/control-panel.html the operator dock
  lib/                      every module below
    modes/                  singles.js  doubles.js  crew.js  index.js (dispatcher)
    server/                 app.js  routes.js  control-status.js  report-set.js  start-set.js
  scripts/                  preflight.js  start-all.js
```

**`index.js` is a composition root, not a god object.** It resolves the TSH root, builds the
services, and passes a single `ctx` to each feature factory. Everything else lives in `lib/`.
`ctx` is `{ config, TSH_ROOT, io, state, portMapper, tsh, startgg, clipperSettings, comboDetector,
obs }`; the wiring order is a DAG — control-status → clip-recorder → report-set → modes → routes —
so nothing needs a late binding.

**`lib/state.js`** — `createState()`. The shared mutable state that used to be a dozen
module-level `let`s in `index.js`: `currentGameState`, `currentSetId`/`currentSetGames`,
`crewBattleState`, the clipper's rate-limit counters, `lastControlStatus`, `tshSwapped`, `source`.
Reached as `ctx.state`. **The file documents which module writes which field — keep that current.**

#### Game modes (`lib/modes/`)

- **`index.js`** — `createModes(ctx)`. Reads TSH once per game start, decides singles / doubles /
  crew, hands off. Also owns `syncSetTracking()` and `reportStage()`.
- **`singles.js`** — game start, plus `onGameEndStandard()`, which doubles shares (the two modes
  differ only at game start). Contains the 0-0 late-bind.
- **`doubles.js`** — game start and `MELEE_TEAM_COLORS`.
- **`crew.js`** — start, end and the `slippi_crew_update` payload.

#### Services (`lib/`)

- **`port-mapper.js`** — `PortMapper` class. Owns all port→team tracking state (`_portToTeam`, `_portToName`, `_portScore`). Never reads files or makes HTTP calls — all data is passed in. `getResolutionInfo()` reports the current mapping plus which heuristic set it (`_resolutionMethod`: name / score / character / positional / manual).
- **`tsh-client.js`** — `TshClient` class; all I/O with TSH. Reads `program_state.json` (`readState()` + pure accessors), calls the TSH HTTP API, and returns typed `{ ok, error?, data? }` results. Every HTTP method goes through one private `_call()`; every state accessor through `_team()`, so the `score.<sb>.team.<n>` dig exists once. Includes bracket-action fronts (`pullStreamSet`, `getOpenSets`, `loadSet`), state accessors (`getSetId`, `getLiveScores`, `getTeamInfos`), crew helpers (`isCrewBattle`, `getActivePlayerName`, `getActivePlayerCharacter`), and a `ping()` health probe.
- **`startgg-client.js`** — `StartggClient` class. The **only** module that talks to an external service, which is the invariant worth keeping: two would mean two places handling token expiry, rate limits and timeouts. Five GraphQL methods (`https://api.start.gg/gql/alpha`, all through one private `_gql()`): `reportSet()` runs the `reportBracketSet` mutation, `getSetEntrants()` fetches per-team entrant ids (TSH's `/get-match` does *not* expose them), `listEvents()` fetches a tournament's event list for the bracket switcher, and `getSetState()` / `startSet()` back the Start Set button (`markSetInProgress`). `resolveShortLink()` is the odd one out — deliberately **not** GraphQL (the API returns `null` for a short slug; only start.gg's web redirect resolves one) and deliberately **not** gated on `enabled`, since it needs no token. `enabled` is false when no token is configured. Bracket *reading during a set* still goes through TSH's native integration.
- **`game-source.js`** — `createFolderSource(config, detector?)`. Polls `SLP_FOLDER` and returns a Node `EventEmitter` firing `game-start` (`rawPlayers, stageId`), `game-end` (`{ winnerPlayerIndex, isHandwarmer, winnerEndStocks }`) and `highlight` (one detected combo). Also exposes `getStatus()` (`{ connected, detail }`) for the control-panel health dot. The mode handlers bind to these events rather than reading `.slp` files, which keeps them testable against a mock emitter.
- **`combo-detector.js`** — `ComboDetector`. Pure: given a live `SlippiGame`, returns the conversions that just finished and clear the operator's thresholds. No I/O, no timers — all rate limiting lives in `lib/clip-recorder.js`. See [Combo Clipper](#combo-clipper--obs-replay-buffer).
- **`clip-recorder.js`** — `createClipRecorder(ctx, refresh)`. The clipper's time-based half: cooldown, per-game cap, save delay, and the `recentClips` ring.
- **`obs-client.js`** — `ObsClient`. The only module that talks to OBS (obs-websocket v5, via `obs-websocket-js`). Lazily connects with backoff, saves the replay buffer, and reports `getStatus()` synchronously for the control panel. Never throws upward — OBS being closed is a normal state.
- **`clipper-settings.js`** — `ClipperSettings`. Three layers merged per-key: module `DEFAULTS` → `config.CLIPPER` → the gitignored `clipper-settings.json`. Validates and clamps every field (values arrive from a browser form) and writes atomically. Reaches **up one level** for the JSON, which stays at the `slippi-bridge/` root because `.gitignore` pins that exact path.
- **`players.js`** — pure per-player record building (`buildPlayersSingles`, `buildPlayersDoubles`, `isDoubles`, `groupByTeamId`) plus the resolve/push/sync steps singles and crew run identically.
- **`char_map.js`** — `resolveCharacter(charId, costume)` and `resolveStage(stageId)`. Pure mapping, no I/O. Deliberately returns **no icon path** — the layouts build that themselves; see `layout/shared/tsh-assets.js`. `STAGE_MAP` covers all 30 Slippi stage ids TSH ships an icon for; unmapped ids (target-test stages 33+) return `null`.
- **`swap.js`**, **`hotkey.js`**, **`lan-urls.js`**, **`log.js`** — the manual swap, the `Ctrl+Shift+S` listener (native module, required lazily), the startup LAN URL list, and `warnIfFailed()`.
- **`port-guard.js`** — `reclaimPort(port, log)`. Called from the `httpServer` `EADDRINUSE` handler so a stale bridge holding `BRIDGE_PORT` is stopped automatically instead of sending the operator to `netstat`/`taskkill` mid-event. See [Port Reclaim](#port-reclaim).
- **`tsh-root.js`** — `resolveTshRoot(baseDir, override)` plus `resolveOrExit(baseDir, override, tag)` for the two entry points. Finds the versioned TSH install folder so no path hardcodes a version. Only filesystem probing, no config or network.
- **`handwarmer.js`** — `wasHandwarmer(game)`. Weighted heuristic over a slippi-js game object; see [Handwarmer Detection](#handwarmer-detection).

#### Server (`lib/server/`)

- **`app.js`** — Express + Socket.io + the `EADDRINUSE` reclaim dance.
- **`routes.js`** — `registerRoutes(app, deps)`. Receives `publicDir` from `index.js` rather than
  computing a `../..` hop of its own.
- **`control-status.js`** — the 2s snapshot, TSH-side swap detection, and liveness. **One TSH
  round-trip per tick:** a successful `getSwapState()` already proves the web server is up, so
  `ping()` runs only as a fallback (`/get-swap` is 5.972+). Concurrent `refresh()` callers share one
  in-flight rebuild — eight call sites invoke it, several in bursts when the operator clicks around.
- **`report-set.js`** — `reportCurrentSet()`, `evaluateReportability()`, `entrantSlot()`.
- **`start-set.js`** — `startCurrentSet()` (start.gg's `markSetInProgress`) and `evaluateStartability()`. See [Start Set](#start-set).
- **`bracket-switch.js`** — the Singles/Doubles buttons. Pure helpers (`normalizeBrackets`, `normalizeEventUrl`, `sameEvent`, `pickEvent`) plus `createBracketSwitch(ctx, refresh)`. See [Bracket switcher](#bracket-switcher).

### Port→Team Assignment (`PortMapper`)

The bridge maintains a **port-persistent, swap-aware** mapping of Slippi player ports (0-based) to TSH teams (1-based). This survives TSH's "Swap Teams" button (which swaps names *and* scores) — see [TSH-Side Swap Detection](#tsh-side-swap-detection) for the immediate path, with name-based re-derivation on the next game start as the fallback.

Assignment priority on each game start (singles):
1. **`resolve(t1, t2)`** — name-based matching (mid-set). Fallback: score-based matching (`_portScore` vs TSH scores). Resets to null on 0-0.
2. **`tryCharacterBased()`** — at 0-0, reads TSH's preloaded character history (`program_state.json → team.player["1"].character["1"]`). Matches on `name`; also checks `skin` (costume index) when both players use the same character.
3. **Positional default** — lower port index → team 1.

**0-0 late-bind (game end):** when a singles game started at 0-0, `onGameEnd` re-reads TSH state *after* the game finishes, looks up the winner's name (via `getPortName()`) in the current TSH team assignments, and uses that as the authoritative team for `incrementScore`. This lets the TO finish entering names / correcting sides during game 1 without the score going to the wrong player. Falls back silently to the game-start assignment if names are blank or TSH is unreachable. Game 2+ is unaffected (`resolve()` at 1-0 already name-matches live TSH state).

### Doubles

Auto-detected when a game has 4 active players with `teamId` assigned in the `.slp` **and** TSH team 1 has more than one player slot. Same scoreboard, same bridge port — no extra config. `onGameStart` routes to `onGameStartDoubles`.

- **PortMapper (doubles):** `resolveDoubles()` (name → score → positional), `tryCharacterBasedDoubles()` (bidirectional scoring vs both TSH teams — breaks ties where only one team has a unique char), `applyDoublesPositional()` (group-based: lower min-port Slippi group → TSH team 1). `applyDoublesPositional()` is called explicitly after `resolveDoubles` + `tryCharacterBasedDoubles` at 0-0 so `_portToTeam` is always set — this fixes the index-based positional fallback that was wrong for non-consecutive groups (e.g. ports {0,3} vs {1,2}).
- **Team colors:** `MELEE_TEAM_COLORS = { 0: '#D32F2F', 1: '#1565C0', 2: '#2E7D32' }` mapped from Slippi `teamId`; overrides whatever color the TO configured in TSH. `teamColorMap` uses min-port-per-group when `_portToTeam` is set, group min-port ranking otherwise.
- **Score tracking:** `onGameEnd` reads the winner team from `currentGameState.players[winnerPlayerIndex].teamNum` before falling back to `portMapper.getTeam()` — fixes a null winner when `_portToTeam` is unset at 0-0.
- **Game end:** RESOLVED end method (the normal doubles win in Slippi) plus a last-frame stock-count fallback when placements are missing.

### Crew Battle Mode

Stock-tracking crew battles for 4- or 5-person teams. The TO configures 4+ players per team in TSH and sets the initial score to the total starting stocks (**16** for 4-person, **20** for 5-person) before game 1. `onGameStart` routes to `onGameStartCrew`.

- **Detection:** `tsh.isCrewBattle(state)` — `Object.keys(team["1"].player).length >= 4`.
- **Stock tracking:** `crewBattleState.carryOverStocks[team]` tracks stocks the active player entered with (init 4). After each game: `totalStocks[loserTeam] -= carryOverStocks[loserTeam]`; the winner's carry-over is updated from `winnerEndStocks` (last-frame `stocksRemaining`, added to the `game-end` payload in `game-source.js`). No handwarmer check in crew mode — every completed game counts.
- **Per-player stats** (`crewBattleState.playerStats[name]`): `isActive`, `eliminated`, `hasPlayed`, `stocksTaken`, `character`. The active player is read from TSH `team[N].player["1"].name` at each game start (the TO updates this slot before each game).
- **Bridge events:** `slippi_crew_update` (fires at game start + end with `totalStocks`, `carryOverStocks`, `playerStats`) and `slippi_crew_end` (fires when a team reaches 0 stocks). Stock counts are pushed to TSH via `setScore`.
- **Scoreboard:** the crew branch in the layout `Update()` renders the active player's character icon via the single-player path `team.N.player.1` (prevents `assetUtils` from iterating all 5 slots). Team name shows in the `.pronoun` chip below the player name.
- **Side panel:** two rotation slots, `crew-team-1` / `crew-team-2`, each with a Name / Stocks-Taken column layout. Pill states: `active` (green left border + tint), `eliminated` (0.35 opacity), `waiting` (default).

### Per-Game Stage Reporting (TSH 5.972+)

TSH 5.972 added the **Individual Game Tracker**, which records stage / characters / winner per game under `score.<N>.stages.<i>`. The bridge already parses the stage from every `.slp` and now pushes it.

- `game-source.js` emits `game-start` as `(rawPlayers, stageId)`, taken from `settings.stageId` (`null` when unavailable).
- `onGameStart` calls `reportStage(stageId)` → `resolveStage()` → `tsh.setCurrentStage(codename)`.
- **Best-effort by design:** unmapped stage ids log a warning and skip; the HTTP call is fire-and-forget with `.catch(() => {})`. Stage reporting is cosmetic and must never block scoring.
- **Skipped in crew battles** — they don't use the game tracker, so there is no game slot to stamp.
- Per-game *characters* need no bridge work: TSH's `_CopySetLevelCharactersToGame` copies the set-level selection (already pushed via `update-team`) into the game slot automatically.

Codenames are the basenames of `user_data/games/ssbm/stage_icon/*.png`. Watch the spellings that don't match the Slippi enum: `HYRULE_TEMPLE`→`temple`, `POKE_FLOATS`→`pokefloats`, `DREAMLAND`→`dream_land`, `KONGO_JUNGLE_N64`→`kong_jungle_64` (**"kong"**, not "kongo"). `ICETOP` (26) maps to `icicle_mountain` — TSH ships no separate asset.

### Port Reclaim

`EADDRINUSE` on `BRIDGE_PORT` is the normal restart case (closed console, crashed `start-all`, editor still running the old copy), not an operator error, so the new process takes the port back itself — `lib/port-guard.js`, wired in `lib/server/app.js`.

- **Identity gate.** It only kills a process that answers `GET /api/identity` with `{ app: "slippi-bridge", pid }`. That response supplies the pid directly, so no `netstat` parsing in the normal path. Killing an unrelated program that happened to pick 5001 would be far worse than refusing to start, so an unidentified occupant is reported and left running.
- **Legacy fallback.** A bridge from before `/api/identity` existed still answers `/api/status` with a shape (`tsh` + `portMapping` keys) nothing else serves; that identifies it, and the pid then comes from `netstat -ano` (`lsof -t` off Windows). One-time path — remove it whenever pre-identity builds stop being in play.
- **Retry is bind-driven.** Windows releases a killed process's socket asynchronously, so `waitForPortFree()` polls by actually binding a throwaway server rather than sleeping a fixed delay.
- `portReclaimTried` allows exactly one attempt — a second `EADDRINUSE` exits.
- The `Socket.io server listening` log is a `httpServer.once("listening")` handler, **not** a `listen()` callback: a `listen()` that fails with `EADDRINUSE` leaves its one-shot callback attached, so the retry fires both and logs twice.

### TSH-Side Swap Detection

`GET /scoreboard<N>-get-swap` returns TSH's own `teamsSwapped` flag as the Python string `"True"`/`"False"` (**not** JSON). Polled in the existing 2s `refreshControlStatus` loop.

- `tshSwapState` starts `null` so the first poll only seeds a baseline — no phantom swap on startup.
- On a change, `handleTshSwap(state)` re-runs `portMapper.resolve()` against fresh TSH names, updates `teamNum` on the live players, and re-emits `slippi_game_start`. Previously an operator-side swap was only noticed on the *next* game start via name re-derivation.
- The bridge's own `swapTeams()` never calls TSH's swap endpoint (it only flips the internal map), so any change in this flag means the scoreboard's sides really moved — either from TSH's UI or from the control panel's **Switch Sides** (`POST /api/swap-sides` → `tsh.swapSides()`). The reaction is identical either way, so no origin bookkeeping is needed.
- Exposed as `tshSwapped` on `control_status` / `/api/status` and rendered in the control panel. `getSwapState()` deliberately does not log failures — it is polled every 2s and would flood the console while TSH restarts.

`PortMapper` remains the scoring authority; this only *detects divergence* rather than delegating the mapping to a single boolean.

### Handwarmer Detection

`slippi-bridge/lib/handwarmer.js` scores each game to detect practice/warm-up games. Weighted score ≥ 2 = handwarmer: each player's `totalDamage < 150` (+1/−1), LRAS end method 7 (+1/−1), both players have > 1 stock in the last frame (+2), duration < 60s (+1). Guard: if `stats.overall` is empty/missing, returns `false` (prevents vacuous-truth false positives).

- **Score-only suppression:** on a handwarmer, `slippi_game_start` still fires (characters update) but the score increment is skipped.
- **Rage-quit handling:** LRAS + not a handwarmer + valid `lrasInitiatorIndex` → awards the point to the other player. In doubles, the point goes to someone on the *other* team by `teamId`, not the quitter's partner.
- Every game end prints a single `[handwarmer]` line with the mode, per-check deltas, raw values, and the verdict.

**Non-obvious gotchas** (do not regress these):
- Use `totalDamage`, not `totalDamageDealt`.
- Read stocks from `getLatestFrame()`, not `stats.stocks` (empty on LRAS).
- Doubles: do **not** `filter(Boolean)` on `lastFrame.players` — that drops null dead-player entries and leaves only the winning team (always > 1 stock), falsely flagging every doubles game. Use `p?.post?.stocksRemaining ?? 0` so null entries count as 0.
- `killCount` from slippi-js is unreliable for 4-player stat computation, so the `killCount <= 1` check is guarded with `!isDoublesGame`.

### `program_state.json` — Key Paths

All keys are **strings**, 1-indexed. Scoreboard number is `config.SCOREBOARD_NUM` (default `"1"`):

```
state.score["1"].team["1"].score                            → team 1 score
state.score["1"].team["1"].player["1"].name                 → team 1 player name
state.score["1"].team["1"].player["1"].character["1"].name  → preloaded character name
state.score["1"].team["1"].player["1"].character["1"].skin  → preloaded costume index (0-based)
state.score["1"].set_id                                     → start.gg set id (null if manual set)
```

### TSH HTTP API (used by bridge)

```
GET  /scoreboard1-teamN-scoreup           → increment team N score by 1
GET  /scoreboard1-teamN-color-<hex>       → set team color (hex without #)
POST /scoreboard1-update-team-N-1         → set character/costume
     body: { mains: { ssbm: [[charDisplayName, costumeIndex]] } }
POST /score                               → set both scores { team1score, team2score, scoreboard }
POST /scoreboard1-set-current-stage       → set the current game's stage (TSH 5.972+)
     body: { codename: "battlefield" }
GET  /scoreboard1-swap-teams              → press TSH's Swap Teams (moves names+scores across sides)
GET  /scoreboard1-get-swap                → TSH's own teamsSwapped flag; returns "True"/"False" as text
GET  /scoreboard1-pull-stream             → pull the next queued stream set onto the scoreboard
GET  /get-sets[?getFinished=1]            → list open (or finished) sets from the bracket provider
GET  /scoreboard1-load-set?set=<id>       → load a specific set by id
GET  /scoreboard1-get-set                 → id of the currently-selected set
GET  /set-tournament?url=<event URL>      → point TSH at a tournament event (writes TOURNAMENT_URL,
                                            signals the provider to re-pull). Returns "OK" as text
GET  /update-bracket                      → re-pull the loaded bracket; 500s when nothing is loaded
```

TSH ships a **complete native start.gg integration** (`src/TournamentDataProvider/StartGGDataProvider.py`) driven by `user_data/settings.json → TOURNAMENT_URL`. It fetches brackets/queue/sets and writes them into `program_state.json` (`score.<N>.set_id`, `bracket.*`, `streamQueue`, `completed_sets`, `recent_sets`, etc.). The bridge *reads* all of that through TSH; it never re-implements bracket fetching. TSH has **no** result-reporting capability — that is the only thing `startgg-client.js` adds.

### Control Panel + start.gg reporting

The bridge serves these on its own Express app (port 5001). Browser JS is normally same-origin with the bridge, and the bridge makes all TSH/start.gg calls server-side, so there is no browser-CORS surface against TSH. A permissive CORS middleware sits in front of the routes anyway: an OBS dock pointed at `public/control-panel.html` as a *file* runs on a `file://` origin, where the panel's `API_BASE` falls back to `http://localhost:5001` and needs CORS to reach `/api/*`.

```
GET  /control            → the operator panel HTML (public/control-panel.html)
GET  /api/identity       → { app: "slippi-bridge", pid } — how a starting bridge recognises a stale one (see Port Reclaim)
GET  /api/status         → { tsh, slippi, slippiDetail, portMapping, tshSwapped, currentSet, tournament, shortLink, startggEnabled, clipper }
POST /api/swap           → same as Ctrl+Shift+S (calls swapTeams()) — flips the internal port→team map only
POST /api/swap-sides     → tsh.swapSides() — presses TSH's own Swap Teams, moving names+scores across sides
POST /api/pull-stream    → tsh.pullStreamSet()
GET  /api/sets[?finished=1] → tsh.getOpenSets(includeFinished)
POST /api/load-set       → tsh.loadSet(body.setId), then refreshControlStatus()
POST /api/bracket        → { kind: "singles" | "doubles" } — point TSH at this week's event for that format
POST /api/start-set      → startCurrentSet() (start.gg markSetInProgress) — no body
POST /api/report         → reportCurrentSet() (start.gg reportBracketSet)
GET  /api/clipper        → { settings, obs, recentClips, clipsThisGame, supported }
POST /api/clipper/settings → validate + persist + apply (clipper-settings.json)
POST /api/clipper/toggle → { enabled } — the master switch, applied immediately
POST /api/clipper/test   → save the replay buffer now (proves the OBS chain)
```
`control_status` is also pushed over Socket.io every 2s and on connect. The panel shows TSH/Slippi/OBS health, the current set + its start/report buttons, the upcoming-sets picker, the combo clipper, and the port→team guess with the heuristic that decided it (a positional guess is flagged as low-confidence) plus TSH's own swap state (`tshSwapped`) and a swap button.

**Every section collapses**, so the dock survives being squeezed next to the OBS preview. Each `.card` carries a `data-section` key, splits into `.card-head` + `.card-body`, and toggles `.collapsed` (`display: none` on the body — *not* an animated `max-height`, which would fight `.sets-list`'s own `overflow-y` scroller). The toggle is its own `<button class="head-toggle">` rather than the whole header row, because two headers already carry a control (the method badge, the sets refresh) and a button can't nest a button. Collapsed keys persist in `localStorage` under `streamControl.collapsed` — an OBS dock reloads every time it's reopened, so the layout choice has to survive that.

The ≥760px layout is **CSS multicolumn**, not a grid. It used to be `grid-template-columns: 1fr 1fr` with `.card-tall` pinned to `grid-column: 2; grid-row: 1 / span 2`; a fixed placement leaves holes the moment cards change height, which is exactly what collapsing does.

**Clipper inputs and the 2s tick.** `render()` runs every 2s and blind-repaints. A `clipDirty` flag latches on the first keystroke so a status push can't overwrite a half-typed threshold; saving clears it and the next tick resyncs from the bridge. Same discipline as the sets list's `setId` guard — and note `render()` has no try/catch, so a missing element id throws and silently freezes the whole panel. It is responsive — one column in an OBS dock, two columns from 760px — so it also works from a phone or tablet at `http://<lan-ip>:5001/control`. `lanControlUrls()` prints those addresses at startup (Tailscale `100.64/10` first, since it survives a venue network change and guest-Wi-Fi client isolation; Hyper-V switches and disconnected `169.254` adapters are filtered out) so the operator never has to run `ipconfig` at a venue.

**Upcoming-sets picker.** The panel is meant to be the only page open during a set, so it renders TSH's bracket data itself rather than sending the TO to `:5000/scoreboard` (a compiled React SPA in the vendored, gitignored `stage_strike_app/build/` — not extensible from this repo). Per-player editing (names, pronouns, country, skins) is deliberately *not* reimplemented; that still happens in TSH.

- Fields consumed from `/get-sets`: `id`, `round_name`, `tournament_phase`, `p1_name`/`p2_name`, `p1_seed`/`p2_seed`, `team1score`/`team2score`, `station`, `stream`. Seeds, station, stream and score render only when populated.
- **One tap loads a set.** The only guard is an inline confirm when the currently-loaded set has a non-zero score, since that is the one case where loading discards operator work. The loaded set is matched on `String(set.id) === String(currentSet.setId)` — TSH reports `set_id` as a string but `/get-sets` uses numbers — and is marked `ON AIR` and made unclickable.
- **Refresh is deliberately slow.** TSH's `get_sets` calls `provider.GetMatches()`, an uncached paginated GraphQL query against start.gg on every call. The panel refreshes on open, on the manual `↻`, after a successful load/pull/report, and on a 90s timer that pauses while `document.visibilityState !== "visible"`. Do not turn this into a fast poll.
- An **empty list is normal** — `get_sets` returns start.gg states 1/6/2 (not started, called, in progress), so a finished bracket legitimately returns 0. The empty state says so and points at the `show finished` toggle (`?finished=1`, which adds state 3); that is distinct from the fetch-failed state.

**Reporting flow (`reportCurrentSet` in index.js):** reads `score.<N>.set_id` + live scores from TSH → refuses if crew / no set_id / `preview` set / tied score → derives the winner *column* from the higher live score → `entrantSlot(column, swapped)` converts that to a start.gg slot → `startgg.getSetEntrants(setId)` maps slot → entrant id (start.gg slot 0 = slot 1) → `startgg.reportSet(setId, winnerEntrantId, gameData)`.

**Swap state is load-bearing for reporting.** TSH's Swap Teams moves each team to the other column *and keeps that orientation for every set loaded afterwards* — `TSHScoreboardWidget.ChangeSetData` does `scoreContainers.reverse()` / `losersContainers.reverse()` / `teamInstances.reverse()` when `teamsSwapped`, so while swapped, TSH column 1 holds start.gg's slot-2 entrant. `entrantSlot()` applies that inversion; without it the report publishes the loser as the winner. `reportCurrentSet` re-reads `getSwapState()` at report time rather than trusting the 2s poll, falls back to the last polled `tshSwapState`, and **refuses** if neither is available — guessing is worse than not reporting. `handleTshSwap()` also flips the recorded `winnerTeam` of every entry in `currentSetGames`, since those are column numbers and the columns just changed hands (mirrors TSH's own `individualGameTracker.SwapStageResults()`). Per-game `gameData` is accumulated in `currentSetGames` (one `{ gameNum, winnerTeam }` per singles/doubles game end; reset in `syncSetTracking()` when `set_id` changes) and is optional — a mismatch falls back to reporting set winner + score only. Manual trigger only; the panel two-step-confirms before POSTing. Singles + doubles; crew battles are excluded.

### Start Set

`lib/server/start-set.js` — the **Start Set on start.gg** button in the Current Set card, which runs start.gg's `markSetInProgress` (the API behind its own "Start match"). It saves the TO opening the bracket page just to start a set they have already loaded on the stream scoreboard.

- **The button only exists while it applies.** `currentSet.canStart` is true only for start.gg states **1** (created) and **6** (called); the panel hides the button otherwise rather than showing a permanently-disabled control on its busiest card. `startReason` carries the refusal.
- **The state is cached per set id, never polled.** `evaluateStartability()` is called from the 2s tick and is **synchronous by contract**: it answers from the cache and schedules the one lookup in the background. A query per tick would spend 30 of start.gg's 80-per-60s on a value that changes twice a set, and the first thing to break would be *reporting* — far from the cause. `tests/start-set.test.js` pins this.
- **The first tick after a set loads reads "Checking start.gg…"** — that's the lookup in flight, not a failure.
- **Preview set ids are never startable.** An event start.gg hasn't started yet has no real sets, so TSH reports `preview_<phase>_<round>_<n>` and there is nothing to mark in progress. Every set in a `CREATED` event looks like this, so the button legitimately stays hidden until the TO starts the bracket — the same reason reporting is blocked there.
- **No confirm, and no automatic trigger.** Starting is non-destructive and start.gg rejects it for any other state, so a misclick costs nothing. It is deliberately *not* fired from the first game start: a handwarmer, a restart, or a set loaded by mistake would each mark the wrong set.
- The route re-evaluates server-side, so a stale panel can't start a finished set.

### Bracket switcher

The panel's **Singles Bracket** / **Doubles Bracket** buttons (`lib/server/bracket-switch.js`). A stream alternates formats, and pointing TSH at the other event otherwise means leaving the dock, opening start.gg, and pasting a link. One press does the chain:

```
config.BRACKETS.shortLink  "100-acres"
  → startgg.resolveShortLink()   web redirect → this week's tournament slug
  → startgg.listEvents()         that tournament's real events
  → pickEvent()                  keyword match → one event
  → tsh.setTournament(url)       TSH re-pulls the bracket
```

- **The short link is why nothing changes week to week.** The TO re-points `start.gg/100-acres` at each new tournament; the bridge follows it. `resolveShortLink()` follows the redirects **by hand** (`maxRedirects: 0`) because the final *URL* is the answer, not the body — axios would otherwise fetch the heavy details page and expose it only via the undocumented `res.request.res.responseUrl`.
- **The event is looked up, not appended.** TSH validates nothing about the URL it accepts, so appending a remembered slug that has since been renamed toasts green and leaves an empty bracket with no error anywhere. `fallbackSlug` is used only when the lookup itself can't run (no token, start.gg unreachable), and that path sets a `warning` the panel latches into the hint.
- **Ambiguity is refused, never guessed.** `pickEvent()` requires exactly one event whose name+slug contains all of the kind's `match` keywords. A tournament with both "Melee Singles" and "Melee Singles Amateur" errors and names the candidates. Picking wrong is silent and puts the wrong bracket on the broadcast.
- **A second press re-pulls rather than no-ops.** `sameEvent(tsh.readTournamentUrl(), url)` compares against `user_data/settings.json`, and a match routes to `/update-bracket` instead — because `/set-tournament` silently does nothing when the URL already matches.
- **No confirmation, by design.** TSH wires `tournament_changed` only to its button-state updaters, so the loaded set's names, scores and `set_id` all survive a switch and a pending report still targets the right set. A misclick costs a bracket re-pull.
- **Concurrent presses are refused, not shared** — the panel can be open in an OBS dock and on a phone at once, and a `doubles` press must not be answered with the `singles` result. This is the opposite of `control-status.js`'s shared-promise dedupe, where every caller wants the same answer.
- `control_status.tournament` (`{ name, eventName }`) comes from `program_state.json → tournamentInfo` and is the **real** confirmation the switch landed — `/set-tournament` returns before TSH's thread pool finishes loading. It reuses the state the tick already reads, so it costs no extra round-trip. The panel refetches the sets list when `eventName` changes.

`tests/bracket-target.test.js` pins the event matching.

### Combo Clipper — OBS replay buffer

Detects notable combos **live, mid-game** and asks OBS to save its replay buffer, so the clip exists by the time the point is over. `obs-scripts/auto_replays.py` then collects those clips into a break-scene playlist.

Detection is deliberately live rather than the post-game scan issue #7 originally described: the replay buffer only holds the last N seconds, so a scan at game end is far too late to capture anything.

**Pipeline:** `game-source.js` (poll tick) → `combo-detector.js` (qualify) → `index.js#onHighlight` (rate limit + delay) → `obs-client.js` (`SaveReplayBuffer`) → `slippi_clip_saved` → control panel + side-panel toast.

- **One `SlippiGame` per file, not per tick.** Folder mode used to rebuild the parser on every 500ms tick; `getStats()` on that is a full re-parse. The instance now lives for the whole game so `processOnTheFly` parses only newly-appended bytes — measured ~4× cheaper across a game, which is what makes a 500ms conversion scan affordable.
- **The parser can be poisoned, and it's guarded.** A live `.slp` carries `rawDataLength = 0` in its header until Slippi closes it, so the parser stops at the last complete command. A file whose header already declares the *full* length while its bytes are still arriving — a finished replay landing in `SLP_FOLDER` via OneDrive sync — makes `iterateEvents` run off the end and leave `readPosition` past EOF, permanently. Nothing recovers: `game-end` would never fire and the rest of the set would go unscored. `game-source.js` compares `readPosition` against the file size each tick and rebuilds the parser when it's past EOF, which degrades to exactly the old fresh-parse behaviour. There is also an `errorStreak` rebuild after ~5s of continuous read failures.
- **Rate limiting is in `lib/clip-recorder.js`, not the detector,** so `combo-detector.js` has no notion of wall-clock time and stays testable against a saved `.slp`. `cooldownSec` stops one exchange banking near-identical clips; `maxClipsPerGame` caps a blowout; `saveDelayMs` waits *after* detection so the kill animation and reaction land in the buffer (the combo itself is already in it).
- **`slippi_clip_saved` carries the attacker's name.** `conversion.playerIndex` in slippi-js is the player who *got hit* — `lastHitBy` is the attacker. Getting this backwards names the victim on the broadcast.
- **Buffer length matters.** Conversions routinely run 6–9s, and `saveDelayMs` adds ~2.5s on top, so OBS's replay buffer wants to be ≥20s or the start of the combo falls out of it.
- **`comboWindowSec` is anchored at the END of the conversion, and that is the whole point.** A conversion does not close when the pressure stops — slippi-js keeps it open until the victim regains neutral or dies — so an offstage chase is *one* conversion running 30s+, mostly dead air. Judged whole, it clips on the strength of an opening burst that, by the time `saveDelayMs` elapses, has already fallen out of the replay buffer: the clip does not contain the thing that qualified it. With a window set, `minMoves`/`minDamage` are measured over the last N seconds instead, so what qualifies and what is captured are the same footage. The window is a subset, so this is strictly stricter than the unwindowed check — it can never let *more* through. Keep it comfortably under the buffer length. **This is not `maxComboDurationSec`**, which caps the total span and so throws away a great punish that happened to begin with a stray poke fifteen seconds earlier; once a window is set, leave that at `0`.
- **Window damage is the sum of in-window `moves[].damage`**, the only per-move figure slippi-js exposes — it undercounts non-move damage, which keeps the filter conservative. No move array (rare, but possible) falls back to whole-conversion judging rather than rejecting: clipping one loose combo is recoverable, clipping nothing for a whole night is not.
- The highlight reports whole-conversion `moveCount`/`damage`/`durationSec` (the panel and toast describe the *combo*) plus a `window: { moveCount, damage, durationSec }` when one applied. `clip-recorder.js` appends it to the `[clipper] Combo by …` line — that log is the operator's only feedback while tuning, and without it a too-tight window looks exactly like a broken OBS chain.

**Hard limit, upstream in slippi-js and not fixable here — singles only.** `ConversionComputer.setup` calls `getSinglesPlayerPermutationsFromSettings`, which returns `[]` unless `players.length === 2`, so `stats.conversions` is *permanently empty in doubles*. Crew battles are 1v1 per game and work fine. The control panel says so rather than leaving the operator waiting for clips that structurally cannot arrive.

**Settings** (`config.CLIPPER` defaults → `clipper-settings.json` overrides, all live-editable from the dock with no restart):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master toggle; off means no extra work per tick and no OBS socket |
| `obsUrl` / `obsPassword` | `ws://127.0.0.1:4455` / `""` | obs-websocket v5 |
| `autoStartBuffer` | `true` | Start OBS's replay buffer if it's idle |
| `minMoves` / `minDamage` | `4` / `30` | Hit-count and damage thresholds — over the whole conversion, or over `comboWindowSec` when it's set |
| `requireKill` | `true` | Only clip conversions that took a stock |
| `comboWindowSec` | `0` | `0` = judge the whole conversion; else the closing N seconds only |
| `maxComboDurationSec` | `0` | `0` = no cap on the conversion's total span |
| `cooldownSec` / `saveDelayMs` | `8` / `2500` | See rate limiting above |
| `maxClipsPerGame` | `0` | `0` = unlimited |
| `clipFolder` | `""` | OBS replay output folder (display + the OBS script) |
| `notifySidePanel` | `true` | Emit the overlay toast |

**OBS setup:** enable the replay buffer (Settings → Output → Replay Buffer, ≥20s); enable obs-websocket (Tools → WebSocket Server Settings) and put its address/password in the dock; press **Test clip now** to prove the chain before a bracket starts. For playback, add a **VLC Video Source** to the break scene and load `obs-scripts/auto_replays.py` (Tools → Scripts), pointing it at the replay folder and that source.

`auto_replays.py` is descended from Melee-Ghost-Streamer's script of the same name and keeps its behaviour, but is driven by `OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED` + `obs_frontend_get_last_replay()` instead of diffing a directory listing every second — instant, and it can't grab a file OBS is still writing. Folder polling remains as an opt-in fallback for clips from another source. It also handles `ffmpeg_source` (the original only ever built playlists for `vlc_source`) and releases every `obs_data` handle (the original leaked one per playlist entry). **Its interpreter is whatever OBS's Tools → Scripts → Python Settings points at** — check that tab before assuming a given Python version loads.

### Layout — `shared/`

`layout/shared/` holds the two helpers every custom layout needs. It is a **custom** folder, not
part of TSH: `layout/include/` is vendored and a TSH update overwrites it, whereas `layout/` is what
gets copied back across an update (see [docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md)). Every layout
is one level under `layout/`, so `../shared/x.js` resolves from all of them.

- **`tsh-assets.js`** — `charIconSrc(codename, skin, game?)` and `charIconFile(codename, skin)`.
  The one place `chara_2_{codename}_{skin}.png` is built. The scoreboard and bracket each used to
  hardcode it, including the `ssbm` game id.
- **`slippi-bridge-client.js`** — `connectBridge(handlers, { tag })`. Injects the bridge's
  `socket.io.js` once, polls up to ~3s for `io` to appear, connects, binds the handler map, and
  swallows `connect_error` so a layout keeps working on TSH data alone when the bridge is down.

Both are in `preflight.js`'s required-layout list — a TSH release zip that overwrites `layout/`
takes them with it, and their absence silently kills character icons and the bridge connection.

**The side panel does not use `charIconSrc` for crew portraits.** It reads TSH's own declared asset
path (`character["1"].assets["base_files/icon"].asset`), which is a different mechanism, not a third
copy of the same construction.

### Theme / design tokens — theme packs

The repo runs more than one tournament, so a theme is a **self-contained folder**, not a set of edits scattered across the layout tree:

```
layout/theme.css                  ← a SWITCH: one @import naming the active pack
layout/themes/hundred-acres/
  theme.css                       ← every token, the @font-face, the two logo urls
  logo.png                        ← tournament logo
  sponsor.png                     ← sponsor/venue logo
  fonts/Baby-Doll.ttf             ← the brand font, self-hosted
```

`main.css:1` `@import`s `theme.css`, which `@import`s the pack, and every layout links `main.css` — so all 16 TSH layouts inherit the active pack automatically.

- **Two different url-resolution rules apply inside a pack, and getting them confused is the trap.** A *normal* `url()` — the `@font-face src` — resolves against the file that declares it, so `./fonts/Baby-Doll.ttf` is correct. A `url()` inside a **custom property** does not: Chrome resolves it at substitution time, against the stylesheet that *uses* the `var()`. So `--logo-url` must be written relative to the consuming layout, hence `url("../themes/<pack>/logo.png")`. Writing `./logo.png` there silently 404s against `layout/side-panel/logo.png`. Every consumer sits exactly one level under `layout/`, so the one `../themes/<pack>/` prefix works from all of them.
- **Copying a pack means editing the pack name inside its own `theme.css`** (those two urls). `preflight.js` resolves both and fails if they don't point at real files, because a missing logo is otherwise invisible until it's on stream.
- **`--logo-filter` / `--sponsor-filter`** are prepended to each logo's filter chain so a pack can recolour artwork it didn't commission — a black-ink transparent PNG needs `invert(1)` to survive a dark overlay. They default to `none`. The side panel applies them via a per-element `--brand-filter`, so both logos keep the shared drop-shadow treatment.
- **Per-event branching.** A new event = a new pack folder plus a one-line change to `layout/theme.css`, on its own branch (`event/<slug>`). Master never touches either, so `git merge master` into an event branch stays conflict-free, and the binary `logo.png` never enters the merge path. Checking out a branch re-skins the broadcast — OBS reads the working tree, so just refresh the browser sources.
- **`layout/logo.png` and `layout/ThePark.png` still exist and are deliberately not deleted.** TSH's own `user_data/settings.json → main_icon_path` points at the former (gitignored, so a branch can't carry it), and five vendored overlays we don't broadcast reference it. Nothing in our four layouts reads them any more.
- **Brand imagery is CSS-only**, via `--logo-url` / `--sponsor-url`. `scoreboard/index.css` `.logo` uses `background-image: var(--logo-url)`; the side panel's `.logo-primary` / `.logo-sponsor` are **`<div>`s with a background-image**, not `<img>`s. That is deliberate: `getComputedStyle` returns a custom property's url *verbatim* (`url("../themes/…")`), so JS would have to redo the resolution CSS already does correctly. `side-panel.js` no longer has `LOGO_PATH` / `SPONSOR_PATH` — do not reintroduce them.
- **Link `main.css` only.** It `@import`s `theme.css`; adding a second `<link>` to `theme.css` just refetches the tokens and the BabyDoll TTF. Same for redeclaring `@font-face` or `--font` in a layout stylesheet — `bracket/index.css` used to, and its bare `--font: "BabyDoll"` silently dropped the Fredoka fallback.
- **`@import` must precede every other rule in a file.** The pre-pack `theme.css` put its `@font-face` above the Google Fonts `@import`, which made that `@import` invalid and silently dropped — Fredoka never actually loaded. The pack has the order right.
- **Font:** BabyDoll primary, Fredoka fallback (Google Fonts — a network request, so it fails on venue wifi; prefer self-hosting a TTF in the pack's `fonts/`). The BabyDoll `@font-face` lives in the pack so no layout repeats it. `--font` / `--score-font`. `layout/include/Baby-Doll.ttf` is still there for four vendored overlays that declare their own `@font-face` against it.
- **`preflight.js` verifies the pack** (`checkThemePack`): it parses the `@import` out of `theme.css` and requires `themes/<pack>/{theme.css,logo.png,sponsor.png}`. CSS fails silently, so without this an unstyled broadcast has no other alarm.
- **Colors:** `--bg-color` `#2a3d23` (deep forest green), `--score-bg-color` `#071820` (dark teal), `--text-color` `#f9d697` (warm gold), `--darkened-text` `#aa8e5b` (muted gold). Semantic: `--icon-bg-color`, `--win-color` `#29b548`, `--loss-color` `#ff3837`, `--p2-team-color` `#308aff`, `--set-score-color`, `--score-color`. RGB triplets for `rgba()`: `--bg-color-rgb`, `--bg-color-light-rgb`, `--text-color-rgb`, `--score-bg-color-rgb`.
- **`--score-bg-color` is three surfaces, not one** — the scoreboard's score boxes, the side panel's entire bottom card, and the bracket title bar. A pack that wants a loud score box would flood the other two, so the scoreboard reads `var(--score-box-bg, var(--score-bg-color))`: set the optional `--score-box-bg` to diverge, leave it unset to keep them together. Hundred Acres leaves it unset; Salty Suite sets it to its corner-post red.

### Layout — scoreboard (`melee.html` / `meleePlayers.html`)

- **Use `melee.html`** as the OBS browser source — there is no `index.html` in `scoreboard/`. It loads `../shared/slippi-bridge-client.js`, which pulls `socket.io.js` off the bridge and no-ops when the bridge is down. `meleePlayers.html` is a standalone player-name list (body class: `fgc thin meleePlayer`); it shares `index.js` but deliberately does **not** load the shared bridge client, which is why the `connectBridge` call is guarded.
- **`index.css`** contains only rules for `melee.html` / `meleePlayers.html`. Everything else — other game variants, flag country/state, `.icon`, `.tsh_character`, `.name_twitter`, `.extra`, skewed bg panels, `.sponsor_icon`, `.twitter_logo`, `.phase`, `.tournament_name`, and three never-applied `@font-face` blocks — has been removed. Active classes: `fgc`, `thin`, `meleePlayer`, and the core layout/character/score/chip selectors. The matching JS was deleted too: `index.js` no longer writes into markup that isn't there.
- **Visual treatment:** raised card depth (`box-shadow`) on all `.container` elements; gold accent line on `.info.container.bottom` and the `meleePlayers` center card only (not player containers); character icons float with a drop-shadow on the image (no box); score box flush to the container edge with breathing room from icons; `meleePlayers` logo repositioned above the center card (742px, 260×260).
- The layout implements TSH's `Start()` and `Update(event)` hooks (`layout/include/globals.js`). The Slippi-bridge integration lives at the bottom of `index.js`, via `SlippiBridge.connectBridge()`:
  - On `slippi_game_start`: stores game data. In singles, patches character `<img>` src after each `tsh_update` (TSH defaults to costume 0), using `TshAssets.charIconSrc`. In doubles, clears leftover character icons.
  - On `tsh_update` (DOM event, dispatched by TSH's `globals.js` whenever `program_state.json` changes): calls `applySlippiCostumes()` with a 150ms delay to let TSH finish rendering. Detects doubles from the DOM (`character_container.team-color`) rather than stale bridge data, so icons clear immediately when TSH switches singles→doubles.
  - In doubles, TSH injects a `div.text.text_empty` placeholder inside `.character_container` even after it's cleared — hidden via `.character_container.team-color .text.text_empty { display: none }`.

### Layout — `side-panel/`

`layout/side-panel/side-panel.html`, a 611×1080 browser source designed to sit beside the webcam.

- **Structure:** four positioned divs (`.bg-top/.bg-bottom/.bg-left/.bg-right`) fill the canvas with forest green; two floating rounded cards (`.header-card`, `.bottom-card`) sit on top with drop shadows + inner edge lighting. The cam cutout (587×330, true 16:9) is a transparent gap between them — the OBS cam source shows through. `.cam-overlay` rounds the cam corners via an outward green spread shadow (`box-shadow: 0 0 0 14px var(--bg-color)`).
- **Header card:** tournament name fetched from `../../out/tournamentInfo/tournamentName.txt` (polled every 5s) + the `Update()` hook. 32px BabyDoll, uppercase, wide letter-spacing.
- **Bottom card:** dark teal with a 5-orb CSS ambient animation (`@keyframes drift1-5`) plus grain/light/vignette layers. Hosts the rotating info-panel system. `?animate=false` disables the ambient animation.
- **Spotlights (opt-in, per pack).** Two beams rise from the bottom edge of `.bottom-card` and sway out↔in — fight-night flair for Salty Suite. The markup (`.spotlight-1/2`) and all the CSS live in the shared layout, but the rule is `display: var(--spotlight-display, none)`, so a pack that doesn't set the token renders nothing and runs no animation. Salty Suite sets `--spotlight-display`, `--spotlight-rgb` (a hotter gold than `--text-color-rgb`, which goes muddy through a screen blend on oxblood) and `--spotlight-strength` (scales all four gradient stops at once — the dial to reach for, not the gradient). **Three effects make the beam, and dropping any one puts a flat wedge on the broadcast:** `clip-path` shapes the cone, the background gradient fades it along its length, and a horizontal `mask-image` fades it *across* — the clip's straight sides otherwise survive the blur. The mask is written prefixed *and* unprefixed for OBS's CEF. `body.no-animate` freezes the sway but leaves the beams lit; they're part of the look, not just motion.
- **Rotating info panels** (each slot `PANEL_INTERVAL`, default 20s; GSAP stagger on entrance): `logo-primary`, `player-1`, `player-2`, `recent-sets`, `logo-sponsor`, `completed-sets`, `queue`, plus `crew-team-1` / `crew-team-2` in crew battles. Every content item is a `.panel-pill`. Player cards show placement history + current-run results; Recent Sets shows a head-to-head record; Completed Sets shows recently-finished sets; Queue shows the stream queue.
- **Skip logic:** `hasPlayerCardContent()` requires actual history/run data (not just a name); logos always show; `completedSets` excludes null-score sets, capped at 8. **Doubles** suppresses `player-1`, `player-2`, `recent-sets`. **Crew** suppresses `player-1`, `player-2`, `recent-sets`, `completed-sets`.
- **Rotation safety:** `Rotator._tl` stores the active GSAP timeline and `_transitionTo()` kills it before starting a new one (prevents stale `onComplete` callbacks spawning duplicate timer chains). `_advance()` calls `clearTimeout` defensively.
- **`buildSlots()` restarts only when the *visible* panel leaves the slot list** — never on a slot-list change alone. Loading a set is not one TSH state push but six or more: `ChangeSetData` clears the names, then `last_sets.1`, `history_sets.1`, `last_sets.2`, `history_sets.2` and `recent_sets` each land as a separate async provider reply, and each is its own `StateManager` write, so each dispatches its own `tsh_update`. Every push that flips a slot predicate changes the list. `restart()` rotates from the top and slot 0 is *always* `logo-primary` (first in `PANEL_ORDER`, predicate `return true`), so restarting per change flashed the logo 3–5× on every set load and 2× on every Swap Teams. When the visible panel survives the rebuild, `_index` is re-aimed at whatever now follows it and the running timer is left alone; only a panel that has genuinely dropped out triggers the restart (which is what stops it being stranded on screen — panels are absolutely stacked and only opacity separates them). Both halves are pinned by `tests/side-panel-rotation.test.js` — run it after touching `Rotator`.
- **Clip-saved toast** (`.clip-toast`): a pill that slides in over the **bottom edge** of `.bottom-card` when the bridge emits `slippi_clip_saved`, holds ~3.2s, and slides back out. At rest it sits at `translateY(160%)` and is hidden by the card's `overflow: hidden`. Absolutely positioned so it never disturbs the rotating panels. Toasts are **queued, not concurrent** — restarting the tween on a visible pill reads as a flicker on stream — and the queue keeps only the newest clip, since a backlog of stale pills is worse than a gap. Only *successful* saves reach the overlay; clip errors go to the operator's control panel (`slippi_clip_error`), never the broadcast.
- **Config constants** at the top of `side-panel.js`: `PANEL_INTERVAL`, `LOGO_PATH`, `SPONSOR_PATH`, `SCOREBOARD_NUM`, the `ANIM_*` GSAP timing values, and `DEBUG_PANEL` (set `null` in production; otherwise locks rotation to one panel).

### Layout — `bracket/`

Four HTML variants sharing one `index.css` / `index.js`: `index.html` (default), `index_expanded.html`, `losers_only.html`, `winners_only.html`. All four have identical title markup and differ only in a `<body class>` and one `window.*` flag. They are kept as four files on purpose — collapsing them into one `?mode=` page would change URLs already configured as OBS browser sources.

- Each player row emits only `.name_twitter > .name`, `.char_icon` and `.score` (`buildSlotHtml()`). The avatar / sponsor / flag / `character_container` divs it used to emit were never populated.

- **Title bar** (`--title-size: 68px`): `width: fit-content; min-width: 560px; margin: 0 auto` — centered, shrinks to content. Dark teal (`--score-bg-color`) base with atmospheric layers (`.title-atm` grain/light/vignette) and three ambient green orbs (`torb1-3` keyframes) matching the side-panel bottom-card aesthetic. Graduated gold accent line via `.container::after`.
- **Player rows:** each `.player.container` includes a `.char_icon` div populated by `index.js` with the character icon PNG (`chara_2_{codename}_{skin}.png`) for singles; cleared for doubles. `index.js` adds `.winner`/`.loser` classes to completed slots (CSS brightness).
- **Containers:** `padding-bottom: 20px` on `.winners_container`, `30px` on `.losers_container` to keep slots off the screen edge.

### Layout — `highlights/`

`layout/highlights/highlights.html`, a 1920×1080 browser source for the **replay / break scene** — the one where `obs-scripts/auto_replays.py` plays back the combo clipper's saved clips. It frames the clip window and the two player cams and titles the scene.

**It is decoration only, and that is a decision rather than an omission.** Nothing in the system knows which clip VLC is currently playing: `auto_replays.py` has no network output at all, and the bridge subscribes to no OBS media events. Any on-screen combo credit would therefore be wrong as often as right, so the layout reads no TSH state and no bridge events. It has no runtime failure modes.

- **`../include/globals.js` is deliberately not loaded**, nor are the two `shared/` scripts — with no `Start()` / `Update()` to implement, `LoadEverything()` would pull jQuery, GSAP, lodash, kuroshiro and socket.io for nothing. **Consequence: never copy `opacity: 0` from `scoreboard/index.css` onto this body.** That rule relies on `globals.js`'s `UpdateWrapper` calling `$("body").fadeTo(...)` on TSH's first state push; with no globals.js nothing fades it back in and the overlay is permanently invisible — a failure that only surfaces on stream.
- **`border` is the plate.** Each of the three frames is *one* div sized to the plate rect with `box-sizing: border-box`, so its padding box lands exactly on the window and the OBS source below shows through. A child div cannot punch a hole in its parent's background, and `mask-composite` is not safe to rely on in OBS's CEF; `border` gives the ring, the transparent centre, the outer radius **and** a derived inner radius that rounds the footage, with no feature detection. This is *not* the side panel's four-band + `.cam-overlay` spread-shadow approach — that exists because the side panel also has to fill the rest of its canvas opaquely. Radius is `calc(pad + var(--border-radius))` so the ring stays uniform and the footage corners land on exactly the theme radius.
- **Geometry is nine `:root` variables and they must equal the OBS source transforms** — a mismatch is the one visible failure this layout has, and it shows up as a gap of background between plate and footage. Defaults match the replay scene: clip `480,140 960×800`; cams `0,288` and `1520,288`, each `400×504`. Both cam centres and the clip centre sit at y=540; keep that when retuning.
- **Alignment is settable from the browser source URL** so a retune is not a CSS edit: `?clip=x,y,w,h`, `?cam=y,w,h`, `?camx=leftX,rightX`, `?pad=clipPad,camPad`. Numbers are plain pixels in 1920×1080 space, copied out of OBS's Edit Transform. Blank components are skipped rather than zeroed (`?clip=,,960` sets width alone). The two cams deliberately **share** `--cam-y/-w/-h` — only their x is independent — because the row only reads level while their centres sit on the clip's line.
- **The cams run flush to the canvas edges, and the plates bleed off rather than pretend otherwise.** `highlights.js` measures each frame's padding box and adds `bleed-l/r/t/b` when it reaches a canvas edge; the CSS squares the corners on that side. Squaring is the whole fix — the border stays declared, so the hole stays on the source rect. **Zeroing the border width instead would slide the hole over by `--pad`**, which is the bug this prevents. Moving the two OBS sources inboard and passing `?camx=40,1480` restores fully floating cam cards.
- **The cams join the clip frame by growing their inner border, not with a bridge div.** `--join-l` / `--join-r` derive the gap from the geometry (`max(0px, …)`, so cams pushed past the clip collapse the join instead of inverting the border), and `.cam-l` / `.cam-r` add it to *both* the border width and the element width — which leaves the padding box, and therefore the hole, exactly where it was. A separate bridge element would mean a second silhouette to keep aligned, a second drop shadow, and a seam of background wherever the two disagreed. Both inner corners square off; a radius there notches the join. Because those borders are now asymmetric, `highlights.js` reads **each side's** border width — assuming the top width would report the cams' rect ~56px off.
- **`?guides=1`** outlines each frame's transparent hole and labels it with its *measured* rect — `getBoundingClientRect()` minus the border width, not a read-back of the CSS variables, so a bad `calc()` (or a mistyped override) shows up there instead of on stream. That is the alignment tool; check it against OBS before a bracket.
- **`?animate=false`** freezes the title orbs and the sheen sweep, same convention as the side panel.
- **The scrim is four edge bands, not a full-canvas wash.** A browser source paints over every OBS source beneath it regardless of z-index, so a full-canvas scrim would tint the footage. Each band stops at the nearest window edge and fades inward; `--scrim-strength` scales all four, `0` turns them off. The side bands are `max(0px, …)` — with the cams flush to the canvas they collapse to nothing, and a negative width would be an invalid declaration that silently falls back to auto sizing.
- **`--title-gap` must stay non-zero.** The title plate and the frames share `--score-bg-color`, so at zero they fuse into one shape and the plate stops reading as a separate card. `--title-y` derives from the clip geometry, so the plate tracks the clip frame automatically.
- The **sheen sweep** across the word is gated behind `@supports (background-clip: text)`: the failure mode of an unsupported `background-clip` is `color: transparent` over a painted rect — i.e. the word disappears behind a bar. The solid gold text underneath is what actually reads; the sheen only ever adds.
- Verified against both theme packs. Nothing hardcodes a pack colour.

### Character Map — `slippi-bridge/lib/char_map.js`

Maps Slippi character IDs (0–25) to TSH codenames and display names. Icon files:
```
TournamentStreamHelper-5.972/user_data/games/ssbm/base_files/icon/chara_2_{codename}_{costume:02d}.png
```
Costume index comes from `player.characterColor` in `getSettings()`.

---

## Reading the Live Game

The bridge polls `SLP_FOLDER` every 500ms, using a `knownFiles` Set to ignore pre-existing files. `fs.watch` is intentionally **not** used — it misses new files on Windows/OneDrive paths.

There used to be a second path (`CONNECTION_MODE: "tcp"`, connecting to the Wii's LAN IP via `@vinceau/slp-realtime`). It was removed along with that dependency: it was unused, and having no `SlippiGame` object meant it silently couldn't support handwarmer detection or the combo clipper. Reading the live `.slp` is now the only path, so there is no `CONNECTION_MODE` and no mode-specific branching anywhere.

---

## Known Gotchas

- `fs.watch` is intentionally not used (misses new files on Windows/OneDrive) — always poll.
- TSH's "Swap Teams" button swaps names AND scores. The bridge now polls `/scoreboard{N}-get-swap` every 2s and re-derives immediately; name-based detection on the next game start remains the fallback.
- `uiohook-napi` provides the global `Ctrl+Shift+S` hotkey; if it fails to load, the fallback is pressing `S` in the terminal.
- The `tsh_update` DOM event fires whenever `program_state.json` changes; the layout listens to it to time its costume patch.
- `config.js` is git-tracked — never put secrets there. The start.gg token goes in the gitignored `config.local.js`.
- **Re-sending the loaded url to `/set-tournament` is a silent no-op** — `SetTournamentSignal` early-returns when `provider.url` matches, and the route still answers `"OK"`. Send the same **scheme-less** form TSH stores (`start.gg/tournament/<t>/event/<e>`) so that comparison stays predictable, and use `/update-bracket` when a real re-pull is what's wanted. The url must also be a full `.../tournament/<t>/event/<e>`: TSH's provider does `url.split("start.gg/")[1]` at ~11 query sites, so anything trailing the event slug corrupts every bracket request afterwards.
- **Never *write* `user_data/settings.json` from the bridge.** TSH's `SettingsManager` owns it, rewrites the whole file on every `Set()`, and never re-reads it at runtime — a bridge-side write would be both ineffective and clobbered. *Reading* `TOURNAMENT_URL` is fine and is how the no-op above is detected (`tsh.readTournamentUrl()`).
- **start.gg's GraphQL API cannot resolve a short link** — `tournament(slug: "100-acres")` returns `null`. Following the web redirect is the only path. The link is also **hyphenated**: `start.gg/100acres` is a hard 404 with no redirect at all.
- **Switching the tournament does not clear the scoreboard.** TSH wires `tournament_changed` only to `UpdateUserSetButton` / `UpdateBottomButtons`, so the loaded set's names, scores and `set_id` survive — which is what makes the bracket buttons safe without a confirm, and means a pending report still targets the right set.
- **`/update-bracket` 500s when no tournament is loaded** — `update_bracket()` dereferences its provider with no null check. Only call it once something is loaded.
- TSH's `/get-match` does **not** expose start.gg entrant ids; `startgg-client.js` queries start.gg directly for them when reporting.
- **TSH's default web server port changed from 5000 (5.967) to 5500 (5.972)** — `TSHWebServer.py` reads `SettingsManager.Get("general.webserver_port", 5500)`. This repo pins it back to **5000** via `user_data/settings.json → general.webserver_port`, because every OBS browser source and `config.TSH_URL` references 5000. A fresh `settings.json` omits the key and silently lands on 5500, which looks exactly like "TSH won't start" — `scripts/start-all.js` just times out waiting on 5000. Check the listening port before debugging anything else.
- Never hardcode the TSH folder name — it carries the version (`TournamentStreamHelper-5.972`) and changes on every update. Use `resolveTshRoot()` / `resolveOrExit()` from `lib/tsh-root.js`.
- `.gitignore` uses the version-independent glob `TournamentStreamHelper-*/*` with a `!TournamentStreamHelper-*/layout/` negation. Pinning an exact version there means the next TSH update silently untracks nothing and starts tracking ~4000 vendored files.
- A fresh TSH extract ships **empty stub** config, not missing files — `local_players.json` is `{}` and `settings.json` has no `TOURNAMENT_URL`. After updating, copy `user_data/games/`, `local_players.json`, `settings.json`, and `pronouns_list.txt` from the previous install.
- `stats.conversions` is **empty in doubles** — slippi-js only computes conversions for 2-player games. Nothing in this repo can work around it; the combo clipper is singles + crew only.
- A slippi-js conversion's `playerIndex` is the player who **got hit**. The attacker is `lastHitBy`.
- The folder-mode parser is now **persistent per file**. Anything added to that poll loop must tolerate a live file, and must not assume a fresh parse each tick — see the poisoned-parser guard in [Combo Clipper](#combo-clipper--obs-replay-buffer).
- `clipper-settings.json` is gitignored and written by the control panel. Don't add clipper tunables to `config.js` expecting them to be authoritative — `config.CLIPPER` is only the default layer.
- **`config.local.js` and `clipper-settings.json` stay at the `slippi-bridge/` root**, even though the code that reads them lives in `lib/`. `.gitignore` pins those exact paths, and moving either one would start tracking the start.gg token or the OBS password. `lib/clipper-settings.js` reaches up a level on purpose.
- **`scripts/` is one level deeper than the bridge root.** `preflight.js` and `start-all.js` resolve the repo root at `../..` and the bridge dir at `..`; `start-all.js` spawns `index.js` with `cwd: BRIDGE_DIR`, not `__dirname`. All three are silent failures — the spawn one only shows up when launching via `start-all.bat`.
- **`preflight.js` has two lazy `require`s** (`../lib/tsh-root`, `../lib/clipper-settings`) that only run inside their check functions, and `lib/hotkey.js` requires `uiohook-napi` inside a `try` whose `catch` degrades silently. A broken path in any of them produces no startup error — run `node scripts/preflight.js` (not just `--offline`) and confirm the hotkey after touching them.
- The control panel's `render()` has **no try/catch**, so a `$("id")` that returns null throws and freezes the whole dock on the next 2s tick. The clipper form is generated from the single `CLIP_FIELDS` spec specifically so its ids can't drift from the JS that reads them.
- `layout/scoreboard/index.js` is shared by `melee.html` **and** `meleePlayers.html`, and only the former loads `shared/slippi-bridge-client.js` — hence the `typeof SlippiBridge !== "undefined"` guard. Anything else added to that file must tolerate the shared scripts being absent.
