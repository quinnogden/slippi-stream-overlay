/**
 * The control panel's HTTP surface.
 *
 * Served to an OBS custom browser dock. Browser→bridge calls are same-origin
 * (bridge port); the bridge makes every start.gg call server-side.
 */

const path = require("path");

/**
 * @param {import("express").Express} app
 * @param {object} deps — {
 *   publicDir, event, clipperSettings, obs,
 *   refreshControlStatus, clipperSnapshot, reportCurrentSet, startCurrentSet,
 *   swapPorts, switchSides, reresolvePorts, recordClip, playerStatsSnapshot
 * }
 */
function registerRoutes(app, deps) {
  const {
    publicDir, event, clipperSettings, obs,
    refreshControlStatus, clipperSnapshot, reportCurrentSet, startCurrentSet, swapPorts,
    switchSides, reresolvePorts, recordClip, playerStatsSnapshot,
  } = deps;

  app.get("/control", (req, res) => {
    res.sendFile(path.join(publicDir, "control-panel.html"));
  });

  // Lets a bridge that finds this port busy confirm the occupant is one of its
  // own — and which process to stop — instead of asking the operator for netstat.
  app.get("/api/identity", (req, res) => {
    res.json({ app: "slippi-bridge", pid: process.pid });
  });

  app.get("/api/status", async (req, res) => {
    res.json(await refreshControlStatus());
  });

  // The ports are the wrong way round: flip which side each port plays for.
  // The scoreboard stays put (same as Ctrl+Shift+S).
  app.post("/api/swap", (req, res) => {
    const result = swapPorts();
    refreshControlStatus();
    res.json(result);
  });

  // Throw away the port map and re-derive it from the players' mains.
  app.post("/api/reresolve", (req, res) => {
    const result = reresolvePorts();
    refreshControlStatus();
    res.json(result);
  });

  // The two sides trade columns on the scoreboard — names, scores, entrant ids
  // and the per-game list together (store.switchSides). The port map follows.
  app.post("/api/swap-sides", (req, res) => {
    switchSides();
    refreshControlStatus();
    res.json({ ok: true });
  });

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
    // Push the new names out now rather than on the next 2s tick, so the
    // panel's Current Set card matches what the operator just loaded.
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

  // start.gg's "Start match" for the loaded set. No body: the set is whatever
  // the scoreboard has loaded, which is what the panel is showing.
  app.post("/api/start-set", async (req, res) => {
    res.json(await startCurrentSet());
  });

  app.post("/api/report", async (req, res) => {
    res.json(await reportCurrentSet());
  });

  // The side panel's stats snapshot — the same object `player_stats` pushes.
  // For checking what the overlay is being fed, from a browser.
  app.get("/api/player-stats", (req, res) => {
    res.json(playerStatsSnapshot());
  });

  // ── Combo clipper ───────────────────────────────────────────────────────────
  app.get("/api/clipper", (req, res) => {
    res.json({ ok: true, ...clipperSnapshot() });
  });

  app.post("/api/clipper/settings", (req, res) => {
    const result = clipperSettings.save(req.body ?? {});
    // Apply either way: save() returns ok:false when only the disk write failed,
    // and the operator's change should still take effect for this session.
    obs.applySettings();
    refreshControlStatus();
    res.json(result);
  });

  app.post("/api/clipper/toggle", (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled (boolean) required" });
    }
    const result = clipperSettings.save({ enabled });
    obs.applySettings();
    refreshControlStatus();
    res.json(result);
  });

  // Proves the whole OBS chain (websocket → buffer → file) without waiting for a
  // combo. The one thing an operator can run at a venue before the bracket starts.
  app.post("/api/clipper/test", async (req, res) => {
    const result = await obs.saveReplayBuffer();
    const clip = recordClip(null, { name: "Test clip", teamNum: null }, result);
    res.json({ ok: result.ok, error: result.error ?? null, clip });
  });
}

module.exports = { registerRoutes };
