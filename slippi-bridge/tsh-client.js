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
   * In doubles, name is "Player1 / Player2" (concatenated from both players).
   * @param {object} state   — from readState()
   * @param {number} teamNum — 1 or 2
   * @returns {{ name: string, score: number }}
   */
  getTeamInfo(state, teamNum) {
    const team = state?.score?.[String(this._config.SCOREBOARD_NUM)]?.team?.[String(teamNum)];
    const names = Object.values(team?.player ?? {})
      .map((p) => (p?.name ?? "").trim())
      .filter(Boolean);
    return {
      name:  names.join(" / "),
      score: team?.score ?? 0,
    };
  }

  /**
   * Returns all player names for a team as an array. Used for doubles name matching.
   * @param {object} state
   * @param {number} teamNum — 1 or 2
   * @returns {string[]}
   */
  getTeamPlayerNames(state, teamNum) {
    const team = state?.score?.[String(this._config.SCOREBOARD_NUM)]?.team?.[String(teamNum)];
    return Object.values(team?.player ?? {})
      .map((p) => (p?.name ?? "").trim())
      .filter(Boolean);
  }

  /**
   * Returns true if the TSH scoreboard is configured for doubles
   * (team 1 has more than one player slot).
   * @param {object} state
   * @returns {boolean}
   */
  isDoubles(state) {
    const team = state?.score?.[String(this._config.SCOREBOARD_NUM)]?.team?.["1"];
    return Object.keys(team?.player ?? {}).length > 1;
  }

  /**
   * Returns true if the TSH scoreboard is configured for a crew battle
   * (team 1 has 4 or more player slots).
   * @param {object} state
   * @returns {boolean}
   */
  isCrewBattle(state) {
    const team = state?.score?.[String(this._config.SCOREBOARD_NUM)]?.team?.["1"];
    return Object.keys(team?.player ?? {}).length >= 4;
  }

  /**
   * Returns the name of the active player in TSH slot 1 for a team.
   * The TO manually updates slot 1 before each crew battle game.
   * @param {object} state
   * @param {number} teamNum — 1 or 2
   * @returns {string}
   */
  getActivePlayerName(state, teamNum) {
    const player = state?.score?.[String(this._config.SCOREBOARD_NUM)]
      ?.team?.[String(teamNum)]?.player?.["1"];
    return (player?.name ?? "").trim();
  }

  /**
   * Extract preloaded character history for both teams.
   * Returns up to 2 preloaded chars per team (index 0 = player 1, 1 = player 2).
   * @param {object} state — from readState()
   * @returns {{ t1: Array<{name:string, skin:number}>, t2: Array<{name:string, skin:number}> }}
   */
  getPreloadedChars(state) {
    const getEntries = (teamNum) => {
      const team = state?.score?.[String(this._config.SCOREBOARD_NUM)]?.team?.[String(teamNum)];
      return Object.values(team?.player ?? {}).map((player) => {
        const entry = player?.character?.["1"];
        return {
          name: (entry?.name ?? "").trim(),
          skin: entry?.skin ?? -1,
        };
      });
    };
    return { t1: getEntries(1), t2: getEntries(2) };
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
   * Set both team scores directly via TSH HTTP API.
   * Used in crew battle mode to update stock counts after each game.
   * @param {number} team1Score
   * @param {number} team2Score
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async setScore(team1Score, team2Score) {
    const url = `${this._config.TSH_URL}/score`;
    try {
      await axios.post(url, {
        team1score: team1Score,
        team2score: team2Score,
        scoreboard: this._config.SCOREBOARD_NUM,
      });
      console.log(`[bridge] Scores set: team1=${team1Score} team2=${team2Score}`);
      return { ok: true };
    } catch (err) {
      const msg = `setScore failed: ${err.message}`;
      console.error(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Set team color via TSH HTTP API.
   * @param {number} teamNumber — 1 or 2
   * @param {string} hexColor   — e.g. '#D32F2F'
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async setTeamColor(teamNumber, hexColor) {
    const color = hexColor.replace("#", "");
    const url = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-team${teamNumber}-color-${color}`;
    try {
      await axios.get(url);
      console.log(`[bridge] TSH team ${teamNumber} color set to #${color}`);
      return { ok: true };
    } catch (err) {
      const msg = `Failed to set color for team ${teamNumber}: ${err.message}`;
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
