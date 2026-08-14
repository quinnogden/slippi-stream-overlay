# Testing Without a Tournament

How to verify a change when there's no bracket running, no console plugged in, and possibly no OBS open.

Most of this is manual, and the expensive failures are the ones that only appear live — a score going to the wrong player, a frozen dock, a parser that stops mid-set. This is the set of harnesses that reproduce those conditions on a laptop. Keep one-off scratch scripts in your temp scratchpad; the exception is [Layer 0](#layer-0--the-automated-checks) below, which is the small set of checks that earned a permanent home.

**Start with the two cheap ones:**

```bash
node tests/run.js                                   # automated checks, ~2s
cd slippi-bridge && node scripts/preflight.js --offline
```

Preflight covers config, dependencies, the TSH install, the four `general` settings, and layout integrity without touching the network. Drop `--offline` once TSH, the bridge and OBS are up. See [FRESH-INSTALL.md](FRESH-INSTALL.md).

---

## Layer 0 — The automated checks

```bash
node tests/run.js                              # everything, no deps, ~2s
node tests/side-panel-rotation.test.js         # one file, with detail
node tests/combo-detector.test.js              # run after touching the clipper's thresholds
node tests/layout-static.test.js -v            # every individual check
```

[`tests/`](../tests/README.md) holds the few failures worth automating: the ones that are **invisible until they are on stream**, where the manual reproduction step is "run a tournament". Today that's static integrity of the layouts (parse errors, dead `<script src>`, unwired `shared/` helpers) and of the control panel (a missing element id freezes the dock), the side panel's rotation under a burst of TSH state pushes, the combo clipper's qualifying thresholds, the bracket buttons' event matching, the Start Set button's per-set caching, and the Re-detect Players port re-derivation. [tests/README.md](../tests/README.md) has a line on each saying what it protects and why that failure is expensive.

It is not a general test suite and shouldn't grow into one — everything else on this page is still the way to check a change. But if you fix a layout bug that only showed up live, that is exactly the kind of thing that belongs in `tests/`; `tests/helpers/layout-sandbox.js` will load any layout script headlessly, and [tests/README.md](../tests/README.md) documents the four sandbox gotchas.

**Do not hand-write TSH state for a new test.** Clone `tests/fixtures/program-state.json` and mutate it. The slot predicates dig into `history_sets` / `last_sets` / `recent_sets` / `streamQueue` in non-obvious shapes, and invented state silently fails every predicate — which produces a test that passes because it exercised nothing.

---

## Layer 1 — Pure modules

`combo-detector.js`, `handwarmer.js`, `char_map.js`, `port-mapper.js`, `tsh-root.js` and `clipper-settings.js` do no I/O of their own (or only filesystem probing), so they're callable directly. This is where most logic changes should be checked first.

```bash
cd slippi-bridge

# Character + stage mapping
node -e 'const {resolveCharacter,resolveStage}=require("./lib/char_map");
console.log(resolveCharacter(2, 3, null));   // Fox, costume 3
console.log(resolveStage(31), resolveStage(33));  // battlefield, then null (target test)'

# Port mapping — no TSH needed, everything is passed in
node -e 'const PortMapper=require("./lib/port-mapper"); const m=new PortMapper();
m.resolve({name:"ALICE",score:1},{name:"BOB",score:0});
console.log(m.getResolutionInfo());'

# Settings validation and clamping (values arrive from a browser form)
node -e 'const {ClipperSettings}=require("./lib/clipper-settings");
const s=new ClipperSettings(require("./config"));
console.log(s.save({minMoves:"999", minDamage:"abc", enabled:"true"}));'
```

`resolveStage` returning `null` for ids 33+ is correct — TSH ships no icon for target-test stages.

---

## Layer 2 — Replaying a `.slp`

`createFolderSource` polls a folder, so any `.slp` you drop in gets processed as if it were live. This is how you test scoring, handwarmer detection and combo detection.

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

Expected: `[bridge] New game file:`, then a `slippi_game_start`, `[clipper]` lines if the clipper is on, then one `[handwarmer]` line and a `game-end` with the right winner.

**B. The OneDrive hazard** — copy a *finished* replay in slowly **without** zeroing the header (`cp` a large file across a slow link, or write it in chunks keeping the real length). Expected: `[bridge] Parser read past EOF … rebuilding`, and then normal behaviour. That log line is the guard in [game-source.js](../slippi-bridge/lib/game-source.js) working. If you instead see silence and no `game-end`, the guard has regressed — this is the single most damaging regression possible in that file, because it costs the remainder of a set.

### Testing the handlers without any file at all

`index.js` binds to an `EventEmitter`, so the singles/doubles handlers can be driven directly with a mock — no `.slp`, no Slippi, no timing. Import `game-source`'s contract by hand:

```js
const EventEmitter = require("events");
const src = new EventEmitter();
src.getStatus = () => ({ connected: true, detail: "mock" });
// then emit "game-start" (rawPlayers, stageId) / "game-end" {…} / "highlight" {…}
```

Useful for exercising the port→team priority chain and the 0-0 late-bind, which otherwise need a real second game to reach.

---

## Layer 3 — The HTTP API

```bash
curl -s http://localhost:5001/api/identity
curl -s http://localhost:5001/api/status
curl -s -X POST http://localhost:5001/api/swap
curl -s -X POST http://localhost:5001/api/clipper/test
curl -s "http://localhost:5001/api/sets?finished=1"
```

Payload shapes and the traps in each route are in [BRIDGE-API.md](BRIDGE-API.md). Two worth repeating: `/api/swap` and `/api/swap-sides` are **not** interchangeable, and `/api/sets` hits start.gg uncached on every call — don't loop it.

---

## Layer 4 — The layouts

### Driving them with a stub bridge

Both layouts hardcode `io("http://localhost:5001")`, so with the real bridge **stopped** you can serve that port yourself and emit whatever event you want. This is the only practical way to test the clip toast or doubles rendering without a console and OBS:

```js
// stub-bridge.js — run with the real bridge stopped
const io = require("socket.io")(5001, { cors: { origin: "*" } });
console.log("stub bridge on 5001");

io.on("connection", (s) => {
  console.log("layout connected");
  setInterval(() => s.emit("slippi_clip_saved", {
    ts: Date.now(), playerName: "TESTER", teamNum: 1,
    moveCount: 7, damage: 84.3, didKill: true,
    file: "Replay 2026-07-29 14-02-11.mkv", ok: true, error: null,
  }), 5000);
});
```

Then open `http://localhost:5000/layout/side-panel/side-panel.html` (TSH still serves the page). The toast should slide in over the bottom card's bottom edge, hold ~3.2s, and slide back out — **leaving nothing stuck on screen**, and without disturbing the panel rotation. Emitting two in quick succession must queue them, not restart a visible pill: a flicker here is visible on broadcast.

Note the toast is deliberately unreachable from the browser console — the layout's functions live inside a `LoadEverything().then()` closure, not on `window`.

### Side panel

- `DEBUG_PANEL` at the top of `side-panel.js` locks rotation to one slot — the fastest way to iterate on a single card. **It must be `null` in anything committed.**
- `?animate=false` disables the ambient animation.
- After touching `Rotator`, run `node tests/side-panel-rotation.test.js` first — it drives the two bursts that actually break it (loading a set, Swap Teams) without needing a bracket.
- Rotation bugs show up two ways. *Acceleration*: panels advancing faster than `PANEL_INTERVAL` means a stale GSAP timeline survived a rebuild — leave it running for several minutes. *Flashing*: the logo appearing several times in a row right after a set load means something restarts the rotation on a slot-list change again (`restart()` rotates from the top, and slot 0 is always the logo). The second is covered by the test above; the first still needs eyes on it.
- The header reads `out/tournamentInfo/tournamentName.txt`, so it needs TSH running with a `TOURNAMENT_URL`, not the bridge.

### Scoreboard

- Use `melee.html`. There is no `index.html` in `scoreboard/`, and `meleePlayers.html` deliberately doesn't load the bridge client.
- The costume patch is timed off the `tsh_update` DOM event with a 150ms delay. To test it, change the character in TSH and confirm the icon ends on the **right costume** — TSH defaults to costume 0, so a broken patch looks like "always costume 0", not like an error.
- Switch TSH from singles to doubles with the page open: icons must clear immediately. That path reads the DOM, not cached bridge state, precisely so this works.

### Highlights (replay scene frame)

- It reads no TSH state and no bridge events, so there is nothing to stub — open it standalone and it renders.
- `?guides=1` outlines each frame's transparent hole and labels it with its **measured** rect, not a read-back of the CSS variables, so a broken `calc()` or a mistyped URL override shows up there instead of on stream. That is the alignment check: hold the labels against OBS's Edit Transform values.
- Override the geometry on the URL rather than in CSS (`?clip=`, `?cam=`, `?camx=`, `?pad=`). Blank components are skipped, so `?clip=,,960` sets width alone.
- `?animate=false` freezes the title orbs and the sheen sweep.
- **Never copy `opacity: 0` onto this body from `scoreboard/index.css`.** This layout deliberately doesn't load `include/globals.js`, so nothing would ever fade it back in — the overlay goes permanently invisible, and only on stream.

### Control panel

- **Freeze test:** leave it open for a minute. `render()` runs every 2s with no try/catch, so a single missing element id kills the interval and the panel silently stops updating while still *looking* fine. If the clock-like fields stop moving, that's what happened.
- **Typing test:** type a threshold and wait through several ticks — it must not be overwritten (`clipDirty`).
- **Collapse persistence:** collapse sections, reload, confirm they're still collapsed (`localStorage`), then confirm the panel is still live.
- Check both widths: one column in a narrow OBS dock, two columns at ≥760px.

---

## Regression checklist for the risky areas

Run these after touching `game-source.js`, `index.js`'s handlers, or `port-mapper.js`:

- [ ] Real singles game → score increments for the **correct** TSH team
- [ ] Handwarmer (both quit out early, low damage) → characters update, score does **not**
- [ ] Rage quit (real damage, then LRAS) → point to the *other* player
- [ ] Game starting at 0-0 with blank TSH names, names filled in during game 1 → score still lands correctly (0-0 late-bind)
- [ ] Press TSH's Swap Teams mid-set → dock reflects it within ~2s and the mapping re-derives
- [ ] Game running with the **previous** set's names still on the scoreboard → enter the real names in TSH, press **↻ Re-detect Players**: toast reports `character` and names both ports, the ports card and badge update, the scoreboard's character icons land on the correct sides, and the game's point goes to the right player at game end
- [ ] Press **↻ Re-detect Players** between games → "No game in progress" toast, ports card unchanged
- [ ] Doubles game → no false handwarmer (the `filter(Boolean)` trap: null dead-player entries must count as 0 stocks, or every doubles game reads as "everyone still has multiple stocks")

---

## What can't be tested offline

| | |
|---|---|
| **Combo clips in doubles** | Structurally impossible. slippi-js computes conversions only for 2-player games, so `stats.conversions` is permanently empty in doubles. Not a bug to chase. |
| **The OBS save chain** | Needs OBS with the replay buffer running. `POST /api/clipper/test` is the smoke test; do it before a bracket, not during. |
| **Buffer length adequacy** | `preflight.js` reads it via obs-websocket, but whether 20s is *enough* only shows up in a real clip. |
| **`uiohook-napi` hotkey** | Native module; behaves differently per machine. Fallback is pressing `S` in the terminal. |
| **start.gg reporting** | Writes to a real bracket. Test on a throwaway tournament, never a live one. Reporting refuses rather than guesses when it can't read TSH's swap state — verify that refusal still happens if you touch that path. |
