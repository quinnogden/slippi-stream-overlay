/**
 * event-target.js — which start.gg event the dock's Singles / Doubles buttons mean.
 *
 * Pure. Hundred Acres runs weekly and a stream alternates formats, so the event
 * is found rather than configured: config.BRACKETS.shortLink is the series'
 * stable short link (the TO re-points it at each week's tournament), and each
 * button's keywords pick one event out of that tournament's list.
 *
 * The event is looked up rather than assembled by appending a remembered slug,
 * because a renamed event under a stale slug loads as an empty bracket with no
 * error anywhere. The configured fallbackSlug is used only when the lookup
 * itself can't run.
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
 * Reduce an event URL or slug to the comparable "tournament/<t>/event/<e>" core.
 *
 * Handles every shape in circulation: start.gg's API slug, a pasted browser URL
 * with "/events/" plural, and either with a trailing "/overview" or a query
 * string.
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
 * may match. Ambiguity is refused rather than guessed: picking wrong silently
 * puts the wrong bracket on the broadcast and mis-targets every set id
 * downstream — including the one /api/report publishes against.
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

module.exports = { normalizeBrackets, normalizeEventUrl, sameEvent, pickEvent };
