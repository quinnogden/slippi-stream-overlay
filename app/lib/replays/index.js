/**
 * Stream-set replays — Replay Reporter for Slippi's job, for the sets played
 * on stream: each set's .slp files and context.json as one bundle, copied to
 * the archive folder and uploaded to LuckyStats.gg.
 *
 *   capture   a successful report, and every `set-closing`, keep the
 *             scoreboard's set (stream-sets.js) — real start.gg sets with games
 *   meta      start.gg's details for the set (tournament, event, phase, group,
 *             round, stream), read once by set id (context.js metaFromStartgg)
 *   archive   REPLAY_ARCHIVE_FOLDER set: the bundle copied there, re-copied
 *             when a correction changes it (archive.js)
 *   upload    LUCKYSTATS_UPLOAD_KEY set: a reported set is queued at once; any
 *             other from the Replays tab (uploader.js)
 *
 * A set's files are finished by Slippi a moment after GAME!, and start.gg's
 * details arrive in the background, so archiving waits and tries again
 * (`settle`) rather than failing the first time it looks.
 *
 * The dock gets the whole picture as `replays` (sticky, /dock only) on every
 * change. Nothing here ever reaches the broadcast.
 */

const path = require("path");
const { StreamSets } = require("./stream-sets");
const { metaFromStartgg, contextProblem } = require("./context");
const { buildBundle } = require("./bundle");
const { archiveBundle } = require("./archive");
const { LuckyStatsUploads } = require("./uploader");
const { readReplay, recentFiles, isFinished } = require("./slp-file");
const { CHAR_MAP } = require("../char_map");

const SETTLE_RETRY_MS = 15000;
const SETTLE_TRIES = 40;          // ~10 minutes of a file still being written
const EMIT_DEBOUNCE_MS = 150;

/**
 * @param {{ config: object, store: object, startgg: object, io: { emit: Function } }} ctx
 * @param {{ file?: string, uploads?: object }} [opts] — for tests: the data file, a stand-in uploader
 */
