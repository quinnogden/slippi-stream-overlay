# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A custom streaming overlay for Melee tournaments that bridges live Slippi game data into [Tournament Stream Helper (TSH)](https://github.com/nicholasgasior/TournamentStreamHelper). It consists of two coupled parts:

1. **`slippi-bridge/`** — A Node.js backend that reads live `.slp` files and drives TSH via HTTP API + Socket.io.
2. **`TournamentStreamHelper-5.967/layout/scoreboard/`** — A customized TSH scoreboard layout (HTML/CSS/JS) that consumes both TSH state and slippi-bridge events.

TSH itself (`TournamentStreamHelper-5.967/`) is a third-party app run as a local web server on port 5000. Do not edit files inside it outside of `layout/scoreboard/`.

---

## Running the Bridge

```bash
cd slippi-bridge
npm install       # first time only
node index.js
```

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
        ├─ index.js             ← layout logic + slippi-bridge integration
        └─ index.css            ← styles
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
POST /scoreboard1-update-team-N-1         → set character/costume
     body: { mains: { ssbm: [[charDisplayName, costumeIndex]] } }
```

### Layout — `melee.html` / `index.js`

- **Use `melee.html`** as the OBS browser source (not `index.html`). It conditionally loads `socket.io.js` from the bridge.
- The layout implements TSH's `Start()` and `Update(event)` hooks (defined in `layout/include/globals.js`).
- The Slippi bridge integration lives at the bottom of `index.js` inside `initSlippiBridge()`. It:
  - Connects to `http://localhost:5001` via Socket.io.
  - On `slippi_game_start`: stores game data, then patches character `<img>` src after each `tsh_update` to show the correct Slippi costume (TSH defaults to costume 0).
  - On `tsh_update` (DOM event): calls `applySlippiCostumes()` with 150ms delay to let TSH finish rendering first.

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

**Build order:** ✅#5 → #6 → #1 → #2 → #4 → #3 → #7

- **[✅#5] Shared CSS design token file** — `layout/theme.css` with Fredoka font + main.css colors. Linked in `melee.html` before `index.css`. All future layouts link to this first. BabyDoll kept in `main.css` as fallback.

- **[#6] Handwarmer detection** — Port `wasHandwarmers()` from [Melee-Ghost-Streamer](https://github.com/Sheepolution/Melee-Ghost-Streamer). Weighted score: damage < 50 (+1), LRAS end (+1), both players had stocks remaining (+2), kill count ≤ 1 (+1), duration < 45s (+1). Score ≥ 2 = handwarmer. Suppresses **both** `slippi_game_start` Socket.io event AND score increment. Console log only, nothing in overlay. Folder mode only.

- **[#1] Doubles support (HIGH PRIORITY)** — User streams 1v1 and 2v2 at every tournament. Auto-detected from `players.length === 4` in `.slp` and `Object.keys(team["1"].player).length > 1` in TSH state. Same scoreboard number as 1v1 — no extra config. Scoreboard layout already has `isTeams` check. PortMapper needs to handle 4 ports (2 per team), name/score matching across 2 players per team, atomic 4-port swap.

- **[#2] Doubles: auto-import TSH team color** — Depends on #1. Replace per-player character+costume with team color from `state.score["1"].team["1"].color`. Emit in `slippi_game_start` payload. 1v1 unchanged.

- **[#4] Right-side panel browser source** — 611×1080px replacing static PNG. Structure: dark top bar (tournament name from TSH), transparent cam cutout middle, dark bottom block (reserved for #3). Always-on with toggleable ambient animation via URL param `?animate=false`. `body { background: transparent }` for OBS cam passthrough. Socket.io connected for future hooks.

- **[#3] Player card** — One shared OBS source. Cycles between player_presentation and recent_sets panels. 10s interval (configurable constant at top of JS). Resets to panel 1 on `slippi_game_start`. Lives in bottom block of side panel (#4). Use GSAP for transitions.

- **[#7] Combo detection + auto replay queue** — Scan `getStats().conversions` for highlights (≥4 moves, ≥30% dmg, `didKill`). OBS replay buffer saves clips on `slippi_highlight` event via WebSocket API. OBS Python script polls folder, queues into VLC source. Plays on manual break scene switch, resets when scene switches away.
