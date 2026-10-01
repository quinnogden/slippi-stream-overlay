/**
 * The loaded start.gg event: the set picker, loading a set, this week's
 * singles/doubles switch, and what the bracket overlay shows.
 */

const { VIEWS } = require("../../event/bracket-model");

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, event, refreshControlStatus }
 */
function register(app, { store, event, refreshControlStatus }) {
  // The set picker: playable sets first. Answered from the event service's
  // last read (refreshed every 90s); ?refresh=1 is the dock's ↻ and re-reads
  // start.gg first.
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
    res.json(result);
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
}

module.exports = { register };
