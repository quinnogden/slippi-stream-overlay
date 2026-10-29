# App API Contract

Everything the app exposes on `BRIDGE_PORT` (default 5001): the HTTP routes the operator's dock drives, the Socket.io namespaces the dock and the OBS sources listen on, and the pages themselves.

This is the contract between `app/` and its clients — the dock ([public/dock/](../app/public/dock/)) and the overlays under [overlays/](../overlays/). Change a payload shape here and something in a browser stops updating **silently**, because nothing on either side validates. Keep this file in step with the code.

---

## Overlay channel — `/overlay` and `/dock`

Every overlay — `/o/scoreboard`, `/o/scoreboard/players`, `/o/casters`, `/o/side-panel`, `/o/bracket`, `/o/highlights` — uses the `/overlay` namespace (highlights only for `theme`) through [overlays/shared/overlay-client.js](../overlays/shared/overlay-client.js); the dock uses `/dock` through the same client. Built in [lib/overlay/channel.js](../app/lib/overlay/channel.js).

| Event | Direction | Payload |
|---|---|---|
| `state:full` | app → page | The store's snapshot: `{ v, rev, tournament, scoreboard, casters, view, bracket, bracketShot }`. Sent on connect and on request |
| `state:patch` | app → page | `{ from, rev, ops: [{ path, value }] }` — whole top-level sections. One per tick, however many store commands ran in it |
| `state:resync` | page → app | No payload. Asks for `state:full` |
| `game:start` / `game:end` | app → both | The `slippi_game_start` / `slippi_game_end` payloads below |
| `clip:saved` | app → both | The `slippi_clip_saved` payload |
| `stats` | app → overlay | The `player_stats` payload |
| `status` / `clip:error` | app → dock | The `control_status` / `slippi_clip_error` payloads |
| `crew:notice` | app → dock | The `crew_notice` payload: a crew game that changed no stocks, or started with a side nobody was sent in for. Never on the broadcast |
| `theme` | app → both | `{ pack }` (from `theme_changed`), after `POST /api/theme` changed the pack. **An overlay fades out and reloads** — `connect()` and `followTheme()` both listen; the dock only updates its select. Not sticky: a page that loads later reads the new `theme.css` anyway |

