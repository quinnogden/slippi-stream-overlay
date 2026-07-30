// Locates the TSH install directory.
//
// TSH ships as a versioned folder (TournamentStreamHelper-5.972), so hardcoding
// the path means every TSH update silently breaks the bridge: program_state.json
// reads, character icon resolution, and the start-all launcher all point at a
// folder that no longer exists. Auto-detecting the newest sibling folder keeps
// updates to "extract the zip, copy layout/ back" with no code edits.

const fs   = require("fs");
const path = require("path");

const TSH_DIR_PATTERN = /^TournamentStreamHelper(?:-(.+))?$/;

/**
 * Parses a trailing version ("5.972" → [5, 972]) for descending sort.
 * Unversioned or unparseable folders sort last so an explicit version wins.
 * @param {string} name — directory basename
 * @returns {number[]}
 */
function versionKey(name) {
  const raw = TSH_DIR_PATTERN.exec(name)?.[1];
  if (!raw) return [];
  return raw.split(".").map((part) => {
    const n = parseInt(part, 10);
    return Number.isNaN(n) ? -1 : n;
  });
}

/** Descending comparison of two version key arrays. */
function compareVersionsDesc(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * True if the directory actually looks like a TSH install rather than a stray
 * folder that happens to match the name pattern. layout/ is what the bridge and
 * the OBS browser sources depend on; the launcher is a secondary signal.
 * @param {string} dir
 */
function looksLikeTshRoot(dir) {
  if (!fs.existsSync(path.join(dir, "layout"))) return false;
  return ["TSH.exe", "TSH_bat.bat", "main.py"].some((f) =>
    fs.existsSync(path.join(dir, f))
  );
}

/**
 * Resolves the TSH install root.
 *
 * @param {string} baseDir   — directory to search (the repo root; TSH sits beside slippi-bridge/)
 * @param {string|null} override — config.TSH_ROOT, if the operator pinned one
 * @returns {string} absolute path to the TSH root
 * @throws {Error} with actionable text when nothing usable is found
 */
function resolveTshRoot(baseDir, override) {
  if (override) {
    const pinned = path.resolve(override);
    if (!looksLikeTshRoot(pinned)) {
      throw new Error(
        `TSH_ROOT is set to "${override}" but that folder does not look like a TSH install ` +
        `(expected a layout/ subfolder plus TSH.exe, TSH_bat.bat, or main.py). ` +
        `Fix TSH_ROOT in config.js / config.local.js, or set it to null to auto-detect.`
      );
    }
    return pinned;
  }

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Could not read "${baseDir}" while looking for the TSH install: ${e.message}`);
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && TSH_DIR_PATTERN.test(e.name))
    .map((e) => path.join(baseDir, e.name))
    .filter(looksLikeTshRoot)
    .sort((a, b) => compareVersionsDesc(versionKey(path.basename(a)), versionKey(path.basename(b))));

  if (candidates.length === 0) {
    throw new Error(
      `Could not find a TSH install in "${baseDir}". ` +
      `Expected a folder named TournamentStreamHelper-<version> containing layout/. ` +
      `Set TSH_ROOT in config.local.js to point at it explicitly.`
    );
  }

  return candidates[0];
}

/**
 * resolveTshRoot, but for a process that cannot continue without it.
 *
 * Both entry points (index.js, scripts/start-all.js) want the same thing: log
 * the resolved root, or print the error and exit 1. Nothing useful happens after
 * a failure, so the try/catch was copy-pasted rather than meaningful.
 *
 * @param {string} baseDir
 * @param {string|null} override
 * @param {string} tag — log prefix, e.g. "bridge" or "launcher"
 * @returns {string} absolute path to the TSH root
 */
function resolveOrExit(baseDir, override, tag) {
  try {
    const root = resolveTshRoot(baseDir, override);
    console.log(`[${tag}] TSH root: ${root}`);
    return root;
  } catch (e) {
    console.error(`[${tag}] ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { resolveTshRoot, resolveOrExit, looksLikeTshRoot };
