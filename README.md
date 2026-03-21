# slippi-stream-overlay

A live Melee tournament streaming overlay that reads real Slippi game data and feeds it into [Tournament Stream Helper (TSH)](https://github.com/nicholasgasior/TournamentStreamHelper). Characters, costumes, and scores update automatically — even across team swaps.

## How It Works

```
Slippi console / .slp file
        ↓
slippi-bridge  (Node.js, port 5001)
  ├─ detects game start → pushes character + costume to TSH
  ├─ detects game end   → auto-increments the correct team's score
  └─ emits Socket.io    → OBS browser source (melee.html)
        ↓
TSH  (Python app, port 5000)
  └─ layout/scoreboard/melee.html  ← OBS browser source
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

### 3. Place the layout in TSH

Copy `TournamentStreamHelper-5.967/layout/scoreboard/` into your TSH installation at the same path:

```
TournamentStreamHelper-5.967/layout/scoreboard/
  melee.html
  index.js
  index.css
  settings.json
```

### 4. Run TSH and the bridge

Start TSH first (so its HTTP API is available), then:

```bash
cd slippi-bridge
node index.js
```

### 5. Add the browser source in OBS

Add a **Browser Source** pointed at:

```
http://localhost:5000/layout/scoreboard/melee.html
```

Use `melee.html`, not `index.html` — it conditionally loads the Socket.io client from the bridge.

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

## Troubleshooting

**Port already in use:**
```
netstat -ano | findstr :5001
taskkill /PID <pid> /F
```

**Characters not updating:** Make sure TSH is running before the bridge starts. The bridge reads `TournamentStreamHelper-5.967/out/program_state.json` directly.

**Wrong player on wrong side:** Press Ctrl+Shift+S to swap manually. On the next game start the bridge will re-detect from names/scores automatically.