- **`from` is what keeps a source honest.** A page applies a patch only when `from` ≤ its own rev. A larger `from` means it missed one, and it must send `state:resync` rather than apply it: every later patch carries only the sections that changed, so a source that missed one would otherwise show the old score indefinitely while looking healthy. A patch whose `rev` it already has (it connected mid-burst, and its `state:full` was newer) is ignored. `state:full` is always taken, even at a lower rev — the app may have restarted. `tests/overlay-patch.test.js` pins all three.
- **Selectors run on change only.** `ov.select(path, fn)` compares the JSON at `path`, so a casters edit doesn't re-run, and re-animate, the scoreboard.
- **Sticky events.** A page that connects mid-game gets `game:start` (dropped at `game:end`, a handwarmer's included) and the last `stats`; the dock also gets the last `status`.
- **The feature modules don't know about the channel.** They emit the event names below through `ctx.io`, which is the channel's `emit()`; its `RELAY` table maps each to the names above, per namespace, and an event with no entry goes nowhere. Nothing is sent on the default namespace.
- **Overlay urls are absolute** (`/o/shared/overlay.css`), so a source works with or without a trailing slash. Every stylesheet sits one level under `/o/`, because a theme pack's `--logo-url` resolves against the stylesheet that uses it. The theme switch is `overlays/theme.css` (`/o/theme.css`) and the packs are `overlays/themes/<pack>/`. `tests/overlays-static.test.js` resolves every page's urls through the server's own tables.
- **Start the app before OBS**, or refresh the sources: a browser source whose page failed to load doesn't retry. Once a page has loaded, it survives app restarts, because socket.io reconnects and is sent `state:full`.

### The `scoreboard` section

```js
{
  setId: "92837465",               // start.gg set id; null for a manual set; "preview_…" before the bracket starts
  phaseGroupId, identifier: "C",
  round: "Winners Semi-Final",     // the override if set, else start.gg's round name
  bestOfLabel: "Flex",             // derived from lPlacement (set-text.js) unless overridden; "" = override "None"
  isGrandFinal, isReset, isPreview,
  isDoubles,                       // the set's shape on load; the dock's toggle; a doubles game with no set
  sides: [                         // [left, right] — switchSides() reverses the array
    { score: 2,                    // derived: the games this side has won
      losers: false,               // the [L] mark, derived in grand finals unless overridden
      color: null,                 // doubles: the team colour — Slippi's at each game start, or the dock's pick
      teamName: "", entrantId: "1234567", seed: 3, fromLosers: false,
      players: [ { playerId, tag, prefix, pronoun,
                   character: { codename: "fox", name: "Fox", skin: 2 } | null,  // what's shown
                   main } ] },     // what the port map matches game 1 against
    { … },
  ],
  games: [ { winnerSide: 0, characters: [[…], […]] | null, manual: false } ],  // the score IS this list
  overrides: { round: null, bestOf: null, losers: [null, null] },              // null = derived
  crew: null,                      // a crew battle — see below
}
```

Built by `scoreboard()` in [lib/scoreboard/store.js](../app/lib/scoreboard/store.js); every write is a store command.

**A crew battle is a set with `crew`** ([lib/crew/crew-model.js](../app/lib/crew/crew-model.js)). Starting one replaces the set on the scoreboard (`set-closing`, then `set-loaded`), and a set load or Clear set ends it. While it's on, everything a reader already uses is derived from it, so the scoreboard overlay, the port map and the dock's names need no crew branch:

- `sides[i].score` is the crew's **stocks left**; `games` stays empty (a crew game moves stocks, it isn't recorded).
- `sides[i].players[0]` is the player in, with their own sponsor `prefix` and pronoun, `main` = what they last played else their DB main, the live `character`, and `playerId: null` (no stats are fetched). With nobody in, it's `{ tag: <crew name>, prefix: "" }` — in the tag, because the scoreboard hides a name with no tag. `teamName` is the crew's name; the scoreboard overlay draws it from `crew` in a chip under the player in (none with nobody in — the name card is the crew's name then).
- `round` is `"Crew Battle"` unless overridden; `bestOfLabel` is `""`; `isDoubles` is `false`; `losers` are both `false`; `setId` is `null`.

```js
crew: {
  stocksEach: 4,                   // 1–9
  active: [memberId | null, …],    // who's in, per column; nobody goes in by themselves
  teams: [                         // [left, right] — switchSides() reverses it with the sides
    { name: "ACRES", total: 6,
      members: [ { id: 1, tag: "Zodd", prefix: "", pronoun: "",
                   icon: { codename, name, skin } | null,   // last played, else the DB main
                   stocks: 2, played: true,
                   status: "active" | "in" | "out" } ] },  // in now / stocks left / none left
    { … },
  ],
}
```

At game end the winner keeps their last-frame stocks, capped at what they carried in (a forgotten SD can't gain one) and at least one; the loser goes to 0 and their column's `active` to `null`. A handwarmer, a winner the port map can't place, or a column with nobody in applies nothing and sends `crew_notice`. `POST /api/score` ± (and the score hotkeys) is one stock for the player in. The other sections: `tournament` `{ name, slug, eventName, eventSlug, kind }`, `casters` `[{ tag, prefix, pronoun, twitter }]`, `view` `{ bracketView, bracketPhaseGroupId }`.

### The `bracket` section

What the bracket overlay draws, published by [lib/event/bracket-feed.js](../app/lib/event/bracket-feed.js) from the event service's reads. `null` with no event loaded. **Not saved** with the rest of the state — it is re-read from start.gg on boot — so a bracket refresh never writes `live-state.json`.

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
  pages: {                         // what each view is shown on (layout.js paginate / paginateList)
    [view]: [ { key: "WW1-W2x2",   //   stable across score changes: a refresh mid-hold doesn't jump
                label: "Winners · Rounds 1–2",  // a readable name for the page ("" for a one-page view)
                short: "W R1–R2",  //   the dock's page key
                setIds: [ … ],     //   the sets on it, in round order
                wrap: { W: 2 } } ] //   k-up per side, as layoutPage lays it out
  },                               //   — upnext included: { key: "U1", … }, a screenful of rows each
  upNext: [ { setId, status: "onstream" | "live" | "ready", state, round, group,  // every live or
              winner: null, slots: [ { entrantId, seed, score, dq, from } ] } ],   //   ready set in the
  upNextEntrants: { [id]: { … } }, // EVENT (all pools), the set on air first with its live score;
}                                  //   entrants as above, from whichever group
```

The layout (card positions, connectors) is computed by [overlays/bracket/layout.js](../overlays/bracket/layout.js), which is pure and loads in the page, the dock and Node alike: the feed cuts the pages with it so the dock's page strip and every source agree, and the page lays each one out. **Every page fits the viewport at or above the legibility floor**; a view that fits whole is one page keyed `"all"`. A view that doesn't is first pruned (rounds past the next one with anybody in it are dropped), so a set id in `views[v]` may be on no page. Which view a source shows is `view.bracketView` (`POST /api/bracket-view`), unless its url pins one with `?view=` — and a pinned source tours its own view's pages, ignoring `bracketShot`.

### The `bracketShot` section

What the bracket overlay is showing right now, owned by [lib/event/bracket-director.js](../app/lib/event/bracket-director.js) (which runs the tour's clock). **Not saved**: the tour ticks every few seconds, and a restart opening on the tour is right.

```js
{
  mode: "tour" | "page" | "board",  // turning the pages · held on one until Auto · the classic board, steered
  view: "full", group: "3441449",   // what it was set for: a switch of either opens the new view's
                                    //   action page — touring if it was, held otherwise
  page: "WW1-W2x2",                 // a key from bracket.pages[view] (kept in board mode: ◀ ▶ go on from it)
  since: 1790000000000, holdMs: 14750,  // tour only: when the page went up and its hold — the dots fill over it
  camera: null                      // board only: { x, y, zoom } (board pixels at the top-left, scale)
}                                   //   or { overview: true }; the page clamps it to the board it draws
```

A page that disappears (the pages were cut again — a round got somebody in it) gives way to the page with the action, in the same mode. Up Next has no Board.

---

## Event payloads

The names the feature modules emit; pages receive them under the channel's names above.

### `slippi_game_start`

The whole `currentGameState`. Emitted on game start, on a port swap or re-detect, on Switch Sides during a game, and (as a sticky `game:start`) to each newly-connected page.

```js
{
  players: {                    // keyed by Slippi port index (0-based), as a string key
    "0": {
      playerIndex: 0,           // Slippi port, 0-based
      side: 1,                  // scoreboard side, 0 = left — the scoring authority is the port map
      slot: 0,                  // which player of that side (doubles)
      teamNum: 2,               // side + 1, the payload's long-standing name for it
      costumeIndex: 2,          // player.characterColor
      codename: "fox",          // icon codename
      display: "Fox",
    },
    // …
  },
  isDoubles: false,
}
```

- A player whose character id doesn't resolve is **omitted** from `players` — don't assume two entries.
- There is deliberately **no icon path**. Build it browser-side with `Overlay.icon({ codename, skin })`.
- `players` is an object, not an array, and its keys are port indices. `Object.values()` is the safe iteration.
- The scoreboard's characters are already in the state (`sides[i].players[j].character`); this event is for what only a live game has (which ports are playing).

### `slippi_game_end`

```js
{ winner: 1 }                   // side + 1 (1 = left), or null
{ winner: null, handwarmer: true }
```

`winner: null` is normal — a handwarmer, an LRA-start with no winner, or a port the map can't place.

### `crew_notice`

```js
{ ok: false, text: "No one sent in for SALTY — no stocks changed" }
```

Dock only (`crew:notice`), shown as a toast. Sent during a crew battle when a game starts with a column nobody was sent in for, and when a game ends without moving any stocks (a handwarmer, no winner, an unmapped winner, a column with nobody in) — the operator then fixes the stocks by hand in the Crew tab.

### `slippi_clip_saved` / `slippi_clip_error`

Same payload, split by outcome. **Only `slippi_clip_saved` reaches the broadcast overlay** — clip failures go to the operator's dock, never on stream. `slippi_clip_saved` is additionally suppressed when `notifySidePanel` is off.

```js
{
  ts: 1753800000000,        // Date.now() at save time
  playerName: "PlayerTag",  // the ATTACKER (see the gotcha below)
  teamNum: 1,               // the attacker's side + 1
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

The side panel's player cards, head-to-head and Just Finished, from start.gg and luckystats.gg (`lib/stats/`). Emitted on every change and on connect; always the whole snapshot. Same object as `GET /api/player-stats`.

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
    recent: [                      // newest seven only
      { id, tournament, event, round, online, completedAt,
        winner: "1097",            // player id
        scores: { "1097": 3, "1069": 1 } },  // null/null for a set reported as a bare winner
    ],
  },
  lucky: {                         // luckystats.gg; null with no LUCKYSTATS_KEY, or no singles pair
    players: ["1097", "1069"],     // which pair this is FOR — check it, as for h2h
    state: "done",                 // "loading" | "done" | "error" (+ error) | "none" (no start.gg user ids)
    ratings: {                     // keyed by start.gg PLAYER id; a player luckystats doesn't know is absent
      "1097": { rank: 167,                          // Lucky Rank; null when unranked
                className: "Regional Threat", classKey: "regional-threat",   // null when unranked
                badge: "/assets/luckystats/class-regional-threat.svg" | null,   // the app's copy; null if it couldn't be saved
                region: "MD/VA Melee",               // their public Region, else their calculated primaryRegion — never a crew
                regionIcon: "/assets/luckystats/region-306be3064a1e1bdd.jpg" | null,  // the Region's artwork (app's copy)
                regionRank: 2 | null,                // their place in the shown Region's crew ranking (regions[].ranking.rank); null for a calculated region
                elo: 2514 | null },                  // luckystats' Elo (its Glicko μ), rounded
    },
    matchup: {                     // null unless both players were found
      winProbability: { "1097": 0.958, "1069": 0.042 },   // glickoOnly — never blended
    } | null,
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
- **There is no second source.** A pair still `loading` shows nothing.
- **`scores` can be null** for a winner-only report. Derive W/L from `winner`.
- **`completedSets`** is the loaded event's finished sets, newest first (12), from the event service's 90s reads — not a query of its own.
- **A `lucky.matchup` for any other pair is not this pair's** — the same rule as `h2h`: show the projection only when `lucky.players` contains both column ids. `ratings` are per player, so a player carried over from the last set keeps theirs.
- **Credit luckystats.** Any card drawing from `lucky` says "Powered by LuckyStats.gg" (with the clover); that was the condition of the endpoint.
- **Any `ratings` field can be null** (unranked, no class, no region, an image that couldn't be saved): show nothing for it and leave no room for it.
- **Images are the app's.** `badge` and `regionIcon` are paths the app serves; luckystats' own urls never reach a source (venue Wi-Fi).
- **Where both sources answer, show start.gg's** — the head-to-head is start.gg's (luckystats' undercounts); `lucky` carries only what start.gg has no answer for.

### `control_status`

The dock's status snapshot. Identical shape to `GET /api/status`. Rebuilt every 2 seconds, **sent only when it changed, and every 5 seconds regardless** — the heartbeat the dock uses to tell a quiet app from a stalled one (no status for 12s dims its health lights). The scoreboard itself reaches the dock as state, not through here.

```js
{
  startgg: { ok: true, state: "ok", error: null },  // the event service's last read
  slippi: true,                    // SLP_FOLDER readable
  slippiDetail: { connected: true, detail: "C:/…/Spectate/quinn" },
  portMapping: {
    method: "character",           // "character" | "positional" | "manual"
    ports: [ { port: 0, side: 1, slot: 0, name: "PlayerTag" }, … ],
  },
  currentSet: {
    setId: "12345678",             // or null for a manual set
    canReport: true,
    reason: "",                    // why reporting is blocked, when canReport is false
    canStart: false,               // start.gg still has this set as not-started/called
  },
  tournament: { name: "Hundred Acres #51", eventName: "Melee Singles (Flex Bo5)" },  // "" when none
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

**`clipper.settings.obsPassword` is included in this payload.** It goes to same-origin dock clients, which is the design, but it does mean the OBS WebSocket password is readable by anything that can reach `/api/status` — including a phone on the venue LAN. Don't widen that exposure further — no proxying it outward.

---

## HTTP routes

All under `http://localhost:5001`. Responses are `{ ok, error?, … }` — the same convention as `lib/startgg-client.js` — except `/api/status` and `/api/state`, which return their object directly. The routes live in `lib/server/api/` by what they act on (`status`, `scoreboard`, `crew`, `event`, `players`, `casters`, `clipper`, `setup`), and there is **no CORS**: the dock and every overlay are served from the app's own origin.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/dock` | The operator's dock (`public/dock/`). `/` and `/control` redirect here |
| `GET` | `/api/identity` | `{ app: "slippi-bridge", pid }` — how a starting app recognises a stale copy of itself before killing it (see Port reclaim in [CLAUDE.md](../CLAUDE.md)) |
| `GET` | `/api/status` | The `control_status` object above |
| `GET` | `/api/state` | The overlays' state — the same object `state:full` sends |
| `GET` | `/api/player-stats` | The `player_stats` snapshot above — for checking what the side panel is being fed |
| `GET` | `/api/event` | The loaded event, its phase groups and the last read's status |
| `GET` | `/api/sets[?finished=1][&refresh=1]` | The set picker, playable sets first: `{ ok, data: [{ setId, status, roundName, identifier, names, seeds, scores, preview, … }], status }`. Answered from the last read; `refresh=1` re-reads start.gg first (the dock's ↻) |
| `POST` | `/api/load-set` | `{ setId }` → re-read that set from start.gg, fill pronouns and mains from the player DB, put it on the scoreboard. The outgoing set's mains are learned first |
| `POST` | `/api/bracket` | `{ kind: "singles" \| "doubles" }` → load this week's event of that kind |
| `POST` | `/api/bracket-url` | `{ url }` → load the event a pasted start.gg URL names. Same reply as `/api/bracket` |
| `POST` | `/api/bracket-view` | `{ view?, phaseGroupId? }` — what every bracket source not pinned with `?view=` shows: `winners`, `losers`, `top8`, `top16`, `full` or `upnext`. `phaseGroupId: null` goes back to following the set on air. 400 for an unknown view or a group not in the loaded event |
| `POST` | `/api/bracket-camera` | What the bracket overlay is pointed at (`bracketShot`): `{ action: "auto" }` (tour from the action page), `"next"` / `"prev"` / `"live"` (hold a page), `{ action: "page", page }`, and the Board: `{ action: "pan", dir: "up"\|"down"\|"left"\|"right" }`, `{ action: "zoom", dir: "in"\|"out" }`, `{ action: "overview" }` (again: back to a readable zoom at the action), `{ action: "goto", cx, cy }` (board pixels — the dock's minimap). The first Board press frames the page that was up rather than moving. `{ ok, shot }`; 400 for a bad action, page or direction, 409 with no bracket or for the Board in Up Next |
| `POST` | `/api/start-set` | Mark the loaded set in progress on start.gg (`markSetInProgress`). No body |
| `POST` | `/api/report` | Report the loaded set to start.gg: winner plus every game's winner. Manual trigger only. A success also learns the players' mains and reloads the stats and the bracket |
| `POST` | `/api/swap` | The ports are the wrong way round: flip which side each port plays for. The scoreboard doesn't move. Same as the swap-ports hotkey |
| `POST` | `/api/swap-sides` | The two sides trade columns — names, scores, entrant ids and the game list together. Same as the switch-sides hotkey |
| `POST` | `/api/reresolve` | Throw the port map away and re-derive it from the players' mains. No body. Needs a live game |
| `GET` | `/api/characters` | The picker's 26 characters in Melee's select-screen order: `[{ id, codename, name, skins }]`, `skins` counted from the icons on disk |
| `POST` | `/api/score` | `{ side, delta: 1 \| -1 }` adds or removes one game; `{ side, score }` (0–9) sets it. The score is the game list, so ± is a game, not a number. **In a crew battle** ± is one stock for that column's player in; `score`, or ± with nobody in, is a 409 |
| `POST` | `/api/player` | `{ side, index, tag?, prefix?, pronoun? }` — the names shown. **A changed tag or prefix unlinks the scoreboard from its start.gg set** (`store.detachSet()`: set id, entrants, seeds and team name go; names, score and round stay; nothing to report) and a changed tag clears that slot's `playerId`. Capitalisation alone is a correction and changes neither. Replies `{ ok, detached }`. 409 during a crew battle (as are `/api/doubles` and `/api/players/assign`): its names are the roster's |
| `POST` | `/api/character` | `{ side, index, codename, skin }`, or `codename: null` for none. Also becomes the player's `main` for the set, which the port map matches the next game's Slippi characters against |
| `POST` | `/api/set-text` | `{ round?, bestOf?, losers?: [bool\|null, bool\|null] }` — overrides; `null` goes back to derived. `bestOf: "None"` makes `bestOfLabel` `""`: the scoreboard hides its best-of pill. Send **both** `losers` entries: JSON turns a missing one into `null`, which clears that side's override |
| `POST` | `/api/clear-set` | An empty scoreboard, for a set that isn't on start.gg. Always singles. The outgoing set's mains are learned first (as on any load) |
| `POST` | `/api/clear-score` | Back to 0–0 on the loaded set: the game list is emptied, names and entrants stay. Same as the clear-score hotkey. 409 during a crew battle (the hotkey does nothing) |
| `POST` | `/api/doubles` | `{ on: boolean }` — singles or doubles by hand. On gives each side a second player; off **drops** the second player (the dock asks first when one has a name). A doubles game with no start.gg set loaded turns it on by itself |
| `POST` | `/api/side-color` | `{ side, color: "red" \| "blue" \| "green" \| null }` — a doubles side's team colour (Melee's three, stored as the hex Slippi's would be). The next doubles game start sets it again from Slippi's teams |
| `POST` | `/api/crew/start` | `{ stocksEach?: 1–9 (4), teams: [{ name, members: [member…] } ×2] }`, `teams[0]` the left column, 1–10 members each. A member is `{ tag, prefix?, pronoun?, ref? }`: the DB record is the one at `ref` while its tag matches, else a lookup by tag; a blank prefix or pronoun and the main come from it. Replaces the set on the scoreboard (the dock asks first over one with games) |
| `POST` | `/api/crew/end` | Takes the crew battle off; the scoreboard is left blank. 409 with none on |
| `POST` | `/api/crew/pick` | `{ side, id }` sends that member in, `id: null` nobody. 409 for a member who is out. Mid-game the column keeps Slippi's character |
| `POST` | `/api/crew/stock` | `{ side, id, delta: 1 \| -1 }` — one stock for any member, 0 to `stocksEach`. 0 takes them out (and off `active`); above 0 brings them back |
| `POST` | `/api/crew/roster` | `{ side, name, members: [{ id?, …member }] }` — the crew's name and its members in their new order. With an `id` it's that member (stocks kept); without, a new one on full stocks; left out, taken off — **409 for anyone who has played, lost a stock or is in** |
| `GET` | `/api/crews` | The saved crews, A–Z: `{ crews: [{ name, members: [{ tag, prefix, pronoun }] }] }` (`app/data/crews.json`) |
| `POST` | `/api/crews/save` | `{ name, members }` — replaces a saved crew of the same name, in any case. Only the typed fields are kept; mains are looked up at start. `{ ok, replaced, crews }` |
| `POST` | `/api/crews/delete` | `{ name }` → `{ ok, removed, crews }` |
| `GET` / `POST` | `/api/casters` | `{ casters: [{ tag, prefix, pronoun, twitter }] }`, up to 4. An empty tag hides that caster's card |
| `GET` | `/api/players[?q=]` | The player DB: tags starting with `q`, then containing it; no `q` = the scoreboard's players. Each `{ ref, tag, prefix, pronoun, twitter, startggPlayerId, main, pinnedMain, learnedMains, onAir }`, mains as `{ codename, name, skin }` |
| `POST` | `/api/players/update` | `{ ref, tag, prefix?, pronoun?, twitter? }`. **`tag` must match the record at `ref`** (409 otherwise — a stale search can't edit someone else). A player on the scoreboard shows a prefix/pronoun change at once |
| `POST` | `/api/players/pin` | `{ ref, tag, codename, skin }` pins the main a player's sets open on (beats learned); `codename: null` unpins. Doesn't change the set on air |
| `GET` | `/api/players/suggest[?q=][&scope=list]` | The name fields' autocomplete. **While an event is loaded, only its entrants** (from the bracket graphs — everyone in a set read so far), filled in from the DB; with none, or `scope=list` (the casters), the DB (`playerDb.search`). `{ scope: "event"\|"list", total, players }`, each as `/api/players` plus `team` (doubles) and `seed`; `ref` is `null` for an entrant not in the DB. No `q` (the field was just clicked): every entrant by seed, or the DB A–Z capped at 150 — `total` is the uncapped count |
| `POST` | `/api/players/assign` | Puts a suggested player in one slot, like a set load: tag, prefix, pronoun, `playerId` and the preferred main. `{ side, index, playerId }` for an entrant of the loaded event (upserted into the DB), `{ side, index, ref, tag }` for a DB record (409 rules as `update`). `playerId` is overwritten — `null` for a record with no start.gg id — so the side panel can't show the previous player's stats under the new name. A different player in the slot unlinks the start.gg set, as `/api/player` does; `{ ok, tag, detached }`. The main also becomes the shown character **unless a game is running**; a player with no main leaves the character alone |
| `GET` | `/api/players/values` | `{ prefixes, pronouns }`: each distinct value in the DB, most used first — the prefix and pronoun suggestions |
| `GET` | `/api/setup` | The Setup tab: `{ overlays: [{ name, path, size, note? }], base, lan: [{ url, name, tailscale }], hotkeys: { mode, bindings, errors }, players: { file, count }, slippiFolder, startgg: { token, shortLink }, theme, themes }` — `theme` is the pack `overlays/theme.css` imports (null if unreadable), `themes` every folder under `overlays/themes/` with a `theme.css` |
| `POST` | `/api/theme` | `{ pack }` — rewrites the `@import` line in `overlays/theme.css` (atomic; the header comment is kept) and sends `theme`. 400 for a pack not in `themes` or a `theme.css` with no `@import` line to repoint. `{ ok, pack, changed }`. The file is git-tracked, so a non-default pack shows as a local change |
| `GET` | `/api/clipper` | `{ settings, obs, recentClips, clipsThisGame }` |
| `POST` | `/api/clipper/settings` | Validate, clamp, persist to `clipper-settings.json`, apply live |
| `POST` | `/api/clipper/toggle` | `{ enabled }` — master switch, applied immediately |
| `POST` | `/api/clipper/test` | Save the replay buffer now; proves the OBS chain |
| `GET` | `/o/scoreboard`, `/o/scoreboard/players`, `/o/casters[?i=N]` | OBS browser sources. `?animate=false` skips the entrances |
| `GET` | `/o/side-panel[?panel=<id>]` | The 611×1080 panel beside the cam. `?panel=` holds one panel (for styling) |
| `GET` | `/o/bracket[?view=…]` | The bracket (and Up Next). Follows the dock's view and shot unless `?view=` pins a view, which then tours its own pages |
| `GET` | `/o/highlights` | The replay-scene frame. `?clip= ?cam= ?camx= ?pad= ?guides=1` |
| `GET` | `/assets/icons/chara_2_<codename>_<NN>.png` | The stock character icons |

### The two swaps are not interchangeable

- **`/api/swap`** (swap ports) changes only which Slippi port plays for which side. Nothing moves on the scoreboard. Use it when the scoreboard is right and the live characters (and so the next point) are on the wrong side. The correction sticks for the rest of the set.
- **`/api/swap-sides`** (switch sides) moves the two sides across the scoreboard — to match where the players actually sit. Each side carries its start.gg entrant id and its games, so a report afterwards still names the right winner; there is no swap state to read and nothing to invert. The port map flips with it, so the live characters follow.

### `/api/reresolve` — Re-detect

For a set loaded after its game 1 had started, or ports the operator suspects. Loading a set already re-detects on its own when a game is live; this is the manual press.

```js
// success
{ ok: true,
  mode: "singles",              // or "doubles"
  method: "character",          // how it landed: character | positional
  ports: [ { port: 3, side: 0, slot: 0, name: "AVERY" }, { port: 1, side: 1, slot: 0, name: "BLAKE" } ],
  summary: "P4→L AVERY, P2→R BLAKE" }   // the toast text

// refusal
{ ok: false, error: "No game in progress — the next game start will re-derive on its own" }
```

- It matches each port's character against the players' mains (pinned, then learned, then what the set opened on), so it is only as good as the player DB.
- `method: "positional"` means no character matched — a coin flip, and the dock says so.
- `port` is 0-based; `summary` prints it 1-based, the way the players and Slippi count.

### `/api/bracket` — Singles / Doubles

`kind` indexes `config.BRACKETS.events`, so the two shipped values are `singles` and `doubles`. The app resolves the series' short link through start.gg's **web redirect** (the GraphQL API returns `null` for a short slug), reads that tournament's event list, matches by keyword ([lib/event/event-target.js](../app/lib/event/event-target.js)), and loads the event.

- **`ok: true` means the event is loaded** — phase groups, sets and brackets read. `refreshed: true` means it was already the loaded event and was re-read instead.
- **Ambiguity is refused**: a tournament with both "Melee Singles" and "Melee Singles Amateur" errors and names the candidates.
- **`warning`** means the event list couldn't be read and the configured `fallbackSlug` was used — unverified. Surface it.
- **Concurrent calls are refused, not queued** (`"Still switching brackets…"`): the dock can be open in OBS and on a phone at once.
- **Switching doesn't touch the scoreboard.** The set on air, its score and its set id survive, so a pending report still targets the right set. That is why the dock asks for no confirmation.

**`/api/bracket-url`** (`{ url }`, the Bracket tab's URL box) loads any event by a pasted start.gg link, with the same reply and the same rules (concurrent calls refused, the scoreboard untouched). An event URL in any shape `normalizeEventUrl` accepts (`/events/` plural, `/overview`, a query string) loads directly; a tournament URL or short link loads its event only if it has exactly one, and otherwise errors with the event names. It clears the tournament's `kind`, since it isn't this week's Singles or Doubles.

### `/api/start-set` and `currentSet.canStart`

`canStart` is true only while start.gg reports the loaded set as state **1** (created) or **6** (called). It is **not** part of the 2s tick's round-trips: `lib/server/start-set.js` caches the state per set id and fetches it once, in the background, the first time a set id appears. Polling it would spend 30 of start.gg's 80-requests-per-60s on a value that changes twice a set, and the first casualty would be reporting.

- **`canStart: false` is the normal first tick** after a set loads ("Checking start.gg…"). The real answer lands a tick or two later.
- A **preview set id** (`preview_3400584_1_5`) is never startable or reportable — start.gg hasn't created the set because the bracket hasn't been started. Load it again once the TO has started the bracket.
- The route re-checks server-side, so a stale dock can't start a finished set.

### `/api/sets` is cheap; `?refresh=1` is not

The picker is answered from the event service's last read, which refreshes every 90s through the background budget and after every report. `refresh=1` re-reads every phase group of the event from start.gg on the operator's (unbudgeted) path — fine for a press, never for a loop. An empty list is **normal** for a finished bracket; `finished=1` adds the done sets.

---

## Adding to this surface

- **A new event** — emit it from the feature module through `ctx.io`, add it to `RELAY` in `lib/overlay/channel.js` for the namespaces that want it (an event with no entry goes nowhere), and document the payload here. Every consumer may already be connected: send enough to be useful standalone rather than a delta, or make it sticky.
- **New state** — a store command in `lib/scoreboard/store.js`, never a direct write; the channel and persistence follow from its `change` event.
- **A new route** — keep handlers thin; it goes in the matching `lib/server/api/<group>.js`. `tests/dock-static.test.js` fails if the dock calls a route (or a method) that doesn't exist.
- **A new `control_status` field** — add it to `compose()` in `lib/server/control-status.js`. That one function builds both the startup seed and every rebuild, so the two can't drift; `tests/control-status-shape.test.js` pins that their key sets match.
- **Anything reached from `obs.getStatus()`** must stay synchronous — it runs every 2 seconds.
