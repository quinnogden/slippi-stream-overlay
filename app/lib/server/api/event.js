/**
 * The loaded start.gg event: the set picker, loading a set, this week's
 * singles/doubles switch, and what the bracket overlay shows.
 */

const { BRACKET_VIEWS: VIEWS } = require("../../event/bracket-feed");

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, event, bracketDirector, bracketOps, refreshControlStatus, emit }
 */
function register(app, { store, event, bracketDirector, bracketOps, refreshControlStatus, emit }) {
  // The set picker: playable sets first. Answered from the event service's
  // last read (its timer, and the re-reads after a press); ?refresh=1 is the
  // dock's ↻ and re-reads start.gg first.
  //
  // The dock is told when the list changes (`sets:changed`) and fetches it
  // again, so Up next shows a report's next set the moment the app has it —
  // not on the dock's own fallback poll, which used to add up to 90s.
  let listed = null;
  event.on("change", () => {
    const now = JSON.stringify(event.openSets({ includeDone: true }));
    if (now === listed) return;
    listed = now;
    emit?.("event_sets", { at: Date.now() });
  });
  app.get("/api/sets", async (req, res) => {
    if (req.query.refresh === "1") {
      const r = await event.refresh();
      if (!r.ok) return res.json(r);
    }
    const status = event.status();
    if (!event.snapshot().event) {
      return res.json({ ok: false, error: status.error ?? "No event loaded — press Singles or Doubles" });
    }
    res.json({ ok: true, data: event.openSets({ includeDone: req.query.finished === "1" }), status });
  });

  // The loaded event, its phase groups and the last read's status.
  app.get("/api/event", (req, res) => {
    res.json({ ok: true, ...event.snapshot() });
  });

  app.post("/api/load-set", async (req, res) => {
    const setId = req.body?.setId;
    if (setId == null) return res.status(400).json({ ok: false, error: "setId required" });
    const result = await event.loadSet(setId);
    // Push the report/start state out now rather than on the next tick.
    if (result.ok) refreshControlStatus();
    // On our start.gg stream too — after the answer: the scoreboard is
    // already up, and the strip's chip says how the mark went.
    if (result.ok && bracketOps) bracketOps.markLoaded(result.setId).catch(() => {});
    res.json(result);
  });

  // The Bracket tab's "Run the bracket" card (lib/event/bracket-ops.js). The
  // card draws from the `bracket-ops` dock event; this is the same snapshot.
  app.get("/api/bracket-ops", (req, res) => {
    if (!bracketOps) return res.status(503).json({ ok: false, error: "Bracket operations aren't running" });
    res.json({ ok: true, ...bracketOps.snapshot() });
  });

  // { action: "call" | "start" | "stream" | "report" | "reset", setId, scores?, dq? }
  app.post("/api/bracket-ops/action", async (req, res) => {
    if (!bracketOps) return res.status(503).json({ ok: false, error: "Bracket operations aren't running" });
    res.json(await bracketOps.act(req.body ?? {}));
  });

  // { markOnStream?: boolean, streamName?: string }
  app.post("/api/bracket-ops/settings", (req, res) => {
    if (!bracketOps) return res.status(503).json({ ok: false, error: "Bracket operations aren't running" });
    res.json(bracketOps.setSettings(req.body ?? {}));
  });

  // This week's singles or doubles event, via the series' short link.
  app.post("/api/bracket", async (req, res) => {
    const kind = req.body?.kind;
    if (typeof kind !== "string" || !kind) {
      return res.status(400).json({ ok: false, error: 'kind ("singles" | "doubles") required' });
    }
    const result = await event.switchEvent(kind);
    refreshControlStatus();
    res.json(result);
  });

  // Any event by a pasted start.gg URL (the Bracket tab's box). Same reply as
  // /api/bracket.
  app.post("/api/bracket-url", async (req, res) => {
    const url = req.body?.url;
    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ ok: false, error: "url required" });
    }
    const result = await event.loadEventUrl(url);
    refreshControlStatus();
    res.json(result);
  });

  // What the bracket overlay shows: { view?, phaseGroupId? }. Every bracket
  // source not pinned with ?view= follows `view`; phaseGroupId null goes back
  // to following the set on the scoreboard.
  app.post("/api/bracket-view", (req, res) => {
    const { view, phaseGroupId } = req.body ?? {};
    if (view !== undefined && !VIEWS.includes(view)) {
      return res.status(400).json({ ok: false, error: `view must be one of ${VIEWS.join(", ")}` });
    }
    if (phaseGroupId !== undefined && phaseGroupId !== null
        && !event.groups().some((g) => g.id === String(phaseGroupId))) {
      return res.status(400).json({ ok: false, error: `phase group ${phaseGroupId} isn't in the loaded event` });
    }
    if (view !== undefined) store.setBracketView(view);
    if (phaseGroupId !== undefined) store.setBracketPhaseGroup(phaseGroupId);
    const v = store.view();
    res.json({ ok: true, view: v.bracketView, phaseGroupId: v.bracketPhaseGroupId,
      showing: store.bracket()?.phaseGroupId ?? null });
  });

  // What the bracket overlay is pointed at (bracket-director.js):
  //   { action: "auto" | "next" | "prev" | "live" }   the page tour, or a held page
  //   { action: "page", page }                        hold one page (a key from bracket.pages[view])
  //   { action: "pan", dir: "up"|"down"|"left"|"right" } | { action: "zoom", dir: "in"|"out" }
  //   { action: "overview" } | { action: "goto", cx, cy }   the Board camera (board pixels)
  app.post("/api/bracket-camera", (req, res) => {
    if (!bracketDirector) return res.status(503).json({ ok: false, error: "The bracket director isn't running" });
    const b = req.body ?? {};
    const r = bracketDirector.command({ ...b, cx: b.cx == null ? b.cx : Number(b.cx), cy: b.cy == null ? b.cy : Number(b.cy) });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    res.json(r);
  });
}

module.exports = { register };
