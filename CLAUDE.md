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

### `slippi-bridge/index.js` — Port→Team Assignment

The bridge maintains a **port-persistent, swap-aware** mapping of Slippi player ports (0-based) to TSH teams (1-based). This survives TSH's "Swap Teams" button.

State variables:
- `portToTeam` — `{ [playerIndex]: teamNum }` — `null` = use positional default
- `portToName` — `{ [playerIndex]: "PlayerName" }` — built from TSH state after each game
- `portScore` — `{ [playerIndex]: wins }` — internal win counter for score-based fallback

Assignment priority on each game start:
1. **`resolvePortTeamMapping()`** — name-based matching (if mid-set). Fallback: score-based matching (portScore vs TSH scores). Resets to null on 0-0.
2. **`tryCharacterBasedMapping()`** — at 0-0, checks TSH's preloaded character history (`program_state.json → team.player["1"].character["1"]`). Matches on `name`; also checks `skin` (costume index) when both players use the same character.
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

- **[#1] Doubles support (2v2 port-to-team mapping)** — `onGameStart` and `PortMapper` currently assume exactly 2 ports. Need to handle all 4 ports, 2 names per team from `program_state.json` (`player["1"]` and `player["2"]`), and winner detection across 4 ports. Doubles games are detectable via `players.length === 4` in `getSettings()`.

- **[#2] Doubles: auto-import TSH team color** — In doubles, replace per-player character+costume display with team color read from `program_state.json` (`state.score["1"].team["1"].color`). Emit color in the `slippi_game_start` Socket.io payload. 1v1 keeps character+costume display unchanged.

- **[#3] Vertical player card with cycling stat panels** — New `layout/player_card/` OBS source that cycles between a player presentation panel (name, sponsor, recent placements) and a recent sets panel (last N sets with scores and dates) using GSAP transitions. Reference: `layout/player_presentation/index.js` and `layout/recent_sets/index.js` for data patterns. Cycle on a timer or triggered by bridge game-start/end events.
