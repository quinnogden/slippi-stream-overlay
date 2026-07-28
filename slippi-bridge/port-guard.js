/**
 * port-guard.js
 *
 * Frees BRIDGE_PORT when a previous slippi-bridge is still holding it.
 *
 * The bridge gets restarted a lot mid-event — a closed console that left the
 * process alive, a crashed start-all, an editor still running the old copy —
 * and the survivor keeps the port. Making the operator run netstat/taskkill
 * between sets is the wrong answer, so the new process reclaims it itself.
 *
 * It only ever kills a process that identifies itself as a slippi-bridge over
 * HTTP. Anything else holding the port is reported and left alone: killing an
 * unrelated program because it happened to pick 5001 would be far worse than
 * refusing to start.
 */

const http = require("http");
const net  = require("net");
const { execFile } = require("child_process");

const APP_ID              = "slippi-bridge";
const IDENTITY_TIMEOUT_MS = 1000;
const STATUS_TIMEOUT_MS   = 3000;   // /api/status hits TSH, so it's slower
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
 * Ask whoever owns the port whether they're a slippi-bridge.
 *
 * `/api/identity` reports its own pid, which is the reliable path. A bridge
 * from before that route existed still answers `/api/status` with a shape
 * nothing else on the machine serves — enough to identify it, but its pid then
 * has to come from the OS.
 *
 * @param {number} port
 * @returns {Promise<{ isBridge: boolean, pid: number|null }>}
 */
async function identifyOccupant(port) {
  const identity = await getLocalJson(port, "/api/identity", IDENTITY_TIMEOUT_MS);
  if (identity && identity.app === APP_ID) {
    return { isBridge: true, pid: Number.isInteger(identity.pid) ? identity.pid : null };
  }

  const status = await getLocalJson(port, "/api/status", STATUS_TIMEOUT_MS);
  if (status && typeof status === "object" && "portMapping" in status && "tsh" in status) {
    return { isBridge: true, pid: null };
  }

  return { isBridge: false, pid: null };
}

/**
 * Ask the OS which process is listening on the port.
 * Only used when the occupant is a confirmed bridge that didn't report its pid.
 * @param {number} port
 * @returns {Promise<number|null>}
 */
function findListenerPid(port) {
  const [cmd, args] = process.platform === "win32"
    ? ["netstat", ["-ano", "-p", "tcp"]]
    : ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]];

  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null);

      if (process.platform !== "win32") {
        const pid = parseInt(String(stdout).trim().split(/\s+/)[0], 10);
        return resolve(Number.isInteger(pid) ? pid : null);
      }

      for (const line of String(stdout).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5 || cols[3] !== "LISTENING") continue;
        // Matches both 0.0.0.0:5001 and [::]:5001.
        if (!cols[1].endsWith(`:${port}`)) continue;
        const pid = parseInt(cols[4], 10);
        if (Number.isInteger(pid)) return resolve(pid);
      }
      resolve(null);
    });
  });
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
    // /T so a bridge started via start-all takes its children with it.
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
  const { isBridge, pid: reportedPid } = await identifyOccupant(port);
  if (!isBridge) {
    return { ok: false, reason: `something other than ${APP_ID} is listening on ${port}` };
  }

  const pid = reportedPid ?? await findListenerPid(port);
  if (pid == null) {
    return { ok: false, reason: `an old ${APP_ID} holds ${port} but its process id could not be found` };
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
