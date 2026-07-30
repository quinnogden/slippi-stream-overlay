/**
 * The control panel's Singles / Doubles bracket buttons.
 *
 * Hundred Acres runs weekly and a stream alternates formats, so the operator
 * otherwise leaves the dock, opens start.gg, and pastes an event link into TSH
 * every time the format changes. One press does the whole chain:
 *
 *   config.BRACKETS.shortLink            e.g. "100-acres"
 *     → resolveShortLink()               → this week's tournament slug
 *     → listEvents() + pickEvent()       → that tournament's real singles/doubles event
 *     → tsh.setTournament(url)           → TSH re-pulls the bracket
 *
 * The event is looked up rather than assembled by appending a remembered slug,
 * because TSH validates nothing about the url it accepts: a stale slug toasts
 * green and leaves an empty bracket, with no error anywhere. The configured
 * fallbackSlug is used only when the lookup itself can't run.
 *
 * No confirmation prompt, deliberately. Switching the tournament does not clear
 * the scoreboard — TSH wires tournament_changed only to its button-state
 * updaters, so the loaded set's names, scores and set_id all survive, and a
 * pending report still targets the right set. A misclick costs a bracket
 * re-pull, not operator work.
 */

const DEFAULTS = {
  shortLink: "",
  events: {
    singles: { match: ["singles"], fallbackSlug: "" },
    doubles: { match: ["doubles"], fallbackSlug: "" },
  },
};

/**
 * Fill every key from DEFAULTS.
 *
 * config.local.js is merged with a shallow Object.assign, so overriding
 * BRACKETS there replaces the whole object — a local override that sets only
 * shortLink would otherwise leave `events` undefined. Same discipline as
 * clipper-settings.js.
 *
 * @param {object} config
 * @returns {{ shortLink: string, events: Record<string, { match: string[], fallbackSlug: string }> }}
 */
function normalizeBrackets(config) {
  const raw = config?.BRACKETS ?? {};
  const events = {};
  for (const kind of new Set([...Object.keys(DEFAULTS.events), ...Object.keys(raw.events ?? {})])) {
    const spec = raw.events?.[kind] ?? {};
    const fallback = DEFAULTS.events[kind] ?? { match: [kind], fallbackSlug: "" };
    const match = Array.isArray(spec.match) && spec.match.length > 0 ? spec.match : fallback.match;
    events[kind] = {
      match: match.map((m) => String(m).toLowerCase()),
      fallbackSlug: String(spec.fallbackSlug ?? fallback.fallbackSlug ?? "").trim(),
    };
  }
  return { shortLink: String(raw.shortLink ?? DEFAULTS.shortLink).trim(), events };
}

/**
 * Reduce an event URL to the comparable "tournament/<t>/event/<e>" core.
 *
 * Handles every shape the two sides produce: TSH stores it scheme-less, start.gg
 * writes "/events/" plural in browser URLs, and either may carry a trailing
 * "/overview" or a query string.
 *
 * @param {string|null|undefined} url
 * @returns {string|null} — null when it isn't an event URL at all
 */
