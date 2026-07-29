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
  ├─ emits Socket.io    → OBS browser sources
  └─ serves an operator control panel + start.gg result reporting
        ↓
TSH  (Python app, port 5000)
  ├─ layout/scoreboard/melee.html   ← scoreboard browser source
  └─ layout/side-panel/side-panel.html  ← side panel browser source
```

The bridge tracks which Slippi player port belongs to which player by name, so TSH's **Swap Teams** button is safe to use mid-set — the bridge will re-detect the correct assignment on the next game start and scores will follow the player, not the side.

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Tournament Stream Helper](https://github.com/nicholasgasior/TournamentStreamHelper) — run it locally so it serves on `http://localhost:5000`
- **Slippi Desktop App** in spectate/mirror mode, so it writes live `.slp` files to a folder

## Setup

> Setting up on a **new machine**, a **fresh TSH extract**, or a **fresh OBS profile**? Use [docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md) instead of this section. It's an ordered checklist covering the parts this section leaves out — the TSH settings that silently fight the bridge, the OBS replay buffer and WebSocket setup, and a verification pass — plus which files a fresh clone doesn't include. Run `cd slippi-bridge && node preflight.js` at any point to check the mechanical half of it automatically.
>
> The steps below are the short version for a machine that's already mostly configured. Other docs: [docs/TESTING.md](docs/TESTING.md), [docs/BRIDGE-API.md](docs/BRIDGE-API.md).

### 1. Clone and install

```bash
git clone https://github.com/quinnogden/slippi-stream-overlay.git
cd slippi-stream-overlay/slippi-bridge
npm install
```

### 2. Configure

Edit `slippi-bridge/config.js`:

```js
// Path where the Slippi Desktop App writes live game files
SLP_FOLDER: "C:/Users/YourName/Documents/Slippi/Spectate/YourName",
```

Leave `TSH_URL`, `SCOREBOARD_NUM`, `TSH_ROOT`, and `BRIDGE_PORT` at their defaults unless you have a specific reason to change them.

`TSH_ROOT` defaults to `null`, meaning the bridge auto-detects the newest `TournamentStreamHelper-*` folder sitting next to `slippi-bridge/` and logs which one it picked at startup. Set it to an absolute path only if TSH lives somewhere else.

