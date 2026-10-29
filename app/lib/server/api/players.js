/**
 * The player DB (local_players.json), for the dock's Players tab and the
 * casters' autocomplete: find a player, correct their prefix / pronoun /
 * twitter, set the main their sets open on until Slippi learns one — one at a
 * time, or down the loaded event's roster before anyone is on stream.
 *
 * A record is addressed by `ref` (its position, PlayerDb.refOf) plus its tag,
 * sent back together: the tag is the check that the ref still means the
 * player the dock showed.
 */

const { characterByName } = require("../../char_map");
const { characterList, pickCharacter, sameName, bad, isSide, isIndex, CREW_SIDES } = require("./scoreboard");

const FIELD_MAX = 40;
const LIST_ALL = 150; // an empty name field lists this many of the player list
const NOT_ENTRANT = "That player isn't in the loaded event — search again";

/** A DB main ({ name, skin }) as an icon-ready { codename, name, skin }. */
const asCharacter = (m) => (m ? characterByName(m.name, m.skin) : null);

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, playerDb, event, iconsDir, refreshControlStatus, gameLive }
 */
function register(app, { store, playerDb, event = null, iconsDir, refreshControlStatus, gameLive = () => false }) {
  const characters = characterList(iconsDir);

  // describe() with each main as an icon-ready { codename, name, skin }.
  const entry = (rec, onAir) => {
    const d = playerDb.describe(rec);
    return {
      ...d,
      main: asCharacter(d.main),
      learnedMains: d.learnedMains.map(asCharacter).filter(Boolean),
      onAir: onAir.has(rec),
    };
  };

  /** The scoreboard's players' records, by start.gg id or tag. */
  function onAirRecords() {
    const out = new Set();
    for (const side of store.scoreboard().sides) {
      for (const p of side.players) {
        if (!p.tag && p.playerId == null) continue;
        const rec = playerDb.find({ playerId: p.playerId, tag: p.tag, prefix: p.prefix });
        if (rec) out.add(rec);
      }
    }
    return out;
  }

  /** The record for { ref, tag }, or a 404/409 already sent. */
  function recordFor(body, res) {
    const rec = playerDb.at(body?.ref);
    if (!rec) { bad(res, "No such player — search again", 404); return null; }
    if (String(rec.gamerTag ?? "") !== String(body?.tag ?? "")) {
      bad(res, "The player list changed since that search — search again", 409);
      return null;
    }
    return rec;
  }

  // ?q= searches by tag; no q = the players on the scoreboard now.
  app.get("/api/players", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const onAir = onAirRecords();
    const recs = q ? playerDb.search(q) : [...onAir];
    res.json({ ok: true, total: playerDb.size, file: playerDb.file, players: recs.map((r) => entry(r, onAir)) });
  });

  // The list's prefixes and pronouns, most used first: the dock's suggestions.
  app.get("/api/players/values", (req, res) => {
    res.json({ ok: true, ...playerDb.values() });
  });

  /** The loaded event's players, or null with no event (or none read yet). */
  function eventPlayers() {
    if (!event || !store.tournament()?.eventSlug) return null;
    const list = event.players();
    return list.length ? list : null;
  }

  const bySeed = (a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.tag.localeCompare(b.tag);

  /** The loaded event's entrant with this start.gg player id, or null. */
  const entrant = (playerId) => (eventPlayers() ?? []).find((x) => x.playerId === String(playerId)) ?? null;

  // The loaded event's players by seed, each with the main their sets open
  // on: the Players tab's roster, for pinning mains before anyone is on
  // stream. An entrant the player list doesn't have yet has ref null — setting
  // a main by start.gg id adds them, as their first set load would. One with
  // no start.gg id is matched by tag, so its tag is the record's (the check).
  app.get("/api/players/event", (req, res) => {
    const t = store.tournament();
    const inEvent = eventPlayers();
    if (!inEvent) return res.json({ ok: true, event: t?.eventSlug ? t.eventName : null, players: [] });
    const onAir = onAirRecords();
    const players = [...inEvent].sort(bySeed).map((p) => {
      const rec = playerDb.find(p);
      const d = rec ? entry(rec, onAir) : null;
      return {
        ref: d ? d.ref : null,
        tag: d && p.playerId == null ? d.tag : p.tag,
        prefix: p.prefix || (d ? d.prefix : ""),
        pronoun: d ? d.pronoun : "",
        startggPlayerId: p.playerId,
        main: d ? d.main : null,
        learnedMains: d ? d.learnedMains : [],
        onAir: d ? d.onAir : false,
        team: p.team,
        seed: p.seed,
      };
    });
    res.json({ ok: true, event: t.eventName, players });
  });

  // The name fields' autocomplete: while an event is loaded,
  // only its entrants (with pronoun and main from the player list); with
  // none, or with ?scope=list (the casters, who aren't entrants), the whole
  // player list. ?q= matches tag or "prefix tag", tags starting with it
  // first. An empty q — the field was just clicked — lists the event's
  // entrants by seed, or the player list A–Z (the first LIST_ALL; `total`
  // says how many there are, so the dock can say to type for the rest).
  app.get("/api/players/suggest", (req, res) => {
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const inEvent = req.query.scope === "list" ? null : eventPlayers();
    if (!inEvent) {
      const onAir = onAirRecords();
      const all = q ? null : playerDb.byTag();
      const recs = q ? playerDb.search(q, 12) : all.slice(0, LIST_ALL);
      const players = recs.map((r) => ({ ...entry(r, onAir), team: "", seed: null }));
      return res.json({ ok: true, scope: "list", total: all ? all.length : players.length, players });
    }
    const tag = (p) => p.tag.toLowerCase();
    const full = (p) => `${p.prefix} ${p.tag}`.trim().toLowerCase();
    const hits = q
      ? [...inEvent.filter((p) => tag(p).startsWith(q)).sort(bySeed),
        ...inEvent.filter((p) => !tag(p).startsWith(q) && (tag(p).includes(q) || full(p).includes(q))).sort(bySeed)]
      : [...inEvent].sort(bySeed);
    const players = hits.slice(0, q ? 12 : 64).map((p) => {
      const rec = playerDb.find(p);
      const d = rec ? playerDb.describe(rec) : null;
      return {
        ref: d ? d.ref : null,
        tag: p.tag,
        prefix: p.prefix || (d ? d.prefix : ""),
        pronoun: d ? d.pronoun : "",
        startggPlayerId: p.playerId,
        main: d ? asCharacter(d.main) : null,
        team: p.team,
        seed: p.seed,
      };
    });
    res.json({ ok: true, scope: "event", total: hits.length, players });
  });

  // Puts a suggested player on the scoreboard in one slot, like a set load
  // does: name, prefix, pronoun, start.gg id and their main.
  //   { side, index, playerId }  an entrant of the loaded event (added to the
  //                              player list if new, as a set load would)
  //   { side, index, ref, tag }  a player-list record
  // The start.gg id is set to the record's, null included, so the side panel
  // can't show the previous player's record under this name. The main is
  // also shown as the character unless a game is running, where Slippi's is
  // the true one; a player with no main keeps the character already shown.
  app.post("/api/players/assign", (req, res) => {
    const { side, index = 0, playerId } = req.body ?? {};
    if (!isSide(side) || !isIndex(index)) return bad(res, "side (0|1) and index (0-3) required");
    if (store.isCrew()) return bad(res, CREW_SIDES, 409);

    let fields;
    let rec;
    if (playerId != null) {
      const p = entrant(playerId);
      if (!p) return bad(res, NOT_ENTRANT, 404);
      rec = playerDb.upsert({ playerId: p.playerId, tag: p.tag, prefix: p.prefix });
      fields = { tag: p.tag, prefix: p.prefix || rec?.prefix || "", pronoun: rec?.pronoun ?? "", playerId: p.playerId };
    } else {
      rec = recordFor(req.body, res);
      if (!rec) return;
      const d = playerDb.describe(rec);
      fields = { tag: d.tag, prefix: d.prefix, pronoun: d.pronoun, playerId: d.startggPlayerId };
    }
    const main = rec ? asCharacter(playerDb.preferredMain(rec)) : null;
    if (main) fields.main = main;
    // Someone else in the slot: the scoreboard isn't the start.gg set any more
    // (as a typed name, /api/player). The same player picked again changes nothing.
    const before = store.scoreboard().sides[side].players[index] ?? {};
    const other = (before.playerId ?? null) !== (fields.playerId ?? null) || !sameName(before.tag, fields.tag)
      || !sameName(before.prefix, fields.prefix);
    const detached = other && store.detachSet();
    store.setPlayer(side, index, fields);
    if (main && !gameLive()) store.setCharacter(side, index, main);
    refreshControlStatus();
    res.json({ ok: true, tag: fields.tag, detached });
  });

  // { ref, tag, prefix?, pronoun?, twitter? }. A player on the scoreboard
  // shows the change at once — that's usually why it's being made.
  app.post("/api/players/update", (req, res) => {
    const rec = recordFor(req.body, res);
    if (!rec) return;
    const fields = {};
    for (const k of ["prefix", "pronoun", "twitter"]) {
      const v = req.body[k];
      if (v === undefined) continue;
      if (typeof v !== "string") return bad(res, `${k} must be a string`);
      fields[k] = v.trim().slice(0, FIELD_MAX);
    }
    playerDb.update(rec, fields);

    const shown = {};
    if (fields.prefix !== undefined) shown.prefix = fields.prefix;
    if (fields.pronoun !== undefined) shown.pronoun = fields.pronoun;
    if (Object.keys(shown).length) {
      store.scoreboard().sides.forEach((side, i) => side.players.forEach((p, n) => {
        if (playerDb.find({ playerId: p.playerId, tag: p.tag, prefix: p.prefix }) === rec) store.setPlayer(i, n, shown);
      }));
      refreshControlStatus();
    }
    res.json({ ok: true, player: entry(rec, onAirRecords()) });
  });

  // { ref, tag, codename, skin } sets the main a player's sets open on — the
  // first of their stored mains, which what Slippi learns beats. The roster
  // sends { playerId } (an entrant of the loaded event) for { ref, tag },
  // adding them to the player list if they're new.
  app.post("/api/players/main", (req, res) => {
    const { codename, skin = 0 } = req.body ?? {};
    const { ch, error } = pickCharacter(characters, codename, skin);
    if (error) return bad(res, error);
    let rec;
    if (req.body.playerId != null) {
      const p = entrant(req.body.playerId);
      if (!p) return bad(res, NOT_ENTRANT, 404);
      rec = playerDb.upsert({ playerId: p.playerId, tag: p.tag, prefix: p.prefix });
    } else {
      rec = recordFor(req.body, res);
    }
    if (!rec) return;
    playerDb.setMain(rec, { name: ch.name, skin });
    res.json({ ok: true, player: entry(rec, onAirRecords()) });
  });
}

module.exports = { register, asCharacter };
