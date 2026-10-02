# Testing Without a Tournament

How to verify a change when there's no bracket running, no console plugged in, and possibly no OBS open.

Most of this is manual, and the expensive failures are the ones that only appear live — a score going to the wrong player, a frozen dock, a parser that stops mid-set, a report naming the loser. This is the set of harnesses that reproduce those conditions on a laptop. Keep one-off scratch scripts in your temp scratchpad; the exception is [Layer 0](#layer-0--the-automated-checks) below, which is the small set of checks that earned a permanent home.

**Start with the two cheap ones:**

```bash
node tests/run.js                                   # automated checks, a few seconds
cd app && node scripts/preflight.js --offline
```

Preflight covers dependencies, config, the hotkeys, the player file, the icons, the overlay pages and the theme pack without touching the network. Drop `--offline` once the app (and OBS, if the clipper matters) is up: it then also checks the running app, the start.gg token, this week's short link and both bracket buttons. See [FRESH-INSTALL.md](FRESH-INSTALL.md).

---

## Layer 0 — The automated checks

```bash
node tests/run.js                              # everything, no deps beyond the app's own
node tests/side-panel.test.js                  # one file, with detail
node tests/combo-detector.test.js              # run after touching the clipper's thresholds
node tests/overlays-static.test.js             # every overlay url resolves
```

[`tests/`](../tests/README.md) holds the failures worth automating: the ones that are **invisible until they are on stream**, where the manual reproduction step is "run a tournament" — which side gets the point, which entrant a report names, an overlay that stops updating, a dock that eats input. [tests/README.md](../tests/README.md) has a line on each saying what it protects and why that failure is expensive.

It is not a general test suite and shouldn't grow into one. But if you fix an overlay or dock bug that only showed up live, that is exactly the kind of thing that belongs in `tests/`; `tests/helpers/overlay-sandbox.js` runs any overlay page — or the dock — headlessly against the real channel, and [tests/README.md](../tests/README.md) documents its gotchas.

**Do not hand-write state for a new test.** Build it with the app's own models from a captured tournament (`tests/fixtures/startgg/`, loaded by `tests/helpers/fake-startgg.js`). Invented state silently fails every predicate — which produces a test that passes because it exercised nothing.

---

## Layer 1 — Pure modules

`combo-detector.js`, `handwarmer.js`, `char_map.js`, `ports/port-map.js`, `event/bracket-model.js`, `event/set-model.js`, `scoreboard/set-text.js` and `clipper-settings.js` do no I/O of their own, so they're callable directly. This is where most logic changes should be checked first.

```bash
cd app

# Character mapping
node -e 'const {resolveCharacter,characterByName}=require("./lib/char_map");
console.log(resolveCharacter(2, 3), characterByName("Captain Falcon", 1));'

# Port mapping — everything is passed in
node -e 'const {PortMap}=require("./lib/ports/port-map"); const m=new PortMap();
console.log(m.info());'

# Settings validation and clamping (values arrive from a browser form)
node -e 'const {ClipperSettings}=require("./lib/clipper-settings");
const s=new ClipperSettings(require("./config"));
console.log(s.save({minMoves:"999", minDamage:"abc", enabled:"true"}));'
```

The store (`lib/scoreboard/store.js`) has no I/O either: build one, call its commands, read `snapshot()` / `reportable()`. That is the fastest way to answer "what does a report send after Switch Sides".

---

## Layer 2 — Replaying a `.slp`

`createFolderSource` polls a folder, so any `.slp` you drop in gets processed as if it were live. This is how you test scoring, handwarmer detection and combo detection end to end.

### The trick that makes it faithful

**Copying a finished replay into `SLP_FOLDER` does not reproduce live conditions, and the difference matters.**

A `.slp` header is 11 bytes — `{U\x03raw[$U#l` — followed by `rawDataLength` as a **UInt32BE at offset 11**. While Slippi is still writing, that field is **0**, which is what tells the parser to stop at the last complete command. A finished file declares its true length, and slippi-js's `iterateEvents` computes `stopReadingAt` from the header — so if the bytes are still arriving, it reads past the real data and leaves `readPosition` **permanently** past EOF. Nothing recovers: `game-end` never fires and the rest of the set goes unscored.

So there are two distinct scenarios, and both need testing:

**A. Faithful live game** — zero the length field, then append in chunks:

```js
// stream-slp.js — writes a growing "live" .slp into SLP_FOLDER
const fs = require("fs"), path = require("path");
const SRC = process.argv[2];                       // a finished .slp
const DEST = path.join(require("./config").SLP_FOLDER, `Game_TEST${Date.now()}.slp`);

const src = fs.readFileSync(SRC);
const live = Buffer.from(src);
live.writeUInt32BE(0, 11);                         // ← rawDataLength = 0, as Slippi writes it

let pos = 0;
const CHUNK = 64 * 1024;
fs.writeFileSync(DEST, live.slice(0, 1024));       // header first
pos = 1024;
const t = setInterval(() => {
  if (pos >= live.length) {
    clearInterval(t);
    // Slippi stamps the real length when it closes the file.
    const fd = fs.openSync(DEST, "r+");
    fs.writeSync(fd, src.slice(11, 15), 0, 4, 11);
    fs.closeSync(fd);
    console.log("done:", DEST);
    return;
  }
  fs.appendFileSync(DEST, live.slice(pos, pos + CHUNK));
  pos += CHUNK;
}, 250);
```

Expected: `[bridge] New game file:`, the two sides' characters logged and drawn on `/o/scoreboard`, `[clipper]` lines if the clipper is on, then one `[handwarmer]` line and `Game over — left/right side wins`, with the score going up on that side in the dock.

**B. The OneDrive hazard** — copy a *finished* replay in slowly **without** zeroing the header (`cp` a large file across a slow link, or write it in chunks keeping the real length). Expected: `[bridge] Parser read past EOF … rebuilding`, and then normal behaviour. That log line is the guard in [game-source.js](../app/lib/game-source.js) working. If you instead see silence and no game end, the guard has regressed — this is the single most damaging regression possible in that file, because it costs the remainder of a set.

### Testing the handlers without any file at all

`index.js` binds to an `EventEmitter`, so the game-mode handlers can be driven directly with a mock — no `.slp`, no Slippi, no timing:

```js
const EventEmitter = require("events");
const src = new EventEmitter();
src.getStatus = () => ({ connected: true, detail: "mock" });
// then emit "game-start" (rawPlayers, stageId) / "game-end" {…} / "highlight" {…}
```

`tests/port-map.test.js` and `tests/mains-learning.test.js` do exactly this through the real modes, store and port map; copy their setup rather than starting from scratch.

---

## Layer 3 — The app, offline from the bracket

Run the app against **a copy** of the player file and, if you want a real bracket, a past event — never this week's live one if you'll press Start or Report:

```js
// boot.js — node boot.js <path to app> <players copy> <event slug>
const path = require("path");
const [app, players, slug] = process.argv.slice(2);
const c = require(path.join(app, "config"));
c.PLAYERS_FILE = players;
const { EventService } = require(path.join(app, "lib/event/event-service"));
EventService.prototype.start = function () { this.loadEvent(slug); this._schedule(); };
require(path.join(app, "index.js"));
```

Past events load and read normally (e.g. `tournament/hundred-acres-48/event/melee-singles-flex-bo5`). The app still writes `app/data/live-state.json`; delete that afterwards **and nothing else in `data/`** — the default player file lives there too.

```bash
curl -s http://localhost:5001/api/identity
curl -s http://localhost:5001/api/status
curl -s http://localhost:5001/api/state
curl -s "http://localhost:5001/api/sets?finished=1"
curl -s -X POST -H "Content-Type: application/json" -d '{"side":0,"delta":1}' http://localhost:5001/api/score
curl -s -X POST http://localhost:5001/api/swap-sides
```

Payload shapes and the traps in each route are in [BRIDGE-API.md](BRIDGE-API.md). Two worth repeating: `/api/swap` (ports) and `/api/swap-sides` (the scoreboard) are **not** interchangeable, and `/api/sets?refresh=1` re-reads every phase group from start.gg — don't loop it.

**The hotkeys are global.** Don't test them by synthesising keypresses — they would also type into whatever window has focus. Press them by hand, watching the `[hotkey]` lines in the console.

---

## Layer 4 — The overlays and the dock

The app serves every page, so there is nothing to stub: open `http://localhost:5001/o/<page>` in Chrome at 1920×1080 (or `/dock` at ~420px wide for the OBS dock, and again at 1280+), and drive it through the API or the dock. OBS's browser is Chromium 103 — no `:has()`, `color-mix()` or container queries.

- **Screenshots:** headless Chrome with `--screenshot --window-size=1920,1080 --virtual-time-budget=4000` captures a page after load. Virtual time runs ahead of real time, so a change made *after* load won't be in it; for a live update use the DevTools protocol (`--remote-debugging-port`, Node's global `WebSocket`) and screenshot after the API call.
- **Every theme pack.** Switch the pack from the dock's Setup → Theme (every source reloads itself), and look again — nothing should hardcode a pack colour.

