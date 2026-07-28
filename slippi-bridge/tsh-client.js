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

  /**
   * Returns the start.gg set_id backing the currently-loaded set, or null.
   * Null means the set was entered manually (exhibition/friendly) and has no
   * start.gg set to report against.
   * @param {object} state — from readState()
   * @returns {string|number|null}
   */
  getSetId(state) {
    return state?.score?.[String(this._config.SCOREBOARD_NUM)]?.set_id ?? null;
  }

  /**
   * Returns the live set score for both teams.
   * @param {object} state — from readState()
   * @returns {{ team1: number, team2: number }}
   */
  getLiveScores(state) {
    const sb = String(this._config.SCOREBOARD_NUM);
    return {
      team1: state?.score?.[sb]?.team?.["1"]?.score ?? 0,
      team2: state?.score?.[sb]?.team?.["2"]?.score ?? 0,
    };
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

  /**
   * Set the stage for the current game in TSH's Individual Game Tracker
   * (TSH 5.972+). Fronts POST /scoreboard{N}-set-current-stage, which writes
   * score.{N}.stage_strike.selectedStage and fills the tracker's stage slot.
   *
   * Purely cosmetic — callers must not let a failure here block scoring.
   * @param {string} codename — TSH stage codename, from resolveStage()
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async setCurrentStage(codename) {
    const url = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-set-current-stage`;
    try {
      await axios.post(url, { codename });
      console.log(`[bridge] TSH stage: ${codename}`);
      return { ok: true };
    } catch (err) {
      const msg = `Failed to set stage "${codename}": ${err.message}`;
      console.warn(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  // ── Bracket actions (proxy TSH's native start.gg integration) ────────────────

  /**
   * Pull the next queued set for the current stream onto the scoreboard.
   * Fronts TSH's GET /scoreboard{N}-pull-stream.
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async pullStreamSet() {
    const url = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-pull-stream`;
    try {
      await axios.get(url);
      console.log("[bridge] Pulled next stream set");
      return { ok: true };
    } catch (err) {
      const msg = `pullStreamSet failed: ${err.message}`;
      console.error(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * List sets from the configured bracket provider. Fronts TSH's GET /get-sets,
   * which returns start.gg states 1/6/2 (not started, called, in progress) and
   * adds state 3 (finished) when getFinished is present.
   *
   * Each call is a live paginated GraphQL query on TSH's side with no caching,
   * so callers must not poll this fast.
   *
   * Item shape is provider-defined; the control panel reads id, round_name,
   * tournament_phase, p1_name/p2_name, p1_seed/p2_seed, team1score/team2score,
   * station and stream.
   *
   * @param {boolean} [includeFinished=false] — also return finished sets
   * @returns {Promise<{ ok: boolean, data?: Array, error?: string }>}
   */
  async getOpenSets(includeFinished = false) {
    const url = `${this._config.TSH_URL}/get-sets`;
    try {
      const res = await axios.get(url, {
        params: includeFinished ? { getFinished: true } : undefined,
      });
      return { ok: true, data: Array.isArray(res.data) ? res.data : [] };
    } catch (err) {
      const msg = `getOpenSets failed: ${err.message}`;
      console.error(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Load a specific set by its provider set id onto the scoreboard.
   * Fronts TSH's GET /scoreboard{N}-load-set?set={id}.
   * @param {string|number} setId
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async loadSet(setId) {
    const url = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-load-set`;
    try {
      await axios.get(url, { params: { set: setId } });
      console.log(`[bridge] Loaded set ${setId}`);
      return { ok: true };
    } catch (err) {
      const msg = `loadSet(${setId}) failed: ${err.message}`;
      console.error(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Return the id of the set currently selected on the scoreboard.
   * Fronts TSH's GET /scoreboard{N}-get-set.
   * @returns {Promise<{ ok: boolean, data?: string, error?: string }>}
   */
  async getCurrentSet() {
    const url = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-get-set`;
    try {
      const res = await axios.get(url);
      return { ok: true, data: res.data };
    } catch (err) {
      const msg = `getCurrentSet failed: ${err.message}`;
      console.error(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Read TSH's own "teams are swapped" flag.
   * Fronts GET /scoreboard{N}-get-swap, which returns Python's str(bool) —
   * the literal text "True" or "False", not JSON.
   *
   * Lets the bridge notice the operator pressing TSH's Swap Teams button
   * instead of waiting to re-derive the mapping from names on the next game.
   * @returns {Promise<{ ok: boolean, data?: boolean, error?: string }>}
   */
  async getSwapState() {
    const url = `${this._config.TSH_URL}/scoreboard${this._config.SCOREBOARD_NUM}-get-swap`;
    try {
      const res = await axios.get(url, { timeout: 2000 });
      return { ok: true, data: String(res.data).trim().toLowerCase() === "true" };
    } catch (err) {
      // Polled every 2s — log nothing here or a TSH restart floods the console.
      return { ok: false, error: `getSwapState failed: ${err.message}` };
    }
  }

  /**
   * Lightweight connectivity probe used by the control panel health indicator.
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      await axios.get(`${this._config.TSH_URL}/`, { timeout: 2000 });
      return true;
    } catch (err) {
      // Any HTTP response (even 404) means the server is up.
      return Boolean(err.response);
    }
  }
}

module.exports = TshClient;
