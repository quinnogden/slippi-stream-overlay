# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A custom streaming overlay for Melee tournaments that bridges live Slippi game data into [Tournament Stream Helper (TSH)](https://github.com/nicholasgasior/TournamentStreamHelper). Two coupled parts:

1. **`slippi-bridge/`** — a Node.js backend that reads live `.slp` files, drives TSH via its HTTP API, emits Socket.io events to the OBS browser sources, and serves an operator control panel.
2. **`TournamentStreamHelper-5.972/layout/`** — customized TSH layouts (scoreboard, side panel, bracket) that consume both TSH state and slippi-bridge events.

TSH itself (`TournamentStreamHelper-5.972/`) is a third-party Python app run as a local web server on port 5000. **Only edit files under `layout/`** — everything else in that folder is vendored and can be read for reference but not modified.

---

## Running the Bridge

```bash
cd slippi-bridge
npm install       # first time only
node index.js
```

Launch options:
- **`start-bridge.bat`** — starts just the bridge (TSH must already be running). Uses `%~dp0` so it works regardless of clone location.
- **`start-all.bat` → `start-all.js`** — one-shot launcher: starts TSH (`TSH.exe`, falling back to `TSH_bat.bat`), polls `TSH_URL` until its HTTP API responds (60s timeout with a friendly failure message), then spawns the bridge with inherited stdio. Does **not** launch OBS and does **not** kill TSH on exit.

Config is in [slippi-bridge/config.js](slippi-bridge/config.js):
- `CONNECTION_MODE`: `"folder"` (watch a folder for `.slp` files) or `"tcp"` (connect directly to Wii)
- `SLP_FOLDER`: path to the Slippi Spectate folder (folder mode)
- `CONSOLE_IP` / `CONSOLE_PORT`: Wii LAN address (TCP mode)
- `TSH_URL`: TSH web server, default `http://localhost:5000`
- `SCOREBOARD_NUM`: TSH scoreboard to control (default `1`)
- `TSH_ROOT`: absolute path to the TSH install. Default `null` = auto-detect (see below).
- `BRIDGE_PORT`: Socket.io + control-panel port (default `5001`)
- `STARTGG_TOKEN`: start.gg personal access token for result reporting. **Never put the real value in config.js (git-tracked).** Set it in `slippi-bridge/config.local.js` (gitignored, copied from `config.local.example.js`); `config.js` merges it over itself at load via `Object.assign` in a try/catch. Missing token → reporting disables itself, the rest of the bridge runs normally.

**Locating TSH (`slippi-bridge/tsh-root.js`):** TSH ships as a versioned folder, so the path is resolved at startup rather than hardcoded — `resolveTshRoot(baseDir, override)` scans the repo root for `TournamentStreamHelper*` directories, keeps only those that look like a real install (a `layout/` subfolder **plus** one of `TSH.exe` / `TSH_bat.bat` / `main.py`), and picks the highest version by **numeric** component-wise comparison (so `5.1001` > `5.972` > `5.99`). `config.TSH_ROOT` short-circuits the scan. Both `index.js` and `start-all.js` call it and log the resolved root; failure exits with an actionable message. **Updating TSH is therefore: extract the new folder, copy `layout/` back, copy `user_data/` across — no code edits.**

**Keyboard shortcut:** `Ctrl+Shift+S` (global, via `uiohook-napi`) manually swaps the port→team assignment. Falls back to pressing `S` in the terminal if `uiohook-napi` fails to load.

