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
 *   publicDir, tsh, clipperSettings, obs, state,
 *   refreshControlStatus, reportCurrentSet, switchBracket, swapTeams, recordClip
 * }
 */
function registerRoutes(app, deps) {
  const {
    publicDir, tsh, clipperSettings, obs, state,
    refreshControlStatus, reportCurrentSet, switchBracket, swapTeams, recordClip,
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
    refreshControlStatus().catch(() => {});
    res.json({ ok: true });
  });

  // Moves the teams to the other side of the scoreboard. The follow-up refresh
  // picks up TSH's flipped teamsSwapped flag and re-derives the port mapping.
  app.post("/api/swap-sides", async (req, res) => {
    const result = await tsh.swapSides();
    refreshControlStatus().catch(() => {});
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
    if (result.ok) refreshControlStatus().catch(() => {});
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

  app.post("/api/report", async (req, res) => {
    res.json(await reportCurrentSet());
  });

  // ── Combo clipper ───────────────────────────────────────────────────────────
  app.get("/api/clipper", (req, res) => {
    res.json({
      ok: true,
      settings: clipperSettings.get(),
      obs: obs.getStatus(),
      recentClips: state.recentClips,
      clipsThisGame: state.clipsThisGame,
    });
  });

  app.post("/api/clipper/settings", (req, res) => {
    const result = clipperSettings.save(req.body ?? {});
    // Apply either way: save() returns ok:false when only the disk write failed,
    // and the operator's change should still take effect for this session.
    obs.applySettings();
    refreshControlStatus().catch(() => {});
    res.json(result);
  });

  app.post("/api/clipper/toggle", (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled (boolean) required" });
    }
    const result = clipperSettings.save({ enabled });
    obs.applySettings();
    refreshControlStatus().catch(() => {});
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
