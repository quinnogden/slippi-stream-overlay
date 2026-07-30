/**
 * Global Ctrl+Shift+S — swap teams regardless of which window is focused.
 *
 * uiohook-napi is a native module, so it is required lazily: on a machine where
 * it failed to build, the bridge must still start and fall back to a terminal
 * keypress rather than refusing to run at a venue.
 */

/**
 * @param {() => void} onSwap — invoked on the hotkey
 * @returns {"global"|"terminal"|"none"} which listener actually installed
 */
function installHotkey(onSwap) {
  try {
    const { UiohookKey, uIOhook } = require("uiohook-napi");
    uIOhook.on("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && e.keycode === UiohookKey.S) {
        onSwap();
      }
    });
    uIOhook.start();
    return "global";
  } catch {
    // uiohook-napi unavailable — fall back to terminal keypresses
    if (!process.stdin.isTTY) return "none";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      if (key === "\u0003") process.exit(); // Ctrl+C — raw mode swallows the default handler
      if (key === "s" || key === "S") onSwap();
    });
    return "terminal";
  }
}

module.exports = { installHotkey };