### Side panel

- `?panel=<id>` holds one panel (for styling); `?animate=false` disables the ambient animation.
- After touching `Rotator`, run `node tests/side-panel.test.js` first — it drives the bursts that actually break it (loading a set, Switch Sides) without needing a bracket.
- Rotation bugs show up two ways. *Acceleration*: panels advancing faster than `PANEL_INTERVAL` means a stale GSAP timeline survived a rebuild — leave it running for several minutes. *Flashing*: the logo appearing several times in a row right after a set load. The second is covered by the test; the first still needs eyes on it.

### Bracket

- Check the biggest captured fixture in all five views (`POST /api/bracket-view {"view":"full"}` …): Top 8 fits with no pan; a 64+ entrant Full view reaches the legibility floor and pans.
- Tune pan speed and holds in OBS, not only in Chrome.

### Highlights (replay scene frame)

- It reads no state and no events, so it renders standalone.
- `?guides=1` outlines each frame's transparent hole and labels it with its **measured** rect, not a read-back of the CSS variables, so a broken `calc()` or a mistyped URL override shows up there instead of on stream. Hold the labels against OBS's Edit Transform values.
- Override the geometry on the URL rather than in CSS (`?clip=`, `?cam=`, `?camx=`, `?pad=`). Blank components are skipped, so `?clip=,,960` sets width alone.

