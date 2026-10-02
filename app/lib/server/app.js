/**
 * Express + Socket.io server, and the port-reclaim dance around binding it.
 */

const http    = require("http");
const express = require("express");
const { Server } = require("socket.io");

const { reclaimPort } = require("../port-guard");

/**
 * @param {{ BRIDGE_PORT: number }} config
 * @returns {{ app, io, httpServer, start: () => void }}
 */
function createServer(config) {
  const app = express();

  // No CORS: the dock and every overlay are served from this origin. (The old
  // control panel needed it when an OBS dock opened its .html as a file://.)
  app.use(express.json());

  const httpServer = http.createServer(app);
  const io         = new Server(httpServer);

  // A stale bridge holding the port is the normal case, not an operator error, so
  // try once to take it back before giving up. reclaimPort only kills a process
  // that identifies itself as a bridge — see port-guard.js.
  let portReclaimTried = false;

  httpServer.on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;

    if (portReclaimTried) {
      console.error(`[bridge] ERROR: Port ${config.BRIDGE_PORT} is still in use after reclaiming it.`);
      process.exit(1);
    }
    portReclaimTried = true;

    reclaimPort(config.BRIDGE_PORT, (msg) => console.log(`[bridge] ${msg}`))
      .then((result) => {
        if (result.ok) return start();
        console.error(`[bridge] ERROR: Port ${config.BRIDGE_PORT} is already in use — ${result.reason}.`);
        console.error(`         Find it with:  netstat -ano | findstr :${config.BRIDGE_PORT}`);
        console.error(`         then:          taskkill /PID <pid> /F`);
        console.error(`         Or set a different BRIDGE_PORT in config.local.js.`);
        process.exit(1);
      })
      .catch((e) => {
        console.error(`[bridge] ERROR: could not reclaim port ${config.BRIDGE_PORT}: ${e.message}`);
        process.exit(1);
      });
  });

  // Registered here rather than as a listen() callback: a listen() that fails with
  // EADDRINUSE leaves its one-shot callback attached, so the retry would fire both
  // and log twice.
  httpServer.once("listening", () => {
    console.log(`[bridge] Socket.io server listening on port ${config.BRIDGE_PORT}`);
  });

  function start() {
    httpServer.listen(config.BRIDGE_PORT);
  }

  return { app, io, httpServer, start };
}

module.exports = { createServer };
