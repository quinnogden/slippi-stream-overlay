/**
 * start-all.js — one-shot tournament launcher.
 *
 * Launches TSH, waits until its HTTP API actually responds, then starts the
 * bridge (index.js) as a child process. Does NOT launch OBS, and does NOT kill
 * TSH when the bridge exits (you may still be using TSH).
 *
 * Use start-bridge.bat instead if TSH is already running.
 */

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const { spawn } = require("child_process");
const config = require("./config");
const { resolveTshRoot } = require("./tsh-root");

// Auto-detected unless config.TSH_ROOT pins it — see tsh-root.js.
let TSH_ROOT;
try {
  TSH_ROOT = resolveTshRoot(path.resolve(__dirname, ".."), config.TSH_ROOT);
  console.log(`[launcher] TSH root: ${TSH_ROOT}`);
} catch (e) {
  console.error(`[launcher] ERROR: ${e.message}`);
  process.exit(1);
}

const TSH_EXE  = path.join(TSH_ROOT, "TSH.exe");
const TSH_BAT  = path.join(TSH_ROOT, "TSH_bat.bat");

const READY_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch TSH in its own window. Returns true if a launcher was found. */
function launchTsh() {
  if (fs.existsSync(TSH_EXE)) {
    console.log(`[launcher] Starting TSH: ${TSH_EXE}`);
    const child = spawn(TSH_EXE, [], { cwd: TSH_ROOT, detached: true, stdio: "ignore" });
    child.unref();
    return true;
  }
  if (fs.existsSync(TSH_BAT)) {
    console.log(`[launcher] TSH.exe not found; starting source build: ${TSH_BAT}`);
    const child = spawn("cmd.exe", ["/c", "start", "", TSH_BAT], { cwd: TSH_ROOT, detached: true, stdio: "ignore" });
    child.unref();
    return true;
  }
  console.error(`[launcher] Could not find TSH.exe or TSH_bat.bat in ${TSH_ROOT}`);
  return false;
}

/** Resolve true once TSH's web server answers (any HTTP response counts). */
async function waitForTsh() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await axios.get(`${config.TSH_URL}/`, { timeout: 2000 });
      return true;
    } catch (err) {
      if (err.response) return true; // even a 404 means the server is up
    }
    process.stdout.write(".");
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** Start the bridge in this console (inherits stdio for logs + keypress swap). */
function startBridge() {
  console.log("\n[launcher] TSH is up — starting the bridge.\n");
  const bridge = spawn(process.execPath, ["index.js"], { cwd: __dirname, stdio: "inherit" });
  bridge.on("exit", (code) => process.exit(code ?? 0));
}

(async () => {
  const alreadyUp = await (async () => {
    try { await axios.get(`${config.TSH_URL}/`, { timeout: 1500 }); return true; }
    catch (err) { return Boolean(err.response); }
  })();

  if (alreadyUp) {
    console.log("[launcher] TSH already running.");
  } else if (!launchTsh()) {
    console.error("[launcher] Start TSH manually, then run start-bridge.bat.");
    process.exit(1);
  } else {
    process.stdout.write("[launcher] Waiting for TSH to come up");
    const ready = await waitForTsh();
    if (!ready) {
      console.error(`\n[launcher] TSH did not respond on ${config.TSH_URL} within ${READY_TIMEOUT_MS / 1000}s.`);
      console.error("[launcher] Start TSH manually and wait for it to finish loading, then run start-bridge.bat.");
      process.exit(1);
    }
  }

  startBridge();
})();
