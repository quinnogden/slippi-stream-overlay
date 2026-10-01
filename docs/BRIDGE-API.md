# Bridge API Contract

Everything the bridge exposes on `BRIDGE_PORT` (default 5001): the HTTP routes the operator's dock drives, and the Socket.io events the OBS sources consume.

This is the contract between `slippi-bridge/` and its clients — on branch `tsh-replacement`, the dock ([public/dock/](../slippi-bridge/public/dock/)) and the overlays under [overlays/](../overlays/); on master, `public/control-panel.html` and the layouts under `TournamentStreamHelper-*/layout/`. Change a payload shape here and something in a browser stops updating **silently**, because nothing on either side validates. Keep this file in step with `index.js`.

For what TSH exposes *to* the bridge, see the TSH HTTP API section of [CLAUDE.md](../CLAUDE.md).

---

## Overlay channel — `/overlay` and `/dock` (branch `tsh-replacement`)

Every overlay is the app's own on this branch — `/o/scoreboard`, `/o/scoreboard/players`, `/o/casters`, `/o/side-panel`, `/o/bracket`, `/o/highlights` — and all but highlights (which never connects) use the `/overlay` namespace through [overlays/shared/overlay-client.js](../overlays/shared/overlay-client.js); the dock uses `/dock` through the same client. Built in [lib/overlay/channel.js](../slippi-bridge/lib/overlay/channel.js).

| Event | Direction | Payload |
|---|---|---|
| `state:full` | app → page | The store's snapshot: `{ v, rev, tournament, scoreboard, casters, view, bracket }`. Sent on connect and on request |
| `state:patch` | app → page | `{ from, rev, ops: [{ path, value }] }` — whole top-level sections. One per tick, however many store commands ran in it |
| `state:resync` | page → app | No payload. Asks for `state:full` |
| `game:start` / `game:end` | app → both | The `slippi_game_start` / `slippi_game_end` payloads below |
| `clip:saved` | app → both | The `slippi_clip_saved` payload |
| `stats` | app → overlay | The `player_stats` payload |
| `status` / `clip:error` | app → dock | The `control_status` / `slippi_clip_error` payloads |

