# Fresh Install Checklist

For bringing this repo up on a **new machine**, a **fresh TSH extract**, or a **fresh OBS profile**.

## How to use this

Say to Claude Code:

> **Run the fresh-install checklist.** *(optionally: "just the TSH part" / "just OBS" / "just verify")*

Claude does every step marked **[claude]** — file checks, generated files, config audits, HTTP probes — and reports a pass/fail line per item. Steps marked **[you]** are GUI or credential work nobody else can do; Claude will stop and ask for them at the right point rather than guessing.

Work the phases in order. Phase 4's TSH settings and Phase 6's replay buffer are the two things that look like "it's broken" much later if skipped.

### The script that does the mechanical half

```bash
cd slippi-bridge
node scripts/preflight.js              # everything, including live probes
node scripts/preflight.js --offline    # files and config only — no network
node scripts/preflight.js --json       # machine-readable
```

[preflight.js](../slippi-bridge/scripts/preflight.js) automates Phases 3, 4 and 8 and parts of Phase 2: dependency resolution, config, the TSH install and `user_data`, layout integrity, the four `general` settings, then live probes of TSH, the bridge and OBS (including the replay buffer's length). It exits non-zero if anything fails.

It is **read-only** — it prints the exact command or menu path to fix each finding rather than changing your tournament config itself. It also runs before `npm install`, so it can diagnose a missing `node_modules`.

Run it after Phase 3, again after Phase 4, and once more at Phase 8 with everything up. Phases 1, 5, 6, 7 and 9 are GUI and judgement work it can't do for you.

---

## Phase 0 — What a fresh clone actually contains **[claude]**

`git clone` gives you the bridge, the custom layouts, and the OBS script. It does **not** give you TSH itself, node modules, or any operator data — those are gitignored.

| Present after clone | Missing — must be installed or generated |
|---|---|
| `slippi-bridge/*.js`, `package.json`, `.bat` launchers | `slippi-bridge/node_modules/` → `npm install` |
| `slippi-bridge/public/control-panel.html` | `slippi-bridge/config.local.js` → copy from `config.local.example.js` |
| `slippi-bridge/config.local.example.js` | `slippi-bridge/clipper-settings.json` → written by the control panel on first save (optional) |
| `obs-scripts/auto_replays.py` | The entire TSH app: `TSH.exe`, `src/`, `assets/`, `dependencies/`, `out/` |
| `TournamentStreamHelper-*/layout/` — the whole tracked layout tree, including `main.css`, `theme.css` and `themes/<pack>/` (the active theme pack: tokens, both logos, the brand font) | `TournamentStreamHelper-*/user_data/` — icons, settings, player DB, pronouns |

Claude verifies this with `git ls-files` and `git status`, and lists exactly which of the right-hand column are absent on this machine.

---

## Phase 1 — Prerequisites **[you]**

- [ ] **Node.js 18+** — `node -v`
- [ ] **A TSH release** downloaded (matching or newer than the folder name in the repo — currently `TournamentStreamHelper-5.972`)
- [ ] **Slippi Desktop App** installed
- [ ] **OBS 28+** (obs-websocket v5 is built in from 28 onward)
- [ ] **VLC, 64-bit** — only if you want the break-scene clip playlist. 32-bit VLC will not give OBS a `vlc_source`.
- [ ] **Python** for OBS scripting — see Phase 7; the version has to be one *your* OBS build accepts, which is not necessarily the newest you have installed.

---

## Phase 2 — Put TSH in place **[you]** + **[claude]** to verify

> ### ⚠ The one that bites
> The repo tracks `TournamentStreamHelper-5.972/layout/`. A TSH release zip **also** contains a `layout/` folder. Extracting the release directly over the repo folder replaces every custom layout with TSH's stock ones, and OBS will happily show you the wrong overlay with no error anywhere.

1. **[you]** Extract the release to a scratch location first — *not* on top of the repo folder.
2. **[you]** Copy everything **except** `layout/` into the repo's `TournamentStreamHelper-<version>/` folder.
3. **[claude]** Verify the layouts survived:
   ```bash
   git status --short "TournamentStreamHelper-*/layout/"
   ```
   Clean = good. Any `M` or `D` lines mean stock TSH landed on top, and the fix is:
   ```bash
   git checkout -- "TournamentStreamHelper-*/layout/"
   ```
4. **[you]** Copy operator data from your previous install's `user_data/` (a fresh extract creates these as *empty stubs*, so "the file exists" is not evidence this was done):
   - [ ] `games/` — character + stage icons. Without these, **no icons render at all**.
   - [ ] `settings.json` — tournament URL, ports, the flags in Phase 4.
   - [ ] `local_players.json` — the player database (a real one is tens of KB; a stub is `{}`).
   - [ ] `pronouns_list.txt`
5. **[claude]** Sanity-check what landed:
   - `TSH.exe` or `TSH_bat.bat` or `main.py` present, plus `layout/` → this is what `resolveTshRoot()` looks for
   - `user_data/games/ssbm/base_files/icon/` is non-empty
   - `user_data/local_players.json` is larger than 2 bytes
   - if the version folder changed, confirm `.gitignore` still matches it via the `TournamentStreamHelper-*` glob (it is version-independent by design — do not pin it)

---

## Phase 3 — Bridge files **[claude]**

- [ ] `cd slippi-bridge && npm install`
- [ ] Confirm all six deps resolve: `@slippi/slippi-js`, `axios`, `express`, `obs-websocket-js`, `socket.io`, `uiohook-napi`
      *(`uiohook-napi` is a native module — if it fails to build, the global `Ctrl+Shift+S` hotkey degrades to pressing `S` in the terminal and everything else still works. Report it, don't treat it as fatal.)*
- [ ] Create `config.local.js` from `config.local.example.js` if absent
- [ ] **[you]** Paste a start.gg token into `config.local.js` if you want result reporting — generate at [start.gg → Developer Settings](https://start.gg/admin/profile/developer). Viewable once; expires after a year. **Never** put it in `config.js`, which is committed.
- [ ] **[you]** Confirm `SLP_FOLDER` in [config.js](../slippi-bridge/config.js) is this machine's Slippi spectate folder. Currently `C:/Users/ogden/OneDrive/Documents/Slippi/Spectate/quinn`. On a different machine, override it in `config.local.js` rather than editing the committed default.
- [ ] `TSH_URL`, `SCOREBOARD_NUM`, `TSH_ROOT`, `BRIDGE_PORT` stay at defaults unless there's a reason
- [ ] Claude confirms the folder in `SLP_FOLDER` exists and is readable — the bridge `process.exit(1)`s on startup if it doesn't

---

## Phase 4 — TSH settings audit **[claude]**, fixes **[you]**

Four keys in `user_data/settings.json` under `general`. Claude reads and reports each; you change them in TSH's UI (Settings → General) or Claude edits the JSON with TSH closed.

| Key | Required | Why it matters |
|---|---|---|
| `webserver_port` | **`5000`** | TSH 5.972's default is **5500**. Every OBS browser source and `config.TSH_URL` in this repo uses 5000. Wrong value = `start-all.bat` hangs 60s and reports TSH never came up, while TSH is running perfectly on another port. |
| `disable_autoupdate` | **`true`** | Off, TSH starts a 5-second timer that re-pulls the selected set from start.gg. |
| `disable_scoreupdate` | **`true`** | Off, that same auto-update **writes start.gg's scores into the scoreboard**, fighting the scores the bridge is driving from live games. (`TSHScoreboardWidget.py:1218`) |
| `hide_track_player` | `true` | Cosmetic — hides start.gg player tracking UI. |

- [ ] **[you]** `TOURNAMENT_URL` set to the event you're running, if you want bracket/queue/side-panel data
- [ ] **[you]** *(cosmetic, per-machine)* `main_icon_path` — TSH's own window/widget icon. It defaults to `./layout/logo.png`, which is the Hundred Acres logo regardless of which theme pack is active, because `settings.json` is gitignored. Point it at `./layout/themes/<active-pack>/logo.png` if you care. Nothing on the broadcast reads this — the overlays get their logos from the pack's `--logo-url` / `--sponsor-url`.
- [ ] **[claude]** After TSH's first launch, confirm it generated `out/program_state.json` and `out/tournamentInfo/tournamentName.txt` (the side panel's header reads the latter)

---

## Phase 5 — Slippi **[you]**

- [ ] Slippi Desktop App running, connected in **mirror/spectate** mode
- [ ] It is writing a live `.slp` into `SLP_FOLDER` (start a game and watch a file appear)
- [ ] **[claude]** With the bridge running, the control panel's **Slippi** dot is green and a game start logs `[bridge] New game file: …`

> If `SLP_FOLDER` is a OneDrive path, know that a *finished* replay syncing in from another machine can land there mid-session. The parser has a guard for it (`[bridge] Parser read past EOF … rebuilding`) — that log line is the guard working, not a fault.

---

## Phase 6 — OBS **[you]**

### Scene sources
- [ ] Canvas **1920 × 1080** (Settings → Video)
- [ ] **Scoreboard** browser source → `http://localhost:5000/layout/scoreboard/melee.html` at **1920 × 1080**
      *Use `melee.html` — there is no `index.html` here, and only `melee.html` loads the bridge's Socket.io client.*
- [ ] **Side panel** browser source → `http://localhost:5000/layout/side-panel/side-panel.html` at **611 × 1080**
      Add `?animate=false` to drop the ambient animation.
- [ ] **Webcam source layered behind** the side panel — the panel has a transparent **587 × 330** cutout for it
- [ ] *Optional* bracket sources → `http://localhost:5000/layout/bracket/index.html` (also `index_expanded`, `winners_only`, `losers_only`) at 1920 × 1080
- [ ] *Optional* **replay/break scene frame** → `http://localhost:5000/layout/highlights/highlights.html` at 1920 × 1080, layered over the clip source and the two cams.
      Its geometry must match those sources' transforms or you get a visible gap between frame and footage. Don't edit CSS — copy the numbers out of OBS's **Edit Transform** and pass them on the URL (`?clip=x,y,w,h&cam=y,w,h&camx=leftX,rightX`), then load it once with `?guides=1` to check the labelled rectangles against OBS. Defaults assume clip `480,140 960×800` and cams at `0,288` / `1520,288`, each `400×504`.
- [ ] On each overlay browser source: **uncheck "Shutdown source when not visible"** and **uncheck "Refresh browser when scene becomes active"** — otherwise the side panel's 20s rotation and the bridge socket restart every scene change

### Operator dock
- [ ] Docks → Custom Browser Docks → name it, URL `http://localhost:5001/control`
- [ ] Confirm the sections collapse and that the collapsed set survives closing and reopening the dock (it persists in `localStorage`)

### Replay buffer — required for the combo clipper
- [ ] Settings → Output → Replay Buffer → **enabled**
- [ ] Buffer length **≥ 20 seconds**. Not optional: conversions run 6–9s and the clipper waits `saveDelayMs` (~2.5s) after detection, so a 10s buffer loses the start of the combo.
- [ ] Note the recording/replay output path — you'll paste it into the dock and the OBS script
- [ ] **Start the replay buffer** (or leave the dock's *Auto-start OBS buffer* on, which starts it on the first combo — that first combo is not captured, and the bridge says so)

### obs-websocket
- [ ] Tools → WebSocket Server Settings → **Enable WebSocket server**, port **4455**
- [ ] Show Connect Info → copy the password
- [ ] In the dock's **Combo Clipper** card: paste the URL (`ws://127.0.0.1:4455`), the password, and the replay folder → **Save settings**
- [ ] Flip the clipper **on**, then press **Test clip now** — a clip should hit the folder and appear in the panel's recent list. Do this *before* a bracket starts; it proves the whole chain.

> Clips are **singles only**. slippi-js computes conversions only for 2-player games, so doubles produces no clips at all — that's upstream and unfixable here.

---

## Phase 7 — OBS playlist script **[you]** + **[claude]**

Only needed if you want saved clips auto-collected into a break-scene playlist.

1. **[you]** Tools → Scripts → **Python Settings** tab → point at a Python install. **Check which versions this OBS build accepts before assuming** — OBS loads Python as a DLL and is picky. If the tab won't accept your only install, that's the blocker to solve first.
2. **[you]** Add a **VLC Video Source** (or Media Source) to the break scene.
3. **[you]** Scripts tab → `+` → [obs-scripts/auto_replays.py](../obs-scripts/auto_replays.py)
4. **[you]** Fill in: clip folder, the playlist source, the break scene, max clips (default 8), newest-first, keep-across-scenes.
5. **[claude]** Verify: save two test clips, switch to the break scene → both play in order; switch away and back → playlist resets (unless keep-across-scenes is on).

The script is event-driven off OBS's own `REPLAY_BUFFER_SAVED`, so it picks up clips the instant they exist. Folder polling is an opt-in fallback for clips arriving from somewhere other than OBS.

---

## Phase 8 — End-to-end verification **[claude]**

Claude runs these and reports each:

```bash
# TSH answering on the port this repo expects
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5000/

# Bridge identity + health
curl -s http://localhost:5001/api/identity     # → { app: "slippi-bridge", pid }
curl -s http://localhost:5001/api/status       # → tsh, slippi, portMapping, tshSwapped, clipper…
```

- [ ] `[bridge] TSH root:` in the startup log names the **correct** TSH folder
- [ ] `/api/status` shows `tsh` up, `slippi` up, and `clipper.obs.connected` if the clipper is on
- [ ] Startup log's LAN control URLs are reachable from a phone (`http://<lan-ip>:5001/control`) — Tailscale address first, since it survives venue Wi-Fi with client isolation
- [ ] Control panel is live-updating (it repaints every 2s; a frozen panel means `render()` threw)
- [ ] Typing in a clipper field survives several 2s ticks without being overwritten
- [ ] Scoreboard browser source shows character icons with correct costumes
- [ ] Side panel shows the tournament name and rotates panels
- [ ] **Test clip now** → toast slides in over the side panel's bottom card and back out, leaving nothing stuck on screen

---

## Phase 9 — Dry run before doors open **[you]**

- [ ] Play one real game start to finish: characters update, the score goes to the **right** player, the stage lands in TSH's game tracker
- [ ] Check the dock's **Port → Team** badge — `name` / `character` / `score` are confident, **amber `positional` is a guess to verify before game 1**
- [ ] Press TSH's **Swap Teams**, confirm the dock notices within ~2s and the mapping re-derives
- [ ] Play a handwarmer (both players quit out early): characters update, **score does not**
- [ ] Load a set from the dock's upcoming-sets picker
- [ ] If reporting: play a set out and report it, then confirm on start.gg. **Reporting is swap-sensitive** — reporting while TSH is swapped without the bridge knowing the swap state publishes the loser as the winner, so the bridge refuses to report when it can't read the swap flag. That refusal is correct behaviour, not a bug to work around.

---

## Quick reference

| | |
|---|---|
| TSH web server | `http://localhost:5000` — pinned in `user_data/settings.json` |
| Bridge / Socket.io / dock | `http://localhost:5001`, panel at `/control` |
| obs-websocket | `ws://127.0.0.1:4455` |
| Launch everything | `slippi-bridge/start-all.bat` (starts TSH, waits for its API, then the bridge) |
| Launch bridge only | `slippi-bridge/start-bridge.bat` |
| Manual port→team swap | `Ctrl+Shift+S` global, or `S` in the terminal as fallback |

**Never commit:** `config.local.js` (start.gg token), `clipper-settings.json` (OBS password + per-venue tuning). Both are gitignored; `config.js` is not, so no secrets there.

**Symptom → cause shortcuts**

| Symptom | First thing to check |
|---|---|
| "TSH did not respond within 60s" but TSH is clearly open | `webserver_port` is 5500, not 5000 (Phase 4) |
| Overlay looks like stock TSH | A release zip overwrote `layout/` (Phase 2) |
| No character or stage icons at all | `user_data/games/` wasn't copied (Phase 2) |
| Scores get overwritten mid-set | `disable_scoreupdate` is false (Phase 4) |
| Clipper never fires | Doubles (structurally impossible), buffer off, or thresholds too high |
| Clips exist but start mid-combo | Replay buffer shorter than 20s (Phase 6) |
| Port 5001 in use | Handled automatically for a stale bridge; anything else on 5001 and it refuses to start and says so |

---

*See [../README.md](../README.md) for what each feature does, [../CLAUDE.md](../CLAUDE.md) for the architecture and the non-obvious constraints behind these steps, and [TESTING.md](TESTING.md) for verifying a change without a live tournament.*
