# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A custom streaming overlay for Melee tournaments that bridges live Slippi game data into [Tournament Stream Helper (TSH)](https://github.com/nicholasgasior/TournamentStreamHelper). It consists of two coupled parts:

1. **`slippi-bridge/`** — A Node.js backend that reads live `.slp` files and drives TSH via HTTP API + Socket.io.
2. **`TournamentStreamHelper-5.967/layout/scoreboard/`** — A customized TSH scoreboard layout (HTML/CSS/JS) that consumes both TSH state and slippi-bridge events.

TSH itself (`TournamentStreamHelper-5.967/`) is a third-party app run as a local web server on port 5000. Do not edit files inside it outside of `layout/`.

---

## Running the Bridge

```bash
cd slippi-bridge
npm install       # first time only
node index.js
```

Or double-click `slippi-bridge/start-bridge.bat` (or a desktop shortcut pointing to it). Uses `%~dp0` so it works on any machine regardless of where the repo is cloned.

Config is in [slippi-bridge/config.js](slippi-bridge/config.js). Key settings:
- `CONNECTION_MODE`: `"folder"` (watch a folder for `.slp` files) or `"tcp"` (connect directly to Wii)
- `SLP_FOLDER`: path to the Slippi Spectate folder (e.g. `C:/Users/.../Slippi/Spectate/quinn`)
- `TSH_URL`: TSH web server, default `http://localhost:5000`
- `SCOREBOARD_NUM`: TSH scoreboard to control (default `1`)
- `BRIDGE_PORT`: Socket.io port the layout connects to (default `5001`)

