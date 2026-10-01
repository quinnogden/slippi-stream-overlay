# slippi-stream-overlay

A Melee tournament stream app: it reads live Slippi game data, runs the event from start.gg, owns the scoreboard, serves every OBS overlay, and gives the operator one dock to drive it all from. Characters, costumes and scores update by themselves as games are played; loading a set, switching sides and reporting the result are one press each.

It replaced [Tournament Stream Helper (TSH)](https://github.com/joaorb64/TournamentStreamHelper), which this repo used to feed. There is now one thing to run.

## How It Works

```
Slippi Desktop App → live .slp in SLP_FOLDER
        ↓
slippi-bridge/  (Node.js, one port: 5001)            ← start.bat
  ├─ reads each game as it's played: characters, the winner, handwarmers, big combos
  ├─ the scoreboard: set, names, score, per-game list (survives a restart)
  ├─ start.gg: this week's event via your short link, the set picker, the bracket,
  │            Start / Report, player stats for the side panel
  ├─ the player DB: pronouns, and each player's mains — learned from what they play
  ├─ OBS: saves the replay buffer when a combo lands
  ├─ /o/…   → every OBS browser source (scoreboard, side panel, bracket, casters, highlights)
  └─ /dock  → the operator's dock (an OBS custom dock, or a phone)
```

## What's in the repo

| | |
|---|---|
| `slippi-bridge/` | The app: game reading, the scoreboard, start.gg, the player DB, OBS, and the dock (`public/dock/`). |
| `overlays/` | Every OBS page, the theme packs, and the stock character icons. Served at `/o/`. |
| `start.bat` | Starts the app (installs dependencies on its first run). |
| `obs-scripts/` | Python scripts that run *inside* OBS. Currently just the break-scene clip playlist. Optional. |
| `tests/` | `node tests/run.js`. No framework, nothing to install. Deliberately narrow — see [tests/README.md](tests/README.md). |
| `docs/` | The longer-form docs below. |

Beyond this page: [docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md) for setting up a machine step by step (including moving over from TSH), [docs/TESTING.md](docs/TESTING.md) for verifying a change with no bracket running, [docs/BRIDGE-API.md](docs/BRIDGE-API.md) for the state, event and route shapes, and [CLAUDE.md](CLAUDE.md) for the architecture and the non-obvious constraints behind the code.

## Requirements

- [Node.js](https://nodejs.org) 18+
- **Slippi Desktop App** in spectate/mirror mode, so it writes live `.slp` files to a folder
- **OBS 28+** — 28 is where obs-websocket v5 became built-in, which the [combo clipper](#combo-clipper) needs

Optional, and only for the break-scene clip playlist: **64-bit VLC**, and a Python install [that your OBS build will actually load](#playing-the-clips-back).

## Setup

> On a **new machine**, a **fresh OBS profile**, or **moving over from TSH**? Use [docs/FRESH-INSTALL.md](docs/FRESH-INSTALL.md) — an ordered checklist with a verification pass. `cd slippi-bridge && node scripts/preflight.js` checks the mechanical half of it at any point.

### 1. Clone

```bash
git clone https://github.com/quinnogden/slippi-stream-overlay.git
```

### 2. Configure

Copy `slippi-bridge/config.local.example.js` to `slippi-bridge/config.local.js` (gitignored) and set:

```js
module.exports = {
  STARTGG_TOKEN: "…",                                          // start.gg → Developer Settings
  SLP_FOLDER: "C:/Users/YourName/Documents/Slippi/Spectate/YourName",
};
```

Generate the token at [start.gg → Developer Settings](https://start.gg/admin/profile/developer) (viewable once; expires after a year). Without it the brackets still load, but Start, Report and the side panel's player stats are off. **Never put it in `config.js`**, which is committed.

`config.js` holds the rest, all with working defaults: `BRACKETS` (your series' start.gg short link, for the [Singles / Doubles buttons](#switching-brackets)), `HOTKEYS`, `SET_TEXT` (the Flex / Bo5 rule), `PLAYERS_FILE` and `CLIPPER` (starting values for the [combo clipper](#combo-clipper), tuned from the dock afterwards). Anything per machine goes in `config.local.js` instead.

### 3. The player database

The app keeps players in TSH's `local_players.json` format — tag, prefix, pronouns, twitter, mains — at `slippi-bridge/data/local_players.json` (gitignored; `PLAYERS_FILE` moves it). Moving from TSH, copy the old install's `user_data/local_players.json` there; the file stays compatible both ways. Starting fresh works too: players are added from start.gg as their sets load, and their mains are learned from what they play.

### 4. Run it

Double-click **`start.bat`**. The console lists the dock url, the urls for a phone, the player file, the event it reloaded and the hotkeys it bound. Closing the window stops it.

### 5. OBS

Add each overlay as a Browser Source — the dock's **Setup** tab lists them all with copy buttons:

| Source | URL | Size |
|---|---|---|
| Scoreboard | `http://localhost:5001/o/scoreboard` | 1920 × 1080 |
| Players bar | `http://localhost:5001/o/scoreboard/players` | 1920 × 1080 |
| Side panel | `http://localhost:5001/o/side-panel` | 611 × 1080 |
| Bracket | `http://localhost:5001/o/bracket` | 1920 × 1080 |
| Highlights | `http://localhost:5001/o/highlights` | 1920 × 1080 |
| Casters | `http://localhost:5001/o/casters` | any |

The side panel has a transparent 587 × 330 cutout — layer your webcam source **behind** it. On every source, **uncheck "Shutdown source when not visible"** and **"Refresh browser when scene becomes active"**. Start the app before OBS, or refresh the sources once it's up.

Then the dock: **Docks → Custom Browser Docks**, URL `http://localhost:5001/dock`.

## The dock

The operator's whole job in one narrow panel, built to sit beside the OBS preview (it widens into columns on a bigger screen, and works from a phone at the address the console prints — the Tailscale one first, since it survives venue Wi-Fi). It is **not** part of the broadcast.

A **live strip** stays pinned at the top: both sides' names and characters, the score with − / + per side, the round, the best-of and the [L] marks (each overridable, **Auto text** puts them back), and the set's actions:

- **⇆ Sides** — the two players trade columns on the scoreboard (names, scores, characters, start.gg entrants, the game list — all together). Use it to match where they actually sit.
- **⇄ Ports** — the Slippi ports are the wrong way round: the points are about to land on the wrong player. The scoreboard stays put; the correction sticks for the rest of the set.
- **↻ Detect** — re-match the ports against the players' characters.
- **Start** / **Report** — start.gg's own "Start match" and the result report. See [Reporting](#reporting-to-startgg).

Tap a character to change it; the picker is the character-select screen, and holding (or right-clicking) a character shows its costumes.

Below the strip, six tabs:

| Tab | |
|---|---|
| **Set** | The event's sets, **playable sets first** (both players known, not started) — one tap loads one, re-read fresh from start.gg, with pronouns and mains from the player DB. **Clear for a manual set** for a friendlies set. |
| **Bracket** | **Singles** / **Doubles** for this week's event, the phase group, and which view the bracket overlay shows: Winners · Losers · Top 8 · Top 16 · Full. |
| **Casters** | Up to four caster tags (autocompleted from the player DB). A draft until **Put on stream**. |
| **Players** | Search the player DB; correct a prefix, pronoun or twitter; **pin** the main a player's sets open on. |
| **Clips** | The combo clipper: on/off, OBS connection, thresholds, recent clips, **Test clip**. |
| **Setup** | Every OBS url, the phone urls, the bound hotkeys, where the files are. |

### Hotkeys

Global — they work whichever window has focus (OBS, Dolphin, a browser):

| | Default |
|---|---|
| Swap ports | `Ctrl+Shift+S` |
| Switch sides | `Ctrl+Shift+X` |
| A game to the left / right side | `Ctrl+Shift+1` / `Ctrl+Shift+2` |
| Take one away | `Ctrl+Shift+Alt+1` / `Ctrl+Shift+Alt+2` |

Change them per action with `HOTKEYS` in `config.local.js` (each needs Ctrl, Alt or Win; `null` turns one off). Modifiers match exactly, and a held key fires once. If the `uiohook-napi` native module can't load, they fall back to single keys typed into the app's own window (`s`, `x`, `1`, `2`, `q`, `w`), and the Setup tab says so.

## The scoreboard and the ports

The score is the **list of games**: a Slippi game end adds one to the side that won, − / + add or remove one by hand. So the report sent to start.gg can never disagree with what's on screen, and Switch Sides moves everything at once.

Which side each Slippi port plays for is decided at every game start:

1. **The same ports as the last game** keep their sides — so a manual ⇄ Ports sticks for the rest of the set.
2. **Characters** — each port's character against the players' mains (game 1) or the last game's characters (when someone moved controllers). Costume breaks a tie between two of the same character.
3. **Positional** — lower port on the left. The dock flags this in amber as a guess to check before game 1.

The winner is read **at game end**, so anything corrected during the game — a port swap, a set loaded late — decides who gets the point. Loading a set while a game is running re-detects the ports on its own.

**Mains are learned.** When a singles set is reported (or replaced by the next one), what each player actually played goes into the player DB, most-played first, so their next set opens on the right character and game 1's ports match first time. A pinned main (Players tab) always wins.

## Reporting to start.gg

When a set loaded from start.gg has been played out, press **Report** on the live strip. The dock shows the winner and score and asks before anything is sent — reporting is always manual. It sends the winner and **every game's winner**, so start.gg shows the real score. A success reloads the bracket and the side panel's stats.

It's unavailable, with the reason shown, when there's nothing valid to report: no token, a manual set, a set that hasn't been started on start.gg (every set of an unstarted bracket is a `preview_…` placeholder — load it again once the TO starts the bracket), or a tied score. Singles and doubles are both supported.

**Start** does the opposite end of the job: start.gg's "Start match" for the set you just loaded, so nobody opens the bracket page to press it. It only shows while start.gg still has the set as not started or called.

## Switching brackets

If your stream alternates formats, the Bracket tab's **Singles** and **Doubles** load the right event in one press.

Nothing about this changes week to week. `config.js → BRACKETS` holds your series' **short link** (`start.gg/100-acres` — hyphenated exactly as it appears) plus a couple of keywords per format; the TO re-points that short link at each new tournament, and the app follows it — resolving the link, reading that tournament's real event list, and matching the event by keyword. If the keywords match two events it refuses and names both rather than guessing.

Switching doesn't touch the scoreboard, so a set in progress and its pending report are unaffected. Preflight's live check resolves the short link and both buttons, so a link the TO forgot to re-point shows up before the stream instead of during it.

## The overlays

### Scoreboard and players bar

Names, prefixes, pronouns, characters (the live Slippi costume), scores, the round and the best-of label: **Flex** outside top 8 (a Bo3 that goes to Bo5 at 1-1) and **Bo5** in top 8, decided from start.gg's placement for the set's loser. **[L]** goes on the grand-finals player from losers automatically. The rule lives in `SET_TEXT`; the live strip can override any of it per set.

### Side panel

A 611 × 1080 source beside the webcam: a header card with the tournament name, and a bottom card rotating every 20 seconds through the tournament logo, each player's recent placements and current run, their head-to-head, the sponsor logo, and the event's just-finished sets. Doubles skips the player cards and head-to-head.

The stats are the app's own, from start.gg — each player's whole set history is crawled once and saved (`stats-cache/`), so a regular's card is up seconds after their set loads. When the combo clipper saves a clip, a pill slides in over the bottom card naming the player and the combo (`notifySidePanel` in the Clips tab turns it off).

### Bracket

One source, five views switched from the dock — **Winners · Losers · Top 8 · Top 16 · Full** — with a crossfade between them; `?view=top8` pins a source to one. Each view scales to fit, down to a legibility floor; past that it pans slowly from the live round and back. Sets show seeds, scores and character icons (Slippi's for sets played on stream, the DB main otherwise); winners' paths light up in the theme's accent, and a losers-side drop-in carries a small "from W-R2" tag instead of a line across the screen.

### Casters

A lower-third tag per caster: mic, prefix, tag, pronouns. `/o/casters` shows them all in a row; `?i=0`, `?i=1` … one per source, to put under each caster's cam.

### Replay scene frame

`/o/highlights` frames the clip window and the two player cams and titles the scene. It's **decoration only** — nothing knows which clip VLC is playing, so on-screen combo credit would be wrong as often as right.

Its geometry has to match your OBS source positions. Rather than editing CSS, pass the numbers straight from OBS's **Edit Transform** on the URL:

```
?clip=x,y,w,h       the clip window
?cam=y,w,h          both cams (they share these; only x differs)
?camx=leftX,rightX  each cam's x
?pad=clipPad,camPad frame thickness
```

Defaults match a clip at `480,140` `960×800` with cams at `0,288` and `1520,288`, each `400×504`. Add **`?guides=1`** to outline each hole with its measured rectangle — hold that against OBS. `?animate=false` freezes the animation (it works on the side panel and scoreboard too).

## Theme packs

A theme is a self-contained folder, so running a different tournament doesn't mean edits scattered across the overlays:

```
overlays/theme.css                  ← a one-line switch naming the active pack
overlays/themes/hundred-acres-s2/
  theme.css                         every colour token, the @font-face, both logo URLs
  flair.css                         the pack's background flair (optional)
  logo.png                          tournament logo
  sponsor.png                       sponsor / venue logo
  fonts/                            the brand font, self-hosted
```

Every overlay imports the switch, so changing its one `@import` re-skins them all. Refresh the OBS sources and you're done. Shipped today: `hundred-acres-s2` (on air), `hundred-acres` (season one) and `salty-suite`.

Each pack owns its background flair — the moving texture behind the side panel's card and the title bars. Season one drifts soft orbs, Salty Suite adds spotlights, and season two has fireflies, with a trail map's topographic contours one token away (`--flair-*` in its `theme.css`).

**To start a new event:** copy a pack folder, change its colours and artwork, and point `overlays/theme.css` at it. Switching back afterwards is the same one-line edit — nothing prompts you, and the wrong branding is only obvious once you're live. When copying, the two logo URLs inside the pack's `theme.css` contain the pack's own folder name and need editing too; preflight fails if they don't resolve.

## Combo Clipper

The app watches for notable combos **as the game is happening** and asks OBS to save its replay buffer, so the clip already exists by the time the point is over. `obs-scripts/auto_replays.py` then collects those clips into a playlist for your break scene.

### Setup

1. **OBS → Settings → Output → Replay Buffer** — enable it, and set the length to **20 seconds or more**. Combos routinely run 6–9 seconds and the app deliberately waits a couple more so the kill and the reaction land in the clip. A 10-second buffer loses the start of the combo.
2. **OBS → Tools → WebSocket Server Settings** — enable it, note the port (4455) and the password.
3. In the dock's **Clips** tab, paste the WebSocket address, the password and your replay output folder, then **Save settings**.
4. Turn the clipper **on** and press **Test clip**. A clip should hit the folder and show up in the recent list. Do this before a bracket starts — it proves the whole chain in one press.

### Tuning

Every setting is live-editable from the Clips tab; no restart. `config.js → CLIPPER` only holds the starting values, and your edits are saved to `clipper-settings.json` (gitignored, since it holds the OBS password).

| Setting | What it does |
|---|---|
| **Min moves** / **Min damage** | How big a combo has to be to qualify |
| **Require kill** | Only clip combos that actually took a stock |
| **Combo window** | Judge only the *last* N seconds of a combo instead of the whole thing — see below |
| **Cooldown** | Minimum gap between saves, so one exchange doesn't bank five near-identical clips |
| **Max clips per game** | Caps a blowout. `0` = unlimited |
| **Save delay** | How long to wait after detecting, so the kill animation is in the clip |
| **Notify side panel** | The "clip saved" pill on the broadcast overlay |

**The combo window is the setting worth understanding.** A combo doesn't end when the pressure stops — Slippi keeps it open until the victim gets back to neutral or dies, so an offstage chase counts as *one* 30-second combo that's mostly dead air. Judged as a whole, it qualifies on the strength of an opening burst that has already fallen out of the replay buffer by the time the clip saves. Set a window (try 8–10 seconds, comfortably under your buffer length) and the thresholds are measured over the closing seconds instead, so what qualifies and what gets captured are the same footage.

> **Clips are singles only.** Slippi's own stats library only computes combos for 2-player games, so doubles produces nothing at all. This is upstream and can't be worked around — the dock says so rather than leaving you waiting.

### Playing the clips back

Add a **VLC Video Source** (64-bit VLC required) or a Media Source to your break scene, then load `obs-scripts/auto_replays.py` via **OBS → Tools → Scripts** and point it at your replay folder and that source. It builds the playlist from the newest clips whenever you switch to the scene.

Check the Scripts window's **Python Settings** tab first — OBS is picky about which Python version it will load, and it's not necessarily the newest one you have installed.

## Handwarmer Detection

Each game is scored on a weighted heuristic to detect practice/warm-up games:

- Both players dealt less than 150 total damage
- Both players had more than 1 stock remaining at the end
- Game ended via LRAS (Quit Out)
- Match duration under 60 seconds

A handwarmer doesn't count: characters and costumes still update, the score doesn't. It works for doubles too — LRAS quit-outs are still caught, and normal doubles endings are never falsely flagged.

**Rage quits:** if LRAS is detected but the game is *not* a handwarmer (a real game was quit), the point goes to the other player.

## Doubles

Detected automatically when a game has 4 active players with Slippi team ids. Each side shows its in-game team colour (red / blue / green), and the side panel drops the per-player cards. Clips and mains learning are singles only.

## How the app reads the game

It polls `SLP_FOLDER` every 500ms for new `.slp` files and reads the one Slippi is currently writing, so it sees characters, scores and combos as the game happens. `fs.watch` is intentionally not used — it misses new files on Windows/OneDrive paths.

## Troubleshooting

**Run preflight first:** `cd slippi-bridge && node scripts/preflight.js`. It checks the config, the player file, the overlays, the theme pack, the hotkeys, the running app, the start.gg token, this week's short link and OBS, and prints the fix for each failure.

**The app exits at startup:** `SLP_FOLDER` doesn't exist on this machine — set it in `config.local.js`.

**Port already in use:** normally handled for you — if the port is held by an older copy of the app, the new one stops it and takes the port back. It only does that for a process that identifies itself as this app; if something else is on 5001 it refuses to start and says so. Either free the port (`netstat -ano | findstr :5001`, then `taskkill /PID <pid> /F`) or move the app with `BRIDGE_PORT` in `config.local.js` — and every OBS source with it.

**An OBS source is blank:** it was added or refreshed while the app was down — refresh it. If it still points at `localhost:5000/layout/…`, that's TSH's old url; use the table in [Setup](#5-obs).

**Points landing on the wrong player:** **⇄ Ports** (or `Ctrl+Shift+S`). If the *names* are on the wrong sides, that's **⇆ Sides** instead.

**Every player opens with no character or pronouns:** there's no player file — the startup log warns about it. See [The player database](#3-the-player-database).

**Overlay renders unstyled, or a logo is missing:** the theme pack is missing or `overlays/theme.css` names a pack that isn't there. Preflight says which.

**Report or Start is unavailable:** the dock shows the reason. Common causes: no start.gg token, a manual set, an unstarted bracket (preview sets), or a tied score.

**Clipper never fires:** in order of likelihood — it's a doubles set, the replay buffer isn't running, or the thresholds are too high. **Test clip** separates an OBS problem from a threshold problem.

**Clips start mid-combo:** the OBS replay buffer is shorter than 20 seconds.

**Highlights frame doesn't line up with the footage:** open it with `?guides=1` and compare the labelled rectangles against OBS's Edit Transform values.

**Score went up on a warm-up game:** the handwarmer threshold may need tuning — the weighted cutoff is at the top of `slippi-bridge/lib/handwarmer.js`. Take the game back with − (or `Ctrl+Shift+Alt+1`/`2`).
