# Bridge API Contract

Everything the bridge exposes on `BRIDGE_PORT` (default 5001): the HTTP routes the control panel drives, and the Socket.io events the OBS layouts consume.

This is the contract between `slippi-bridge/` and its two clients — [public/control-panel.html](../slippi-bridge/public/control-panel.html) and the layouts under `TournamentStreamHelper-*/layout/`. Change a payload shape here and something in a browser stops updating **silently**, because nothing on either side validates. Keep this file in step with `index.js`.

For what TSH exposes *to* the bridge, see the TSH HTTP API section of [CLAUDE.md](../CLAUDE.md).

---

## Socket.io events (bridge → browser)

Clients connect to `http://localhost:5001`. On connect, the bridge immediately replays `slippi_game_start` (if a game is live) and `control_status`, so a browser source that loads mid-set is never blank waiting for the next event.

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

### `control_status`

The full control-panel snapshot. Pushed **every 2 seconds** and on connect. Identical shape to `GET /api/status`.

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

A permissive CORS middleware fronts every route. It exists for exactly one case: an OBS dock pointed at `control-panel.html` as a **file**, which runs on a `file://` origin (`Origin: null`) and would otherwise be unable to reach `/api/*`. Same-origin dock use needs none of it.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/control` | The operator panel HTML |
| `GET` | `/api/identity` | `{ app: "slippi-bridge", pid }` — how a starting bridge recognises a stale one before killing it (see Port Reclaim in [CLAUDE.md](../CLAUDE.md)) |
| `GET` | `/api/status` | The `control_status` object above |
| `POST` | `/api/swap` | Flip the internal port→team map. Same as `Ctrl+Shift+S`. Does **not** touch TSH |
| `POST` | `/api/swap-sides` | Press TSH's own Swap Teams — moves names **and scores** across columns |
| `POST` | `/api/reresolve` | Throw the port→team mapping away and re-derive it from TSH's current names and characters. No body. Needs a live game |
| `POST` | `/api/pull-stream` | Pull the next queued stream set onto the scoreboard |
| `GET` | `/api/sets[?finished=1]` | Open sets from TSH's bracket provider; `finished=1` adds completed ones |
| `POST` | `/api/load-set` | `{ setId }` → load it, then refresh status |
| `POST` | `/api/bracket` | `{ kind: "singles" \| "doubles" }` → point TSH at this week's event for that format |
| `POST` | `/api/start-set` | Mark the loaded set in progress on start.gg (`markSetInProgress`). No body |
| `POST` | `/api/report` | Report the current set to start.gg. Manual trigger only |
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
- **A new route** — keep handlers thin and let the client module own the I/O and the `{ ok, error }` shaping, matching the existing block at the end of `index.js`.
- **A new `control_status` field** — add it to **both** the `lastControlStatus` default literal *and* the 2s rebuild. Only adding it to the rebuild leaves a window at startup where consumers see `undefined`; only adding it to the default means it never updates.
- **Anything reached from `obs.getStatus()`** must stay synchronous — it runs every 2 seconds.