function createReplays(ctx, opts = {}) {
  const { config, store, startgg, io } = ctx;
  const sets = new StreamSets(opts.file ?? path.join(__dirname, "..", "..", "data", "stream-sets.json"));
  const archiveRoot = config.REPLAY_ARCHIVE_FOLDER || null;
  const slpFolder = config.SLP_FOLDER;

  const metaLoading = new Map(); // setId → in-flight getSetContext
  const settling = new Map();    // setId → retry timer

  // ── start.gg's details ──────────────────────────────────────────────────────

  /** Read the set's start.gg details once; later calls share or skip it. */
  function ensureMeta(setId) {
    const r = sets.get(setId);
    if (!r || r.meta) return Promise.resolve(r?.meta ?? null);
    if (metaLoading.has(setId)) return metaLoading.get(setId);
    const p = startgg.getSetContext(setId).then((res) => {
      if (!res.ok) {
        sets.update(setId, { metaError: res.error });
        console.warn(`[replays] start.gg's details for set ${setId}: ${res.error}`);
        return null;
      }
      const meta = metaFromStartgg(res.set);
      sets.update(setId, { meta, metaError: null });
      return meta;
    }).catch((err) => {
      sets.update(setId, { metaError: err.message });
      return null;
    }).finally(() => metaLoading.delete(setId));
    metaLoading.set(setId, p);
    return p;
  }

  /** The uploader's bundle: never without start.gg's details (they're asked for, and it waits). */
  function bundleFor(record) {
    if (!record.meta) {
      ensureMeta(record.setId);
      return { ok: false, waiting: true, error: record.metaError ? `start.gg: ${record.metaError}` : "Waiting for start.gg's details" };
    }
    return buildBundle(record, { requireMeta: true });
  }

  const uploads = opts.uploads ?? new LuckyStatsUploads({
    key: config.LUCKYSTATS_UPLOAD_KEY,
    sets,
    bundleFor,
    onChange: () => emitSoon(),
  });

  // ── Archive ─────────────────────────────────────────────────────────────────

  /**
   * Bring a set's archive copy up to date, waiting for its files and start.gg's
   * details when they aren't there yet.
   */
  async function settle(setId, tries = 0) {
    clearTimeout(settling.get(setId));
    settling.delete(setId);
    const r = sets.get(setId);
    if (!r || !archiveRoot) return;
    if (contextProblem(r)) return; // shown in the dock; a fix calls settle again
    await ensureMeta(setId);
    const rec = sets.get(setId);
    const bundle = buildBundle(rec);
    if (!bundle.ok) {
      if ((bundle.waiting || !rec.meta) && tries < SETTLE_TRIES) {
        const t = setTimeout(() => settle(setId, tries + 1), SETTLE_RETRY_MS);
        t.unref?.();
        settling.set(setId, t);
      }
      return;
    }
    if (!rec.meta && tries < SETTLE_TRIES) {
      // Archive without the startgg block only once start.gg has had its chance.
      const t = setTimeout(() => settle(setId, tries + 1), SETTLE_RETRY_MS);
      t.unref?.();
      settling.set(setId, t);
      return;
    }
    if (rec.archive?.digest === bundle.digest) return;
    const res = archiveBundle(bundle, archiveRoot, rec.meta?.tournament?.slug || rec.tournament.slug);
    sets.update(setId, { archive: res.ok
      ? { digest: bundle.digest, dir: res.dir, at: Date.now(), error: null }
      : { ...(rec.archive ?? {}), error: res.error } });
    if (res.ok) console.log(`[replays] Archived set ${setId} → ${res.dir}`);
    else console.warn(`[replays] ${res.error}`);
  }

  // ── Capture ─────────────────────────────────────────────────────────────────

  function capture(sb, { reported = false } = {}) {
    const res = sets.capture(sb, store.tournament(), { reported });
    if (!res.ok) return res;
    ensureMeta(res.record.setId);
    settle(res.record.setId);
    return res;
  }

  store.on("set-closing", (sb) => { capture(sb); });

  /**
   * The set on the scoreboard was just reported: keep it, and queue its upload.
   */
  function onSetReported() {
    const sb = store.scoreboard();
    const res = capture(sb, { reported: true });
    if (!res.ok || !uploads.enabled) return;
    const u = res.record.upload;
    if (u?.state === "staged" && !res.changed) return; // reported again, nothing new
    uploads.enqueue(res.record.setId);
  }

  // ── The Replays tab ─────────────────────────────────────────────────────────

  const onScoreboard = (setId) => String(store.scoreboard().setId ?? "") === String(setId);

  /** A game of a closed set, corrected. The set on the scoreboard is the strip's. */
  function editGame(setId, index, edit) {
    if (onScoreboard(setId)) {
      return { ok: false, error: "This set is still on the scoreboard — fix it on the strip, then it's kept when the set closes" };
    }
    const res = sets.editGame(setId, index, edit);
    if (res.ok) settle(setId);
    return res;
  }

  /**
   * A replay file for a game that has none (a game scored by hand, or a file
   * the app missed): read it, and put its ports on the sides the set's other
   * games had them — else the lower port on the left.
   */
  function attachFile(setId, index, file) {
    if (!slpFolder) return { ok: false, error: "No SLP_FOLDER" };
    const full = path.resolve(slpFolder, path.basename(String(file ?? "")));
    if (!isFinished(full)) return { ok: false, error: "That replay isn't finished (or isn't there)" };
    const info = readReplay(full);
    if (!info.ok) return info;
    const r = sets.get(setId);
    if (!r) return { ok: false, error: "That set isn't in the list" };

    const known = new Map();
    for (const g of r.games) {
      g.replay?.players?.forEach((list, side) => list.forEach((p, slot) => { if (p) known.set(p.port, { side, slot }); }));
    }
    const ports = info.players.map((p) => p.port);
    let place;
    if (ports.every((p) => known.has(p)) && new Set(ports.map((p) => known.get(p).side)).size === 2) {
      place = (p) => known.get(p.port);
    } else {
      // Positional: singles lower port left; teams, the lower port's team left.
      const first = info.players[0];
      const counters = [0, 0];
      place = (p) => {
        const side = info.isTeams ? (p.teamId === first.teamId ? 0 : 1) : (p.port === first.port ? 0 : 1);
        return { side, slot: counters[side]++ };
      };
    }
    const players = [[], []];
    const teamIds = [null, null];
    const characters = [[], []];
    for (const p of info.players) {
      const { side, slot } = place(p);
      players[side][slot] = { port: p.port, characterId: p.characterId, costume: p.costume };
      if (p.teamId != null) teamIds[side] = p.teamId;
      const c = CHAR_MAP[p.characterId];
      characters[side][slot] = c ? { codename: c.codename, name: c.display, skin: p.costume } : null;
    }
    const replay = { file: full, startMs: info.startMs, lastFrame: info.lastFrame, stageId: info.stageId, players, teamIds };
    return editGame(setId, index, { op: "attach", replay, characters });
  }

  /** The folder's newest replays, marked with the set each is already in. */
  function files() {
    const used = new Map();
    for (const r of sets.list()) {
      r.games.forEach((g, i) => { if (g.replay?.file) used.set(path.resolve(g.replay.file), `${r.roundName || r.setId} game ${i + 1}`); });
    }
    return recentFiles(slpFolder ?? "").map((f) => ({
      name: f.name, mtimeMs: f.mtimeMs, size: f.size,
      usedBy: used.get(path.resolve(f.file)) ?? null,
    }));
  }

  function forget(setId) {
    if (onScoreboard(setId)) return { ok: false, error: "This set is on the scoreboard" };
    const r = sets.get(setId);
    if (r?.upload?.state === "uploading") return { ok: false, error: "It's uploading — cancel it first" };
    sets.remove(setId);
    return { ok: true };
  }

  // ── The dock's picture ──────────────────────────────────────────────────────

  function view(r) {
    const score = [0, 1].map((s) => r.games.filter((g) => g.winnerSide === s).length);
    return {
      setId: r.setId,
      round: r.meta?.set?.fullRoundText || r.roundName,
      tournament: r.meta?.tournament?.name || r.tournament?.name || "",
      capturedAt: r.capturedAt,
      reported: !!r.reported,
      edited: !!r.edited,
      onScoreboard: onScoreboard(r.setId),
      sides: r.sides.map((s) => ({ name: s.teamName || s.players.map((p) => p.tag).filter(Boolean).join(" + ") })),
      score,
      games: r.games.map((g) => ({
        winnerSide: g.winnerSide,
        manual: !!g.manual,
        file: g.replay?.file ? path.basename(g.replay.file) : null,
        characters: g.characters ?? null,
        players: g.replay?.players ?? null,
      })),
      problem: contextProblem(r),
      meta: !!r.meta,
      metaError: r.metaError ?? null,
      archive: r.archive ?? null,
      upload: r.upload ? {
        state: r.upload.state, error: r.upload.error ?? null, revision: r.upload.revision ?? null,
        stagedAt: r.upload.stagedAt ?? null, sentBytes: r.upload.sentBytes ?? 0, totalBytes: r.upload.totalBytes ?? 0,
        nextTryAt: r.upload.nextTryAt ?? null, remote: r.upload.remote ?? null,
      } : null,
    };
  }

  function snapshot() {
    const current = uploads.currentCollection?.() ?? null;
    return {
      archive: archiveRoot,
      upload: { enabled: uploads.enabled, connection: uploads.connection ?? null },
      collection: current ? { id: current, ...(sets.collections[current] ?? {}) } : null,
      sets: sets.list().slice(0, 60).map(view),
    };
  }

  let emitTimer = null;
  function emitSoon() {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      io.emit("replays_state", snapshot());
    }, EMIT_DEBOUNCE_MS);
    emitTimer.unref?.();
  }
  sets.on("change", emitSoon);
  // The scoreboard moving changes which set is "on the scoreboard".
  store.on("set-loaded", emitSoon);

  function start() {
    uploads.start?.();
    // Anything a restart interrupted: archive copies and queued uploads resume.
    for (const r of sets.list()) if (archiveRoot && !r.archive?.digest) settle(r.setId);
    emitSoon();
  }

  return {
    sets, uploads, snapshot, start, onSetReported, editGame, attachFile, files, forget, ensureMeta, settle,
    upload: (setId) => uploads.enqueue(setId),
    flush: () => sets.flush(),
  };
}

module.exports = { createReplays };
