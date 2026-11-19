/**
 * StartggClient — the only module that talks to start.gg, and that is the
 * invariant worth keeping: two modules would mean two places handling token
 * expiry, rate limits and timeouts.
 *
 *   - getEvent(), getPhaseGroupSets(), getChangedSets(), getSet(), listEvents()
 *     — the event, its bracket (whole, or what changed since a time) and the
 *     set being loaded (lib/event/event-service.js). All may fall back to
 *     start.gg's keyless web endpoint (see _gql).
 *   - reportSet()        — reportBracketSet (a DQ too); answers with the sets
 *                          the result changed, which the bracket shows at once.
 *   - getSetState()      — whether the Start Set button applies; cached per set
 *                          by start-set.js.
 *   - startSet()         — markSetInProgress.
 *   - callSet(), assignStream(), resetSet() — the dock's bracket card
 *                          (lib/event/bracket-ops.js).
 *   - resolveShortLink() — deliberately NOT GraphQL and deliberately NOT gated
 *                          on `enabled`. The API cannot resolve a short link
 *                          (tournament(slug: "100-acres") returns null); only
 *                          the web redirect chain can, and it needs no token.
 *   - backgroundQuery()  — the side panel's player stats (lib/stats/). Those own
 *                          their queries; what they share with everything here is
 *                          the token, the timeout and — the reason this method
 *                          exists — the rate limit.
 *
 * **Background requests are budgeted; the operator's are not.** start.gg allows
 * 80 requests per 60s per token, and a head-to-head between two regulars costs
 * several. Stats go through backgroundQuery(), which waits whenever the last 60s
 * already hold BACKGROUND_BUDGET requests of any kind. The bracket's timed reads
 * have a lane of their own (BRACKET_BUDGET), so a stats crawl can't hold up Up
 * next either. Everything else — report, start, the bracket switch — is never
 * delayed. So a burst of set loads slows the side panel's stats down; it can
 * never make a report fail.
 *
 * Auth is a start.gg "personal access token" (config.STARTGG_TOKEN, supplied
 * via the gitignored config.local.js). When no token is set, `enabled` is false
 * and _gql() sends reads to the web endpoint and refuses mutations; the
 * short-link resolve needs no token at all.
 */

const axios = require("axios");

const { SET_FIELDS, EVENT_QUERY, PHASE_GROUP_SETS_QUERY, SET_QUERY, SET_CONTEXT_QUERY, SET_RESULT_QUERY, PAGE_SIZES,
        changedSetsQuery } = require("./event/queries");

const ENDPOINT = "https://api.start.gg/gql/alpha";
const WEB_BASE = "https://www.start.gg";

// start.gg's own website endpoint: keyless, and it accepts the official API's
// queries unchanged (verified against a phase group's sets). Undocumented, so it
// is a FALLBACK for reads only — never for a mutation, which must carry the
// operator's token. Headers are the ones TSH's provider sends.
const WEB_GQL_ENDPOINT = `${WEB_BASE}/api/-/gql`;
const WEB_GQL_HEADERS = {
  "client-version": "20",
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
};

// start.gg's edge serves the redirect either way, but a default axios UA on a
// browser-facing route is the kind of thing that gets rate-limited first.
const USER_AGENT = "Mozilla/5.0 (compatible; slippi-bridge/1.0)";

// Two hops in practice: start.gg/<short> → www.start.gg/<short> →
// /tournament/<slug>/details. The cap is only a loop guard.
const MAX_SHORT_LINK_HOPS = 6;

// start.gg's limit is 80 per 60s. Background work may fill the window up to
// this; the remaining 30 are headroom the operator's actions can always use.
const RATE_WINDOW_MS    = 60000;
const BACKGROUND_BUDGET = 50;
// The bracket's reads (the event service's timer and its re-reads after a
// press) have a queue of their own and may fill the window this far: past the
// stats' 50, so a stats crawl can never hold the bracket up, and still 15 short
// of start.gg's 80, so neither can crowd out a report.
const BRACKET_BUDGET    = 65;

// A 429 means the window is already spent — possibly by another tool on the same
// token — so background work stands down for a while rather than retrying into it.
const RATE_LIMIT_COOLDOWN_MS = 30000;

