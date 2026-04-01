# slippi-stream-overlay

A live Melee tournament streaming overlay that reads real Slippi game data and feeds it into [Tournament Stream Helper (TSH)](https://github.com/nicholasgasior/TournamentStreamHelper). Characters, costumes, and scores update automatically — even across team swaps.

## How It Works

```
Slippi console / .slp file
        ↓
slippi-bridge  (Node.js, port 5001)
  ├─ detects game start → pushes character + costume to TSH
  ├─ detects game end   → auto-increments the correct team's score
  ├─ filters handwarmer games (no score change)
  └─ emits Socket.io    → OBS browser sources
        ↓
TSH  (Python app, port 5000)
  ├─ layout/scoreboard/melee.html   ← scoreboard browser source
  └─ layout/side-panel/side-panel.html  ← side panel browser source
```

The bridge tracks which Slippi player port belongs to which player by name, so TSH's **Swap Teams** button is safe to use mid-set — the bridge will re-detect the correct assignment on the next game start and scores will follow the player, not the side.

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Tournament Stream Helper](https://github.com/nicholasgasior/TournamentStreamHelper) — run it locally so it serves on `http://localhost:5000`
- One of:
  - **Slippi Desktop App** in spectate/folder mode (writes live `.slp` files)
  - **Direct Wii connection** over LAN (TCP mode)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/quinnogden/slippi-stream-overlay.git
cd slippi-stream-overlay/slippi-bridge
npm install
```

### 2. Configure

Edit `slippi-bridge/config.js`:

```js
CONNECTION_MODE: "folder",   // "folder" or "tcp"

// Folder mode — path where Slippi writes live game files
SLP_FOLDER: "C:/Users/YourName/Documents/Slippi/Spectate/YourName",

// TCP mode — your Wii's local IP (only used when CONNECTION_MODE is "tcp")
CONSOLE_IP: "192.168.1.100",
```

Leave `TSH_URL`, `SCOREBOARD_NUM`, and `BRIDGE_PORT` at their defaults unless you have a specific reason to change them.

### 3. Place the layouts in TSH

Copy both layout folders into your TSH installation at the same paths:

```
TournamentStreamHelper-5.967/layout/scoreboard/
  melee.html
  index.js
  index.css
  settings.json

TournamentStreamHelper-5.967/layout/side-panel/
  side-panel.html
  side-panel.js
  side-panel.css
```

Also copy `TournamentStreamHelper-5.967/layout/theme.css` and `TournamentStreamHelper-5.967/layout/main.css` — shared design tokens used by both layouts.

### 4. Run TSH and the bridge

Start TSH first (so its HTTP API is available), then either:

```bash
cd slippi-bridge
node index.js
```

Or double-click `slippi-bridge/start-bridge.bat` (or a desktop shortcut to it). The batch file uses a relative path so it works on any machine regardless of where the repo is cloned.

### 5. Add browser sources in OBS

**Scoreboard** — add a Browser Source at:
```
http://localhost:5000/layout/scoreboard/melee.html
```
Use `melee.html`, not `index.html` — it conditionally loads the Socket.io client from the bridge.

**Side panel** — add a second Browser Source at:
```
http://localhost:5000/layout/side-panel/side-panel.html
```
Set the browser source size to **611 × 1080**. Position it on the right side of the scene. The panel has a transparent cam cutout (587 × 330 px) where your webcam source shows through — layer the cam source behind it in OBS.

Add `?animate=false` to the URL to disable the ambient background animation (useful if you find it distracting or want to reduce GPU load).

**Player names list** *(optional)* — a compact player-name layout is also available at:
```
http://localhost:5000/layout/scoreboard/meleePlayers.html
```
This is a standalone name display intended as a secondary browser source.

## Port→Team Assignment

The bridge automatically maps each player's Slippi port to a TSH team using this priority chain on every game start:

1. **Name matching** — matches port to TSH player name from previous games in the set
2. **Score matching** — fallback when names aren't filled in; compares internal win counts to TSH scores
3. **Character history** — at 0-0, reads TSH's preloaded character (and costume) to assign ports before the first game
4. **Positional default** — lower port index → team 1

Mapping resets automatically when scores return to 0-0 (new set).

### Manual swap

Press **Ctrl+Shift+S** at any time (even when the terminal isn't focused) to flip the port→team assignment. Characters in TSH update immediately.

If `uiohook-napi` binaries are unavailable, the fallback is pressing `S` in the terminal window.

## Connection Modes

| Mode | How it works | Best for |
|------|-------------|----------|
| `folder` | Polls a directory every 500ms for new `.slp` files | Slippi Desktop App spectate/mirror |
| `tcp` | Connects directly to the Wii's LAN IP | Lowest latency, direct capture |

> `fs.watch` is intentionally not used — it misses new files on Windows/OneDrive paths.

## Doubles Support

Doubles mode is detected automatically when a game has 4 active players with team IDs assigned in the `.slp` file and TSH is configured with more than one player per team. No extra configuration needed — the bridge uses the same scoreboard and port.

Team colors are assigned from Slippi's `teamId` field (red / blue / green) and pushed to TSH, overriding whatever color the TO had configured.

The side panel suppresses the per-player cards and recent sets panel in doubles mode, showing only the completed sets and queue panels.

## Handwarmer Detection

The bridge scores each game on a weighted heuristic to detect practice/warm-up games:

- Both players dealt less than 150 total damage
- Both players had more than 1 stock remaining at the end
- Game ended via LRAS (Quit Out)
- Match duration under 60 seconds

Games that score above the threshold do not increment the scoreboard. Characters and costumes still update normally so players can warm up without polluting the score.

**Doubles:** handwarmer detection works for doubles too — LRAS quit-outs are still caught, and normal doubles game endings are never falsely flagged.

**Rage quit handling:** if LRAS is detected but the game is *not* a handwarmer (a real game was quit), the bridge awards a point to the other player automatically.

## Side Panel

The side panel is a 611 × 1080 browser source designed to sit beside the webcam. It has two floating cards with a transparent cam cutout between them.

**Bottom card panels** rotate every 20 seconds:

| Panel | Shows |
|-------|-------|
| Tournament logo | Logo image from `layout/logo.png` |
| Player 1 | Recent tournament placements + current run results |
| Player 2 | Same for player 2 |
| Recent Sets | Head-to-head set record between the two players |
| Sponsor logo | Sponsor image from `layout/ThePark.png` |
| Just Finished | Most recently completed sets at the tournament |
| Up Next | Stream queue |

Logo and image paths are set at the top of `side-panel.js` (`LOGO_PATH`, `SPONSOR_PATH`). The rotation interval is `PANEL_INTERVAL` (default 20 seconds).

## Troubleshooting

**Port already in use:**
```
netstat -ano | findstr :5001
taskkill /PID <pid> /F
```

**Characters not updating:** Make sure TSH is running before the bridge starts. The bridge reads `TournamentStreamHelper-5.967/out/program_state.json` directly.

**Wrong player on wrong side:** Press Ctrl+Shift+S to swap manually. On the next game start the bridge will re-detect from names/scores automatically.

**Side panel not loading tournament data:** Make sure TSH is running and `out/program_state.json` exists. The side panel polls TSH state directly — it does not need the bridge to be running, but TSH must be up.

**Score incremented on a warm-up game:** The handwarmer threshold may need tuning. Check `slippi-bridge/handwarmer.js` — the weighted score cutoff is at the top of the file.
