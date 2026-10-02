/**
 * Live-state persistence: the scoreboard survives a restart. Without it a
 * restart mid-set would blank the names, the score and the per-game list a
 * report is built from.
 *
 * Every store `change` schedules a debounced, atomic write (temp file +
 * rename, so a kill mid-write leaves the previous save rather than half a
 * file). On boot, restore() loads it; a missing, unreadable or different-
 * version save leaves the store empty — a stale shape is worse than a blank
 * scoreboard the operator can reload in one tap.
 */

const fs   = require("fs");
const path = require("path");
const { PERSISTED } = require("./store");

const SAVE_DEBOUNCE_MS = 300;

/**
 * @param {import("./store").ScoreboardStore} store
 * @param {string} file — e.g. <app>/data/live-state.json (gitignored)
 * @param {{ debounceMs?: number }} [opts]
 */
function createPersist(store, file, opts = {}) {
  const debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
  let timer = null;

  function saveNow() {
    clearTimeout(timer);
    timer = null;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(store.toJSON(), null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      console.warn(`[persist] Couldn't save ${file}: ${err.message}`);
      return false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(saveNow, debounceMs);
    timer.unref?.();
  }

  /** @returns {boolean} whether a saved state was restored */
  function restore() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[persist] Ignoring unreadable ${file}: ${err.message}`);
      return false;
    }
    const ok = store.restore(saved);
    if (!ok) console.warn(`[persist] Ignoring ${file}: saved by a different version`);
    return ok;
  }

  /** Start saving on change. Call after restore(), so the restore isn't re-saved for nothing. */
  function start() {
    // A bracket refresh isn't saved (it is re-read on boot), so it doesn't write.
    store.on("change", ({ keys }) => {
      if (keys.some((k) => PERSISTED.includes(k))) schedule();
    });
  }

  return { restore, start, saveNow, get pending() { return timer !== null; } };
}

module.exports = { createPersist };
