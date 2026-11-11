/**
 * The stats worker: reads one .slp at a time off the app's main thread
 * (a parse is ~0.5s, which would stall the socket, the hotkeys and the live
 * game's poll). index.js keeps one running and queues files to it.
 *
 * In:  { id, file }        Out: { id, result }  (game-stats.js's shape)
 */

const { parentPort } = require("worker_threads");
const { readGameStats } = require("./game-stats");

parentPort.on("message", ({ id, file }) => {
  let result;
  try {
    result = readGameStats(file);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  parentPort.postMessage({ id, result });
});