- **`from` is what keeps a source honest.** A page applies a patch only when `from` ≤ its own rev. A larger `from` means it missed one, and it must send `state:resync` rather than apply it: every later patch carries only the sections that changed, so a source that missed one would otherwise show the old score indefinitely while looking healthy. A patch whose `rev` it already has (it connected mid-burst, and its `state:full` was newer) is ignored. `state:full` is always taken, even at a lower rev — the app may have restarted. `tests/overlay-patch.test.js` pins all three.
- **Selectors run on change only.** `ov.select(path, fn)` compares the JSON at `path`, so a casters edit doesn't re-run, and re-animate, the scoreboard.
- **Sticky events.** A page that connects mid-game gets `game:start` (dropped at `game:end`, a handwarmer's included) and the last `stats`; the dock also gets the last `status`.
- **The feature modules don't know about the channel.** They still emit their original names through `ctx.io`, which is the channel's `emit()`; its `RELAY` table maps each to the names above, per namespace. Nothing is sent on the default namespace any more — the dock replaced the control panel, the last client there.
- **Overlay urls are absolute** (`/o/shared/overlay.css`), so a source works with or without a trailing slash. Every stylesheet sits one level under `/o/`, because a theme pack's `--logo-url` resolves against the stylesheet that uses it. The theme switch is `overlays/theme.css` (`/o/theme.css`) and the packs are `overlays/themes/<pack>/`. `tests/overlays-static.test.js` resolves every page's urls through the server's own tables.

### The `bracket` section

What the bracket overlay draws, published by [lib/event/bracket-feed.js](../slippi-bridge/lib/event/bracket-feed.js) from the event service's reads. `null` with no event loaded. **Not saved** with the rest of the state — it is re-read from start.gg on boot — so a bracket refresh never writes `live-state.json`.

```js
{
  phaseGroupId: "3441449",         // the group shown: view.bracketPhaseGroupId if set, else the
  label: "Bracket",                //   on-air set's, else the furthest running one
  phaseName, bracketType, eventName, tournamentName,
  groups: [ { id, label } ],       // every group of the event, for the dock's picker
  preview: false,                  // the event hasn't started: sets are preview_… placeholders
  sets: { [id]: { … } },           // bracket-model.buildBracket's set nodes (side, round, name, state,
                                   //   completedAt, winner, conditional, slots[{ entrantId, seed,
                                   //   score, dq, from }]) — the on-air set carries its LIVE score
  entrants: { [id]: { name, seed, players: [{ playerId, tag, prefix }],
                      character } },   // singles only: Slippi's for the two on air, else the DB main
  rounds: [ … ],
  views: { winners, losers, top8, top16, full },  // each { rounds, setIds, fedFromOutside }
}
```

The layout (card positions, connectors) is computed in the page by [overlays/bracket/layout.js](../overlays/bracket/layout.js), because it depends on the fit scale. Which view a source shows is `view.bracketView` (`POST /api/bracket-view`), unless its url pins one with `?view=`.
- **Start the app before OBS**, or refresh the sources: a browser source whose page failed to load doesn't retry. Once a page has loaded, it survives app restarts, because socket.io reconnects and is sent `state:full`.

---

## Socket.io events (bridge → browser)

On this branch these payloads reach pages only through the channel above, under its names (`game:start`, `status`, …); nothing listens on the default namespace. The names below are what the feature modules emit and what master's clients still use.

### `slippi_game_start`

The whole `currentGameState`. Emitted on game start, on a manual or TSH-side swap, and to each newly-connected client.

```js
{
  players: {                    // keyed by Slippi port index (0-based), as a string key
    "0": {
      playerIndex: 0,           // Slippi port, 0-based
      teamNum: 1,               // TSH team, 1-based — the scoring authority
      costumeIndex: 2,          // player.characterColor
      codename: "fox",          // TSH asset codename
      display: "Fox",           // TSH display name, used by the update-team API
    },
    // …
  },
  isDoubles: false,
  startedAtZeroZero: true,      // singles only — drives the 0-0 late-bind at game end
  teamColorMap: undefined,      // doubles only: { "1": "#D32F2F", "2": "#1565C0" }
}
```

- A player whose character id doesn't resolve is **omitted** from `players` — don't assume two entries.
- There is deliberately **no icon path**. Build it browser-side with `charIconSrc(codename, costumeIndex)` from `layout/shared/tsh-assets.js`; a bridge-side absolute path is useless to a browser source.
- `players` is an object, not an array, and its keys are port indices. `Object.values()` is the safe iteration.
- Consumers must detect doubles from the DOM rather than trusting a cached `isDoubles`; see the `tsh_update` note in [CLAUDE.md](../CLAUDE.md).

### `slippi_game_end`

```js
{ winner: 1 }      // TSH team number, or null when no winner could be determined
```

`winner: null` is normal — a handwarmer or an undetermined end.

### `slippi_clip_saved` / `slippi_clip_error`

Same payload, split by outcome. **Only `slippi_clip_saved` reaches the broadcast overlay** — clip failures go to the operator's dock, never on stream. `slippi_clip_saved` is additionally suppressed when `notifySidePanel` is off.

```js
{
  ts: 1753800000000,        // Date.now() at save time
  playerName: "PlayerTag",  // the ATTACKER (see the gotcha below)
  teamNum: 1,
  moveCount: 7,
  damage: 84.3,
  didKill: true,
  path: "C:/…/Replay 2026-07-29 14-02-11.mkv",  // null if OBS reported none
  file: "Replay 2026-07-29 14-02-11.mkv",       // basename, or null
  ok: true,
  error: null,              // set instead of path/file when ok is false
}
```

> `playerName` is the attacker. slippi-js's `conversion.playerIndex` is the player who got **hit** — the attacker is `lastHitBy`. Getting this backwards credits the victim on the broadcast.

`ok: true` with `path: null` is a real case: OBS accepted the save but never emitted `ReplayBufferSaved` within the timeout. The clip is almost certainly on disk; only the path is unknown.

### `player_stats`

The side panel's player cards, head-to-head and Just Finished, from start.gg (`lib/stats/`). Emitted on every change and on connect; always the whole snapshot. Same object as `GET /api/player-stats`.

```js
{
  enabled: true,                   // false = no start.gg token: no players / h2h. completedSets
                                   // still comes through — it is the event service's own reads
  event: { id: "1700988", slug: "tournament/…/event/…", name: "Melee Singles", singles: true },  // or null
  players: {                       // keyed by start.gg PLAYER id (string) — never by column
    "1097": {
      playerId: "1097", name: "ZODD-01",
      state: "done",               // "loading" | "done" | "error" (+ error)
      history: [ { tournament, event, placement, entrants, startAt, online } ],  // singles, final, newest first
      run:     [ { id, opponent, round, myScore, oppScore, won, completedAt } ], // this event, newest first
    },
  },
  h2h: {                           // null unless two singles players with start.gg ids are loaded
    players: ["1097", "1069"],     // which pair this is FOR — check it (see below)
    state: "done",                 // "loading" | "done" | "error" (+ error)
    wins: { "1097": 22, "1069": 8 },   // the whole record
    total: 30,
    recent: [                      // newest five only
      { id, tournament, event, round, online, completedAt,
        winner: "1097",            // player id
        scores: { "1097": 3, "1069": 1 } },  // null/null for a set reported as a bare winner
    ],
  },
  completedSets: {
    state: "done",                 // "none" (no event loaded) | "done" | "error"
    sets: [ { id, round, names: ["ZODD-01", "Redd"], scores: [3, 1], winner: 0, completedAt } ],
  },
  updatedAt: 1789701909000,
}
```

Consumer rules — each is a way to put a healthy-looking wrong number on stream:

- **Orient by id, every render.** Match `players` / `h2h.players` against the start.gg ids the scoreboard shows in each column *now* (`scoreboard.sides[i].players[0].playerId`). Never cache a left/right orientation: Switch Sides moves the players, not the snapshot.
- **An `h2h` for any other pair is not this pair's.** The stats answer seconds after a set loads, so a snapshot for the *previous* pair is routinely current while the new names are already up. Show nothing until `h2h.players` contains both column ids.
- **There is no second source.** A pair still `loading` shows nothing — the TSH head-to-head that used to fill that gap was the one that was wrong.
- **`scores` can be null** for a winner-only report. Derive W/L from `winner`.
- **`completedSets`** is the loaded event's finished sets, newest first (12), from the event service's 90s reads — not a query of its own.

### `control_status`

The full control-panel snapshot. Identical shape to `GET /api/status`. Rebuilt every 2 seconds; on this branch it is **sent only when it changed, and every 5 seconds regardless** — the heartbeat the dock uses to tell a quiet app from a stalled one (no status for 12s dims its health lights). The dock reads the scoreboard itself from the channel's state, so `currentSet.scores` / `teamNames` here are for `/api/status` readers.

```js
{
  tsh: true,                       // TSH's HTTP API answered
  slippi: true,                    // SLP_FOLDER readable
  slippiDetail: { connected: true, detail: "C:/…/Spectate/quinn" },
  portMapping: {
    method: "name",                // "name" | "score" | "character" | "positional" | "manual"
    ports: [ { port: 0, team: 1, name: "PlayerTag" }, … ],
  },
  tshSwapped: false,               // TSH's own teamsSwapped flag; null = unknown
  currentSet: {
    setId: "12345678",             // string from TSH, or null for a manual set
    scores:    { team1: 2, team2: 1 },
    teamNames: { team1: "…", team2: "…" },
    canReport: true,
    reason: "",                    // why reporting is blocked, when canReport is false
    canStart: false,               // start.gg still has this set as not-started/called
    startReason: "…",              // why starting is blocked, when canStart is false
  },
  tournament: {                    // what TSH's provider actually has loaded
    name: "Hundred Acres #43",     // "" when nothing is loaded
    eventName: "Melee Doubles",
  },
  bracketOverlay: {                // branch tsh-replacement: what /o/bracket is showing
    view: "top8",                  // winners | losers | top8 | top16 | full
    group: "Bracket",              // the phase group's label, or null with no event
  },
  shortLink: "100-acres",          // config.BRACKETS.shortLink, for the panel's label
  startggEnabled: true,            // a token is configured
  clipper: {
    settings: { /* full clipper settings — see clipper-settings.js */ },
    obs: { enabled, connected, url, bufferActive, lastError },
    recentClips: [ /* newest first, max 10, same shape as slippi_clip_saved */ ],
    clipsThisGame: 0,
  },
  ts: 1753800000000,
}
```

**`clipper.settings.obsPassword` is included in this payload.** It goes to same-origin dock clients over localhost, which is the design, but it does mean the OBS WebSocket password is readable by anything that can reach `/api/status`. Don't widen that exposure — no remote binding, no proxying it outward.

Two consumer rules learned the hard way:

- The 2s cadence means a blind repaint **eats operator input**. The panel latches a `clipDirty` flag on the first keystroke and skips repainting those fields until save. Any new editable field needs the same treatment.
- The panel's `render()` has **no try/catch**. One missing element id throws, the interval dies, and the whole dock silently freezes while looking fine. Guard every new lookup.

---

## HTTP routes

All under `http://localhost:5001`. Responses are `{ ok, error?, data? }` — the same convention as `lib/tsh-client.js` and `lib/startgg-client.js` — with the exception of `/api/status`, which returns the status object directly.

On this branch the routes live in `lib/server/api/` by what they act on (`status`, `scoreboard`, `event`, `players`, `casters`, `clipper`, `setup`), and there is **no CORS**: the dock and every overlay are served from the app's own origin. (Master's permissive CORS existed for the control panel opened as a `file://` page.)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/dock` | The operator's dock (`public/dock/`). `/` and `/control` redirect here |
| `GET` | `/api/identity` | `{ app: "slippi-bridge", pid }` — how a starting bridge recognises a stale one before killing it (see Port Reclaim in [CLAUDE.md](../CLAUDE.md)) |
| `GET` | `/api/status` | The `control_status` object above |
| `POST` | `/api/swap` | Flip the internal port→team map. Same as the swap-ports hotkey (`Ctrl+Shift+S` by default). Does **not** touch TSH |
| `POST` | `/api/swap-sides` | Press TSH's own Swap Teams — moves names **and scores** across columns |
| `POST` | `/api/reresolve` | Throw the port→team mapping away and re-derive it from TSH's current names and characters. No body. Needs a live game |
| `POST` | `/api/pull-stream` | Pull the next queued stream set onto the scoreboard |
| `GET` | `/api/sets[?finished=1]` | Open sets from TSH's bracket provider; `finished=1` adds completed ones |
| `POST` | `/api/load-set` | `{ setId }` → load it, then refresh status |
| `POST` | `/api/bracket` | `{ kind: "singles" \| "doubles" }` → point TSH at this week's event for that format |
| `POST` | `/api/start-set` | Mark the loaded set in progress on start.gg (`markSetInProgress`). No body |
| `POST` | `/api/report` | Report the current set to start.gg. Manual trigger only. A success also reloads the side panel's stats ~4s later |
| `GET` | `/api/player-stats` | The `player_stats` snapshot above — for checking what the side panel is being fed |
| `GET` | `/api/state` | The overlays' state — the same object `state:full` sends |
| `GET` / `POST` | `/api/casters` | `{ casters: [{ tag, prefix, pronoun, twitter }] }`, up to 4. An empty tag hides that caster's card |
| `GET` | `/api/characters` | The picker's 26 characters in Melee's select-screen order: `[{ id, codename, name, skins }]`, `skins` counted from the icons on disk |
| `POST` | `/api/score` | `{ side, delta: 1 \| -1 }` adds or removes one game; `{ side, score }` (0–9) sets it. The score is the game list, so ± is a game, not a number |
| `POST` | `/api/player` | `{ side, index, tag?, prefix?, pronoun? }` — the names shown. The start.gg entrant behind the side is untouched, so a corrected tag still reports to the right one |
| `POST` | `/api/character` | `{ side, index, codename, skin }`, or `codename: null` for none. Also becomes the player's `main` for the set, which the port map matches the next game's Slippi characters against |
| `POST` | `/api/set-text` | `{ round?, bestOf?, losers?: [bool\|null, bool\|null] }` — overrides; `null` goes back to derived. Send **both** `losers` entries: JSON turns a missing one into `null`, which clears that side's override |
| `POST` | `/api/clear-set` | An empty scoreboard, for a set that isn't on start.gg. The outgoing set's mains are learned first (as on any load) |
| `GET` | `/api/players[?q=]` | The player DB: tags starting with `q`, then containing it; no `q` = the scoreboard's players. Each `{ ref, tag, prefix, pronoun, twitter, startggPlayerId, main, pinnedMain, learnedMains, onAir }`, mains as `{ codename, name, skin }` |
| `POST` | `/api/players/update` | `{ ref, tag, prefix?, pronoun?, twitter? }`. **`tag` must match the record at `ref`** (409 otherwise — a stale search can't edit someone else). A player on the scoreboard shows a prefix/pronoun change at once |
| `POST` | `/api/players/pin` | `{ ref, tag, codename, skin }` pins the main a player's sets open on (beats learned); `codename: null` unpins. Doesn't change the set on air |
| `GET` | `/api/setup` | The Setup tab: `{ overlays: [{ name, path, size, note? }], base, lan: [{ url, name, tailscale }], hotkeys: { mode, bindings, errors }, players: { file, count }, slippiFolder, startgg: { token, shortLink }, theme }` |
| `POST` | `/api/bracket-view` | `{ view?, phaseGroupId? }` — what every bracket source not pinned with `?view=` shows. `phaseGroupId: null` goes back to following the set on air. 400 for an unknown view or a group not in the loaded event |
| `GET` | `/o/scoreboard`, `/o/scoreboard/players`, `/o/casters[?i=N]` | The OBS browser sources. `?animate=false` skips the entrances |
| `GET` | `/o/side-panel[?panel=<id>]` | The 611×1080 panel beside the cam. `?panel=` holds one panel (for styling) |
| `GET` | `/o/bracket[?view=…]` | The bracket. Follows the dock's view unless `?view=` pins it |
| `GET` | `/o/highlights` | The replay-scene frame. Keeps `?clip= ?cam= ?camx= ?pad= ?guides=1` |
| `GET` | `/api/clipper` | `{ settings, obs, recentClips, clipsThisGame, supported }` |
| `POST` | `/api/clipper/settings` | Validate, clamp, persist to `clipper-settings.json`, apply live |
| `POST` | `/api/clipper/toggle` | `{ enabled }` — master switch, applied immediately |
| `POST` | `/api/clipper/test` | Save the replay buffer now; proves the OBS chain |

### The two swap routes are not interchangeable

This is the single easiest thing to get wrong here.

- **`/api/swap`** changes only which Slippi port scores for which TSH team. Nothing moves on the scoreboard. Use it when the *right* names are on the *wrong* sides of the bridge's mapping.
- **`/api/swap-sides`** presses TSH's button, moving both teams' names and scores to the other column — and TSH **keeps that orientation for every set loaded afterwards**.

That persistence is why swap state is load-bearing for reporting: while swapped, TSH column 1 holds start.gg's *slot 2* entrant. `entrantSlot()` applies the inversion. `/api/report` re-reads the swap flag at report time rather than trusting the 2s poll, and **refuses to report** if it can't read it — publishing the loser as the winner is far worse than not publishing.

### `/api/reresolve` — Re-detect Players

For the set that changed before the TO finished entering the names. Everything the bridge knows about the ports still belongs to the *previous* set, and nothing self-corrects until the next game start — by which time game 1's point has already been awarded, possibly to the wrong player.

```js
// success
{ ok: true,
  mode: "singles",              // or "doubles"
  method: "character",          // how it landed: character | positional
  ports: [ { port: 3, team: 1, name: "AVERY" }, { port: 1, team: 2, name: "BLAKE" } ],
  summary: "P4→T1 AVERY, P2→T2 BLAKE" }   // the toast text