**Optional — start.gg result reporting.** To report set results from the control panel (see [Control Panel](#control-panel)), copy `config.local.example.js` to `config.local.js` and paste a start.gg personal access token:

```bash
cd slippi-bridge
cp config.local.example.js config.local.js
```

Generate the token at [start.gg → Developer Settings](https://start.gg/admin/profile/developer) (you can only view it once; tokens expire after a year). `config.local.js` is gitignored, so your token never gets committed. Without it, everything else works and the report button just stays disabled.

### 3. Place the layouts in TSH

Copy both layout folders into your TSH installation at the same paths:

```
TournamentStreamHelper-5.972/layout/scoreboard/
  melee.html
  index.js
  index.css
  settings.json

TournamentStreamHelper-5.972/layout/side-panel/
  side-panel.html
  side-panel.js
  side-panel.css
```

Also copy `TournamentStreamHelper-5.972/layout/theme.css` and `TournamentStreamHelper-5.972/layout/main.css` — shared design tokens used by both layouts.

### 4. Run TSH and the bridge

**One-shot launcher (recommended):** double-click `slippi-bridge/start-all.bat`. It starts TSH, waits until its API is up, then starts the bridge — one click instead of launching two things in order. It does not touch OBS, and it leaves TSH running when the bridge closes.

**Bridge only** (when TSH is already running):

```bash
cd slippi-bridge
node index.js
```

Or double-click `slippi-bridge/start-bridge.bat`. Both batch files use a relative path, so they work on any machine regardless of where the repo is cloned.

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

## Control Panel

The bridge serves an operator control panel at:
```
http://localhost:5001/control
```
Add it to OBS as a dock — **Docks → Custom Browser Docks**, name it, and paste that URL. It lives alongside your scenes and is **not** part of the broadcast, so you never have to alt-tab into TSH's window mid-set. It shows:

- **Health** — whether the bridge is talking to TSH and to your Slippi source.
- **Port → Team** — the current port→team guess, the player name if known, and *how* it was decided (name / character / score = confident; **positional = a low-confidence guess to verify** before the game starts). A **Swap** button does the same thing as `Ctrl+Shift+S`.
- **Bracket** — **Pull Next Match** loads the next queued set from your stream queue, and **Load a Set…** lists the open sets so you can pick one — both without opening TSH's UI.
- **Report to start.gg** — see below.

## Reporting to start.gg

If you set a start.gg token in `config.local.js` (see [Setup step 2](#2-configure)), the control panel can report a finished set back to your bracket so you don't have to re-enter it on the start.gg website.

When a set loaded from start.gg has been played out, click **Report to start.gg**. The panel shows the winner and score it detected and asks you to confirm before anything is sent — reporting is always manual, never automatic. On confirm, it submits the result (winner derived from the live scoreboard score, with per-game detail when available).

The button stays disabled, with the reason shown, when there's nothing valid to report — no token configured, a manually-entered exhibition set with no start.gg set behind it, a set that hasn't started on start.gg yet, or a tied score. Singles and doubles are supported; crew battles are not.

## Port→Team Assignment

The bridge automatically maps each player's Slippi port to a TSH team using this priority chain on every game start:

1. **Name matching** — matches port to TSH player name from previous games in the set
2. **Score matching** — fallback when names aren't filled in; compares internal win counts to TSH scores
3. **Character history** — at 0-0, reads TSH's preloaded character (and costume) to assign ports before the first game
4. **Positional default** — lower port index → team 1

Mapping resets automatically when scores return to 0-0 (new set).

**Late setup during game 1:** If you swap sides in TSH while game 1 is already in progress (score 0-0), the bridge re-reads TSH at game end and re-derives which team the winner is on before incrementing the score. This means you can finish entering names and correcting sides during the first game without worrying about the score going to the wrong player.

### Manual swap

Press **Ctrl+Shift+S** at any time (even when the terminal isn't focused) to flip the port→team assignment. Characters in TSH update immediately.

If `uiohook-napi` binaries are unavailable, the fallback is pressing `S` in the terminal window.

### Swapping from TSH instead

If you press **TSH's own** Swap Teams button, the bridge notices within about 2 seconds and re-derives the port→team mapping right away — you don't need to also press Ctrl+Shift+S. The control panel shows the current TSH swap state under Port → Team.

## Per-Game Stage Tracking

Requires TSH 5.972 or newer.

TSH's Individual Game Tracker keeps a per-game record of the stage, characters, and winner. The bridge reads the stage out of each `.slp` and pushes it automatically at game start, so the tracker fills itself in as the set plays out — nothing to enter by hand.

Characters are handled too, without extra work: TSH copies the current scoreboard character selection into each game's slot, and the bridge is already setting that.

This is cosmetic. If a stage can't be identified the bridge logs a warning and moves on — scoring is never affected. Crew battles skip it entirely, since they don't use the game tracker.

## How the bridge reads the game

The bridge polls `SLP_FOLDER` every 500ms for new `.slp` files and reads the one Slippi is currently writing, so it sees characters, stages, scores and combos as the game happens.

> `fs.watch` is intentionally not used — it misses new files on Windows/OneDrive paths.

## Doubles Support

Doubles mode is detected automatically when a game has 4 active players with team IDs assigned in the `.slp` file and TSH is configured with more than one player per team. No extra configuration needed — the bridge uses the same scoreboard and port.

Team colors are assigned from Slippi's `teamId` field (red / blue / green) and pushed to TSH, overriding whatever color the TO had configured.

The side panel suppresses the per-player cards and recent sets panel in doubles mode, showing only the completed sets and queue panels.

## Crew Battle Support

Crew battles (4- or 5-person teams playing sequential 1v1s with carry-over stocks) are supported with no extra configuration beyond setting up TSH correctly.

### Setup

1. In TSH, add **4 or 5 players per team** on the scoreboard.
2. Before the first game, manually set the score to the total starting stocks: **16 for a 4-person crew**, **20 for a 5-person crew**.
3. Before each game, set TSH team 1's player 1 slot to the player who is about to play for that team. The bridge reads this slot to know who is active.

### How it works

- The bridge detects crew mode from the TSH player count (≥ 4 per team) and initializes stock tracking from the opening scores.
- After each game the loser's team stock total drops by their player's carry-over stocks; the winner's carry-over is updated from their actual remaining stocks in the final frame.
- Stock counts are pushed back to TSH via the score API so the scoreboard always shows current totals.
- When a team reaches 0 stocks a `slippi_crew_end` event fires and the bridge stops decrementing.
- Handwarmer detection is skipped in crew mode — every completed game counts.

### Scoreboard

The active player's character icon and costume are shown on the scoreboard. The team name (from TSH's **Team Name** field) appears as a chip below the player tag, matching the pronouns chip position.

### Side Panel

Two new rotation slots replace the per-player and recent-sets cards during crew:

| Panel | Shows |
|-------|-------|
| Team 1 | All players with Name / Stocks Taken columns; active player highlighted, eliminated players dimmed |
| Team 2 | Same for team 2 |

The "Just Finished" card is also hidden during crew so only crew-relevant panels rotate.

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

## Updating TSH

TSH ships as a version-named folder, so an update means a *new* folder rather than changed files in the old one. The bridge auto-detects it (see `TSH_ROOT` above) and `.gitignore` uses a version-independent glob, so **no code or config changes are needed** — but the new extract ships with empty stub config, and its stock `layout/` will not contain the custom layouts.

With TSH closed:

1. Extract the new release next to `slippi-bridge/`, e.g. `TournamentStreamHelper-5.972/`.
2. Copy the custom `layout/` folder over the new one (see [Place the layouts in TSH](#3-place-the-layouts-in-tsh)).
3. Copy operator data across from the previous install's `user_data/`:
   - `games/` — character and stage icons. Without these, no icons render.
   - `settings.json` — holds `TOURNAMENT_URL`, hotkeys, display options, and the web server port.
   - `local_players.json` — the player database.
   - `pronouns_list.txt`
4. **Check TSH's web server port.** As of 5.972 the default is **5500**, but this setup uses **5000** everywhere (OBS browser sources, `config.TSH_URL`). Confirm `user_data/settings.json` contains:
   ```json
   "general": { "webserver_port": 5000 }
   ```
   It's also under Settings → General in TSH's UI. If this is wrong, `start-all.bat` just hangs for 60s and reports that TSH never came up — the app is running fine, it's simply listening elsewhere.
5. Start the bridge and confirm the `[bridge] TSH root:` line names the new folder.
6. Delete the old folder once a set has run cleanly.

Watch out: a fresh extract *creates* these files as empty stubs rather than leaving them missing, so a 2-byte `local_players.json` or a `settings.json` with no `TOURNAMENT_URL` is the symptom of a skipped step 3 — not of a broken install.

## Troubleshooting

**Port already in use:** normally handled for you — if the port is held by an older slippi-bridge, the new one stops it and takes the port back (`Port 5001 is held by an old slippi-bridge (pid N) — stopping it.`). It only does that for a process that identifies itself as a bridge; if something else is on 5001 it refuses to start and says so. In that case, either free the port:
```
netstat -ano | findstr :5001
taskkill /PID <pid> /F
```
or move the bridge with `BRIDGE_PORT` in `config.local.js` (remember the OBS browser sources point at 5001 too).

**"TSH did not respond within 60s" — but TSH is clearly running:** it's almost certainly listening on the wrong port. TSH 5.972 changed its default web server port to 5500; this setup expects 5000. Set `general.webserver_port` to `5000` in `user_data/settings.json` (or Settings → General in TSH), then restart TSH. Verify with `curl http://localhost:5000/`.

**Characters not updating:** Make sure TSH is running before the bridge starts. The bridge reads `TournamentStreamHelper-5.972/out/program_state.json` directly. If icons are missing entirely rather than stale, check that `user_data/games/ssbm/` was copied across — a fresh TSH install has no game assets.

**Wrong player on wrong side:** Press Ctrl+Shift+S to swap manually. On the next game start the bridge will re-detect from names/scores automatically.

**Side panel not loading tournament data:** Make sure TSH is running and `out/program_state.json` exists. The side panel polls TSH state directly — it does not need the bridge to be running, but TSH must be up.

**Control panel is blank or shows everything offline:** The panel is served by the bridge, so the bridge must be running (`start-all.bat` or `start-bridge.bat`). The TSH health dot goes green once TSH's API responds; the Slippi dot goes green once the watched `SLP_FOLDER` is readable.

**Report button is greyed out:** Hover for the reason. Common causes: no start.gg token in `config.local.js`, the loaded set was entered manually (no start.gg set behind it), the set hasn't started on start.gg yet, the score is tied, or it's a crew battle (not supported).

**Score incremented on a warm-up game:** The handwarmer threshold may need tuning. Check `slippi-bridge/handwarmer.js` — the weighted score cutoff is at the top of the file.
