/**
 * bracket-ops.js — running start.gg's bracket from the dock: the Bracket tab's
 * "Run the bracket" card, and the stream mark on each set loaded.
 *
 * The operator isn't the TO, but works the bracket all night beside one or
 * two: calling a set, starting one, putting one on stream, reporting a set
 * played off stream (or a DQ), taking back a misreport. Each press goes
 * straight to start.gg on the operator's (unbudgeted) path, then shows at
 * once over start.gg's lagging lists (event-service afterAction).
 *
 *   - **The set on the scoreboard is reported from the strip**, never here: the
 *     strip sends each game in order and queues the replays. This card refuses
 *     it and says so.
 *   - **A set loaded onto the scoreboard is put on our start.gg stream**
 *     (`markOnStream`, on by default), so start.gg's bracket and the TO's stream
 *     queue show what's on stream. Which stream: the one picked by name (kept
 *     week to week — each week's tournament has its own stream ids, the same
 *     names), else the tournament's only one.
 *   - **A press on a preview set** (`preview_…`: the bracket hasn't started)
 *     can't reach start.gg — except Start, which starts the bracket itself
 *     (start.gg starts the whole bracket when its first set starts). A stream
 *     mark or a call on one waits in `queue` and is sent to the same match
 *     (set-model findSameMatch) once the bracket has real ids; dropped after
 *     10 minutes.
 *   - **Call order** for the sets ready to play: the earliest in the bracket
 *     first (they hold it up), then the closest seeds (the closest matches run
 *     longest, so they should start soonest), then the better-seeded set.
 *
 * Publishes `bracket_ops` (dock only, sticky) on every change: the card draws
 * from it, so it never polls.
 */

const fs = require("fs");
const path = require("path");
const { findSameMatch } = require("./set-model");

const QUEUE_MS = 10 * 60000;
const RECENT = 12;
const DEFAULTS = { markOnStream: true, streamName: "" };

/**
 * @param {object} ctx — { event, store, startgg, io }
 * @param {{ file?: string|null, refreshControlStatus?: Function, forgetStartState?: Function, log?: Function }} [opts]
 */