// refusal
{ ok: false, error: "No game in progress — the next game start will re-derive on its own" }
```

- It runs **the game-start path with the name/score step skipped**, so the TSH character push, `syncNames`, the doubles team colours and a `slippi_game_start` re-emit all happen as a side effect. Layouts see a normal game start.
- `method: "positional"` means no character match was found — that result is a coin flip, and the panel says so in the toast.
- `port` is 0-based; `summary` prints it 1-based, the way the players and Slippi's own UI count.
- **It needs a live game.** With no `currentGameState` there is nothing to re-push or re-emit; between games the next game start re-derives on its own.
- It deliberately does **not** flip `currentSetGames[*].winnerTeam` the way a TSH-side swap does. Those are TSH column numbers and the columns have not moved — only the bridge's read of which port sits in them.

### `/api/bracket` — what "ok" does and doesn't mean

`kind` indexes `config.BRACKETS.events`, so the two shipped values are `singles` and `doubles`. The bridge resolves the series' short link through start.gg's **web redirect** (the GraphQL API returns `null` for a short slug), queries that tournament's real event list, matches by keyword, and hands TSH the result.

Three things a consumer has to know:

- **`ok: true` is not "the bracket is loaded".** TSH's `/set-tournament` returns `"OK"` before its thread pool finishes fetching, so the response only means the request was accepted. `control_status.tournament.eventName` is the real confirmation — it changes only once TSH's provider has answered.
- **`refreshed: true` means it was already loaded** and the bridge re-pulled it via `/update-bracket` instead. Re-sending an already-loaded URL to `/set-tournament` is a silent no-op inside TSH, so this branch is what stops a second press being a dead button.
- **Concurrent calls are refused, not queued** (`"Still switching brackets…"`). The panel can legitimately be open in an OBS dock and on a phone at once, and answering a `doubles` press with a `singles` result would be worse than a visible refusal.

`warning` may be set on a successful response — it means the event was **not** verified against start.gg (no token, or the lookup failed) and the configured `fallbackSlug` was appended instead. Surface it; TSH accepts a stale slug without complaint and leaves an empty bracket.

Switching is **non-destructive**: TSH keeps the loaded set's names, scores and `set_id`, so a pending `/api/report` still targets the right set. That is why the panel asks for no confirmation.

### `/api/start-set` and `currentSet.canStart`

`canStart` is true only while start.gg reports the loaded set as state **1** (created) or **6**
(called). It is **not** part of the 2s tick's round-trips: `lib/server/start-set.js` caches the
state per set id and fetches it once, in the background, the first time a set id appears. Polling
it would spend 30 of start.gg's 80-requests-per-60s on a value that changes twice a set, and the
first casualty would be reporting.

Consequences for a consumer:

- **`canStart: false` with `startReason: "Checking start.gg…"` is the normal first tick** after a
  set loads. The real answer lands a tick or two later.
- A **preview set id** (`preview_3400584_1_5`) is never startable — start.gg hasn't created the set
  yet because the bracket hasn't been started. Every set in an unstarted event has one, so the
  button legitimately never appears until the TO starts the bracket. Same reason `canReport` is
  false there.
- The route re-checks `canStart` server-side, so a stale panel can't start a finished set.

### `/api/sets` is deliberately slow

TSH's `get_sets` runs an uncached paginated GraphQL query against start.gg on **every** call. The panel fetches on open, on the manual refresh, after a successful load/pull/report, and on a 90s timer that pauses when the document is hidden. Do not turn this into a fast poll.

An empty list is **normal**, not an error: `get_sets` returns start.gg states 1/6/2 (not started, called, in progress), so a finished bracket legitimately returns zero rows.

---

## Adding to this surface

- **A new Socket.io event** — emit it in `index.js`, document the payload here, and remember every consumer may already be connected: send enough state to be useful standalone rather than a delta.
- **A new route** — keep handlers thin and let the client module own the I/O and the `{ ok, error }` shaping. On this branch it goes in the matching `lib/server/api/<group>.js`; `tests/dock-static.test.js` fails if the dock calls a route (or a method) that doesn't exist.
- **A new `control_status` field** — add it to `compose()` in `lib/server/control-status.js`. That one function builds both the startup seed and every 2s rebuild, so the two can't drift; `tests/control-status-shape.test.js` pins that their key sets match.
- **Anything reached from `obs.getStatus()`** must stay synchronous — it runs every 2 seconds.