### Dock

- **Freeze test:** leave it open for a minute. Every renderer is wrapped in `guard()`, so one that throws shows an error in the dock instead of freezing it — if the health lights dim after ~12s, the status heartbeat stopped arriving.
- **Typing test:** type into a name, a caster or a clipper threshold and wait through several pushes — it must not be overwritten mid-word.
- Both widths: one column in a narrow OBS dock, several from ~760px.

---

## Regression checklist for the risky areas

Run these after touching `game-source.js`, `lib/modes/`, `lib/ports/port-map.js` or the store:

- [ ] Real singles game → the point goes to the **correct** side
- [ ] Handwarmer (both quit out early, low damage) → characters update, score does **not**
- [ ] Rage quit (real damage, then LRAS) → point to the *other* player
- [ ] Ports backwards at game 1 → ⇄ Ports (or the swap-ports hotkey) during the game → the point still lands on the right side, and game 2 keeps the correction
- [ ] Switch Sides mid-set → names, scores and characters cross together; **Report** afterwards names the right winner (`tests/scoreboard-store.test.js` pins this; check the dock's confirm text too)
- [ ] Load a set while game 1 is running → the ports re-detect on their own (toast) against the new players' mains
- [ ] Kill the app mid-set and restart → the scoreboard, score and game list come back (`data/live-state.json`)
- [ ] Report a set → the two players' learned mains appear in the Players tab; their next set opens on them
- [ ] Doubles game → no false handwarmer (null dead-player entries must count as 0 stocks, or every doubles game reads as "everyone still has multiple stocks")

---

## What can't be tested offline

| | |
|---|---|
| **Combo clips in doubles** | Structurally impossible. slippi-js computes conversions only for 2-player games, so `stats.conversions` is permanently empty in doubles. Not a bug to chase. |
| **The OBS save chain** | Needs OBS with the replay buffer running. `POST /api/clipper/test` (the Clips tab's Test button) is the smoke test; do it before a bracket, not during. |
| **Buffer length adequacy** | `preflight.js` reads it via obs-websocket, but whether 20s is *enough* only shows up in a real clip. |
| **`uiohook-napi` hotkeys** | Native module; behaves differently per machine. Press them by hand; the Setup tab and the startup log say whether they bound globally or fell back to the app's own window. |
| **start.gg Start / Report** | Write to a real bracket. Test on a throwaway tournament, never a live one. |