function createBracketOps(ctx, opts = {}) {
  const { event, store, startgg, io } = ctx;
  const file = opts.file ?? null;
  const log = opts.log ?? ((m) => console.log(`[bracket] ${m}`));
  const refreshControlStatus = opts.refreshControlStatus ?? (() => {});
  const forgetStartState = opts.forgetStartState ?? (() => {});

  let settings = { ...DEFAULTS, ...readSettings(file) };
  let queue = [];        // presses waiting for the bracket's real ids
  let lastMark = null;   // the last stream mark: { setId, ok, queued, error, stream, at }

  // ── Settings ──────────────────────────────────────────────────────────────

  /** The stream "on stream" means: the one picked by name, else the tournament's only one. */
  function stream() {
    const list = event.streams();
    const want = String(settings.streamName ?? "").trim().toLowerCase();
    if (want) {
      const hit = list.find((s) => s.name.toLowerCase() === want);
      if (hit) return hit;
    }
    return list.length === 1 ? list[0] : null;
  }

  function setSettings(patch) {
    const next = { ...settings };
    if (typeof patch?.markOnStream === "boolean") next.markOnStream = patch.markOnStream;
    if (typeof patch?.streamName === "string") next.streamName = patch.streamName.trim().slice(0, 100);
    settings = next;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2));
        fs.renameSync(`${file}.tmp`, file);
      } catch (err) {
        log(`Couldn't save ${path.basename(file)}: ${err.message}`);
      }
    }
    publish();
    return { ok: true, settings: { ...settings } };
  }

  // ── What the card draws ───────────────────────────────────────────────────

  function rows() {
    const groups = event.groups().filter((g) => g.graph);
    const labelled = groups.length > 1;
    const onAirId = store.scoreboard().setId != null ? String(store.scoreboard().setId) : null;
    const ours = stream();
    const out = [];
    const recent = [];
    for (const g of groups) {
      const graph = g.graph;
      for (const set of Object.values(graph.sets)) {
        const slots = set.slots.map((s) => {
          const ent = s.entrantId ? graph.entrants[s.entrantId] : null;
          return { entrantId: s.entrantId, name: ent?.name ?? "", seed: s.seed, score: s.score, dq: s.dq };
        });
        const known = slots.filter((s) => s.entrantId).length;
        const status = set.state === "done" ? "done"
          : set.state === "live" ? "live"
          : set.called ? "called"
          : known === 2 ? "ready"
          : "waiting";
        if (status === "waiting" && known === 0) continue;
        const row = {
          setId: set.id, phaseGroupId: g.id, group: labelled ? g.label : "",
          round: set.name, identifier: set.identifier, status, preview: set.preview,
          lPlacement: set.lPlacement, startedAt: set.startedAt, completedAt: set.completedAt,
          station: set.station, streamId: set.streamId,
          onStream: !!ours && set.streamId === ours.id,
          onAir: set.id === onAirId,
          winner: set.winner, slots, callOrder: null,
        };
        (status === "done" ? recent : out).push(row);
      }
    }
    const rank = { live: 0, called: 1, ready: 2, waiting: 3 };
    out.sort((a, b) => rank[a.status] - rank[b.status] || callKey(a, b));
    let n = 0;
    for (const r of out) if (r.status === "ready") r.callOrder = ++n;
    recent.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return { sets: out, recent: recent.slice(0, RECENT) };
  }

  function snapshot() {
    const info = event.eventInfo();
    const { sets, recent } = info ? rows() : { sets: [], recent: [] };
    return {
      enabled: startgg.enabled,
      event: info ? { name: info.name, tournamentName: info.tournamentName } : null,
      rebuilding: event.rebuilding,
      streams: event.streams(),
      stream: stream(),
      settings: { ...settings },
      lastMark,
      queue: queue.map(({ kind, label, at }) => ({ kind, label, at })),
      sets,
      recent,
    };
  }

  let publishing = false;
  function publish() {
    if (publishing) return;
    publishing = true;
    setImmediate(() => {
      publishing = false;
      io.emit("bracket_ops", snapshot());
    });
  }

  // ── Presses ───────────────────────────────────────────────────────────────

  /**
   * One press on one set.
   * @param {{ action: "call"|"start"|"stream"|"report"|"reset", setId: string,
   *           scores?: Object<string, number>, dq?: string }} body —
   *   report: `scores` per entrant id (the winner has more), or `dq`: the entrant DQ'd
   * @returns {Promise<{ ok: boolean, error?: string, queued?: boolean, text?: string }>}
   */
  async function act(body) {
    const { action } = body ?? {};
    const setId = body?.setId == null ? null : String(body.setId);
    if (!["call", "start", "stream", "report", "reset"].includes(action)) return { ok: false, error: `Unknown action "${action}"` };
    if (!startgg.enabled) return { ok: false, error: "start.gg token not configured — the bracket is read-only" };
    const found = setId && event.findSet(setId);
    if (!found) return { ok: false, error: "That set isn't in the loaded event — refresh the list" };
    const { set } = found;
    const label = describe(found);

    if (set.preview && action !== "start") {
      if (action === "call" || action === "stream") {
        if (event.rebuilding) return enqueue(action, found, label);
        return { ok: false, error: "The bracket hasn't started on start.gg — start a set first (that starts the bracket)" };
      }
      return { ok: false, error: "The bracket hasn't started on start.gg — this set doesn't exist there yet" };
    }

    let r;
    switch (action) {
      case "call":
        if (set.state !== "pending") return { ok: false, error: `${label} is already ${set.state === "live" ? "in progress" : "finished"}` };
        r = await startgg.callSet(setId);
        if (r.ok) event.afterAction(setId, { state: 6 });
        break;
      case "start":
        if (set.state !== "pending") return { ok: false, error: `${label} is already ${set.state === "live" ? "in progress" : "finished"}` };
        if (set.slots.some((s) => !s.entrantId)) return { ok: false, error: `${label} is still waiting on a player` };
        r = await startgg.startSet(setId);
        if (r.ok) event.afterAction(setId, { state: 2, startedAt: Math.floor(Date.now() / 1000), startsBracket: set.preview });
        break;
      case "stream": {
        const s = stream();
        if (!s) return { ok: false, error: noStreamReason() };
        r = await startgg.assignStream(setId, s.id);
        if (r.ok) event.afterAction(setId, { streamId: s.id });
        break;
      }
      case "report": {
        if (String(store.scoreboard().setId ?? "") === setId) {
          return { ok: false, error: "That set is on the scoreboard — report it from the strip, which sends each game and queues its replays" };
        }
        const plan = reportPlan(set, body);
        if (!plan.ok) return plan;
        r = await startgg.reportSet(setId, plan.winnerId, plan.gameData, { isDQ: plan.dq });
        if (r.ok) event.afterAction(setId, { state: 3, winnerId: plan.winnerId, scores: plan.scores, dq: plan.dq });
        if (r.ok) r.text = plan.text;
        break;
      }
      case "reset":
        if (set.state !== "done") return { ok: false, error: `${label} hasn't been reported` };
        r = await startgg.resetSet(setId);
        if (r.ok) event.afterAction(setId, { state: 1 });
        break;
    }
    if (!r.ok) return { ok: false, error: r.error };
    log(`${verb(action)} ${label}${r.text ? ` — ${r.text}` : ""}`);
    forgetStartState(setId);
    refreshControlStatus();
    publish();
    return { ok: true, text: r.text };
  }

  function noStreamReason() {
    const list = event.streams();
    if (!list.length) return "This tournament has no stream on start.gg (Manage → Streams)";
    return `Pick which stream is ours — this tournament has ${list.length} (${list.map((s) => s.name).join(", ")})`;
  }

  /** A preview set's press, sent once start.gg has given its match a real id. */
  function enqueue(kind, found, label) {
    const ents = found.set.slots.map((s) => s.entrantId);
    if (ents.some((e) => !e)) return { ok: false, error: "That set is still waiting on a player" };
    queue = queue.filter((q) => !(q.kind === kind && q.fromId === found.set.id));
    queue.push({ kind, fromId: found.set.id, identifier: found.set.identifier, entrantIds: ents,
                 phaseGroupId: found.groupId, label, at: Date.now() });
    log(`${verb(kind)} ${label}: queued until start.gg has the bracket's real sets`);
    publish();
    return { ok: true, queued: true };
  }

  /** Send what's queued to the sets start.gg now has for the same matches. */
  async function flushQueue() {
    if (!queue.length || event.rebuilding) return;
    const groups = event.groups();
    const todo = queue;
    queue = [];
    for (const q of todo) {
      if (Date.now() - q.at > QUEUE_MS) {
        log(`Dropped the queued ${q.kind} for ${q.label}: start.gg never came back with the set`);
        continue;
      }
      const want = { identifier: q.identifier, entrantIds: q.entrantIds, phaseGroupId: q.phaseGroupId, excludeId: q.fromId };
      const hit = findSameMatch(groups, want) ?? findSameMatch(groups, { ...want, loose: true });
      if (!hit) { queue.push(q); continue; }
      const r = q.kind === "stream" ? await markOn(hit.set.id) : await act({ action: q.kind, setId: hit.set.id });
      if (!r.ok) log(`The queued ${q.kind} for ${q.label} failed: ${r.error}`);
    }
    publish();
  }

  // ── The stream mark on a loaded set ───────────────────────────────────────

  /**
   * A set was loaded onto the scoreboard: put it on our start.gg stream. Not
   * awaited by the load — the scoreboard is already up; the strip's chip says
   * how it went.
   */
  async function markLoaded(setId) {
    if (!settings.markOnStream || !startgg.enabled || setId == null) return { ok: false, skipped: true };
    const found = event.findSet(setId);
    if (!found) return { ok: false, skipped: true };
    // A preview set waits for the bracket to start: the set on air follows
    // its match to the real id (event-service), and the queue marks that.
    if (found.set.preview) {
      const r = enqueue("stream", found, describe(found));
      lastMark = { setId: String(setId), ok: false, queued: r.ok, error: r.ok ? null : r.error, stream: stream()?.name ?? null, at: Date.now() };
      publish();
      return r;
    }
    return markOn(setId);
  }

  async function markOn(setId) {
    const s = stream();
    const found = event.findSet(setId);
    if (!s) {
      lastMark = { setId: String(setId), ok: false, queued: false, error: noStreamReason(), stream: null, at: Date.now() };
      publish();
      return { ok: false, error: lastMark.error };
    }
    if (found?.set.streamId === s.id) {
      lastMark = { setId: String(setId), ok: true, queued: false, error: null, stream: s.name, at: Date.now() };
      publish();
      return { ok: true };
    }
    const r = await startgg.assignStream(setId, s.id);
    lastMark = { setId: String(setId), ok: r.ok, queued: false, error: r.ok ? null : r.error, stream: s.name, at: Date.now() };
    if (r.ok) {
      event.afterAction(setId, { streamId: s.id });
      log(`Put ${found ? describe(found) : `set ${setId}`} on stream (${s.name}) on start.gg`);
    } else {
      log(`Couldn't put set ${setId} on stream on start.gg: ${r.error}`);
    }
    publish();
    return r;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  let onAirKey = null;
  function start() {
    event.on("change", () => { publish(); flushQueue().catch((err) => log(`Queue failed: ${err.message}`)); });
    // The set on air followed its new id: its stream mark goes with it.
    event.on("set-relinked", ({ from, to }) => {
      if (lastMark?.setId === from) lastMark = { ...lastMark, setId: to };
    });
    store.on("change", ({ keys }) => {
      if (!keys.includes("scoreboard")) return;
      const key = String(store.scoreboard().setId ?? "");
      if (key === onAirKey) return;
      onAirKey = key;
      publish();
    });
    publish();
  }

  return { start, act, markLoaded, setSettings, snapshot, stream };
}