function normalizeEventUrl(url) {
  const m = String(url ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?start\.gg\//, "")
    .match(/tournament\/([^/?#]+)\/events?\/([^/?#]+)/);
  return m ? `tournament/${m[1]}/event/${m[2]}` : null;
}

/**
 * Do two URLs name the same event? A null on either side is "can't tell", which
 * must not read as a match — that would skip the switch entirely.
 * @param {string|null} a
 * @param {string|null} b
 * @returns {boolean}
 */
function sameEvent(a, b) {
  const na = normalizeEventUrl(a);
  const nb = normalizeEventUrl(b);
  return na !== null && na === nb;
}

/**
 * Pick the one event matching a kind's keywords.
 *
 * Every keyword must appear in the event's name + slug, and exactly one event
 * may match. Ambiguity is refused rather than guessed: TSH accepts any
 * well-formed event URL without checking it, so picking wrong silently puts the
 * wrong bracket on the broadcast and mis-targets every set id downstream —
 * including the one /api/report publishes against.
 *
 * @param {Array<{name: string, slug: string}>} events
 * @param {{ match: string[] }} spec
 * @param {string} [kind] — only used in the error text
 * @returns {{ ok: boolean, event?: object, error?: string }}
 */
function pickEvent(events, spec, kind = "matching") {
  const list = Array.isArray(events) ? events : [];
  const keywords = (spec?.match ?? []).map((m) => String(m).toLowerCase());

  const hits = list.filter((e) => {
    const hay = `${e?.name ?? ""} ${e?.slug ?? ""}`.toLowerCase();
    return keywords.length > 0 && keywords.every((k) => hay.includes(k));
  });

  if (hits.length === 1) return { ok: true, event: hits[0] };

  const names = list.map((e) => e?.name ?? e?.slug ?? "?").join(", ") || "none";
  if (hits.length === 0) {
    return { ok: false, error: `No ${kind} event on this tournament — found: ${names}. Adjust config.BRACKETS.events.${kind}.match.` };
  }
  return {
    ok: false,
    error: `"${kind}" matched ${hits.length} events (${hits.map((e) => e.name).join(", ")}) — refusing to guess. Narrow config.BRACKETS.events.${kind}.match.`,
  };
}

function createBracketSwitch(ctx, refreshControlStatus) {
  const { config, tsh, startgg } = ctx;
  const brackets = normalizeBrackets(config);

  /**
   * Turn a tournament slug into the event URL to hand TSH, verifying against
   * start.gg's real event list where possible and falling back to the configured
   * slug where it isn't. Every branch carries its own operator-facing wording.
   *
   * @param {string} tournamentSlug
   * @param {string} kind
   * @param {{ match: string[], fallbackSlug: string }} spec
   */
  async function resolveEvent(tournamentSlug, kind, spec) {
    const appended = () => ({
      url: `start.gg/tournament/${tournamentSlug}/event/${spec.fallbackSlug}`,
      eventName: spec.fallbackSlug,
      tournamentName: tournamentSlug,
    });

    // No token → nothing to look events up with. Fall back rather than lose the
    // buttons entirely, but say so.
    if (!startgg.enabled) {
      if (!spec.fallbackSlug) {
        return { ok: false, error: `No start.gg token, so the ${kind} event can't be looked up — set BRACKETS.events.${kind}.fallbackSlug, or add a token.` };
      }
      return { ok: true, ...appended(), warning: "No start.gg token — used the configured event slug without checking it exists." };
    }

    const list = await startgg.listEvents(tournamentSlug);
    if (!list.ok) {
      if (!spec.fallbackSlug) return list; // pass _gql's wording through untouched
      console.warn(`[bridge] Event lookup failed (${list.error}) — falling back to "${spec.fallbackSlug}"`);
      return { ok: true, ...appended(), warning: `Couldn't read ${tournamentSlug}'s events (${list.error}) — used the configured slug instead.` };
    }

    const hit = pickEvent(list.events, spec, kind);
    if (!hit.ok) return hit;

    // Scheme-less on purpose: byte-for-byte the form TSH stores, which is what
    // makes sameEvent() and TSH's own provider.url dedupe behave.
    return { ok: true, url: `start.gg/${hit.event.slug}`, eventName: hit.event.name, tournamentName: list.name };
  }

  // Rejected, not shared: this is 2–3 network hops, the panel can be open in an
  // OBS dock and on a phone at once, and a press on the *other* button must not
  // be answered with the first one's result. Distinct from the shared-promise
  // dedupe in control-status.js, where every caller wants the same answer.
  let inFlight = false;

  /**
   * Point TSH at this week's singles or doubles bracket.
   * @param {string} kind — "singles" | "doubles"
   * @returns {Promise<{ ok: boolean, url?: string, eventName?: string, tournamentName?: string, refreshed?: boolean, warning?: string, error?: string }>}
   */
  async function switchBracket(kind) {
    const spec = brackets.events[kind];
    if (!spec) {
      return { ok: false, error: `Unknown bracket "${kind}" — configured: ${Object.keys(brackets.events).join(", ")}` };
    }
    if (inFlight) {
      return { ok: false, error: "Still switching brackets — wait for that to finish" };
    }
    inFlight = true;

    try {
      const link = await startgg.resolveShortLink(brackets.shortLink);
      if (!link.ok) return link;

      const target = await resolveEvent(link.slug, kind, spec);
      if (!target.ok) return target;

      const { url, eventName, tournamentName, warning } = target;

      // Already loaded? /set-tournament would silently do nothing, so make the
      // second press mean "re-pull this bracket" instead of a dead button.
      if (sameEvent(tsh.readTournamentUrl(), url)) {
        const res = await tsh.updateBracket();
        if (!res.ok) return res;
        return { ok: true, refreshed: true, url, eventName, tournamentName, warning };
      }

      const res = await tsh.setTournament(url);
      if (!res.ok) return res;

      // TSH loads on its own thread pool, so this refresh will very likely still
      // show the old event — the 2s tick is what confirms the switch.
      refreshControlStatus().catch(() => {});
      return { ok: true, refreshed: false, url, eventName, tournamentName, warning };
    } finally {
      inFlight = false;
    }
  }

  return { switchBracket, shortLink: brackets.shortLink };
}

module.exports = { createBracketSwitch, pickEvent, sameEvent, normalizeEventUrl, normalizeBrackets };