// isDQ: the loser was disqualified (no games; start.gg shows "DQ").
// start.gg answers with a LIST of sets (its schema: `[Set]`): the reported one
// and the ones the result changed. They're asked for in the bracket reads' own
// shape, so the event service can show them at once — start.gg's set lists
// take seconds to catch up with a report.
const REPORT_MUTATION = `
mutation reportSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput], $isDQ: Boolean) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData, isDQ: $isDQ) { ${SET_FIELDS} }
}`.trim();

// The bracket card's other presses (lib/event/bracket-ops.js): call a set to
// its station, put it on a stream, and take a reported result back.
// resetDependentSets: false — a reset that would undo later sets is refused
// by start.gg instead of cascading.
const CALL_SET_MUTATION = `
mutation callSet($setId: ID!) {
  markSetCalled(setId: $setId) { id state }
}`.trim();

const ASSIGN_STREAM_MUTATION = `
mutation assignStream($setId: ID!, $streamId: ID!) {
  assignStream(setId: $setId, streamId: $streamId) { id stream { id } }
}`.trim();

const RESET_SET_MUTATION = `
mutation resetSet($setId: ID!) {
  resetSet(setId: $setId, resetDependentSets: false) { id state }
}`.trim();

// start.gg's set states: 1 = not started, 2 = in progress, 3 = completed,
// 6 = called to station — whether "Start set" would do anything.
const SET_STATE_QUERY = `
query setState($setId: ID!) {
  set(id: $setId) { id state }
}`.trim();

// The API equivalent of start.gg's own "Start match" button.
const START_SET_MUTATION = `
mutation startSet($setId: ID!) {
  markSetInProgress(setId: $setId) { id state }
}`.trim();

// event.slug already comes back as "tournament/<t>/event/<e>" — exactly what
// getEvent() takes — so the switcher never has to assemble one from parts.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * The page size to try after start.gg refused `perPage` for complexity. Its
 * message says how far over it was ("… (actual: 1081)"): scale to 90% of the
 * ceiling from that. Without the number, halve. Never below 5.
 */
function smallerPage(perPage, message) {
  const actual = Number(String(message ?? "").match(/actual:\s*(\d+)/i)?.[1]);
  const next = Number.isFinite(actual) && actual > 0
    ? Math.floor((perPage * 900) / actual)
    : Math.floor(perPage / 2);
  return Math.max(5, Math.min(next, perPage - 1));
}

class StartggClient {
  /**
   * @param {{ STARTGG_TOKEN?: string }} config
   */
  constructor(config) {
    this._token = (config.STARTGG_TOKEN ?? "").trim();
    // Send times (ms) of every GraphQL request in the last RATE_WINDOW_MS.
    this._sent = [];
    // Background requests wait until this time after a 429.
    this._coolUntil = 0;
    // Serialise background requests, one queue per lane, so two waiters can't
    // both see one free slot — and so the bracket never waits behind the stats.
    this._queues = { stats: Promise.resolve(), bracket: Promise.resolve() };
    // Phase group id → the page size its last read fit in, so a group that
    // needed smaller pages isn't refused again on every refresh.
    this._pageSizes = new Map();
  }

  /** True when a token is configured; the report feature keys off this. */
  get enabled() {
    return this._token.length > 0;
  }