/**
 * Call order among the ready sets: earliest in the bracket first (the higher
 * lPlacement — its loser goes out sooner), then the closest seeds, then the
 * better-seeded set. Sets without seeds keep their place.
 */
function callKey(a, b) {
  if (a.status !== "ready" || b.status !== "ready") return 0;
  const lp = (b.lPlacement ?? 0) - (a.lPlacement ?? 0);
  if (lp) return lp;
  const gap = (r) => {
    const [x, y] = r.slots.map((s) => s.seed);
    return x != null && y != null ? Math.abs(x - y) : Infinity;
  };
  const best = (r) => Math.min(...r.slots.map((s) => (s.seed == null ? Infinity : s.seed)));
  return gap(a) - gap(b) || best(a) - best(b);
}

/**
 * What a report from the card sends: the winner, each entrant's score, and
 * the games (start.gg keeps no score without them). The order the games went
 * isn't known, so the loser's wins come first and the set ends on the
 * winner's last game. A DQ sends no games.
 */
function reportPlan(set, body) {
  const ents = set.slots.map((s) => s.entrantId);
  if (ents.some((e) => !e)) return { ok: false, error: "This set is still waiting on a player" };
  if (body.dq != null) {
    const dq = String(body.dq);
    if (!ents.includes(dq)) return { ok: false, error: "The DQ'd player isn't in this set" };
    const winnerId = ents.find((e) => e !== dq);
    return { ok: true, dq: true, winnerId, gameData: undefined, scores: { [dq]: -1, [winnerId]: 0 }, text: "DQ" };
  }
  const scores = {};
  for (const e of ents) {
    const v = Number(body.scores?.[e]);
    if (!Number.isInteger(v) || v < 0 || v > 9) return { ok: false, error: "Each score must be a whole number from 0 to 9" };
    scores[e] = v;
  }
  const [a, b] = ents.map((e) => scores[e]);
  if (a === b) return { ok: false, error: `The score is tied (${a}–${b}) — a set needs a winner` };
  const winnerId = a > b ? ents[0] : ents[1];
  const loserId = a > b ? ents[1] : ents[0];
  const gameData = [];
  for (let i = 0; i < scores[loserId]; i++) gameData.push({ gameNum: gameData.length + 1, winnerId: loserId });
  for (let i = 0; i < scores[winnerId]; i++) gameData.push({ gameNum: gameData.length + 1, winnerId });
  return { ok: true, dq: false, winnerId, gameData, scores, text: `${Math.max(a, b)}–${Math.min(a, b)}` };
}

function describe(found) {
  const s = found.set;
  return `${s.name || "set"}${s.identifier ? ` (${s.identifier})` : ""}`;
}

function verb(action) {
  return { call: "Called", start: "Started", stream: "Put on stream", report: "Reported", reset: "Reset" }[action] ?? action;
}

function readSettings(file) {
  if (!file) return {};
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch (_) {
    return {};
  }
}

module.exports = { createBracketOps, callKey, reportPlan };
