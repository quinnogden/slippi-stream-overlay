/**
 * StartggClient — the bridge's direct client for start.gg.
 *
 * This is the ONE place the bridge talks to an external service, and that is the
 * invariant worth keeping: two modules would mean two places handling token
 * expiry, rate limits and timeouts. Bracket/queue/set *reading* during a set
 * still goes through TSH's native integration (see tsh-client.js) — what lives
 * here is what TSH cannot do:
 *
 *   - reportSet()        — reportBracketSet; TSH has no reporting capability.
 *   - getSetEntrants()   — TSH's /get-match doesn't expose entrant ids.
 *   - getSetState()      — TSH's set list doesn't carry start.gg's set state, so
 *                          nothing else can tell a not-yet-started set from a
 *                          running one.
 *   - startSet()         — markSetInProgress; TSH can't start a set either.
 *   - listEvents()       — the bracket switcher needs a tournament's real event
 *                          list before TSH has been pointed at anything.
 *   - resolveShortLink() — deliberately NOT GraphQL and deliberately NOT gated
 *                          on `enabled`. The API cannot resolve a short link
 *                          (tournament(slug: "100-acres") returns null); only
 *                          the web redirect chain can, and it needs no token.
 *
 * Auth is a start.gg "personal access token" (config.STARTGG_TOKEN, supplied
 * via the gitignored config.local.js). When no token is set, `enabled` is false
 * and every GraphQL method short-circuits — the rest of the bridge is
 * unaffected, and the short-link resolve still works.
 */

const axios = require("axios");

const ENDPOINT = "https://api.start.gg/gql/alpha";
const WEB_BASE = "https://www.start.gg";

// start.gg's edge serves the redirect either way, but a default axios UA on a
// browser-facing route is the kind of thing that gets rate-limited first.
const USER_AGENT = "Mozilla/5.0 (compatible; slippi-bridge/1.0)";

// Two hops in practice: start.gg/<short> → www.start.gg/<short> →
// /tournament/<slug>/details. The cap is only a loop guard.
const MAX_SHORT_LINK_HOPS = 6;

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

// start.gg's set states: 1 = not started, 2 = in progress, 3 = completed,
// 6 = called to station. TSH's /get-sets returns 1/6/2 without saying which,
// so this is the only way to know whether "Start set" would do anything.
const SET_STATE_QUERY = `
query setState($setId: ID!) {
  set(id: $setId) { id state }
}`.trim();

// The API equivalent of start.gg's own "Start match" button.
const START_SET_MUTATION = `
mutation startSet($setId: ID!) {
  markSetInProgress(setId: $setId) { id state }
}`.trim();

// event.slug already comes back as "tournament/<t>/event/<e>" — exactly the
// shape TSH stores — so the switcher never has to assemble one from parts.
const TOURNAMENT_EVENTS_QUERY = `
query tournamentEvents($slug: String!) {
  tournament(slug: $slug) { id name events { id name slug } }
}`.trim();

/**
 * The tournament slug in a start.gg URL, or null if there isn't one.
 * @param {string} url
 * @returns {string|null}
 */
