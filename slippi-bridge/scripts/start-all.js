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
const { spawn } = require("child_process");
const config = require("../config");
const TshClient = require("../lib/tsh-client");
const { resolveOrExit } = require("../lib/tsh-root");

// This script lives in slippi-bridge/scripts/, so the bridge folder is one level
// up and the repo root (where the TournamentStreamHelper-* folder sits) is two.
const BRIDGE_DIR = path.resolve(__dirname, "..");
const REPO_ROOT  = path.resolve(__dirname, "..", "..");

// Auto-detected unless config.TSH_ROOT pins it — see tsh-root.js.
const TSH_ROOT = resolveOrExit(REPO_ROOT, config.TSH_ROOT, "launcher");

const TSH_EXE  = path.join(TSH_ROOT, "TSH.exe");
const TSH_BAT  = path.join(TSH_ROOT, "TSH_bat.bat");

const tsh = new TshClient(config, TSH_ROOT);

// TSH 5.972 moved its default web server port from 5000 to 5500. A settings.json
// without general.webserver_port lands there, and from here that looks exactly
// like TSH never starting — so on a timeout, check whether that's what happened.
const TSH_DEFAULT_PORT = "5500";

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

/**
 * Resolve true once TSH's web server answers.
 * @param {{ once?: boolean }} [opts] — once: probe a single time, print nothing
 */
async function waitForTsh({ once = false } = {}) {
  if (once) return tsh.ping(1500);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tsh.ping(2000)) return true;
    process.stdout.write(".");
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Is TSH answering on its own default port instead of the configured one?
 * @returns {Promise<string|null>} — the URL it answered on, or null
 */
async function tshOnDefaultPort() {
  const alt = new URL(config.TSH_URL);
  if (alt.port === TSH_DEFAULT_PORT) return null;
  alt.port = TSH_DEFAULT_PORT;
  const url = alt.origin;
  const probe = new TshClient({ ...config, TSH_URL: url }, TSH_ROOT);
  return (await probe.ping(1500)) ? url : null;
}

/** Start the bridge in this console (inherits stdio for logs + keypress swap). */
function startBridge() {
  console.log("\n[launcher] TSH is up — starting the bridge.\n");
  const bridge = spawn(process.execPath, ["index.js"], { cwd: BRIDGE_DIR, stdio: "inherit" });
  bridge.on("exit", (code) => process.exit(code ?? 0));
}

(async () => {
  if (await waitForTsh({ once: true })) {
    console.log("[launcher] TSH already running.");
  } else if (!launchTsh()) {
    console.error("[launcher] Start TSH manually, then run start-bridge.bat.");
    process.exit(1);
  } else {
    process.stdout.write("[launcher] Waiting for TSH to come up");
    const ready = await waitForTsh();
    if (!ready) {
      console.error(`\n[launcher] TSH did not respond on ${config.TSH_URL} within ${READY_TIMEOUT_MS / 1000}s.`);
      const wrongPort = await tshOnDefaultPort();
      if (wrongPort) {
        console.error(`[launcher] TSH IS running — on ${wrongPort}, its own default. Set general.webserver_port`);
        console.error(`[launcher] to ${new URL(config.TSH_URL).port} (TSH → Settings → General), restart TSH, then run this again.`);
      } else {
        console.error("[launcher] Start TSH manually and wait for it to finish loading, then run start-bridge.bat.");
      }
      process.exit(1);
    }
  }

  startBridge();
})();
