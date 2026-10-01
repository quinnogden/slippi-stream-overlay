/**
 * Read-only views of the app: who it is, the dock's status, the overlays'
 * state, the side panel's stats.
 */

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, refreshControlStatus, playerStatsSnapshot }
 */
function register(app, { store, refreshControlStatus, playerStatsSnapshot }) {
  // Lets an app that finds this port busy confirm the occupant is one of its
  // own — and which process to stop — instead of asking the operator for netstat.
  app.get("/api/identity", (req, res) => {
    res.json({ app: "slippi-bridge", pid: process.pid });
  });

  app.get("/api/status", async (req, res) => {
    res.json(await refreshControlStatus());
  });

  // Everything the overlays are drawing — the same object `state:full` sends.
  app.get("/api/state", (req, res) => {
    res.json(store.snapshot());
  });

  // The side panel's stats snapshot — the same object `player_stats` pushes.
  // For checking what the overlay is being fed, from a browser.
  app.get("/api/player-stats", (req, res) => {
    res.json(playerStatsSnapshot());
  });
}

module.exports = { register };
