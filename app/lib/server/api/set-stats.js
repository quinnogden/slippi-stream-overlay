/**
 * The stats popup (lib/set-stats/): its settings — layout, picture style,
 * automatic show and its timing, which reading — and Show / Hide.
 *
 * Like every route here, the answer that matters is the state patch that
 * follows (`statsConfig`, `statsShot`, `setStats`).
 */

const { LAYOUTS, STYLES, MODES, configError } = require("../../set-stats/catalog");

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, setStats }
 */
function register(app, { store, setStats }) {
  // What the dock lists: the layouts and styles, and the popup's state now.
  app.get("/api/set-stats", (req, res) => {
    res.json({ ok: true, layouts: LAYOUTS, styles: STYLES, modes: MODES,
      config: store.statsConfig(), shot: store.statsShot(), portraits: !!setStats?.portraits?.dir });
  });

  // { layout?, style?, auto?, delaySec?, holdSec?, mode? } — any subset.
  app.post("/api/set-stats/config", (req, res) => {
    const err = configError(req.body);
    if (err) return res.status(400).json({ ok: false, error: err });
    const pick = {};
    for (const k of ["layout", "style", "auto", "delaySec", "holdSec", "mode"]) if (req.body[k] !== undefined) pick[k] = req.body[k];
    res.json({ ok: true, config: store.setStatsConfig(pick) });
  });

  // { action: "show" | "hide" | "toggle" }
  app.post("/api/set-stats/show", (req, res) => {
    if (!setStats) return res.status(503).json({ ok: false, error: "Set stats aren't running" });
    const r = setStats.command(req.body ?? {});
    if (!r.ok) return res.status(r.status ?? 400).json({ ok: false, error: r.error });
    res.json({ ok: true, shot: store.statsShot() });
  });

  // Read every game's replay again.
  app.post("/api/set-stats/refresh", (req, res) => {
    if (!setStats) return res.status(503).json({ ok: false, error: "Set stats aren't running" });
    res.json(setStats.refresh());
  });
}

module.exports = { register };
