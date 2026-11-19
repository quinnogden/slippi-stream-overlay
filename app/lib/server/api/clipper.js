/**
 * The combo clipper's settings, master switch and test button, and OBS's
 * (the connection and health settings live with the clipper's: one socket).
 */

/**
 * @param {import("express").Express} app
 * @param {object} deps — { clipperSettings, obs, refreshControlStatus, clipperSnapshot, recordClip }
 */
function register(app, { clipperSettings, obs, refreshControlStatus, clipperSnapshot, recordClip }) {
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

  // An overlay in OBS that failed to load never retries: press its Refresh.
  app.post("/api/obs/refresh-source", async (req, res) => {
    const inputName = req.body?.inputName;
    if (typeof inputName !== "string" || !inputName) {
      return res.status(400).json({ ok: false, error: "inputName required" });
    }
    const result = await obs.refreshBrowserSource(inputName);
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

module.exports = { register };
