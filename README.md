# slippi-stream-overlay

A live Melee tournament streaming overlay that reads real Slippi game data and feeds it into [Tournament Stream Helper (TSH)](https://github.com/nicholasgasior/TournamentStreamHelper). Characters, costumes, and scores update automatically — even across team swaps.

## How It Works

```
Slippi console / .slp file
        ↓
slippi-bridge  (Node.js, port 5001)
  ├─ detects game start → pushes character + costume + stage to TSH
  ├─ detects game end   → auto-increments the correct team's score
  ├─ filters handwarmer games (no score change)
  ├─ spots big combos   → tells OBS to save its replay buffer
  ├─ emits Socket.io    → OBS browser sources
  └─ serves an operator control panel + start.gg reporting
        ↓
TSH  (Python app, port 5000)
  ├─ layout/scoreboard/melee.html       ← scoreboard browser source
  ├─ layout/side-panel/side-panel.html  ← side panel browser source
  ├─ layout/bracket/index.html          ← bracket browser source
  └─ layout/highlights/highlights.html  ← replay-scene frame (decoration only)
```

The bridge tracks which Slippi player port belongs to which player by name, so TSH's **Swap Teams** button is safe to use mid-set — the bridge notices within about 2 seconds, re-derives the assignment, and scores keep following the player rather than the side.

## What's in the repo

| | |
|---|---|
| `slippi-bridge/` | The Node.js backend: reads the live `.slp`, drives TSH, talks to OBS and start.gg, and serves the operator dock. |
| `TournamentStreamHelper-5.972/layout/` | The custom overlays. **This folder is the only part of TSH this repo owns** — everything else under `TournamentStreamHelper-*/` is the third-party app itself, and isn't tracked. |
| `obs-scripts/` | Python scripts that run *inside* OBS. Currently just the break-scene clip playlist. Optional; the bridge doesn't need it. |
| `tests/` | `node tests/run.js`. No framework, nothing to install. Deliberately narrow — see [tests/README.md](tests/README.md). |
| `docs/` | The longer-form docs below. |

Beyond this page: [docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md) for setting up a new machine step by step, [docs/TESTING.md](docs/TESTING.md) for verifying a change with no bracket running, [docs/BRIDGE-API.md](docs/BRIDGE-API.md) for the event and route shapes, and [CLAUDE.md](CLAUDE.md) for the architecture and the non-obvious constraints behind the code.

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Tournament Stream Helper](https://github.com/nicholasgasior/TournamentStreamHelper) — run it locally so it serves on `http://localhost:5000`
- **Slippi Desktop App** in spectate/mirror mode, so it writes live `.slp` files to a folder
- **OBS 28+** — 28 is where obs-websocket v5 became built-in, which the [combo clipper](#combo-clipper) needs

Optional, and only for the break-scene clip playlist: **64-bit VLC**, and a Python install [that your OBS build will actually load](#playing-the-clips-back).

## Setup

> Setting up on a **new machine**, a **fresh TSH extract**, or a **fresh OBS profile**? Use [docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md) instead of this section. It's an ordered checklist covering the parts this section leaves out — the TSH settings that silently fight the bridge, the OBS replay buffer and WebSocket setup, and a verification pass — plus which files a fresh clone doesn't include. Run `cd slippi-bridge && node scripts/preflight.js` at any point to check the mechanical half of it automatically.
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

Two more blocks in there are for features covered further down: `BRACKETS` (your series' start.gg short link, for the [bracket buttons](#switching-brackets)) and `CLIPPER` (starting values for the [combo clipper](#combo-clipper), which you'll then tune from the dock rather than here).

**Optional — start.gg result reporting.** To report set results from the control panel (see [Control Panel](#control-panel)), copy `config.local.example.js` to `config.local.js` and paste a start.gg personal access token:

```bash
cd slippi-bridge
cp config.local.example.js config.local.js
```

Generate the token at [start.gg → Developer Settings](https://start.gg/admin/profile/developer) (you can only view it once; tokens expire after a year). `config.local.js` is gitignored, so your token never gets committed. Without it, everything else works and the report button just stays disabled.

### 3. Place the layouts in TSH

A fresh clone already has these in the right place. You only need this step when you install or **update TSH**, because a TSH release zip ships its own `layout/` folder and will overwrite them. Copy the repo's versions back over the new install:

```
TournamentStreamHelper-5.972/layout/
  main.css        imports theme.css — link this one, never theme.css directly
  theme.css       the one-line switch naming the active theme pack
  themes/         the packs themselves: colour tokens, brand font, both logos
  shared/         helpers every custom layout needs
  scoreboard/     melee.html, meleePlayers.html, index.js, index.css, settings.json
  side-panel/     side-panel.html, side-panel.js, side-panel.css
  bracket/        index.html + three variants, index.js, index.css
  highlights/     highlights.html, highlights.js, highlights.css
```

`shared/` and the theme pack are the two easiest to miss, and both fail silently — without `shared/` the character icons and the bridge connection quietly stop working, and without the pack the whole overlay renders unstyled. `scripts/preflight.js` checks for all of it explicitly.

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
Use `melee.html` — there is no `index.html` here. It loads the shared bridge client, which pulls the Socket.io client from the bridge and no-ops when the bridge is down.

**Side panel** — add a second Browser Source at:
```
http://localhost:5000/layout/side-panel/side-panel.html
```
Set the browser source size to **611 × 1080**. Position it on the right side of the scene. The panel has a transparent cam cutout (587 × 330 px) where your webcam source shows through — layer the cam source behind it in OBS.

Add `?animate=false` to the URL to disable the ambient background animation (useful if you find it distracting or want to reduce GPU load).

**Bracket** *(optional)* — four variants of the same bracket layout, at 1920 × 1080:
```
http://localhost:5000/layout/bracket/index.html
http://localhost:5000/layout/bracket/index_expanded.html
http://localhost:5000/layout/bracket/winners_only.html
http://localhost:5000/layout/bracket/losers_only.html
```

**Highlights** *(optional)* — the frame for your replay/break scene, at 1920 × 1080:
```
http://localhost:5000/layout/highlights/highlights.html
```
See [Replay scene frame](#replay-scene-frame) — it needs its geometry matched to your OBS source positions, and there's a `?guides=1` mode for doing exactly that.

**Player names list** *(optional)* — a compact player-name layout is also available at:
```
http://localhost:5000/layout/scoreboard/meleePlayers.html
```
This is a standalone name display intended as a secondary browser source.

On every overlay browser source, **uncheck "Shutdown source when not visible"** and **uncheck "Refresh browser when scene becomes active"** — otherwise the side panel's rotation and the bridge connection restart on every scene change.

## Control Panel

The bridge serves an operator control panel at:
```
http://localhost:5001/control
```
Add it to OBS as a dock — **Docks → Custom Browser Docks**, name it, and paste that URL. It lives alongside your scenes and is **not** part of the broadcast, so you never have to alt-tab into TSH's window mid-set. It shows:

- **Health** — whether the bridge is talking to TSH, to your Slippi source, and to OBS.
- **Current Set** — the loaded set, the live score, and the **Start Set on start.gg** and **Report to start.gg** buttons. See [Reporting to start.gg](#reporting-to-startgg).
- **Port → Team** — the current port→team guess, the player name if known, and *how* it was decided (name / character / score = confident; **positional = a low-confidence guess to verify** before the game starts). Three buttons: **⇄ Swap Teams** (same as `Ctrl+Shift+S`), **⇆ Switch Sides**, and **↻ Re-detect Players** — see [Port→Team Assignment](#portteam-assignment) for which one you want.
- **Upcoming Sets** — the open sets from your bracket, one tap to load. **pull next match** takes the next set off the stream queue instead. Neither needs TSH's UI. The list refreshes on a slow timer on purpose (each refresh is an uncached start.gg query), so use the **↻** when you know something changed.
- **Bracket** — **Singles Bracket** / **Doubles Bracket**, one press to point TSH at this week's event for that format. See [Switching brackets](#switching-brackets).
- **Combo Clipper** — the master switch, the OBS connection, the thresholds, and the recently-saved clips. See [Combo Clipper](#combo-clipper).

Every section collapses, and stays collapsed when you reopen the dock, so it survives being squeezed next to the OBS preview. It's responsive too — the same URL works from a phone or tablet at `http://<lan-ip>:5001/control`, and the bridge prints the LAN addresses to use at startup.

## Reporting to start.gg

If you set a start.gg token in `config.local.js` (see [Setup step 2](#2-configure)), the control panel can report a finished set back to your bracket so you don't have to re-enter it on the start.gg website.

When a set loaded from start.gg has been played out, click **Report to start.gg**. The panel shows the winner and score it detected and asks you to confirm before anything is sent — reporting is always manual, never automatic. On confirm, it submits the result (winner derived from the live scoreboard score, with per-game detail when available).

The button stays disabled, with the reason shown, when there's nothing valid to report — no token configured, a manually-entered exhibition set with no start.gg set behind it, a set that hasn't started on start.gg yet, or a tied score. Singles and doubles are both supported.

**Start Set on start.gg** sits above it on the same card and does the opposite end of the job: it runs start.gg's own "Start match" for the set you already have loaded, so you don't open the bracket page just to press it. It only appears while start.gg still has the set as not-started or called — the moment it's in progress or finished, the button goes away rather than sitting there disabled.

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

The dock's **⇆ Switch Sides** button presses that same TSH button for you, so you can do it without leaving the dock. It is **not** the same as **⇄ Swap Teams**: Switch Sides moves both players' names *and scores* to the other column of the scoreboard, while Swap Teams only changes which Slippi port the bridge scores for which team. Use Swap Teams when the right names are on the right sides but the points are landing on the wrong one.

### ↻ Re-detect Players

For the case the automatic chain can't cover: **a new set's game 1 is already running while the previous set's names are still on the scoreboard.** Everything the bridge knows about the ports belongs to the old set — the names are wrong, and the team guess was made against the old set's characters — and nothing self-corrects until the *next* game start, by which point game 1's point has already been awarded, possibly to the wrong player.

So: enter the real names in TSH, then press **↻ Re-detect Players**. The bridge throws the whole mapping away and re-derives it from TSH's current names and characters — the same thing it does at the start of a set, which is why entering the names first matters (TSH then holds the right registered characters for those players, and characters are what it matches on).

The toast tells you which ports it landed on and how it decided. If it says `positional`, no character match was found and the result is a coin flip — check it. If the sides came out reversed, press **⇄ Swap Teams**.

It needs a game to be running; pressed between games it says so and changes nothing, because the next game start re-derives on its own anyway. There's no automatic trigger — a 2-second poll can't tell a corrected name from a half-typed one.

## Switching brackets

If your stream alternates formats, the dock's **Singles Bracket** and **Doubles Bracket** buttons point TSH at the right event in one press, instead of opening start.gg and pasting a link.

Nothing about this changes week to week. `config.js → BRACKETS` holds your series' **short link** (`start.gg/100-acres`) plus a couple of keywords per format; the TO re-points that short link at each new tournament, and the bridge follows it — resolving the link, looking up that tournament's real event list, and matching the event by keyword.

Two behaviours worth knowing:

- **A green toast doesn't mean the bracket is loaded.** TSH answers before its background thread finishes fetching. The **Bracket** card's tournament and event name are the real confirmation — they change only once TSH's provider has actually answered.
- **If the keywords match two events, it refuses** and names both rather than guessing. A tournament with "Melee Singles" and "Melee Singles Amateur" needs a more specific keyword list. Guessing wrong is silent and puts the wrong bracket on the broadcast.

Switching is non-destructive — the loaded set's names, scores and set id all survive, so a set you're partway through is unaffected and a pending report still targets the right set. That's why there's no confirmation prompt. Pressing the same button twice just re-pulls the bracket.

## Combo Clipper

The bridge watches for notable combos **as the game is happening** and asks OBS to save its replay buffer, so the clip already exists by the time the point is over. `obs-scripts/auto_replays.py` then collects those clips into a playlist for your break scene.

### Setup

1. **OBS → Settings → Output → Replay Buffer** — enable it, and set the length to **20 seconds or more**. This isn't optional: combos routinely run 6–9 seconds and the bridge deliberately waits a couple more so the kill and the reaction land in the clip. A 10-second buffer loses the start of the combo.
2. **OBS → Tools → WebSocket Server Settings** — enable it, note the port (4455) and the password.
3. In the dock's **Combo Clipper** card, paste the WebSocket address and password and your replay output folder, then **Save settings**.
4. Flip the clipper **on** and press **Test clip now**. A clip should hit the folder and show up in the panel's recent list. Do this before a bracket starts — it proves the whole chain in one press.

### Tuning

Every setting is live-editable from the dock; no restart. `config.js → CLIPPER` only holds the starting values, and your edits are saved to `clipper-settings.json` (gitignored, since it holds the OBS password).

| Setting | What it does |
|---|---|
| **Min moves** / **Min damage** | How big a combo has to be to qualify |
| **Require kill** | Only clip combos that actually took a stock |
| **Combo window** | Judge only the *last* N seconds of a combo instead of the whole thing — see below |
| **Cooldown** | Minimum gap between saves, so one exchange doesn't bank five near-identical clips |
| **Max clips per game** | Caps a blowout. `0` = unlimited |
| **Save delay** | How long to wait after detecting, so the kill animation is in the clip |
| **Notify side panel** | The "clip saved" pill on the broadcast overlay |

**The combo window is the setting worth understanding.** A combo doesn't end when the pressure stops — Slippi keeps it open until the victim gets back to neutral or dies, so an offstage chase counts as *one* 30-second combo that's mostly dead air. Judged as a whole, it qualifies on the strength of an opening burst that has already fallen out of the replay buffer by the time the clip saves, and you get a clip that doesn't contain the thing that earned it. Set a window (try 8–10 seconds, comfortably under your buffer length) and the thresholds are measured over the closing seconds instead, so what qualifies and what gets captured are the same footage.

> **Clips are singles only.** Slippi's own stats library only computes combos for 2-player games, so doubles produces nothing at all. This is upstream of this repo and can't be worked around — the dock says so rather than leaving you waiting.

### Playing the clips back

Add a **VLC Video Source** (64-bit VLC required) or a Media Source to your break scene, then load `obs-scripts/auto_replays.py` via **OBS → Tools → Scripts** and point it at your replay folder and that source. It builds the playlist from the newest clips whenever you switch to the scene.

Check the Scripts window's **Python Settings** tab first — OBS is picky about which Python version it will load, and it's not necessarily the newest one you have installed.

## Replay scene frame

`layout/highlights/highlights.html` is a 1920 × 1080 overlay for the break/replay scene: it frames the clip window and the two player cams and titles the scene. It's **decoration only** — it reads no TSH state and no bridge events, so it has nothing to break mid-stream. (Nothing in the system knows which clip VLC is currently playing, so on-screen combo credit would be wrong as often as right.)

The one thing it needs is for its geometry to match your OBS source positions, or you get a visible gap between the frame and the footage. Rather than editing CSS, pass the numbers straight from OBS's **Edit Transform** dialog on the browser source URL:

```
?clip=x,y,w,h       the clip window
?cam=y,w,h          both cams (they share these; only x differs)
?camx=leftX,rightX  each cam's x
?pad=clipPad,camPad frame thickness
```

Defaults match a clip at `480,140` `960×800` with cams at `0,288` and `1520,288`, each `400×504`.

Add **`?guides=1`** to outline each frame's transparent hole and label it with its measured rectangle — hold that against OBS and the alignment is obvious. `?animate=false` freezes the title animation, same as the side panel.

## Theme packs

A theme is a self-contained folder, so running a different tournament doesn't mean edits scattered across the layouts:

```
layout/theme.css                   ← a one-line switch naming the active pack
layout/themes/hundred-acres/
  theme.css                        every colour token, the @font-face, both logo URLs
  logo.png                         tournament logo
  sponsor.png                      sponsor / venue logo
  fonts/                           the brand font, self-hosted
```

`main.css` imports `theme.css`, and every layout links `main.css`, so switching the one `@import` re-skins every overlay at once. Refresh the OBS browser sources and you're done.

**To start a new event:** copy an existing pack folder, change its colours and drop in the new artwork, then point `layout/theme.css` at it. The convention is to do this on a branch named `event/<slug>` — master never touches `theme.css` or the pack folders, so merging master into an event branch stays conflict-free and checking out a branch re-skins the broadcast.

One gotcha when copying a pack: the two logo URLs inside its `theme.css` contain the pack's own folder name, so they need editing too. `scripts/preflight.js` resolves both and fails if they don't point at real files — a missing logo is otherwise invisible until it's on stream.

## Per-Game Stage Tracking

Requires TSH 5.972 or newer.

TSH's Individual Game Tracker keeps a per-game record of the stage, characters, and winner. The bridge reads the stage out of each `.slp` and pushes it automatically at game start, so the tracker fills itself in as the set plays out — nothing to enter by hand.

Characters are handled too, without extra work: TSH copies the current scoreboard character selection into each game's slot, and the bridge is already setting that.

This is cosmetic. If a stage can't be identified the bridge logs a warning and moves on — scoring is never affected.

## How the bridge reads the game

The bridge polls `SLP_FOLDER` every 500ms for new `.slp` files and reads the one Slippi is currently writing, so it sees characters, stages, scores and combos as the game happens.

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
| Tournament logo | `logo.png` from the active theme pack (`layout/themes/<pack>/`) |
| Player 1 | Recent tournament placements + current run results |
| Player 2 | Same for player 2 |
| Recent Sets | Head-to-head set record between the two players |
| Sponsor logo | `sponsor.png` from the active theme pack |
| Just Finished | Most recently completed sets at the tournament |
| Up Next | Stream queue |

Both logos come from the active **theme pack**, not from the layout — the panel styles them with `--logo-url` / `--sponsor-url`, so re-skinning an event never means editing `side-panel.js`. See [Theme packs](#theme-packs). The rotation interval is `PANEL_INTERVAL` at the top of `side-panel.js` (default 20 seconds).

When the combo clipper saves a clip, a small pill slides in over the bottom edge of the bottom card naming the player and the combo, holds a few seconds, and slides out. Only successful saves ever reach the broadcast — clip errors go to the operator's dock instead. Turn the pill off with `notifySidePanel` in the dock's clipper card.

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

**Points landing on the wrong player:** press **⇄ Swap Teams** in the dock (or Ctrl+Shift+S). If it's a new set whose names you entered late, enter them in TSH first and press **↻ Re-detect Players** instead — that re-derives the whole mapping rather than just flipping it.

**Overlay looks like stock TSH:** a TSH release zip overwrote `layout/`. Restore it with `git checkout -- "TournamentStreamHelper-*/layout/"`.

**Overlay renders unstyled:** the theme pack is missing or `layout/theme.css` names a pack that isn't there. `node slippi-bridge/scripts/preflight.js --offline` will say which.

**Clipper never fires:** in order of likelihood — it's a doubles set (structurally impossible, see [Combo Clipper](#combo-clipper)), the replay buffer isn't running, or the thresholds are too high. Press **Test clip now** to separate an OBS problem from a threshold problem.

**Clips start mid-combo:** the OBS replay buffer is shorter than 20 seconds.

**Highlights frame doesn't line up with the footage:** open it with `?guides=1` and compare the labelled rectangles against OBS's Edit Transform values.

**Side panel not loading tournament data:** Make sure TSH is running and `out/program_state.json` exists. The side panel polls TSH state directly — it does not need the bridge to be running, but TSH must be up.

**Control panel is blank or shows everything offline:** The panel is served by the bridge, so the bridge must be running (`start-all.bat` or `start-bridge.bat`). The TSH health dot goes green once TSH's API responds; the Slippi dot goes green once the watched `SLP_FOLDER` is readable.

**Report button is greyed out:** Hover for the reason. Common causes: no start.gg token in `config.local.js`, the loaded set was entered manually (no start.gg set behind it), the set hasn't started on start.gg yet, or the score is tied.

**Start Set button isn't there:** it only shows while start.gg has the set as not-started or called. If the bracket hasn't been started on start.gg at all, every set id is a `preview_…` placeholder and there is nothing to start yet — the same reason reporting is blocked there.

**Score incremented on a warm-up game:** The handwarmer threshold may need tuning. Check `slippi-bridge/lib/handwarmer.js` — the weighted score cutoff is at the top of the file.