  /**
   * Report a set result to start.gg.
   * @param {string|number} setId          — start.gg set id
   * @param {string|number} winnerEntrantId — start.gg entrant id of the winning team
   * @param {Array<object>} [gameData]      — optional per-game detail (BracketSetGameDataInput)
   * @param {{ isDQ?: boolean }} [opts]     — isDQ: the other entrant was disqualified (no games)
   * @returns {Promise<{ ok: boolean, state?: number, sets?: Array<object>, error?: string }>}
   *   sets: what start.gg answered with — the reported set and the ones the
   *   result changed, as getPhaseGroupSets() nodes
   */
  async reportSet(setId, winnerEntrantId, gameData, { isDQ = false } = {}) {
    if (setId == null || winnerEntrantId == null) {
      return { ok: false, error: "reportSet requires both a set id and a winner entrant id" };
    }

    const variables = { setId: String(setId), winnerId: String(winnerEntrantId) };
    if (isDQ) variables.isDQ = true;
    else if (Array.isArray(gameData) && gameData.length > 0) {
      variables.gameData = gameData;
    }

    const res = await this._gql(REPORT_MUTATION, variables, "start.gg rejected the report");
    // A refused report has no sets. Sets that came back beside an error mean
    // the report went through and only a field asked for alongside failed —
    // calling that a failure would have the operator report it twice.
    const answer = res.ok ? res.data?.reportBracketSet : res.partial?.reportBracketSet;
    if (!res.ok && !answer) return res;
    if (!answer) {
      return { ok: false, error: "start.gg returned no result (unexpected response shape)" };
    }
    if (!res.ok) console.log(`[bridge] Set ${setId} reported, but part of start.gg's answer failed: ${res.error}`);

    const sets = (Array.isArray(answer) ? answer : [answer]).filter((s) => s?.id != null);
    const own = sets.find((s) => String(s.id) === String(setId));
    const state = own?.state == null ? undefined : Number(own.state);
    console.log(`[bridge] Reported set ${setId} to start.gg (state ${state ?? "?"}; ${sets.length} set${sets.length === 1 ? "" : "s"} back)`);
    return { ok: true, state, sets };
  }

  /**
   * One GraphQL round-trip against start.gg.
   *
   * Every GraphQL method posts to the same endpoint with the same headers and
   * timeout, and has to handle the same failure modes — no token at all, a
   * rejected token, the rate limit, and GraphQL's habit of returning HTTP 200
   * with an `errors` array on logical failures (set not in a reportable state,
   * insufficient permission). So the token gate lives here too, once.
   *
   * **Read fallback.** A caller passing `{ fallback: true }` (reads only) gets
   * the query re-sent to start.gg's keyless web endpoint when the official API
   * can't answer: no token, the rate limit, a 5xx, or no response at all. A
   * rejected token (401/403) does NOT fall back — that is a configuration
   * problem the operator has to see, and hiding it would let the token lapse
   * unnoticed until the first report fails.
   *
   * @param {string} query
   * @param {object} variables
   * @param {string} [errorPrefix] — prepended to a GraphQL-level error message
   * @param {{ fallback?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, data?: object, error?: string, viaFallback?: boolean }>}
   */
  async _gql(query, variables, errorPrefix, opts = {}) {
    if (!this.enabled) {
      return opts.fallback
        ? this._gqlWeb(query, variables, errorPrefix)
        : { ok: false, error: "start.gg token not configured" };
    }
    // Inside a 429 cooldown the official API will only refuse again; a read
    // that can fall back goes straight to the web endpoint instead.
    if (opts.fallback && Date.now() < this._coolUntil) return this._gqlWeb(query, variables, errorPrefix);

    this._sent.push(Date.now());
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
      let failure;
      if (status === 429) {
        this._coolUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        failure = { ok: false, rateLimited: true, error: "start.gg rate limit hit (80 requests/60s). Wait a moment and try again." };
      } else {
        failure = { ok: false, error: `Network error contacting start.gg: ${err.message}` };
      }
      if (opts.fallback && (status === 429 || !status || status >= 500)) {
        const web = await this._gqlWeb(query, variables, errorPrefix);
        if (web.ok) return web;
      }
      return failure;
    }

