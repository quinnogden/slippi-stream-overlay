/**
 * TshClient — all I/O with Tournament Stream Helper.
 *
 * Wraps file reads and HTTP calls so callers get typed results instead of
 * silent nulls or swallowed errors.
 */

const fs   = require("fs");
const path = require("path");
const axios = require("axios");

class TshClient {
  /**
   * @param {{ TSH_URL: string, SCOREBOARD_NUM: number }} config
   * @param {string} tshRoot  — absolute path to TSH install directory
   */
  constructor(config, tshRoot) {
    this._config  = config;
    this._tshRoot = tshRoot;
    this._statePath = path.join(tshRoot, "out/program_state.json");
  }

  // ── State file ──────────────────────────────────────────────────────────────

  /**
   * Reads and parses program_state.json.
   * Throws an Error with a specific message if anything goes wrong.
   * Callers should wrap in try/catch and log the message.
   *
   * @returns {object} Parsed TSH state
   */
  readState() {
    let raw;
    try {
      raw = fs.readFileSync(this._statePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`[bridge] TSH state file not found: ${this._statePath}`);
      }
      if (err.code === "EACCES") {
        throw new Error(`[bridge] Permission denied reading TSH state: ${this._statePath}`);
      }
      throw new Error(`[bridge] Failed to read TSH state (${err.code ?? err.message})`);
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`[bridge] TSH state file contains invalid JSON: ${this._statePath}`);
    }
  }

  // ── Pure accessors (operate on a state returned by readState()) ─────────────

  /**
   * Extract team name and score for a given team number.
   * @param {object} state   — from readState()
   * @param {number} teamNum — 1 or 2
   * @returns {{ name: string, score: number }}
   */
  getTeamInfo(state, teamNum) {
    const team = state?.score?.[String(this._config.SCOREBOARD_NUM)]?.team?.[String(teamNum)];
    return {
      name:  (team?.player?.["1"]?.name ?? "").trim(),
      score: team?.score ?? 0,
    };
  }

  /**
   * Extract preloaded character history for both teams.
   * @param {object} state — from readState()
   * @returns {{ t1: { name: string, skin: number }, t2: { name: string, skin: number } }}
   */
  getPreloadedChars(state) {
    const getEntry = (teamNum) => {
      const team  = state?.score?.[String(this._config.SCOREBOARD_NUM)]?.team?.[String(teamNum)];
      const entry = team?.player?.["1"]?.character?.["1"];
      return {
        name: (entry?.name ?? "").trim(),
        skin: entry?.skin ?? -1,
      };
    };
    return { t1: getEntry(1), t2: getEntry(2) };
  }

  // ── HTTP calls ──────────────────────────────────────────────────────────────

  /**
   * Increment the score for a team via TSH HTTP API.
   * @param {number} teamNumber — 1 or 2
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async incrementScore(teamNumber) {
    const url = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-team${teamNumber}-scoreup`;
    try {
      await axios.get(url);
      console.log(`[bridge] Score incremented for team ${teamNumber}`);
      return { ok: true };
    } catch (err) {
      const msg = `Failed to increment score for team ${teamNumber}: ${err.message}`;
      console.error(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Set character + costume for a team via TSH HTTP API.
   * @param {number} teamNumber
   * @param {string} charDisplayName
   * @param {number} costumeIndex
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async setCharacter(teamNumber, charDisplayName, costumeIndex) {
    const url  = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-update-team-${teamNumber}-1`;
    const body = { mains: { ssbm: [[charDisplayName, costumeIndex]] } };
    try {
      await axios.post(url, body);
      console.log(`[bridge] TSH team ${teamNumber}: ${charDisplayName} costume ${costumeIndex}`);
      return { ok: true };
    } catch (err) {
      const msg = `Failed to set character for team ${teamNumber}: ${err.message}`;
      console.error(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }
}

module.exports = TshClient;
