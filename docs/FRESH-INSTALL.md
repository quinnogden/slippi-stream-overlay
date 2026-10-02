# Fresh Install Checklist

For bringing this repo up on a **new machine**, a **fresh OBS profile**, or a machine **moving over from TSH**.

## How to use this

Say to Claude Code:

> **Run the fresh-install checklist.** *(optionally: "just OBS" / "just verify")*

Claude does every step marked **[claude]** — file checks, config audits, probes — and reports a pass/fail line per item. Steps marked **[you]** are GUI or credential work nobody else can do; Claude will stop and ask for them at the right point rather than guessing.

Work the phases in order. The player file (Phase 2) and the replay buffer (Phase 5) are the two things that look like "it's broken" much later if skipped.

### The script that does the mechanical half

```bash
cd app
node scripts/preflight.js              # everything, including live probes
node scripts/preflight.js --offline    # files and config only — no network
node scripts/preflight.js --json       # machine-readable
```

[preflight.js](../app/scripts/preflight.js) automates Phases 2 and 7: dependencies, config, the hotkeys, the player file, the icons, the overlay pages, the theme pack, the clipper settings, then live probes of the app, the start.gg token, this week's short link and both bracket buttons, and OBS (including the replay buffer's length). It exits non-zero if anything fails.

It is **read-only** — it prints the exact command or menu path to fix each finding rather than changing anything itself. It also runs before `npm install`, so it can diagnose a missing `node_modules`.

---

## Phase 0 — What a fresh clone actually contains **[claude]**

| Present after clone | Missing — must be installed or made |
|---|---|
| `app/` — the app, `config.js`, `config.local.example.js` | `app/node_modules/` → `npm install` (`start.bat` does it on first run) |
| `overlays/` — every OBS page, the theme packs, the character icons | `app/config.local.js` → copy from `config.local.example.js` |
| `start.bat` | `app/data/local_players.json` — this machine's player DB (Phase 2) |
| `obs-scripts/auto_replays.py` | `app/clipper-settings.json` → written by the dock's Clips tab on first save (optional) |

`app/data/` (the player file and the saved live scoreboard), `stats-cache/` and `clipper-settings.json` are per machine and gitignored.

---

## Phase 1 — Prerequisites **[you]**

- [ ] **Node.js 18+** — `node -v`
- [ ] **Slippi Desktop App** installed
- [ ] **OBS 28+** (obs-websocket v5 is built in from 28 onward)
- [ ] **VLC, 64-bit** — only if you want the break-scene clip playlist. 32-bit VLC will not give OBS a `vlc_source`.
- [ ] **Python** for OBS scripting — see Phase 6; the version has to be one *your* OBS build accepts, which is not necessarily the newest you have installed.

TSH is **not** needed. On a machine moving over from it, keep the old TSH folder for a couple of events as a rollback, but don't run it while the app is up.

---

## Phase 2 — App files **[claude]**, credentials **[you]**

- [ ] `cd app && npm install`
- [ ] Confirm all six deps resolve: `@slippi/slippi-js`, `axios`, `express`, `obs-websocket-js`, `socket.io`, `uiohook-napi`
      *(`uiohook-napi` is a native module — if it fails to build, the global hotkeys fall back to keys typed into the app's own window and everything else still works. Report it, don't treat it as fatal.)*
