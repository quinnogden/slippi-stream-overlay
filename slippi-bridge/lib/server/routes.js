/**
 * The control panel's HTTP surface.
 *
 * Served to an OBS custom browser dock. Browser→bridge calls are same-origin
 * (bridge port); the bridge makes the TSH/start.gg calls server-side, so there
 * is no browser-CORS surface against TSH.
 */

const path = require("path");

/**
 * @param {import("express").Express} app
 * @param {object} deps — {
 *   publicDir, tsh, clipperSettings, obs,
 *   refreshControlStatus, clipperSnapshot, reportCurrentSet, startCurrentSet, switchBracket,
 *   swapTeams, reresolvePorts, recordClip, playerStatsSnapshot
 * }
 */
function registerRoutes(app, deps) {
  const {
    publicDir, tsh, clipperSettings, obs,
    refreshControlStatus, clipperSnapshot, reportCurrentSet, startCurrentSet, switchBracket, swapTeams,
    reresolvePorts, recordClip, playerStatsSnapshot,
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

  app.post("/api/swap", (req, res) => {
    swapTeams();
    refreshControlStatus();
    res.json({ ok: true });
  });

  // Throw away the port→team mapping and re-derive it from TSH's current names
  // and characters — for when the set changed before the TO updated the names.
  app.post("/api/reresolve", (req, res) => {
    const result = reresolvePorts();
    refreshControlStatus();
    res.json(result);
  });

  // Moves the teams to the other side of the scoreboard. The follow-up refresh
  // picks up TSH's flipped teamsSwapped flag and re-detects the port mapping
  // (control-status.js#handleTshSwap).
  //
  // TSH's /swap-teams only emits a Qt signal and answers "OK" — the flag flip and
  // the program_state.json rewrite happen afterwards on its GUI thread. So the
  // immediate refresh is for the panel's health/set card, and the delayed one is
  // what actually catches the swap. Without it the operator waits out the 2s tick
  // for the sides to follow.
  app.post("/api/swap-sides", async (req, res) => {
    const result = await tsh.swapSides();
    refreshControlStatus();
    if (result.ok) setTimeout(refreshControlStatus, 400);
    res.json(result);
  });

  app.post("/api/pull-stream", async (req, res) => {
    res.json(await tsh.pullStreamSet());
  });

  app.get("/api/sets", async (req, res) => {
    res.json(await tsh.getOpenSets(req.query.finished === "1"));
  });

  app.post("/api/load-set", async (req, res) => {
    const setId = req.body?.setId;
    if (setId == null) return res.status(400).json({ ok: false, error: "setId required" });
    const result = await tsh.loadSet(setId);
    // Push the new names/scores out now rather than on the next 2s tick, so the
    // panel's Current Set card matches what the operator just loaded.
    if (result.ok) refreshControlStatus();
    res.json(result);
  });

  // Two start.gg hops on the way; bracket-switch.js owns the re-entrancy guard
  // and the follow-up refresh, because only it knows whether anything changed.
  app.post("/api/bracket", async (req, res) => {
    const kind = req.body?.kind;
    if (typeof kind !== "string" || !kind) {
      return res.status(400).json({ ok: false, error: 'kind ("singles" | "doubles") required' });
    }
    res.json(await switchBracket(kind));
  });

  // start.gg's "Start match" for the loaded set. No body: the set is whatever
  // TSH has loaded, which is what the panel is showing.
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
