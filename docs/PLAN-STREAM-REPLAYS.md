# Plan — Stream-set replays (Replay Reporter, built in)

Status: **built, not yet used at an event** (R1–R6 on the `stream-replays` branch, 2026-11-10). How
it works now is in CLAUDE.md's "Stream-set replays" section; this file is the plan as written, kept
for its open questions. Where the build differs from the plan:

- **No `REPLAYS` settings block yet.** Only `LUCKYSTATS_UPLOAD_KEY` and `REPLAY_ARCHIVE_FOLDER`.
- **The start.gg fields come from their own query** (`SET_CONTEXT_QUERY`, read by set id when a set
  is kept) instead of widening the bracket queries. `winnersTargetPhaseId` and `ordinal` are null.
- **Upload status is not a `control_status` light.** It is the Replays tab's badge (`replays` event).
- **Still open:** questions 1, 2, 3 and 6 below. For question 4, both work: the dock's Finish button,
  or LuckyStats' auto-finish. For question 5, doubles is built (Replay Reporter's format has teams)
  but not yet tested against a real doubles set. Without question 6's real `context.json`, the format
  is matched to Replay Reporter's source, not to a file it wrote.

## Goal

Every set played on stream ends up as a **per-set replay bundle**: that set's `.slp` files plus a
`context.json` in [Replay Reporter for Slippi](https://github.com/jmlee337/replay-manager-for-slippi)'s
format. The bundle is archived locally and uploaded to LuckyStats.gg, the way Replay Reporter does it
for the other setups. The operator reports the set with the Report button exactly as now.
Everything after that happens in the background and shows in the dock.

The API details are in memory (`reference_luckystats_uploads.md`). In short: base
`https://luckystats.gg/api/integrations/v1`, headers `Authorization: Bearer <LUCKYSTATS_UPLOAD_KEY>`
and `X-App-Id: replay-reporter` (the user has OK'd sharing Replay Reporter's app ID). The steps are
`POST /uploads` → PUT each file to a signed S3 link → `POST /uploads/:id/complete` (staged).
Sets are imported when `POST /tournaments/:id/complete` is called, or when LuckyStats auto-finishes
the tournament after 6h idle.

## What carries over from Replay Reporter, and what doesn't

| Replay Reporter feature | Here |
|---|---|
| Replays grouped per set, labelled, `context.json` | **Build** (`lib/replays/`) |
| Report winner to start.gg | Already have it (`report-set.js`); the bundle hangs off its success |
| Report a DQ | **Add** (Report with a DQ flag, no game data) |
| Mark set started | Already have it (`start-set.js`) |
| Set players (batch / per game) | The port map already does this; **add** a per-game fix in the Replays tab |
| Set / override / unset a game's winner | **Add** per-game editing (the game list already drives the score) |
| Swap Zelda/Sheik | **Add** a per-game character fix (it changes the `context.json` characters) |
| Copy to folder/zip, file and folder naming | **Build** the local archive (`REPLAY_ARCHIVE_FOLDER`) |
| LuckyStats upload with retry journal | **Build** (`lib/replays/uploader.js`) |
| Write display names into the `.slp` | Later / optional |
| Re-time replays to the PC clock | Check first: the stream setup's files may already have a correct `startAt` (see Open questions) |
| USB detection / safe-remove / delete | Not needed: the stream PC writes straight to `SLP_FOLDER`, and the app never deletes its files |
| parry.gg, Offline Mode, manual name lists, tiebreakers, stream assignment, Enforcer | Out of scope |

## Design

### 1. Remember which file each game came from (`game-source.js`, `game-end.js`, `store.js`)

The store's game list is `{ winnerSide, characters, manual }` today, and it doesn't know the file.

- `game-source.js` adds `filePath` to `game-start` and `game-end`, plus `startAt` and `lastFrame`
  (for `durationMs`).
- `game-end.js` passes into `recordGame` the **ports per side** (from the port map at game end, the
  same moment that decides the winner), each port's character and costume, and the file.
- A game becomes `{ winnerSide, characters, manual, file, ports: [[…],[…]], startMs, durationMs }`.
  It persists with the set, and old saves still load because restore merges over `emptySet()`.
- **Handwarmers record nothing**, as now. The bundle's game count has to equal the score, or
  LuckyStats refuses it with `game_count_mismatch`.
- **A manual ± game has no file.** That set can't be bundled until the game is given a file (the
  Replays tab shows the folder's recent files to attach) or removed.

### 2. `context.json` builder (`lib/replays/context.js`, pure)

This matches Replay Reporter's `Context` type (`src/common/types.ts`; the builder is in
`src/renderer/App.tsx`). LuckyStats' importer validates against that format, so **match it field
for field**:

