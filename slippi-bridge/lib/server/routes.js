/**
 * The operator's HTTP surface: the dock page and every /api/* route.
 *
 * The routes are grouped by what they act on, one file each under api/. The
 * dock is the only browser client of /api/*; everything start.gg is called
 * server-side.
 */

const path    = require("path");
const express = require("express");

const API = ["status", "scoreboard", "event", "casters", "clipper"].map((name) => require(`./api/${name}`));

/**
 * @param {import("express").Express} app
 * @param {object} deps — {
 *   publicDir, iconsDir, store, event, clipperSettings, obs,
 *   refreshControlStatus, clipperSnapshot, reportCurrentSet, startCurrentSet,
 *   swapPorts, switchSides, reresolvePorts, recordClip, playerStatsSnapshot
 * }
 */
function registerRoutes(app, deps) {
  const dockDir = path.join(deps.publicDir, "dock");

  // The dock. `/` and the old control panel's `/control` lead here, so an OBS
  // dock or a phone bookmark from before the dock still lands somewhere.
  app.get(["/", "/control"], (req, res) => res.redirect("/dock"));
  app.get(["/dock", "/dock/"], (req, res) => res.sendFile(path.join(dockDir, "index.html")));
  app.use("/dock", express.static(dockDir, { index: false, redirect: false }));

  for (const api of API) api.register(app, deps);
}

module.exports = { registerRoutes };
