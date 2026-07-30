/**
 * StartggClient — direct client for start.gg's official GraphQL API.
 *
 * This is the ONE place the bridge talks to an external service. It exists
 * only to report set results back to the bracket (reportBracketSet) — TSH has
 * no reporting capability of its own. All *reading* of bracket/queue/set data
 * still goes through TSH's native start.gg integration (see tsh-client.js).
 *
 * Auth is a start.gg "personal access token" (config.STARTGG_TOKEN, supplied
 * via the gitignored config.local.js). When no token is set, `enabled` is false
 * and reportSet() short-circuits — the rest of the bridge is unaffected.
 */

const axios = require("axios");

const ENDPOINT = "https://api.start.gg/gql/alpha";

const REPORT_MUTATION = `
mutation reportSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
    id
    state
  }
}`.trim();

// TSH stores the start.gg set id but does not expose per-team entrant ids in
// its /get-match response — reportBracketSet needs the winning ENTRANT id, so
// we fetch the set's slots directly. Slot order matches TSH's team order
// (slots[0] = team 1, slots[1] = team 2).
const SET_ENTRANTS_QUERY = `
query setEntrants($setId: ID!) {
  set(id: $setId) {
    id
    slots { slotIndex entrant { id name } }
  }
}`.trim();

class StartggClient {
  /**
   * @param {{ STARTGG_TOKEN?: string }} config
   */
  constructor(config) {
    this._token = (config.STARTGG_TOKEN ?? "").trim();
  }

  /** True when a token is configured; the report feature keys off this. */
  get enabled() {
    return this._token.length > 0;
  }

  /**
   * Report a set result to start.gg.
   * @param {string|number} setId          — start.gg set id (from TSH state)
   * @param {string|number} winnerEntrantId — start.gg entrant id of the winning team
   * @param {Array<object>} [gameData]      — optional per-game detail (BracketSetGameDataInput)
   * @returns {Promise<{ ok: boolean, state?: number, error?: string }>}
   */
  async reportSet(setId, winnerEntrantId, gameData) {
    if (!this.enabled) {
      return { ok: false, error: "start.gg token not configured" };
    }
    if (setId == null || winnerEntrantId == null) {
      return { ok: false, error: "reportSet requires both a set id and a winner entrant id" };
    }

    const variables = { setId: String(setId), winnerId: String(winnerEntrantId) };
    if (Array.isArray(gameData) && gameData.length > 0) {
      variables.gameData = gameData;
    }

    const res = await this._gql(REPORT_MUTATION, variables, "start.gg rejected the report");
    if (!res.ok) return res;

    const result = res.data?.reportBracketSet;
    if (!result) {
      return { ok: false, error: "start.gg returned no result (unexpected response shape)" };
    }

    console.log(`[bridge] Reported set ${setId} to start.gg (state ${result.state})`);
    return { ok: true, state: result.state };
  }

  /**
   * One GraphQL round-trip against start.gg.
   *
   * Both callers post to the same endpoint with the same headers and timeout,
   * and have to handle the same three failure modes — a rejected token, the rate
   * limit, and GraphQL's habit of returning HTTP 200 with an `errors` array on
   * logical failures (set not in a reportable state, insufficient permission).
   *
   * @param {string} query
   * @param {object} variables
   * @param {string} [errorPrefix] — prepended to a GraphQL-level error message
   * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
   */
  async _gql(query, variables, errorPrefix) {
    let res;
    try {
      res = await axios.post(
        ENDPOINT,
        { query, variables },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${this._token}`,
          },
          timeout: 10000,
        }
      );
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        return { ok: false, error: "start.gg rejected the token (invalid or expired — they expire yearly). Regenerate it and update config.local.js." };
      }
      if (status === 429) {
        return { ok: false, error: "start.gg rate limit hit (80 requests/60s). Wait a moment and try again." };
      }
      return { ok: false, error: `Network error contacting start.gg: ${err.message}` };
    }

    const gqlErrors = res.data?.errors;
    if (Array.isArray(gqlErrors) && gqlErrors.length > 0) {
      const msg = gqlErrors.map((e) => e.message).join("; ");
      return { ok: false, error: errorPrefix ? `${errorPrefix}: ${msg}` : msg };
    }

    return { ok: true, data: res.data?.data };
  }

  /**
   * Fetch the two entrants for a set, keyed by TSH team number (slot 0 → team 1).
   * @param {string|number} setId
   * @returns {Promise<{ ok: boolean, entrants?: { 1?: { id: string, name: string }, 2?: { id: string, name: string } }, error?: string }>}
   */
  async getSetEntrants(setId) {
    if (!this.enabled) {
      return { ok: false, error: "start.gg token not configured" };
    }

    const res = await this._gql(SET_ENTRANTS_QUERY, { setId: String(setId) });
    if (!res.ok) return res;

    const slots = res.data?.set?.slots;
    if (!Array.isArray(slots) || slots.length < 2) {
      return { ok: false, error: "start.gg returned no entrants for this set (is it a real, seeded set?)" };
    }

    const entrants = {};
    slots.forEach((slot, i) => {
      const ent = slot?.entrant;
      if (ent?.id != null) entrants[i + 1] = { id: String(ent.id), name: ent.name ?? "" };
    });
    return { ok: true, entrants };
  }
}

module.exports = StartggClient;