**Operator control panel:** `http://localhost:5001/control`, served by the bridge from `slippi-bridge/public/control-panel.html`. Intended as an OBS Custom Browser Dock — an internal operator tool, not part of the broadcast. See [Control Panel](#control-panel--startgg-reporting).

---

## Architecture

### Data Flow

```
Slippi console / .slp file
        ↓
slippi-bridge/index.js   (Node.js, port 5001)
  ├─ reads live game file via @slippi/slippi-js (folder mode)
  │   or @vinceau/slp-realtime (TCP mode)
  ├─ pushes character+costume → TSH HTTP API  (POST /scoreboard1-update-team-N-1)
  ├─ pushes score increments  → TSH HTTP API  (GET /scoreboard1-teamN-scoreup)
  ├─ emits Socket.io events   → layout browser sources
  └─ serves /control + /api/* → operator control panel (OBS dock)
        ↓
TournamentStreamHelper-5.972/  (Python app, port 5000)
  ├─ out/program_state.json    (live state — read by bridge and layouts)
  └─ layout/                   (OBS browser sources: scoreboard, side-panel, bracket)
```

### slippi-bridge modules

- **`index.js`** — entry point; wires everything together. Owns `currentGameState` and `crewBattleState`, routes game-start/end to the singles/doubles/crew handlers, runs the keyboard listener, serves the control panel + `/api/*` routes, and runs a 2s `setInterval` that rebuilds `lastControlStatus` and emits `control_status` over Socket.io.
- **`port-mapper.js`** — `PortMapper` class. Owns all port→team tracking state (`_portToTeam`, `_portToName`, `_portScore`). Never reads files or makes HTTP calls — all data is passed in. `getResolutionInfo()` reports the current mapping plus which heuristic set it (`_resolutionMethod`: name / score / character / positional / manual).
- **`tsh-client.js`** — `TshClient` class; all I/O with TSH. Reads `program_state.json` (`readState()` + pure accessors), calls the TSH HTTP API, and returns typed `{ ok, error?, data? }` results. Includes bracket-action fronts (`pullStreamSet`, `getOpenSets`, `loadSet`, `getCurrentSet`), state accessors (`getSetId`, `getLiveScores`), crew helpers (`isCrewBattle`, `getActivePlayerName`), and a `ping()` health probe.
- **`startgg-client.js`** — `StartggClient` class. The **only** module that talks to an external service (start.gg's official GraphQL API, `https://api.start.gg/gql/alpha`). `reportSet()` runs the `reportBracketSet` mutation; `getSetEntrants()` fetches per-team entrant ids (TSH's `/get-match` does *not* expose them). `enabled` is false when no token is configured. All bracket *reading* still goes through TSH's native integration, not this module.
- **`game-source.js`** — `createFolderSource` / `createTcpSource`. Returns a Node `EventEmitter` firing `game-start` (`rawPlayers, stageId`) and `game-end` (`{ winnerPlayerIndex, isHandwarmer, winnerEndStocks }`). Also exposes `getStatus()` (`{ mode, connected, detail }`) for the control-panel health dot. `index.js` binds to these and never calls mode-specific code directly.
- **`char_map.js`** — `resolveCharacter(charId, costume, tshRoot)` and `resolveStage(stageId)`. Pure mapping, no I/O. `STAGE_MAP` covers all 30 Slippi stage ids TSH ships an icon for; unmapped ids (target-test stages 33+) return `null`.
- **`port-guard.js`** — `reclaimPort(port, log)`. Called from the `httpServer` `EADDRINUSE` handler so a stale bridge holding `BRIDGE_PORT` is stopped automatically instead of sending the operator to `netstat`/`taskkill` mid-event. See [Port Reclaim](#port-reclaim).
- **`tsh-root.js`** — `resolveTshRoot(baseDir, override)`. Finds the versioned TSH install folder so no path hardcodes a version. Only filesystem probing, no config or network. Used by `index.js` and `start-all.js`.
- **`handwarmer.js`** — `wasHandwarmer(game)`. Weighted heuristic over a slippi-js game object; see [Handwarmer Detection](#handwarmer-detection).

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

- `game-source.js` emits `game-start` as `(rawPlayers, stageId)`; both folder and TCP modes supply `settings.stageId` (`null` when unavailable).
- `onGameStart` calls `reportStage(stageId)` → `resolveStage()` → `tsh.setCurrentStage(codename)`.
- **Best-effort by design:** unmapped stage ids log a warning and skip; the HTTP call is fire-and-forget with `.catch(() => {})`. Stage reporting is cosmetic and must never block scoring.
- **Skipped in crew battles** — they don't use the game tracker, so there is no game slot to stamp.
- Per-game *characters* need no bridge work: TSH's `_CopySetLevelCharactersToGame` copies the set-level selection (already pushed via `update-team`) into the game slot automatically.

Codenames are the basenames of `user_data/games/ssbm/stage_icon/*.png`. Watch the spellings that don't match the Slippi enum: `HYRULE_TEMPLE`→`temple`, `POKE_FLOATS`→`pokefloats`, `DREAMLAND`→`dream_land`, `KONGO_JUNGLE_N64`→`kong_jungle_64` (**"kong"**, not "kongo"). `ICETOP` (26) maps to `icicle_mountain` — TSH ships no separate asset.

### Port Reclaim

`EADDRINUSE` on `BRIDGE_PORT` is the normal restart case (closed console, crashed `start-all`, editor still running the old copy), not an operator error, so the new process takes the port back itself — `port-guard.js`.

- **Identity gate.** It only kills a process that answers `GET /api/identity` with `{ app: "slippi-bridge", pid }`. That response supplies the pid directly, so no `netstat` parsing in the normal path. Killing an unrelated program that happened to pick 5001 would be far worse than refusing to start, so an unidentified occupant is reported and left running.
- **Legacy fallback.** A bridge from before `/api/identity` existed still answers `/api/status` with a shape (`tsh` + `portMapping` keys) nothing else serves; that identifies it, and the pid then comes from `netstat -ano` (`lsof -t` off Windows). One-time path — remove it whenever pre-identity builds stop being in play.
- **Retry is bind-driven.** Windows releases a killed process's socket asynchronously, so `waitForPortFree()` polls by actually binding a throwaway server rather than sleeping a fixed delay.
- `portReclaimTried` allows exactly one attempt — a second `EADDRINUSE` exits.
- The `Socket.io server listening` log is a `httpServer.once("listening")` handler, **not** a `listen()` callback: a `listen()` that fails with `EADDRINUSE` leaves its one-shot callback attached, so the retry fires both and logs twice.

### TSH-Side Swap Detection

`GET /scoreboard<N>-get-swap` returns TSH's own `teamsSwapped` flag as the Python string `"True"`/`"False"` (**not** JSON). Polled in the existing 2s `refreshControlStatus` loop.

- `tshSwapState` starts `null` so the first poll only seeds a baseline — no phantom swap on startup.
- On a change, `handleTshSwap(state)` re-runs `portMapper.resolve()` against fresh TSH names, updates `teamNum` on the live players, and re-emits `slippi_game_start`. Previously an operator-side swap was only noticed on the *next* game start via name re-derivation.
- The bridge's own `swapTeams()` never calls TSH's swap endpoint (it only flips the internal map), so any change in this flag is unambiguously operator-initiated — no origin bookkeeping needed.
- Exposed as `tshSwapped` on `control_status` / `/api/status` and rendered in the control panel. `getSwapState()` deliberately does not log failures — it is polled every 2s and would flood the console while TSH restarts.

`PortMapper` remains the scoring authority; this only *detects divergence* rather than delegating the mapping to a single boolean.

### Handwarmer Detection

`slippi-bridge/handwarmer.js` scores each game to detect practice/warm-up games. Weighted score ≥ 2 = handwarmer: each player's `totalDamage < 150` (+1/−1), LRAS end method 7 (+1/−1), both players have > 1 stock in the last frame (+2), duration < 60s (+1). Guard: if `stats.overall` is empty/missing, returns `false` (prevents vacuous-truth false positives).

- **Score-only suppression:** on a handwarmer, `slippi_game_start` still fires (characters update) but the score increment is skipped.
- **Rage-quit handling:** LRAS + not a handwarmer + valid `lrasInitiatorIndex` → awards the point to the other player. In doubles, the point goes to someone on the *other* team by `teamId`, not the quitter's partner.
- Folder mode only; TCP mode always passes `isHandwarmer: false`.
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
GET  /scoreboard1-get-swap                → TSH's own teamsSwapped flag; returns "True"/"False" as text
GET  /scoreboard1-pull-stream             → pull the next queued stream set onto the scoreboard
GET  /get-sets[?getFinished=1]            → list open (or finished) sets from the bracket provider
GET  /scoreboard1-load-set?set=<id>       → load a specific set by id
GET  /scoreboard1-get-set                 → id of the currently-selected set
```

TSH ships a **complete native start.gg integration** (`src/TournamentDataProvider/StartGGDataProvider.py`) driven by `user_data/settings.json → TOURNAMENT_URL`. It fetches brackets/queue/sets and writes them into `program_state.json` (`score.<N>.set_id`, `bracket.*`, `streamQueue`, `completed_sets`, `recent_sets`, etc.). The bridge *reads* all of that through TSH; it never re-implements bracket fetching. TSH has **no** result-reporting capability — that is the only thing `startgg-client.js` adds.

### Control Panel + start.gg reporting

The bridge serves these on its own Express app (port 5001). Browser JS is normally same-origin with the bridge, and the bridge makes all TSH/start.gg calls server-side, so there is no browser-CORS surface against TSH. A permissive CORS middleware sits in front of the routes anyway: an OBS dock pointed at `public/control-panel.html` as a *file* runs on a `file://` origin, where the panel's `API_BASE` falls back to `http://localhost:5001` and needs CORS to reach `/api/*`.

```
GET  /control            → the operator panel HTML (public/control-panel.html)
GET  /api/identity       → { app: "slippi-bridge", pid } — how a starting bridge recognises a stale one (see Port Reclaim)
GET  /api/status         → { tsh, slippi, slippiDetail, portMapping, tshSwapped, currentSet, startggEnabled }
POST /api/swap           → same as Ctrl+Shift+S (calls swapTeams())
POST /api/pull-stream    → tsh.pullStreamSet()
GET  /api/sets[?finished=1] → tsh.getOpenSets(includeFinished)
POST /api/load-set       → tsh.loadSet(body.setId), then refreshControlStatus()
POST /api/report         → reportCurrentSet() (start.gg reportBracketSet)
```
`control_status` is also pushed over Socket.io every 2s and on connect. The panel shows TSH/Slippi health, the current set + report button, the upcoming-sets picker, and the port→team guess with the heuristic that decided it (a positional guess is flagged as low-confidence) plus TSH's own swap state (`tshSwapped`) and a swap button. It is responsive — one column in an OBS dock, two columns from 760px — so it also works from a phone or tablet at `http://<lan-ip>:5001/control`. `lanControlUrls()` prints those addresses at startup (Tailscale `100.64/10` first, since it survives a venue network change and guest-Wi-Fi client isolation; Hyper-V switches and disconnected `169.254` adapters are filtered out) so the operator never has to run `ipconfig` at a venue.

**Upcoming-sets picker.** The panel is meant to be the only page open during a set, so it renders TSH's bracket data itself rather than sending the TO to `:5000/scoreboard` (a compiled React SPA in the vendored, gitignored `stage_strike_app/build/` — not extensible from this repo). Per-player editing (names, pronouns, country, skins) is deliberately *not* reimplemented; that still happens in TSH.

- Fields consumed from `/get-sets`: `id`, `round_name`, `tournament_phase`, `p1_name`/`p2_name`, `p1_seed`/`p2_seed`, `team1score`/`team2score`, `station`, `stream`. Seeds, station, stream and score render only when populated.
- **One tap loads a set.** The only guard is an inline confirm when the currently-loaded set has a non-zero score, since that is the one case where loading discards operator work. The loaded set is matched on `String(set.id) === String(currentSet.setId)` — TSH reports `set_id` as a string but `/get-sets` uses numbers — and is marked `ON AIR` and made unclickable.
- **Refresh is deliberately slow.** TSH's `get_sets` calls `provider.GetMatches()`, an uncached paginated GraphQL query against start.gg on every call. The panel refreshes on open, on the manual `↻`, after a successful load/pull/report, and on a 90s timer that pauses while `document.visibilityState !== "visible"`. Do not turn this into a fast poll.
- An **empty list is normal** — `get_sets` returns start.gg states 1/6/2 (not started, called, in progress), so a finished bracket legitimately returns 0. The empty state says so and points at the `show finished` toggle (`?finished=1`, which adds state 3); that is distinct from the fetch-failed state.

**Reporting flow (`reportCurrentSet` in index.js):** reads `score.<N>.set_id` + live scores from TSH → refuses if crew / no set_id / `preview` set / tied score → derives the winner team from the higher live score → `startgg.getSetEntrants(setId)` maps team → entrant id (slot 0 = team 1) → `startgg.reportSet(setId, winnerEntrantId, gameData)`. Per-game `gameData` is accumulated in `currentSetGames` (one `{ gameNum, winnerTeam }` per singles/doubles game end; reset in `syncSetTracking()` when `set_id` changes) and is optional — a mismatch falls back to reporting set winner + score only. Manual trigger only; the panel two-step-confirms before POSTing. Singles + doubles; crew battles are excluded.

### Theme / design tokens

`layout/theme.css` is the single source of truth for colors and fonts. `main.css` `@import`s it, so all 16 TSH layouts inherit the tokens automatically.

- **Font:** BabyDoll primary, Fredoka fallback (loaded from Google Fonts). The BabyDoll `@font-face` lives in `theme.css` so no layout repeats it. `--font` / `--score-font`.
- **Colors:** `--bg-color` `#2a3d23` (deep forest green), `--score-bg-color` `#071820` (dark teal), `--text-color` `#f9d697` (warm gold), `--darkened-text` `#aa8e5b` (muted gold). Semantic: `--icon-bg-color`, `--win-color` `#29b548`, `--loss-color` `#ff3837`, `--p2-team-color` `#308aff`, `--set-score-color`, `--score-color`. RGB triplets for `rgba()`: `--bg-color-rgb`, `--bg-color-light-rgb`, `--text-color-rgb`, `--score-bg-color-rgb`.

### Layout — scoreboard (`melee.html` / `meleePlayers.html`)

- **Use `melee.html`** as the OBS browser source (not `index.html`). It conditionally loads `socket.io.js` from the bridge. `meleePlayers.html` is a standalone player-name list (body class: `fgc thin meleePlayer`).
- **`index.css`** contains only rules for `melee.html` / `meleePlayers.html`. All other game-variant styles and unused features (flag country/state, `.icon`, `.tsh_character`, `.name_twitter`, `.extra`, skewed bg panels) were removed in a cleanup pass. Active classes: `fgc`, `thin`, `meleePlayer`, and the core layout/character/score/chip selectors.
- **Visual treatment:** raised card depth (`box-shadow`) on all `.container` elements; gold accent line on `.info.container.bottom` and the `meleePlayers` center card only (not player containers); character icons float with a drop-shadow on the image (no box); score box flush to the container edge with breathing room from icons; `meleePlayers` logo repositioned above the center card (742px, 260×260).
- The layout implements TSH's `Start()` and `Update(event)` hooks (`layout/include/globals.js`). The Slippi-bridge integration lives at the bottom of `index.js` in `initSlippiBridge()`:
  - Connects to `http://localhost:5001` via Socket.io.
  - On `slippi_game_start`: stores game data. In singles, patches character `<img>` src after each `tsh_update` (TSH defaults to costume 0). In doubles, clears leftover character icons.
  - On `tsh_update` (DOM event, dispatched by TSH's `globals.js` whenever `program_state.json` changes): calls `applySlippiCostumes()` with a 150ms delay to let TSH finish rendering. Detects doubles from the DOM (`character_container.team-color`) rather than stale bridge data, so icons clear immediately when TSH switches singles→doubles.
  - In doubles, TSH injects a `div.text.text_empty` placeholder inside `.character_container` even after it's cleared — hidden via `.character_container.team-color .text.text_empty { display: none }`.

### Layout — `side-panel/`

`layout/side-panel/side-panel.html`, a 611×1080 browser source designed to sit beside the webcam.

- **Structure:** four positioned divs (`.bg-top/.bg-bottom/.bg-left/.bg-right`) fill the canvas with forest green; two floating rounded cards (`.header-card`, `.bottom-card`) sit on top with drop shadows + inner edge lighting. The cam cutout (587×330, true 16:9) is a transparent gap between them — the OBS cam source shows through. `.cam-overlay` rounds the cam corners via an outward green spread shadow (`box-shadow: 0 0 0 14px var(--bg-color)`).
- **Header card:** tournament name fetched from `../../out/tournamentInfo/tournamentName.txt` (polled every 5s) + the `Update()` hook. 32px BabyDoll, uppercase, wide letter-spacing.
- **Bottom card:** dark teal with a 5-orb CSS ambient animation (`@keyframes drift1-5`) plus grain/light/vignette layers. Hosts the rotating info-panel system. `?animate=false` disables the ambient animation.
- **Rotating info panels** (each slot `PANEL_INTERVAL`, default 20s; GSAP stagger on entrance): `logo-primary`, `player-1`, `player-2`, `recent-sets`, `logo-sponsor`, `completed-sets`, `queue`. Every content item is a `.panel-pill`. Player cards show placement history + current-run results; Recent Sets shows a head-to-head record; Completed Sets shows recently-finished sets; Queue shows the stream queue.
- **Skip logic:** `hasPlayerCardContent()` requires actual history/run data (not just a name); logos always show; `completedSets` excludes null-score sets, capped at 8. **Doubles** suppresses `player-1`, `player-2`, `recent-sets`. **Crew** suppresses `player-1`, `player-2`, `recent-sets`, `completed-sets`.
- **Rotation safety:** `Rotator._tl` stores the active GSAP timeline and `_transitionTo()` kills it before starting a new one (prevents stale `onComplete` callbacks spawning duplicate timer chains). `_advance()` calls `clearTimeout` defensively. `buildSlots()` does a full clean restart when the current panel leaves the active slot list (prevents stacked/accelerating rotation).
- **Config constants** at the top of `side-panel.js`: `PANEL_INTERVAL`, `LOGO_PATH`, `SPONSOR_PATH`, `SCOREBOARD_NUM`, the `ANIM_*` GSAP timing values, and `DEBUG_PANEL` (set `null` in production; otherwise locks rotation to one panel).

### Layout — `bracket/`

Four HTML variants sharing one `index.css` / `index.js`: `index.html` (default), `index_expanded.html`, `losers_only.html`, `winners_only.html`. All four have identical title markup.

- **Title bar** (`--title-size: 68px`): `width: fit-content; min-width: 560px; margin: 0 auto` — centered, shrinks to content. Dark teal (`--score-bg-color`) base with atmospheric layers (`.title-atm` grain/light/vignette) and three ambient green orbs (`torb1-3` keyframes) matching the side-panel bottom-card aesthetic. Graduated gold accent line via `.container::after`.
- **Player rows:** each `.player.container` includes a `.char_icon` div populated by `index.js` with the character icon PNG (`chara_2_{codename}_{skin}.png`) for singles; cleared for doubles. `index.js` adds `.winner`/`.loser` classes to completed slots (CSS brightness).
- **Containers:** `padding-bottom: 20px` on `.winners_container`, `30px` on `.losers_container` to keep slots off the screen edge.

### Character Map — `slippi-bridge/char_map.js`

Maps Slippi character IDs (0–25) to TSH codenames and display names. Icon files:
```
TournamentStreamHelper-5.972/user_data/games/ssbm/base_files/icon/chara_2_{codename}_{costume:02d}.png
```
Costume index comes from `player.characterColor` in `getSettings()`.

---

## Folder Mode vs TCP Mode

- **Folder mode** (default): polls `SLP_FOLDER` every 500ms, using a `knownFiles` Set to ignore pre-existing files. `fs.watch` is intentionally **not** used — it misses new files on Windows/OneDrive paths.
- **TCP mode**: `@vinceau/slp-realtime` v3.3.0 (`SlpLiveStream` + `SlpRealTime`) connects directly to the Wii's IP.

---

## Known Gotchas

- `fs.watch` is intentionally not used (misses new files on Windows/OneDrive) — always poll.
- TSH's "Swap Teams" button swaps names AND scores. The bridge now polls `/scoreboard{N}-get-swap` every 2s and re-derives immediately; name-based detection on the next game start remains the fallback.
- `uiohook-napi` provides the global `Ctrl+Shift+S` hotkey; if it fails to load, the fallback is pressing `S` in the terminal.
- The `tsh_update` DOM event fires whenever `program_state.json` changes; the layout listens to it to time its costume patch.
- `config.js` is git-tracked — never put secrets there. The start.gg token goes in the gitignored `config.local.js`.
- TSH's `/get-match` does **not** expose start.gg entrant ids; `startgg-client.js` queries start.gg directly for them when reporting.
- **TSH's default web server port changed from 5000 (5.967) to 5500 (5.972)** — `TSHWebServer.py` reads `SettingsManager.Get("general.webserver_port", 5500)`. This repo pins it back to **5000** via `user_data/settings.json → general.webserver_port`, because every OBS browser source and `config.TSH_URL` references 5000. A fresh `settings.json` omits the key and silently lands on 5500, which looks exactly like "TSH won't start" — `start-all.js` just times out waiting on 5000. Check the listening port before debugging anything else.
- Never hardcode the TSH folder name — it carries the version (`TournamentStreamHelper-5.972`) and changes on every update. Use `resolveTshRoot()` from `tsh-root.js`.
- `.gitignore` uses the version-independent glob `TournamentStreamHelper-*/*` with a `!TournamentStreamHelper-*/layout/` negation. Pinning an exact version there means the next TSH update silently untracks nothing and starts tracking ~4000 vendored files.
- A fresh TSH extract ships **empty stub** config, not missing files — `local_players.json` is `{}` and `settings.json` has no `TOURNAMENT_URL`. After updating, copy `user_data/games/`, `local_players.json`, `settings.json`, and `pronouns_list.txt` from the previous install.

---

## Planned / Not Yet Built

- **Combo detection + auto replay queue** ([#7](https://github.com/quinnogden/slippi-stream-overlay/issues)) — scan `getStats().conversions` for highlights (≥4 moves, ≥30% dmg, `didKill`); OBS replay buffer saves clips on a `slippi_highlight` event via the WebSocket API; an OBS Python script polls the folder and queues clips into a VLC source, playing on a manual break-scene switch.
