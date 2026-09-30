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
    this._settingsPath = path.join(tshRoot, "user_data/settings.json");
    // Every key in program_state.json is a string, and the scoreboard number is
    // in most of the paths below and every HTTP route — resolve it once.
    this._sb = String(config.SCOREBOARD_NUM);
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

  /**
   * readState() in the { ok } shape the HTTP methods use, for callers that
   * report a failure rather than propagate it. Goes through readState() so a
   * test that stubs that one method stubs this too.
   * @returns {{ ok: true, state: object } | { ok: false, error: string }}
   */
  tryReadState() {
    try {
      return { ok: true, state: this.readState() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── Pure accessors (operate on a state returned by readState()) ─────────────

  /**
   * The team subtree for a scoreboard column. Every accessor below starts here,
   * so the `score.<sb>.team.<n>` dig is written once rather than eight times.
   * @param {object|null} state
   * @param {number|string} teamNum — 1 or 2
   */
  _team(state, teamNum) {
    return state?.score?.[this._sb]?.team?.[String(teamNum)];
  }


  /**
   * Extract team name and score for a given team number.
   * In doubles, name is "Player1 / Player2" (concatenated from both players).
   * @param {object} state   — from readState()
   * @param {number} teamNum — 1 or 2
   * @returns {{ name: string, score: number }}
   */
  getTeamInfo(state, teamNum) {
    return {
      name:  this.getTeamPlayerNames(state, teamNum).join(" / "),
      score: this._team(state, teamNum)?.score ?? 0,
    };
  }

  /**
   * Both teams' info at once, tolerating a null state.
   *
   * Callers that have just read (or failed to read) TSH otherwise repeat the
   * same `state ? getTeamInfo(state, n) : { name: "", score: 0 }` pair.
   * @param {object|null} state
   * @returns {{ t1: { name: string, score: number }, t2: { name: string, score: number } }}
   */
  getTeamInfos(state) {
    if (!state) return { t1: { name: "", score: 0 }, t2: { name: "", score: 0 } };
    return { t1: this.getTeamInfo(state, 1), t2: this.getTeamInfo(state, 2) };
  }

  /**
   * Trimmed, non-empty player names for a team, in slot order. Tolerates a null
   * state (returns []).
   * @param {object|null} state
   * @param {number} teamNum — 1 or 2
   * @returns {string[]}
   */
  getTeamPlayerNames(state, teamNum) {
    return Object.values(this._team(state, teamNum)?.player ?? {})
      .map((p) => (p?.name ?? "").trim())
      .filter(Boolean);
  }

  /**
   * Which scoreboard column currently shows this player name.
   * @param {object} state
   * @param {string} name
   * @returns {1|2|null}
   */
  teamOfName(state, name) {
    if (!name) return null;
    if (this.getTeamPlayerNames(state, 1).includes(name)) return 1;
    if (this.getTeamPlayerNames(state, 2).includes(name)) return 2;
    return null;
  }

  /**
   * The start.gg ids of a team's first player, or null when there are none
   * (a name typed by hand, or a player from TSH's local database).
   *
   * TSH's start.gg provider stores `id` as `[playerId, userId]`, with a userId
   * of 0 for a player who never claimed an account. A bare scalar is tolerated
   * as a playerId alone.
   * @param {object|null} state
   * @param {number} teamNum — 1 or 2
   * @returns {{ playerId: string, userId: string|null, name: string } | null}
   */
  getPlayerIds(state, teamNum) {
    const player = this._team(state, teamNum)?.player?.["1"];
    const raw = player?.id;
    const [pid, uid] = Array.isArray(raw) ? raw : [raw, null];
    const clean = (v) => (v != null && /^[1-9]\d*$/.test(String(v)) ? String(v) : null);
    const playerId = clean(pid);
    if (!playerId) return null;
    return { playerId, userId: clean(uid), name: (player?.name ?? "").trim() };
  }

  /**
   * Returns true if the TSH scoreboard is configured for doubles
   * (team 1 has more than one player slot).
   * @param {object} state
   * @returns {boolean}
   */
  isDoubles(state) {
    return Object.keys(this._team(state, 1)?.player ?? {}).length > 1;
  }

  /**
   * Extract preloaded character history for both teams.
   * Returns up to 2 preloaded chars per team (index 0 = player 1, 1 = player 2).
   * @param {object} state — from readState()
   * @returns {{ t1: Array<{name:string, skin:number}>, t2: Array<{name:string, skin:number}> }}
   */
  getPreloadedChars(state) {
    const getEntries = (teamNum) =>
      Object.values(this._team(state, teamNum)?.player ?? {}).map((player) => {
        const entry = player?.character?.["1"];
        return {
          name: (entry?.name ?? "").trim(),
          skin: entry?.skin ?? -1,
        };
      });
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
    return state?.score?.[this._sb]?.set_id ?? null;
  }

  /**
   * Tournament + event names as TSH's provider last reported them.
   *
   * This is the real confirmation that a bracket switch landed: /set-tournament
   * returns before TSH's thread pool finishes loading, so its "OK" proves
   * nothing, whereas these fields only change once the provider has answered.
   * @param {object|null} state — from readState()
   * @returns {{ name: string, eventName: string }}
   */
  getTournamentInfo(state) {
    const t = state?.tournamentInfo ?? {};
    return { name: (t.tournamentName ?? "").trim(), eventName: (t.eventName ?? "").trim() };
  }

  /**
   * TSH's currently-loaded tournament URL, from user_data/settings.json.
   *
   * READ ONLY. SettingsManager owns that file and rewrites the whole thing on
   * every Set(), and TSH never re-reads it at runtime — a bridge-side write
   * would be both ineffective and clobbered. Used only to spot that a bracket is
   * already loaded, because /set-tournament silently does nothing in that case.
   *
   * @returns {string|null} — null means "unknown", not "none loaded"
   */
  readTournamentUrl() {
    try {
      return JSON.parse(fs.readFileSync(this._settingsPath, "utf8")).TOURNAMENT_URL ?? null;
    } catch {
      return null; // missing / unparseable just means we can't tell
    }
  }

  /**
   * Returns the live set score for both teams.
   * @param {object} state — from readState()
   * @returns {{ team1: number, team2: number }}
   */
  getLiveScores(state) {
    return {
      team1: this._team(state, 1)?.score ?? 0,
      team2: this._team(state, 2)?.score ?? 0,
    };
  }

  // ── HTTP calls ──────────────────────────────────────────────────────────────

  /**
   * One call to TSH's HTTP API.
   *
   * Every route below is the same shape — build a URL, await axios, log, and
   * return `{ ok }` rather than throwing — so it is written once here. Callers
   * supply only what actually differs.
   *
   * @param {string} route — path only, e.g. "/get-sets"
   * @param {object} [opts]
   * @param {"get"|"post"} [opts.method="get"]
   * @param {object} [opts.params] — query string (GET)
   * @param {object} [opts.body]   — JSON body (POST)
   * @param {number} [opts.timeout]
   * @param {string} [opts.success] — logged at info level when the call succeeds
   * @param {string} [opts.failure] — prefix for the error message
   * @param {"error"|"warn"|"silent"} [opts.onError="error"] — how loudly to fail
   * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
   */
  async _call(route, opts = {}) {
    const { method = "get", params, body, timeout, success, failure, onError = "error" } = opts;
    const url = `${this._config.TSH_URL}${route}`;
    try {
      const res = method === "post"
        ? await axios.post(url, body, { timeout })
        : await axios.get(url, { params, timeout });
      if (success) console.log(`[bridge] ${success}`);
      return { ok: true, data: res.data };
    } catch (err) {
      const msg = `${failure}: ${err.message}`;
      if (onError === "error")     console.error(`[bridge] ${msg}`);
      else if (onError === "warn") console.warn(`[bridge] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** A scoreboard-scoped route, e.g. _sbRoute("-pull-stream"). */
  _sbRoute(suffix) {
    return `/scoreboard${this._sb}${suffix}`;
  }

  /**
   * Increment the score for a team via TSH HTTP API.
   * @param {number} teamNumber — 1 or 2
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  incrementScore(teamNumber) {
    return this._call(this._sbRoute(`-team${teamNumber}-scoreup`), {
      success: `Score incremented for team ${teamNumber}`,
      failure: `Failed to increment score for team ${teamNumber}`,
    });
  }

  /**
   * Set team color via TSH HTTP API.
   * @param {number} teamNumber — 1 or 2
   * @param {string} hexColor   — e.g. '#D32F2F'
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  setTeamColor(teamNumber, hexColor) {
    const color = hexColor.replace("#", "");
    return this._call(this._sbRoute(`-team${teamNumber}-color-${color}`), {
      success: `TSH team ${teamNumber} color set to #${color}`,
      failure: `Failed to set color for team ${teamNumber}`,
    });
  }

  /**
   * Set character + costume for a team via TSH HTTP API.
   * @param {number} teamNumber
   * @param {string} charDisplayName
   * @param {number} costumeIndex
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  setCharacter(teamNumber, charDisplayName, costumeIndex) {
    return this._call(this._sbRoute(`-update-team-${teamNumber}-1`), {
      method: "post",
      body: { mains: { ssbm: [[charDisplayName, costumeIndex]] } },
      success: `TSH team ${teamNumber}: ${charDisplayName} costume ${costumeIndex}`,
      failure: `Failed to set character for team ${teamNumber}`,
    });
  }

  /**
   * Set the stage for the current game in TSH's Individual Game Tracker
   * (TSH 5.972+). Fronts POST /scoreboard{N}-set-current-stage, which writes
   * score.{N}.stage_strike.selectedStage and fills the tracker's stage slot.
   *
   * Purely cosmetic — callers must not let a failure here block scoring, which
   * is why it only warns.
   * @param {string} codename — TSH stage codename, from resolveStage()
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  setCurrentStage(codename) {
    return this._call(this._sbRoute("-set-current-stage"), {
      method: "post",
      body: { codename },
      success: `TSH stage: ${codename}`,
      failure: `Failed to set stage "${codename}"`,
      onError: "warn",
    });
  }

  // ── Bracket actions (proxy TSH's native start.gg integration) ────────────────

  /**
   * Pull the next queued set for the current stream onto the scoreboard.
   * Fronts TSH's GET /scoreboard{N}-pull-stream.
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  pullStreamSet() {
    return this._call(this._sbRoute("-pull-stream"), {
      success: "Pulled next stream set",
      failure: "pullStreamSet failed",
    });
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
    const res = await this._call("/get-sets", {
      params: includeFinished ? { getFinished: true } : undefined,
      failure: "getOpenSets failed",
    });
    // The panel iterates this, so a non-array body must not reach it.
    return res.ok ? { ok: true, data: Array.isArray(res.data) ? res.data : [] } : res;
  }

  /**
   * Load a specific set by its provider set id onto the scoreboard.
   * Fronts TSH's GET /scoreboard{N}-load-set?set={id}.
   * @param {string|number} setId
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  loadSet(setId) {
    return this._call(this._sbRoute("-load-set"), {
      params: { set: setId },
      success: `Loaded set ${setId}`,
      failure: `loadSet(${setId}) failed`,
    });
  }

  /**
   * Point TSH at a tournament event. Fronts TSH's GET /set-tournament?url=,
   * which writes TOURNAMENT_URL and signals its provider to re-pull the
   * tournament, phases and entrants at runtime. TSH does not watch
   * settings.json, so this route is the only way to switch brackets live.
   *
   * Three TSH-side traps this cannot paper over:
   *   - The url must be a full ".../tournament/<t>/event/<e>". TSH's provider
   *     does url.split("start.gg/")[1] at ~11 query sites, so anything trailing
   *     the event slug corrupts every bracket request it makes afterwards.
   *   - It returns the plain string "OK" *even when it did nothing* — and
   *     re-sending the currently-loaded url is exactly that no-op
   *     (SetTournamentSignal early-returns when provider.url matches). Pass the
   *     same scheme-less form TSH stores so that comparison stays predictable,
   *     and use updateBracket() when a real re-pull is what's wanted.
   *   - Nothing validates the event exists. A stale slug is accepted, logs
   *     nothing, and leaves an empty bracket.
   *
   * @param {string} url — e.g. "start.gg/tournament/hundred-acres-43/event/melee-doubles"
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  setTournament(url) {
    // An empty url UNSETS TSH's tournament — refuse it here rather than let a
    // missing config value quietly wipe the operator's bracket.
    if (!url) {
      return Promise.resolve({ ok: false, error: "setTournament needs a url — an empty one unsets TSH's tournament" });
    }
    return this._call("/set-tournament", {
      params: { url },
      timeout: 10000,
      success: `TSH tournament set to ${url}`,
      failure: "setTournament failed",
    });
  }

  /**
   * Re-pull the loaded bracket from the provider. Fronts GET /update-bracket.
   *
   * Only meaningful once a tournament is loaded: update_bracket() dereferences
   * its provider with no null check, so calling this with nothing loaded is a
   * 500 rather than a no-op. Callers must know a bracket is in place.
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  updateBracket() {
    return this._call("/update-bracket", {
      timeout: 15000,
      success: "Re-pulled the bracket from the provider",
      failure: "updateBracket failed",
    });
  }

  /**
   * Press TSH's own Swap Teams button — moves each team (names, scores, all
   * player data) to the other side of the scoreboard. Fronts TSH's
   * GET /scoreboard{N}-swap-teams, which returns the plain text "OK".
   *
   * Distinct from the bridge's swapTeams(), which only flips the internal
   * port→team map and leaves the scoreboard's sides alone. The 2s
   * getSwapState() poll notices the flag change afterwards and re-derives the
   * port mapping against the moved names, so scoring follows automatically.
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  swapSides() {
    return this._call(this._sbRoute("-swap-teams"), {
      success: "TSH Swap Teams triggered from the control panel",
      failure: "swapSides failed",
    });
  }

  /**
   * Read TSH's own "teams are swapped" flag.
   * Fronts GET /scoreboard{N}-get-swap, which returns Python's str(bool) —
   * the literal text "True" or "False", not JSON.
   *
   * Lets the bridge notice the operator pressing TSH's Swap Teams button
   * instead of waiting to re-derive the mapping from names on the next game.
   *
   * Silent on failure: it is polled every 2s, so logging would flood the console
   * for as long as TSH is restarting. It doubles as the control-status loop's
   * liveness probe — see server/control-status.js#probeTsh.
   * @returns {Promise<{ ok: boolean, data?: boolean, error?: string }>}
   */
  async getSwapState() {
    const res = await this._call(this._sbRoute("-get-swap"), {
      timeout: 2000,
      failure: "getSwapState failed",
      onError: "silent",
    });
    return res.ok
      ? { ok: true, data: String(res.data).trim().toLowerCase() === "true" }
      : res;
  }

  /**
   * Lightweight connectivity probe: the control panel health indicator, and
   * start-all.js waiting for TSH to come up.
   * @param {number} [timeout=2000]
   * @returns {Promise<boolean>}
   */
  async ping(timeout = 2000) {
    try {
      await axios.get(`${this._config.TSH_URL}/`, { timeout });
      return true;
    } catch (err) {
      // Any HTTP response (even 404) means the server is up.
      return Boolean(err.response);
    }
  }
}

module.exports = TshClient;