**Keyboard shortcut:** `Ctrl+Shift+S` (global, works even when the terminal isn't focused) manually swaps the port→team assignment. Requires `uiohook-napi` to be installed (it is in `package.json`).

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
  └─ emits Socket.io events   → layout browser source
        ↓
TournamentStreamHelper-5.967/  (Python app, port 5000)
  ├─ out/program_state.json    (live state — read by bridge and layout)
  └─ layout/scoreboard/        (OBS browser source)
        ├─ melee.html           ← USE THIS in OBS (loads slippi-bridge socket.io)
        ├─ meleePlayers.html    ← player-name list layout (body class: fgc thin meleePlayer)
        ├─ index.js             ← layout logic + slippi-bridge integration
        └─ index.css            ← styles (stripped to melee/meleePlayer only; ~537 lines)
```

### slippi-bridge modules

The bridge is split across four files:

- **`index.js`** — entry point, wires everything together. Owns `currentGameState`, calls the other modules, handles the keyboard listener.
- **`port-mapper.js`** — `PortMapper` class. Owns all port→team tracking state (`portToTeam`, `portToName`, `portScore`). Never reads files or makes HTTP calls — all data is passed in.
- **`tsh-client.js`** — `TshClient` class. All I/O with TSH: reads `program_state.json`, calls TSH HTTP API. Returns typed results instead of silently swallowing errors.
- **`game-source.js`** — `createFolderSource` / `createTcpSource`. Returns a Node `EventEmitter` firing `game-start` (rawPlayers) and `game-end` (winnerPlayerIndex). `index.js` binds to these and never calls mode-specific code directly.
- **`char_map.js`** — `resolveCharacter(charId, costume, tshRoot)`. Pure mapping, no I/O.

### Port→Team Assignment (`PortMapper`)

The bridge maintains a **port-persistent, swap-aware** mapping of Slippi player ports (0-based) to TSH teams (1-based). This survives TSH's "Swap Teams" button.

Assignment priority on each game start:
1. **`portMapper.resolve(t1, t2)`** — name-based matching (if mid-set). Fallback: score-based matching (`portScore` vs TSH scores). Resets to null on 0-0.
2. **`portMapper.tryCharacterBased()`** — at 0-0, checks TSH's preloaded character history (`program_state.json → team.player["1"].character["1"]`). Matches on `name`; also checks `skin` (costume index) when both players use the same character.
3. **Positional default** — lower port index → team 1.

### `program_state.json` — Key Paths

All keys are **strings**, 1-indexed. Scoreboard number is `config.SCOREBOARD_NUM` (default `"1"`):

```
state.score["1"].team["1"].score                        → team 1 score
state.score["1"].team["1"].player["1"].name             → team 1 player name
state.score["1"].team["1"].player["1"].character["1"].name  → preloaded character name
state.score["1"].team["1"].player["1"].character["1"].skin  → preloaded costume index (0-based)
```

### TSH HTTP API (used by bridge)

```
GET  /scoreboard1-teamN-scoreup           → increment team N score by 1
GET  /scoreboard1-teamN-color-<hex>       → set team color (hex without #)
POST /scoreboard1-update-team-N-1         → set character/costume
     body: { mains: { ssbm: [[charDisplayName, costumeIndex]] } }
```

### Layout — `melee.html` / `index.js`

- **Use `melee.html`** as the OBS browser source (not `index.html`). It conditionally loads `socket.io.js` from the bridge.
- **`index.css`** contains only rules for `melee.html` and `meleePlayers.html`. All game-variant styles (tekken8, sf6, ssbu, roa2, mk1, pokken, nasb2, pbrave, skullgirls, strive, bblue, arms, gbvsr, dbfz, uni2) and unused features (flag country/state, `.icon`, `.tsh_character`, `.name_twitter`, `.extra`, skewed bg panels) were removed in a cleanup pass. Active classes: `fgc`, `thin`, `meleePlayer`, and the core layout/character/score/chip selectors.
- The layout implements TSH's `Start()` and `Update(event)` hooks (defined in `layout/include/globals.js`).
- The Slippi bridge integration lives at the bottom of `index.js` inside `initSlippiBridge()`. It:
  - Connects to `http://localhost:5001` via Socket.io.
  - On `slippi_game_start`: stores game data. In singles, patches character `<img>` src after each `tsh_update` (TSH defaults to costume 0). In doubles, clears any leftover character icons.
  - On `tsh_update` (DOM event): calls `applySlippiCostumes()` with 150ms delay to let TSH finish rendering first. Detects doubles mode from DOM (`character_container.team-color`) rather than from stale bridge data, so icons clear immediately when TSH config switches from singles to doubles.
  - In doubles, TSH injects a `div.text.text_empty` placeholder inside `.character_container` even after it's cleared — hidden via `.character_container.team-color .text.text_empty { display: none }` in CSS.

### Character Map — `slippi-bridge/char_map.js`

Maps Slippi character IDs (0–25) to TSH codenames and display names. Icon files are at:
```
TournamentStreamHelper-5.967/user_data/games/ssbm/base_files/icon/chara_2_{codename}_{costume:02d}.png
```
Costume index comes from `player.characterColor` in `getSettings()`.

---

## Folder Mode vs TCP Mode

- **Folder mode** (current default): polls the `SLP_FOLDER` directory every 500ms. Uses a `knownFiles` Set to ignore pre-existing files. No `fs.watch` — unreliable on Windows/OneDrive paths.
- **TCP mode**: uses `@vinceau/slp-realtime` v3.3.0 (`SlpLiveStream` + `SlpRealTime`) to connect directly to the Wii's IP.

---

## Known Gotchas

- `fs.watch` is intentionally not used — it misses new files on Windows/OneDrive. Always use the poll-based approach.
- TSH's "Swap Teams" button swaps names AND scores, so after a swap the bridge's name-based detection will correctly re-derive the mapping on the next game.
- `uiohook-napi` provides the global `Ctrl+Shift+S` hotkey. If it fails to load, the bridge falls back to terminal keypress (`S` or `s`) for swapping.
- The `tsh_update` DOM event is dispatched by TSH's `globals.js` whenever `program_state.json` changes. The bridge listens to this to time its costume-patch.

---

## Planned TODOs

Tracked as GitHub issues at [github.com/quinnogden/slippi-stream-overlay/issues](https://github.com/quinnogden/slippi-stream-overlay/issues).

**Build order:** ✅#5 → ✅#6 → ✅#1 → ✅#2 → ✅#4 → ✅Phase2 → ✅#3 → #7

- **[✅#5] Shared CSS design token file** — `layout/theme.css` with BabyDoll primary font (Fredoka as fallback). BabyDoll `@font-face` declared in `theme.css` so all sources inherit it without repeating it in per-layout CSS.

- **[✅#6] Handwarmer detection** — `slippi-bridge/handwarmer.js`. Weighted score ≥ 2 = handwarmer: each player's `totalDamage < 150` (+1/−1), LRAS end method 7 (+1/−1), both players have >1 stocks in last frame (+2), duration < 45s (+1). Guard: if `stats.overall` is empty/missing, returns false (prevents vacuous-truth false positives). Score-only suppression: `slippi_game_start` still fires (characters update), score increment skipped. Rage quit handling: LRAS + not handwarmer + valid `lrasInitiatorIndex` → awards point to the other player. Folder mode only; TCP mode always passes `isHandwarmer: false`.

- **[✅#1 + ✅#2] Doubles support + team colors** — Auto-detected from 4 active players with `teamId` assigned in `.slp` AND `Object.keys(team["1"].player).length > 1` in TSH state. Same scoreboard, same bridge port — no extra config.
  - **PortMapper extensions**: `resolveDoubles()` (name → score → positional), `tryCharacterBasedDoubles()` (bidirectional scoring vs both TSH teams — breaks ties where only one team has a unique char), `applyDoublesPositional()` (group-based: lower min-port Slippi group → TSH team 1). `applyDoublesPositional` is called explicitly after `resolveDoubles`+`tryCharacterBased` at 0-0 so `_portToTeam` is always set — fixes index-based positional fallback which was wrong for non-consecutive groups (e.g. ports {0,3} vs {1,2}).
  - **Team colors**: `MELEE_TEAM_COLORS = { 0: '#D32F2F', 1: '#1565C0', 2: '#2E7D32' }` mapped from Slippi `teamId`. TSH TO-configured color is ignored/overwritten. `teamColorMap` uses min-port-per-group when `_portToTeam` is set; group min-port ranking otherwise.
  - **Score tracking**: `onGameEnd` reads winner team from `currentGameState.players[winnerPlayerIndex].teamNum` before falling back to `portMapper.getTeam()`, fixing null winner when `_portToTeam` is unset at 0-0.
  - **Game end**: RESOLVED end method (normal doubles win in Slippi) + last-frame stock count fallback when placements are missing.

- **[✅#4] Right-side panel browser source** — `layout/side-panel/` (own folder). 611×1080px.
  - **Structure**: Green background (`--bg-color`) fills entire canvas via four positioned divs (`.bg-top`, `.bg-bottom`, `.bg-left`, `.bg-right`). Two floating rounded-rectangle cards (`.header-card`, `.bottom-card`) sit on top with drop shadows + inner edge lighting for raised depth. Cam cutout (587×330px, true 16:9) is transparent gap between them — OBS cam source shows through.
  - **Cam overlay**: `.cam-overlay` div with `border-radius: 10px` + outward green spread shadow (`box-shadow: 0 0 0 14px var(--bg-color)`) rounds the cam corners without covering any transparent pixels.
  - **Header card**: tournament name fetched from `../../out/tournamentInfo/tournamentName.txt` (polled every 5s) + `Update()` hook. Thin graduated gold accent line at top edge. Text: 32px BabyDoll, uppercase, wide letter-spacing, dark drop shadows.
  - **Bottom card**: dark teal with 5-orb CSS ambient animation (green orbs, `@keyframes drift1-5`), atmospheric grain + light + vignette layers. Logo slot hosts the rotating info panel system (see #3). `LOGO_PATH = "../logo.png"` and `SPONSOR_PATH = "../ThePark.png"` are each their own rotation slot.
  - **Config constants** at top of `side-panel.js`: `LOGO_PATH`, `SPONSOR_PATH`, `LOGO_INTERVAL`. `?animate=false` URL param disables ambient animation. Socket.io connected to bridge for future hooks.
  - **Font/theme**: BabyDoll `@font-face` moved to `theme.css`; `meleePlayers.html` now links `theme.css`.

- **[✅Phase2] Scoreboard visual polish + theme centralization**
  - **Scoreboard**: raised card depth (`box-shadow`) on all `.container` elements. Gold accent line on `.info.container.bottom` and `meleePlayers` center card only (not player containers). Character icons float without box — drop-shadow applied directly to image. Score box flush to container edge with breathing room from icons. `meleePlayers` logo repositioned (742px) above center card, enlarged to 260×260px.
  - **Theme**: `theme.css` is now the single source of truth. `main.css` `@import`s it so all 16 TSH layouts inherit tokens automatically. New semantic variables: `--icon-bg-color`, `--win-color`, `--loss-color`, `--p2-team-color`, `--set-score-color`, `--score-color` (merged from `--p1/p2-score-color`). RGB triplets `--bg-color-rgb`, `--bg-color-light-rgb`, `--text-color-rgb` for `rgba()` usage. All hardcoded theme colors removed from `side-panel.css` and 10 other layout CSS files.

- **[✅#3] Rotating info card system** — Lives in the bottom card of the side panel. Panels: `logo-primary`, `player-1`, `player-2`, `recent-sets`, `logo-sponsor`, `completed-sets`, `queue`. Each slot is 20s (configurable `PANEL_INTERVAL`). Logo slots are separate rotation entries (no crossfade — each is its own slot). GSAP transitions with James Bond stagger: pills fall in top-to-bottom on panel entrance.
  - **Pill system**: every content item is a `.panel-pill` (rounded, `flex: 1`, subtle bg + shadow). Lists use `flex: 1 / flex-direction: column` to fill remaining card height. `max-height: 120px` caps individual pill height.
  - **Panel headers**: `.panel-header` with `::before`/`::after` decorative flanking lines.
  - **Player card**: `.player-identity` block (tag + char-name). History pills show tournament name + ordinal placement (`<sup>` suffix + `/entrants`). Run pills show opponent, round, score with win/loss left+right border accents. Sections hidden when empty. Filtered to `"single"` events only.
  - **Recent Sets**: H2H header block (`h2h-header`, `h2h-mid`, `h2h-score`) showing set record between the two players. Result pills: large score values flanking a center info column (tournament + date on top, round below).
  - **Completed Sets**: symmetric pill (`completed-set-pill.p1win/.p2win`) — green/red border on left and right edges reflect which side won. Score + round centered.
  - **Queue**: pill per match showing P1 name, match label, P2 name (right-aligned).
  - **Skip logic**: `hasPlayerCardContent()` requires actual history or run data (not just name); logos always shown. `completedSets` filtered to exclude sets with null scores, then capped at 8. Doubles mode (detected via `isDoubles()`) suppresses `player-1`, `player-2`, and `recent-sets` slots.
  - **DOM helpers**: `ordinalSuffix(n)` (shared by `ordinal()` and `makePlacementEl()`), `makePill()`, `makeTwoLinePill()`, `makePlacementEl()`, `formatDate()`, `fitText()` (auto-shrinks overflow names). `el()` helper.
  - **Config constants** at top of JS: `PANEL_INTERVAL`, `LOGO_PATH`, `SPONSOR_PATH`, `SCOREBOARD_NUM`, plus `ANIM_TRANSITION_DURATION`, `ANIM_PILL_DURATION`, `ANIM_PILL_DELAY`, `ANIM_PILL_STAGGER`, `ANIM_PILL_Y_OFFSET` for GSAP timing. `DEBUG_PANEL` (set `null` in production) locks rotation to a single panel.
  - **Rotation safety**: `Rotator._tl` stores the active GSAP timeline; `_transitionTo()` kills it before starting a new one so stale `onComplete` callbacks can't create duplicate timer chains. `_advance()` calls `clearTimeout(this._timer)` defensively at the top. `buildSlots()` does a full clean restart (clear timer + kill timeline + reset `_current`/`_index`) when the current panel is removed from the active slot list — prevents stacked panels and accelerating rotation caused by overlapping GSAP timelines.
  - **Theme**: `--bg-color` darkened to `#2a3d23`, `--score-bg-color` deepened to `#071820`; RGB triplets updated to match.

- **[#7] Combo detection + auto replay queue** — Scan `getStats().conversions` for highlights (≥4 moves, ≥30% dmg, `didKill`). OBS replay buffer saves clips on `slippi_highlight` event via WebSocket API. OBS Python script polls folder, queues into VLC source. Plays on manual break scene switch, resets when scene switches away.
