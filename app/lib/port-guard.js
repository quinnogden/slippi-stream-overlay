/**
 * Frees BRIDGE_PORT when an earlier copy of the app still holds it — a start.bat
 * window left open, a crash that left node running — so the operator never has
 * to netstat/taskkill between sets.
 *
 * It only kills a process that identifies itself as the app over HTTP (the id
 * string is kept from the bridge era). Anything else holding the port is
 * reported and left alone: killing an unrelated program would be far worse than
 * refusing to start.
 */

const http = require("http");
const net  = require("net");
const { execFile } = require("child_process");

const APP_ID              = "slippi-bridge";
const IDENTITY_TIMEOUT_MS = 1000;
const FREE_TIMEOUT_MS     = 5000;
const FREE_POLL_MS        = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a JSON document from the local port, resolving null on any failure.
 * @param {number} port
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<object|null>} parsed body, or null if it wasn't reachable JSON
 */
function getLocalJson(port, path, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/**
 * Ask whoever owns the port whether it's the app: `/api/identity` answers with
 * the app's id and its own pid.
 *
 * @param {number} port
 * @returns {Promise<{ isApp: boolean, pid: number|null }>}
 */
async function identifyOccupant(port) {
  const identity = await getLocalJson(port, "/api/identity", IDENTITY_TIMEOUT_MS);
  if (identity?.app !== APP_ID) return { isApp: false, pid: null };
  return { isApp: true, pid: Number.isInteger(identity.pid) ? identity.pid : null };
}

/**
 * Terminate a process, resolving true only if the kill command itself worked.
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
function killPid(pid) {
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGTERM"); return Promise.resolve(true); }
    catch { return Promise.resolve(false); }
  }
  return new Promise((resolve) => {
    // /T so the whole process tree goes, whatever launched it.
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true },
      (err) => resolve(!err));
  });
}

/**
 * Poll until the port can actually be bound. Windows releases a killed
 * process's socket asynchronously, so the retry has to be driven by a real
 * bind rather than a fixed sleep.
 * @param {number} port
 * @returns {Promise<boolean>} false if it never freed up within FREE_TIMEOUT_MS
 */
async function waitForPortFree(port) {
  const deadline = Date.now() + FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "0.0.0.0");
    });
    if (free) return true;
    await sleep(FREE_POLL_MS);
  }
  return false;
}

/**
 * Try to make the port bindable again.
 *
 * @param {number} port
 * @param {(msg: string) => void} log
 * @returns {Promise<{ ok: boolean, reason?: string }>} ok means "bind again now"
 */
async function reclaimPort(port, log = () => {}) {
  const { isApp, pid } = await identifyOccupant(port);
  if (!isApp) {
    return { ok: false, reason: `something other than ${APP_ID} is listening on ${port}` };
  }
  if (pid == null) {
    return { ok: false, reason: `an old ${APP_ID} holds ${port} but didn't report its process id` };
  }
  if (pid === process.pid) {
    return { ok: false, reason: `port ${port} is held by this process` };
  }

  log(`Port ${port} is held by an old ${APP_ID} (pid ${pid}) — stopping it.`);
  if (!await killPid(pid)) {
    return { ok: false, reason: `could not stop pid ${pid} (try running as the user that started it)` };
  }
  if (!await waitForPortFree(port)) {
    return { ok: false, reason: `pid ${pid} was stopped but port ${port} is still busy` };
  }

  log(`Port ${port} reclaimed.`);
  return { ok: true };
}

module.exports = { reclaimPort, APP_ID };
