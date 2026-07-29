# Testing Without a Tournament

How to verify a change when there's no bracket running, no console plugged in, and possibly no OBS open.

Almost nothing here has automated tests, and the expensive failures are the ones that only appear live — a score going to the wrong player, a frozen dock, a parser that stops mid-set. This is the set of manual harnesses that reproduce those conditions on a laptop. Put scratch scripts in your temp scratchpad, not in the repo.

**Start with the cheap one:**

```bash
cd slippi-bridge && node preflight.js --offline
```

That covers config, dependencies, the TSH install, the four `general` settings, and layout integrity without touching the network. Drop `--offline` once TSH, the bridge and OBS are up. See [FRESH-INSTALL.md](FRESH-INSTALL.md).

---

## Layer 1 — Pure modules

`combo-detector.js`, `handwarmer.js`, `char_map.js`, `port-mapper.js`, `tsh-root.js` and `clipper-settings.js` do no I/O of their own (or only filesystem probing), so they're callable directly. This is where most logic changes should be checked first.

```bash
cd slippi-bridge

# Character + stage mapping
node -e 'const {resolveCharacter,resolveStage}=require("./char_map");
console.log(resolveCharacter(2, 3, null));   // Fox, costume 3
console.log(resolveStage(31), resolveStage(33));  // battlefield, then null (target test)'

# Port mapping — no TSH needed, everything is passed in
node -e 'const {PortMapper}=require("./port-mapper"); const m=new PortMapper();
m.resolve({name:"ALICE",score:1},{name:"BOB",score:0});
console.log(m.getResolutionInfo());'

# Settings validation and clamping (values arrive from a browser form)
node -e 'const {ClipperSettings}=require("./clipper-settings");
const s=new ClipperSettings(require("./config"));
console.log(s.save({minMoves:"999", minDamage:"abc", enabled:"true"}));'
```

`resolveStage` returning `null` for ids 33+ is correct — TSH ships no icon for target-test stages.

---

## Layer 2 — Replaying a `.slp`

`createFolderSource` polls a folder, so any `.slp` you drop in gets processed as if it were live. This is how you test scoring, handwarmer detection, crew stock tracking and combo detection.

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

**B. The OneDrive hazard** — copy a *finished* replay in slowly **without** zeroing the header (`cp` a large file across a slow link, or write it in chunks keeping the real length). Expected: `[bridge] Parser read past EOF … rebuilding`, and then normal behaviour. That log line is the guard in [game-source.js](../slippi-bridge/game-source.js) working. If you instead see silence and no `game-end`, the guard has regressed — this is the single most damaging regression possible in that file, because it costs the remainder of a set.

### Testing the handlers without any file at all

`index.js` binds to an `EventEmitter`, so the singles/doubles/crew handlers can be driven directly with a mock — no `.slp`, no Slippi, no timing. Import `game-source`'s contract by hand:

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

Both layouts hardcode `io("http://localhost:5001")`, so with the real bridge **stopped** you can serve that port yourself and emit whatever event you want. This is the only practical way to test the clip toast, crew panels, or doubles rendering without a console and OBS:

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
- Rotation bugs show up as *acceleration*: if panels start advancing faster than `PANEL_INTERVAL`, a stale GSAP timeline survived a rebuild. Leave it running for several minutes after touching `Rotator`.
- The header reads `out/tournamentInfo/tournamentName.txt`, so it needs TSH running with a `TOURNAMENT_URL`, not the bridge.

### Scoreboard

- Use `melee.html`. `index.html` doesn't load the bridge's Socket.io client.
- The costume patch is timed off the `tsh_update` DOM event with a 150ms delay. To test it, change the character in TSH and confirm the icon ends on the **right costume** — TSH defaults to costume 0, so a broken patch looks like "always costume 0", not like an error.
- Switch TSH from singles to doubles with the page open: icons must clear immediately. That path reads the DOM, not cached bridge state, precisely so this works.

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
- [ ] Doubles game → no false handwarmer (the `filter(Boolean)` trap: null dead-player entries must count as 0 stocks, or every doubles game reads as "everyone still has multiple stocks")
- [ ] Crew battle → stock totals decrement by carry-over, not by 1

---

## What can't be tested offline

| | |
|---|---|
| **Combo clips in doubles** | Structurally impossible. slippi-js computes conversions only for 2-player games, so `stats.conversions` is permanently empty in doubles. Not a bug to chase — crew battles are 1v1 per game and do work. |
| **The OBS save chain** | Needs OBS with the replay buffer running. `POST /api/clipper/test` is the smoke test; do it before a bracket, not during. |
| **Buffer length adequacy** | `preflight.js` reads it via obs-websocket, but whether 20s is *enough* only shows up in a real clip. |
| **`uiohook-napi` hotkey** | Native module; behaves differently per machine. Fallback is pressing `S` in the terminal. |
| **start.gg reporting** | Writes to a real bracket. Test on a throwaway tournament, never a live one. Reporting refuses rather than guesses when it can't read TSH's swap state — verify that refusal still happens if you touch that path. |