- `scores[i].slots` are in **game 1's port order** (slot 0 = the side holding the lowest port in
  game 1), and each slot's `score` is the score **before** game i.
- `finalScore` is the last game's slots with the final score; `bestOf` is
  `max(wins) * 2 - 1` (Replay Reporter's own formula, not the set's best-of).
- `players.entrant1/2` are in **start.gg's slot order** (not the strip's left/right, which Switch
  Sides reverses). Each player is `{ name, characters: [display names] }`.
- `startgg`: `tournament {name, location}`, `event {id, name, slug, hasSiblings}`,
  `phase {id, name, hasSiblings}`,
  `phaseGroup {id, name, bracketType, hasSiblings, waveId, winnersTargetPhaseId}`,
  `set {id, internalId, fullRoundText, ordinal, round, stream}`.
  - Some of these aren't fetched yet: location, event slug and name, phase name, waveId,
    winnersTargetPhaseId, ordinal, round number, stream. Extend `lib/event/queries.js` (and the
    capture script's fixtures) to fetch them.
- `characters[].id` is Slippi's external character id (the same 0–25 the app uses), plus `costume`.
- Doubles: up to two names, ports and characters per slot, plus `teamId`. Replay Reporter supports
  doubles, so this can too.
- **Fixture test against a real `context.json` written by Replay Reporter.** Get one from the TO's
  machine. A hand-written expected file would pass while proving nothing (see tests/README.md).

### 3. Per-set history (`lib/replays/stream-sets.js`)

`data/stream-sets.json` (atomic writes) keeps one record per stream set that closed with games.
It holds the set's ids, the game list, the bundle state (`incomplete | ready | archived`) and the
upload state (`queued | uploading | staged | imported | failed | superseded`). It is written on
`set-closing` and on a successful report. This is what the dock lists, and what the uploader drains.

### 4. Local archive (`lib/replays/archive.js`)

The archive copies each bundle to `REPLAY_ARCHIVE_FOLDER/<tournament>/<round> - <p1> vs <p2>/`
(context.json + `Game 1.slp` …), with names in Replay Reporter's style. It **copies, never moves**:
`SLP_FOLDER` is Slippi's. `null` turns the archive off. An optional zip comes later.

### 5. Uploader (`lib/replays/uploader.js`)

- **The only module that sends uploads to luckystats.gg.** `lib/stats/luckystats.js` keeps reading
  ratings. The two use different keys and endpoints, and share nothing but the host.
- **Persistent journal** (`data/upload-journal.json`): the idempotency key, file sizes and SHA-256
  checksums of each revision are saved **before** `POST /uploads`, so a crash mid-upload resumes with
  the same key.
  - Same contents → same key.
  - Changed contents (a game edited after upload) → a new key = a new revision. LuckyStats swaps
    the new revision in atomically.
- Each file is PUT with the returned headers **exactly**. A 412 on a retried PUT means the file is
  already there. Links last 15 min (`POST /uploads/:id/links` refreshes them).
- Limits: 10 approvals and 120 requests per minute, 3 unfinished transfers. Honour `Retry-After`;
  back off with jitter on 5xx and network errors. Uploads run in the background and must never delay
  Report or Start.
- `GET /tournaments/:id` is polled every 15s only while this tournament has uploads, for the dock's
  status display.
- **Finish tournament**: a dock button (with a confirm step) calls
  `POST /tournaments/:id/complete {collectionVersion}`. Otherwise LuckyStats' auto-finish handles it.
  A `409 uploads_in_progress` reply means drain the queue first.
- Not uploaded: preview sets, manual (non-start.gg) sets, crew battles (no start.gg set id).
- No `LUCKYSTATS_UPLOAD_KEY` → archive only, and the dock says so.

### 6. When it runs

- **On a successful Report** (`reportCurrentSet` in `index.js`, beside `mainsLearning.commit`):
  bundle, archive and queue the upload.
- **A set reported somewhere else** (the TO reported from start.gg or their own laptop): the set's
  record stays `ready`, and the Replays tab has **Upload** for it.
- **A set edited after its upload**: the record goes back to `ready`, and re-uploading creates a new
  revision.

### 7. Dock — new **Replays** tab (8th)

- A list of this event's stream sets, newest first. Each row shows the round, the players, the
  score, a badge per game (character icons, winner, file ✓/✗), the bundle state and the upload
  state.
- Per set: **Upload / Re-upload**, **Open folder**, **Cancel upload** (`DELETE /uploads/:id`, only
  before the tournament is finished).
- Per game: change the winner, take the game out, fix the character (Zelda ⇄ Sheik), attach a file.
- Tournament footer: total sets uploaded (from LuckyStats' status), **Finish tournament**.
- Setup tab: the upload key's state (`GET /connection`), the archive folder.
- `control_status` gets an upload-queue light. A failed upload shows in the dock, never on stream.

### 8. Config, preflight, docs

- `config.local.js`: `LUCKYSTATS_UPLOAD_KEY` (added 2026-11-09), `REPLAY_ARCHIVE_FOLDER`.
  Later settings get a `REPLAYS` block with per-key defaults in its module, like `CLIPPER`.
- `scripts/preflight.js`: probes `GET /connection` when the key is set. Add the keys to
  `config.local.example.js`.
- Update CLAUDE.md (a `lib/replays/` section, plus the luckystats-module invariant),
  docs/BRIDGE-API.md (new routes and the `replays` state section) and docs/TESTING.md (replaying a
  set in order to test a bundle).

## Milestones

- **R1** — Each game remembers its file, ports and timing (store + game-source + game-end). Tests:
  handwarmers are excluded, ports and sides are right after ⇄ and ⇆, an old save restores.
- **R2** — `context.js` + the extra start.gg fields + the fixture test against a real Replay Reporter
  `context.json`.
- **R3** — Stream-set history + local archive + the Replays tab (read-only list).
- **R4** — Uploader with journal, retries and status polling; it runs on a successful report.
  Test it against LuckyStats with one finished set from a past event.
- **R5** — Per-game editing, DQ report, re-upload revisions, cancel, Finish tournament.
- **R6** — Preflight, docs, and a dry run at a weekly before relying on it.

## Open questions (ask before R1)

1. **Is the stream setup a console mirrored through Slippi Launcher, or netplay/Dolphin?** This
   decides whether `startAt` is trustworthy (Replay Reporter re-times Wii clocks) and whether
   re-timing is needed.
2. **Does the TO also run Replay Reporter on the stream setup's sets?** If so, both would upload the
   same set id, and the later revision wins. Pick one source.
3. **Does the start.gg account connected on LuckyStats admin the tournament?** LuckyStats requires
   it.
4. **Who finishes the tournament on LuckyStats?** The dock button, the TO, or auto-finish.
5. **Doubles in scope for v1?** The format supports it. The clipper's singles-only limit doesn't
   apply here.
6. **Get a real `context.json` from Replay Reporter** (any set) for the R2 fixture.