- [ ] Create `config.local.js` from `config.local.example.js` if absent
- [ ] **[you]** Paste a start.gg token into `config.local.js` — generate at [start.gg → Developer Settings](https://start.gg/admin/profile/developer). Viewable once; expires after a year. **Never** put it in `config.js`, which is committed. Without one the brackets still load (start.gg's keyless web endpoint), but Start, Report and the side panel's player stats are off.
- [ ] **[you]** Set `SLP_FOLDER` in `config.local.js` to this machine's Slippi spectate folder. The committed default is another machine's, and the app exits at startup if the folder doesn't exist.
- [ ] **The player DB.** It is TSH's `local_players.json` format, and each machine has its own:
  - moving from TSH: copy the old install's `user_data/local_players.json` to `app/data/local_players.json` — preflight prints the exact `copy` command when it finds one beside the repo. **Copy, don't point at it**: TSH rewrites the whole file on save.
  - or set `PLAYERS_FILE` in `config.local.js` to wherever this machine keeps it;
  - or start empty: players are added from start.gg as their sets load, and their mains are learned as they play.
- [ ] `BRIDGE_PORT` stays 5001 unless there's a reason — every OBS source names it
- [ ] *Optional* `HOTKEYS` in `config.local.js`, per action (each chord needs Ctrl, Alt or Win; `null` turns one off). Preflight checks them.

---

## Phase 3 — Slippi **[you]**

- [ ] Slippi Desktop App running, connected in **mirror/spectate** mode
- [ ] It is writing a live `.slp` into `SLP_FOLDER` (start a game and watch a file appear)
- [ ] **[claude]** With the app running, the dock's **Slippi** light is green and a game start logs `[bridge] New game file: …`

> If `SLP_FOLDER` is a OneDrive path, know that a *finished* replay syncing in from another machine can land there mid-session. The parser has a guard for it (`[bridge] Parser read past EOF … rebuilding`) — that log line is the guard working, not a fault.

---

## Phase 4 — Start the app **[you]**

Double-click **`start.bat`** at the repo root (or `node index.js` in `app/`). The console lists the dock url, the phone urls, the player file and its count, the event it reloaded, and the hotkeys it bound. Closing the window stops the app.

Start it **before** OBS, or refresh the browser sources after: a source whose page failed to load doesn't retry. Once loaded, sources survive app restarts.

---

## Phase 5 — OBS **[you]**

### Browser sources

The dock's **Setup** tab lists every url with a copy button. All are on the app's one port:

| Source | URL | Size | Notes |
|---|---|---|---|
| Scoreboard | `http://localhost:5001/o/scoreboard` | 1920 × 1080 | |
| Players bar | `http://localhost:5001/o/scoreboard/players` | 1920 × 1080 | |
| Side panel | `http://localhost:5001/o/side-panel` | 611 × 1080 | Webcam layered **behind** it, in the transparent 587 × 330 cutout. `?animate=false` drops the ambient animation |
| Bracket | `http://localhost:5001/o/bracket` | 1920 × 1080 | Follows the dock's Bracket tab; `?view=top8` (`winners`, `losers`, `top16`, `full`) pins one |
| Highlights | `http://localhost:5001/o/highlights` | 1920 × 1080 | The replay/break scene frame; see below |
| Casters | `http://localhost:5001/o/casters` | any | Every caster in a row; `?i=0`, `?i=1` … for one per cam |

- [ ] Canvas **1920 × 1080** (Settings → Video)
- [ ] On each source: **uncheck "Shutdown source when not visible"** and **"Refresh browser when scene becomes active"** — otherwise the side panel's rotation and the socket restart on every scene change
- [ ] Moving from TSH: every old source pointed at `localhost:5000/layout/…` or a local file in the TSH folder. Re-enter each one from the table; the old ones show nothing once TSH is gone.
- [ ] **Highlights geometry** must match the clip and cam sources' transforms or you get a visible gap between frame and footage. Don't edit CSS — copy the numbers out of OBS's **Edit Transform** and pass them on the URL (`?clip=x,y,w,h&cam=y,w,h&camx=leftX,rightX`), then load it once with `?guides=1` to check the labelled rectangles against OBS. Defaults assume clip `480,140 960×800` and cams at `0,288` / `1520,288`, each `400×504`.

### Operator dock
- [ ] Docks → Custom Browser Docks → name it, URL `http://localhost:5001/dock`
- [ ] Phone or tablet: the startup log and the Setup tab list `http://<ip>:5001/dock` per network — the Tailscale address first, since it survives venue Wi-Fi with client isolation

### Replay buffer — required for the combo clipper
- [ ] Settings → Output → Replay Buffer → **enabled**
- [ ] Buffer length **≥ 20 seconds**. Not optional: conversions run 6–9s and the clipper waits `saveDelayMs` (~2.5s) after detection, so a 10s buffer loses the start of the combo.
- [ ] Note the replay output path — you'll paste it into the dock and the OBS script
- [ ] **Start the replay buffer** (or leave the Clips tab's *Auto-start OBS buffer* on, which starts it on the first combo — that first combo is not captured, and the app says so)

### obs-websocket
- [ ] Tools → WebSocket Server Settings → **Enable WebSocket server**, port **4455**
- [ ] Show Connect Info → copy the password
- [ ] In the dock's **Clips** tab: the URL (`ws://127.0.0.1:4455`), the password, and the replay folder → **Save**
- [ ] Turn the clipper **on**, then press **Test clip** — a clip should hit the folder and appear in the recent list. Do this *before* a bracket starts; it proves the whole chain.

> Clips are **singles only**. slippi-js computes conversions only for 2-player games, so doubles produces no clips at all — that's upstream and unfixable here.

---

## Phase 6 — OBS playlist script **[you]** + **[claude]**

Only needed if you want saved clips auto-collected into a break-scene playlist.

1. **[you]** Tools → Scripts → **Python Settings** tab → point at a Python install. **Check which versions this OBS build accepts before assuming** — OBS loads Python as a DLL and is picky. If the tab won't accept your only install, that's the blocker to solve first.
2. **[you]** Add a **VLC Video Source** (or Media Source) to the break scene.
3. **[you]** Scripts tab → `+` → [obs-scripts/auto_replays.py](../obs-scripts/auto_replays.py)
4. **[you]** Fill in: clip folder, the playlist source, the break scene, max clips (default 8), newest-first, keep-across-scenes.
5. **[claude]** Verify: save two test clips, switch to the break scene → both play in order; switch away and back → playlist resets (unless keep-across-scenes is on).

The script is event-driven off OBS's own `REPLAY_BUFFER_SAVED`, so it picks up clips the instant they exist. Folder polling is an opt-in fallback for clips arriving from somewhere other than OBS.

---

## Phase 7 — End-to-end verification **[claude]**

```bash
cd app && node scripts/preflight.js
```

With the app and OBS up, every live section should pass: the app identifies itself, an event is loaded, the Slippi folder is watched, the hotkeys bound **globally**, the token is accepted, the short link resolves to this week's tournament and both bracket buttons find exactly one event, and OBS's replay buffer is running and long enough. Then by eye:

- [ ] The dock's three health lights are green, and it keeps updating (lights dim after ~12s without a status)
- [ ] Typing a caster name survives a few seconds of pushes without being overwritten
- [ ] The scoreboard source shows the loaded set's names; the side panel shows the tournament name and rotates
- [ ] **Test clip** → the toast slides in over the side panel's bottom card and back out, leaving nothing stuck on screen
- [ ] The dock opens from a phone at the logged address

---

## Phase 8 — Dry run before doors open **[you]**

- [ ] Press **Singles** in the Bracket tab; load a playable set from the Set tab
- [ ] Play one real game start to finish: characters update, the score goes to the **right** player
- [ ] Check the dock's ports badge — `character` and `manual` are confident; **amber `positional` is a guess to verify before game 1**. Wrong? ⇄ Ports (swap ports) fixes it for the rest of the set.
- [ ] Press each hotkey once by hand and watch the `[hotkey]` line and the dock agree
- [ ] Play a handwarmer (both players quit out early): characters update, **score does not**
- [ ] Switch sides (⇆ Sides) and back: names, score and characters cross together
- [ ] If reporting: play a set out on a throwaway tournament and report it, then confirm on start.gg — never against a live bracket as a test

---

## Quick reference

| | |
|---|---|
| Start | `start.bat` at the repo root |
| Dock | `http://localhost:5001/dock` (the Setup tab has every url) |
| Overlays | `http://localhost:5001/o/…` |
| obs-websocket | `ws://127.0.0.1:4455` |
| Hotkeys (defaults) | `Ctrl+Shift+S` swap ports · `Ctrl+Shift+X` switch sides · `Ctrl+Shift+1`/`2` a game to left/right · add `Alt` to take one away |
| Player DB | `app/data/local_players.json`, or `PLAYERS_FILE` |

**Never commit:** `config.local.js` (start.gg token), `clipper-settings.json` (OBS password + per-venue tuning), `data/` (players, live state). All gitignored; `config.js` is not, so no secrets there.

**Symptom → cause shortcuts**

| Symptom | First thing to check |
|---|---|
| App exits at startup | `SLP_FOLDER` doesn't exist on this machine (Phase 2) |
| Every player opens on no character, no pronouns | No player file — the startup log warns; Phase 2 |
| An OBS source is blank | It was added before the app started — refresh it; or it still points at TSH's `localhost:5000` |
| Unstyled overlay / missing logo | The theme pack (`overlays/theme.css`) — preflight checks it |
| Brackets load but Start/Report are off | No start.gg token, or it expired — preflight's live check says which |
| Hotkeys do nothing | uiohook-napi didn't load (the Setup tab says "terminal"), or another app took the chord |
| Clipper never fires | Doubles (structurally impossible), buffer off, or thresholds too high |
| Clips exist but start mid-combo | Replay buffer shorter than 20s (Phase 5) |
| Port 5001 in use | Handled automatically for a stale copy of the app; anything else on 5001 and it refuses to start and says so |

---

*See [../README.md](../README.md) for what each feature does, [../CLAUDE.md](../CLAUDE.md) for the architecture and the non-obvious constraints behind these steps, and [TESTING.md](TESTING.md) for verifying a change without a live tournament.*