    return this._readGql(res, errorPrefix);
  }

  /**
   * The keyless web endpoint — see WEB_GQL_ENDPOINT. Not counted against the
   * token's rate window: it is a different endpoint with its own limits.
   */
  async _gqlWeb(query, variables, errorPrefix) {
    let res;
    try {
      res = await axios.post(WEB_GQL_ENDPOINT, { query, variables },
                             { headers: WEB_GQL_HEADERS, timeout: 15000 });
    } catch (err) {
      return { ok: false, error: `start.gg web fallback failed: ${err.response?.status ?? err.message}` };
    }
    const out = this._readGql(res, errorPrefix);
    return out.ok ? { ...out, viaFallback: true } : out;
  }

  /** GraphQL's 200-with-errors convention, shared by both endpoints. */
  _readGql(res, errorPrefix) {
    const gqlErrors = res.data?.errors;
    if (Array.isArray(gqlErrors) && gqlErrors.length > 0) {
      const msg = gqlErrors.map((e) => e.message).join("; ");
      // start.gg refuses any response over 1000 objects — the whole response, not
      // just the part over the line. Flagged so a batching caller can split and
      // retry instead of treating the batch as empty.
      const complexity = /complexity is too high/i.test(msg);
      // partial: whatever data came back beside the errors (reportSet reads it).
      return { ok: false, complexity, error: errorPrefix ? `${errorPrefix}: ${msg}` : msg,
               partial: res.data?.data ?? null };
    }

    return { ok: true, data: res.data?.data };
  }

  /**
   * A GraphQL query the caller can afford to wait on — the side panel's stats.
   *
   * Waits for room in the background budget (see the header), then goes through
   * _gql() like everything else. Queued one at a time, so the wait is honest
   * under concurrency. Never throws.
   *
   * With `{ fallback: true }` it goes straight to the web endpoint when there
   * is no token, or while a 429 cooldown is running — the token's budget
   * doesn't cover that endpoint, so there is nothing to wait for, and a paged
   * read would otherwise stall 30s between pages.
   *
   * `lane: "bracket"` is the event service's (through getEvent() and
   * getPhaseGroupSets()): its own queue and BRACKET_BUDGET, so the bracket is
   * never read late because the stats are crawling a history.
   *
   * @param {string} query
   * @param {object} [variables]
   * @param {{ fallback?: boolean, lane?: "stats" | "bracket" }} [opts]
   * @returns {Promise<{ ok: boolean, data?: object, error?: string, complexity?: boolean, rateLimited?: boolean }>}
   */
  backgroundQuery(query, variables = {}, opts = {}) {
    if (!this.enabled) {
      return opts.fallback
        ? this._gqlWeb(query, variables)
        : Promise.resolve({ ok: false, error: "start.gg token not configured" });
    }
    if (opts.fallback && Date.now() < this._coolUntil) return this._gqlWeb(query, variables);
    const lane = opts.lane === "bracket" ? "bracket" : "stats";
    const run = this._queues[lane].then(async () => {
      await this._waitForBackgroundRoom(lane === "bracket" ? BRACKET_BUDGET : BACKGROUND_BUDGET);
      return this._gql(query, variables, undefined, opts);
    });
    // The queue must survive a failure, or one rejected request stalls its lane forever.
    this._queues[lane] = run.catch(() => {});
    return run;
  }

  /** Resolve once a background request fits in the budget (the last 60s hold fewer than `budget`). */
  async _waitForBackgroundRoom(budget = BACKGROUND_BUDGET) {
    for (;;) {
      const now = Date.now();
      this._sent = this._sent.filter((t) => now - t < RATE_WINDOW_MS);
      if (now < this._coolUntil) {
        await sleep(this._coolUntil - now);
        continue;
      }
      if (this._sent.length < budget) return;
      // The oldest request leaves the window first; wake just after it does.
      await sleep(this._sent[this._sent.length - budget] + RATE_WINDOW_MS - now + 50);
    }
  }

  /**
   * The set's current start.gg state (1 not started, 2 in progress, 3 done,
   * 6 called). Used to decide whether the dock's Start button applies.
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

  /** Call a set to its station (start.gg state 6). */
  callSet(setId) {
    return this._mutateSet(CALL_SET_MUTATION, { setId: String(setId) }, "markSetCalled", "start.gg wouldn't call the set");
  }

  /** Put a set on one of the tournament's streams. */
  assignStream(setId, streamId) {
    if (streamId == null) return Promise.resolve({ ok: false, error: "No stream to put it on" });
    return this._mutateSet(ASSIGN_STREAM_MUTATION, { setId: String(setId), streamId: String(streamId) },
                           "assignStream", "start.gg wouldn't put the set on stream");
  }

  /** Take a set's result back (it goes back to not started). Refused if later sets depend on it. */
  resetSet(setId) {
    return this._mutateSet(RESET_SET_MUTATION, { setId: String(setId) }, "resetSet", "start.gg wouldn't reset the set");
  }

  /** One set mutation: { ok, state? } or start.gg's refusal. Never falls back (it needs the token). */
  async _mutateSet(mutation, variables, field, errorPrefix) {
    if (variables.setId == null || variables.setId === "undefined") return { ok: false, error: "No set id" };
    const res = await this._gql(mutation, variables, errorPrefix);
    if (!res.ok) return res;
    const result = res.data?.[field];
    if (!result) return { ok: false, error: "start.gg returned no set (unexpected response shape)" };
    console.log(`[bridge] start.gg ${field} on set ${variables.setId}${result.state != null ? ` (state ${result.state})` : ""}`);
    return { ok: true, state: result.state == null ? undefined : Number(result.state) };
  }

  // ── Bracket switcher ────────────────────────────────────────────────────────

  /**
   * Resolve a start.gg short link to the tournament slug it currently points at.
   *
   * The series' short link is re-pointed at each week's tournament, so this is
   * what makes the dock's Singles / Doubles buttons need no weekly edit.
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
   * "tournament/<t>/event/<e>" path getEvent() takes. A read, so it falls back
   * to the web endpoint — the Singles / Doubles buttons work without a token.
   *
   * @param {string} tournamentSlug — e.g. "hundred-acres-43"
   * @returns {Promise<{ ok: boolean, name?: string, events?: Array<{id: string, name: string, slug: string}>, error?: string }>}
   */
  async listEvents(tournamentSlug) {
    const res = await this._gql(TOURNAMENT_EVENTS_QUERY, { slug: String(tournamentSlug) },
                                "start.gg couldn't list the tournament's events", { fallback: true });
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

  // ── Event reads (bracket, set picker) ───────────────────────────────────────

  /**
   * One event with its phases and phase groups — what the event service needs
   * to know which brackets exist. Falls back to the web endpoint.
   *
   * `background` is for the event service's timed and after-a-press reads,
   * which go through the bracket's lane of the budget; an operator's press (a
   * bracket switch, ↻) is never delayed.
   *
   * @param {string} eventSlug — "tournament/<t>/event/<e>"
   * @param {{ background?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, event?: object, error?: string }>}
   */
  async getEvent(eventSlug, { background = false } = {}) {
    const vars = { slug: String(eventSlug) };
    const res = background
      ? await this.backgroundQuery(EVENT_QUERY, vars, { fallback: true, lane: "bracket" })
      : await this._gql(EVENT_QUERY, vars, "start.gg couldn't load the event", { fallback: true });
    if (!res.ok) return res;
    const event = res.data?.event;
    if (!event) return { ok: false, error: `start.gg doesn't recognise the event "${eventSlug}"` };
    return { ok: true, event };
  }

  /**
   * Every set in a phase group, paged under start.gg's 1000-object ceiling.
   * Falls back to the web endpoint. `background` as for getEvent(): the
   * bracket's lane of the budget, so it can never crowd out a report.
   *
   * A complexity refusal restarts the group at a smaller page size — offsets
   * change with the page size, so pages already read can't be kept.
   *
   * @param {string|number} phaseGroupId
   * @param {{ background?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, sets?: Array<object>, requests?: number, error?: string }>}
   *   requests: how many it took (the event service paces its timer by it)
   */
  async getPhaseGroupSets(phaseGroupId, { background = false } = {}) {
    const key = String(phaseGroupId);
    let perPage = this._pageSizes.get(key) ?? PAGE_SIZES[0];
    let requests = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const sets = [];
      let refused = null;
      for (let page = 1; ; page++) {
        const vars = { id: key, page, perPage };
        requests++;
        const res = background
          ? await this.backgroundQuery(PHASE_GROUP_SETS_QUERY, vars, { fallback: true, lane: "bracket" })
          : await this._gql(PHASE_GROUP_SETS_QUERY, vars, undefined, { fallback: true });
        if (!res.ok) {
          if (res.complexity) { refused = res; break; }
          return res;
        }
        const conn = res.data?.phaseGroup?.sets;
        sets.push(...(conn?.nodes ?? []));
        if (page >= (conn?.pageInfo?.totalPages ?? 0)) break;
      }
      if (!refused) {
        this._pageSizes.set(key, perPage);
        return { ok: true, sets, requests };
      }
      const next = smallerPage(perPage, refused.error);
      if (next >= perPage) break;
      perPage = next;
    }
    return { ok: false, error: `start.gg refused phase group ${phaseGroupId} even at ${perPage} sets a page` };
  }

  /**
   * What changed in each phase group since a time, in one request
   * (queries.js changedSetsQuery). Falls back to the web endpoint; `background`
   * as for getEvent().
   * @param {Array<{ id: string|number, after: number }>} groups — after: unix seconds, exclusive
   * @param {{ background?: boolean }} [opts]
   * @returns {Promise<{ ok: true, groups: Object<string, { sets: Array<object>, total: number } | null> }
   *                  | { ok: false, error: string, complexity?: boolean }>}
   *   groups[id]: null when start.gg didn't answer for that group
   */
  async getChangedSets(groups, { background = false } = {}) {
    if (!groups.length) return { ok: true, groups: {} };
    let query;
    try {
      query = changedSetsQuery(groups);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const res = background
      ? await this.backgroundQuery(query, {}, { fallback: true, lane: "bracket" })
      : await this._gql(query, {}, undefined, { fallback: true });
    if (!res.ok) return res;
    const out = {};
    groups.forEach((g, i) => {
      const conn = res.data?.[`g${i}`]?.sets;
      out[String(g.id)] = conn ? { sets: conn.nodes ?? [], total: conn.pageInfo?.total ?? 0 } : null;
    });
    return { ok: true, groups: out };
  }

  /**
   * One set as it stands now, in getPhaseGroupSets()'s node shape — read when
   * the operator loads it. Operator path; falls back to the web endpoint.
   * @param {string|number} setId — a real id (a preview_… id has nothing to read)
   * @returns {Promise<{ ok: boolean, set?: object, error?: string }>}
   */
  async getSet(setId) {
    const res = await this._gql(SET_QUERY, { id: String(setId) },
                                "start.gg couldn't read the set", { fallback: true });
    if (!res.ok) return res;
    const set = res.data?.set;
    if (!set) return { ok: false, error: `start.gg doesn't recognise set ${setId}` };
    return { ok: true, set };
  }

  /**
   * Where a set was played — tournament, event, phase, phase group, round and
   * stream — for its replay bundle's context.json (lib/replays/context.js).
   * Background: bundling is never what the operator is waiting on. Reads fall
   * back to the web endpoint, so it works without a token.
   * @param {string|number} setId — a real id
   * @returns {Promise<{ ok: boolean, set?: object, error?: string }>}
   */
  async getSetContext(setId) {
    const res = await this.backgroundQuery(SET_CONTEXT_QUERY, { id: String(setId) }, { fallback: true });
    if (!res.ok) return res;
    const set = res.data?.set;
    if (!set?.phaseGroup?.phase?.event?.tournament) {
      return { ok: false, error: `start.gg doesn't recognise set ${setId}` };
    }
    return { ok: true, set };
  }

  /**
   * A set's result as start.gg has it now: its state (3 = completed), the
   * winner, and each entrant's score (-1 = DQ). Background, falls back keyless
   * — the replays' completion watch asks every few minutes, never the operator.
   * @param {string|number} setId
   * @returns {Promise<{ ok: true, state: number, winnerId: string|null, scores: Object<string, number|null> }
   *                  | { ok: false, error: string }>}
   */
  async getSetResult(setId) {
    const res = await this.backgroundQuery(SET_RESULT_QUERY, { id: String(setId) }, { fallback: true });
    if (!res.ok) return res;
    const set = res.data?.set;
    if (set?.state == null) return { ok: false, error: `start.gg doesn't recognise set ${setId}` };
    const scores = {};
    for (const slot of set.slots ?? []) {
      if (slot?.entrant?.id == null) continue;
      const v = slot.standing?.stats?.score?.value;
      scores[String(slot.entrant.id)] = Number.isFinite(v) ? v : null;
    }
    return { ok: true, state: Number(set.state), winnerId: set.winnerId == null ? null : String(set.winnerId), scores };
  }
}

module.exports = StartggClient;
