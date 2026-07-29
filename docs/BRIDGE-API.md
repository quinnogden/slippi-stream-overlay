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
      iconPath: "…/chara_2_fox_02.png",
    },
    // …
  },
  isDoubles: false,
  isCrew: undefined,            // true only in crew battles
  startedAtZeroZero: true,      // singles only — drives the 0-0 late-bind at game end
  teamColorMap: undefined,      // doubles only: { "1": "#D32F2F", "2": "#1565C0" }
}
```

- A player whose character id doesn't resolve is **omitted** from `players` — don't assume two entries.
- `players` is an object, not an array, and its keys are port indices. `Object.values()` is the safe iteration.
- Consumers must detect doubles from the DOM rather than trusting a cached `isDoubles`; see the `tsh_update` note in [CLAUDE.md](../CLAUDE.md).

### `slippi_game_end`

```js
{ winner: 1 }      // TSH team number, or null when no winner could be determined
```

`winner: null` is normal — a handwarmer, an undetermined end, or a crew battle already over.

### `slippi_crew_update`

Crew battles only. Fires at both game start and game end.

```js
{
  totalStocks:     { "1": 14, "2": 16 },   // TSH team → stocks left, pushed to TSH as the score
  carryOverStocks: { "1": 2,  "2": 4  },   // stocks the active player entered the game with
  playerStats: {
    "PlayerTag": { isActive: true, eliminated: false, hasPlayed: true, stocksTaken: 3, character: "Fox" },
    // …
  },
}
```

`playerStats` is keyed by **player name as TSH reports it**, so a name edited mid-battle appears as a new key.

### `slippi_crew_end`

```js
{ winner: 1 }      // the team that still has stocks
```

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
  },
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

All under `http://localhost:5001`. Responses are `{ ok, error?, data? }` — the same convention as `tsh-client.js` and `startgg-client.js` — with the exception of `/api/status`, which returns the status object directly.

A permissive CORS middleware fronts every route. It exists for exactly one case: an OBS dock pointed at `control-panel.html` as a **file**, which runs on a `file://` origin (`Origin: null`) and would otherwise be unable to reach `/api/*`. Same-origin dock use needs none of it.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/control` | The operator panel HTML |
| `GET` | `/api/identity` | `{ app: "slippi-bridge", pid }` — how a starting bridge recognises a stale one before killing it (see Port Reclaim in [CLAUDE.md](../CLAUDE.md)) |
| `GET` | `/api/status` | The `control_status` object above |
| `POST` | `/api/swap` | Flip the internal port→team map. Same as `Ctrl+Shift+S`. Does **not** touch TSH |
| `POST` | `/api/swap-sides` | Press TSH's own Swap Teams — moves names **and scores** across columns |
| `POST` | `/api/pull-stream` | Pull the next queued stream set onto the scoreboard |
| `GET` | `/api/sets[?finished=1]` | Open sets from TSH's bracket provider; `finished=1` adds completed ones |
| `POST` | `/api/load-set` | `{ setId }` → load it, then refresh status |
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

### `/api/sets` is deliberately slow

TSH's `get_sets` runs an uncached paginated GraphQL query against start.gg on **every** call. The panel fetches on open, on the manual refresh, after a successful load/pull/report, and on a 90s timer that pauses when the document is hidden. Do not turn this into a fast poll.

An empty list is **normal**, not an error: `get_sets` returns start.gg states 1/6/2 (not started, called, in progress), so a finished bracket legitimately returns zero rows.

---

## Adding to this surface

- **A new Socket.io event** — emit it in `index.js`, document the payload here, and remember every consumer may already be connected: send enough state to be useful standalone rather than a delta.
- **A new route** — keep handlers thin and let the client module own the I/O and the `{ ok, error }` shaping, matching the existing block at the end of `index.js`.
- **A new `control_status` field** — add it to **both** the `lastControlStatus` default literal *and* the 2s rebuild. Only adding it to the rebuild leaves a window at startup where consumers see `undefined`; only adding it to the default means it never updates.
- **Anything reached from `obs.getStatus()`** must stay synchronous — it runs every 2 seconds.