function tournamentSlugFromUrl(url) {
  return String(url ?? "").match(/\/tournament\/([^/?#]+)/)?.[1] ?? null;
}

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

  /**
   * The set's current start.gg state (1 not started, 2 in progress, 3 done,
   * 6 called). Used to decide whether the panel's Start Set button applies.
   *
   * Deliberately a separate round-trip rather than a field on the 2s status
   * tick: start.gg allows 80 requests/60s, and polling this would spend most of
   * that budget on a value that changes twice per set. start-set.js caches it
   * per set id.
   *
   * @param {string|number} setId
   * @returns {Promise<{ ok: boolean, state?: number, error?: string }>}
   */
  async getSetState(setId) {
    if (!this.enabled) return { ok: false, error: "start.gg token not configured" };

    const res = await this._gql(SET_STATE_QUERY, { setId: String(setId) });
    if (!res.ok) return res;

    const state = res.data?.set?.state;
    if (state == null) {
      return { ok: false, error: `start.gg doesn't recognise set ${setId}` };
    }
    return { ok: true, state: Number(state) };
  }

  /**
   * Mark a set in progress on start.gg — the API's "Start match".
   *
   * Safe to the bracket: it only moves the set from not-started/called to
   * in-progress, and start.gg rejects it (via the errors array) for a set that
   * is already running or finished.
   *
   * @param {string|number} setId
   * @returns {Promise<{ ok: boolean, state?: number, error?: string }>}
   */
  async startSet(setId) {
    if (!this.enabled) return { ok: false, error: "start.gg token not configured" };
    if (setId == null) return { ok: false, error: "startSet requires a set id" };

    const res = await this._gql(START_SET_MUTATION, { setId: String(setId) },
                                "start.gg wouldn't start the set");
    if (!res.ok) return res;

    const result = res.data?.markSetInProgress;
    if (!result) {
      return { ok: false, error: "start.gg returned no set (unexpected response shape)" };
    }

    console.log(`[bridge] Marked set ${setId} in progress on start.gg (state ${result.state})`);
    return { ok: true, state: Number(result.state) };
  }

  // ── Bracket switcher ────────────────────────────────────────────────────────

  /**
   * Resolve a start.gg short link to the tournament slug it currently points at.
   *
   * The series' short link is re-pointed at each week's tournament, so this is
   * what makes the control panel's bracket buttons need no weekly edit.
   *
   * NOT GraphQL: the API returns null for a short slug, so the server-side
   * redirect is the only mechanism. NOT gated on `enabled`: no token is
   * involved, and the buttons should keep working on a machine without one.
   *
   * Redirects are followed by hand (maxRedirects: 0) because the *URL* is the
   * answer, not the body — letting axios follow would fetch the heavy details
   * page and expose the final URL only through the undocumented
   * `res.request.res.responseUrl`.
   *
   * @param {string} shortLink — e.g. "100-acres"; a pasted URL is tolerated
   * @returns {Promise<{ ok: boolean, slug?: string, error?: string }>}
   */
  async resolveShortLink(shortLink) {
    const clean = String(shortLink ?? "").trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^(www\.)?start\.gg\//i, "")
      .replace(/^\/+|\/+$/g, "");
    if (!clean) {
      return { ok: false, error: "No start.gg short link configured (config.BRACKETS.shortLink)." };
    }

    let at = `${WEB_BASE}/${clean}`;
    for (let hop = 0; hop < MAX_SHORT_LINK_HOPS; hop++) {
      // Checked before fetching, so a value that is already a tournament URL
      // costs no network calls at all.
      const slug = tournamentSlugFromUrl(at);
      if (slug) return { ok: true, slug };

      let res;
      try {
        res = await axios.get(at, {
          maxRedirects: 0,
          timeout: 10000,
          validateStatus: () => true, // a 3xx is the payload; a 404 is a reportable outcome
          headers: { Accept: "text/html", "User-Agent": USER_AGENT },
        });
      } catch (err) {
        return { ok: false, error: `Couldn't reach start.gg to resolve "${clean}": ${err.message}` };
      }

      const loc = res.headers?.location;
      if (!loc) {
        return { ok: false, error: `start.gg has no short link "${clean}" (HTTP ${res.status}) — check config.BRACKETS.shortLink; the hyphen matters ("100-acres", not "100acres").` };
      }
      at = new URL(loc, at).toString(); // Location is relative on the second hop
    }
    return { ok: false, error: `start.gg redirected in a loop resolving "${clean}".` };
  }

  /**
   * A tournament's events, so the switcher can match one by name rather than
   * appending a slug it never verified. Each `slug` is already the full
   * "tournament/<t>/event/<e>" path TSH wants.
   *
   * @param {string} tournamentSlug — e.g. "hundred-acres-43"
   * @returns {Promise<{ ok: boolean, name?: string, events?: Array<{id: string, name: string, slug: string}>, error?: string }>}
   */
  async listEvents(tournamentSlug) {
    if (!this.enabled) {
      return { ok: false, error: "start.gg token not configured" };
    }

    const res = await this._gql(TOURNAMENT_EVENTS_QUERY, { slug: String(tournamentSlug) });
    if (!res.ok) return res;

    const t = res.data?.tournament;
    if (!t) {
      return { ok: false, error: `start.gg doesn't recognise the tournament "${tournamentSlug}"` };
    }
    const events = Array.isArray(t.events) ? t.events : [];
    if (events.length === 0) {
      return { ok: false, error: `"${t.name ?? tournamentSlug}" has no events on start.gg yet` };
    }

    return { ok: true, name: t.name ?? tournamentSlug, events };
  }
}

module.exports = StartggClient;
// Exported so bracket-switch.js and its test share the one parser.
module.exports.tournamentSlugFromUrl = tournamentSlugFromUrl;
