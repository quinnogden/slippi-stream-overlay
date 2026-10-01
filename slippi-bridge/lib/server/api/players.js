/**
 * The player DB (local_players.json), for the dock's Players tab and the
 * casters' autocomplete: find a player, correct their prefix / pronoun /
 * twitter, pin the main shown when their sets load.
 *
 * A record is addressed by `ref` (its position, PlayerDb.refOf) plus its tag,
 * sent back together: the tag is the check that the ref still means the
 * player the dock showed.
 */

const { characterByName } = require("../../char_map");
const { characterList } = require("./scoreboard");

const FIELD_MAX = 40;
const LIST_ALL = 150; // an empty name field lists this many of the player list

const isSide = (v) => v === 0 || v === 1;
const isIndex = (v) => Number.isInteger(v) && v >= 0 && v < 4;

function bad(res, error, code = 400) {
  return res.status(code).json({ ok: false, error });
}

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, playerDb, event, iconsDir, refreshControlStatus, gameLive }
 */
function register(app, { store, playerDb, event = null, iconsDir, refreshControlStatus, gameLive = () => false }) {
  const characters = characterList(iconsDir);

  // describe() with each main as an icon-ready { codename, name, skin }.
  const entry = (rec, onAir) => {
    const d = playerDb.describe(rec);
    const ch = (m) => (m ? characterByName(m.name, m.skin) : null);
    return {
      ...d,
      main: ch(d.main),
      pinnedMain: ch(d.pinnedMain),
      learnedMains: d.learnedMains.map(ch).filter(Boolean),
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

  // The name fields' autocomplete, as TSH does it: while an event is loaded,
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
    const bySeed = (a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.tag.localeCompare(b.tag);
    const hits = q
      ? [...inEvent.filter((p) => tag(p).startsWith(q)).sort(bySeed),
        ...inEvent.filter((p) => !tag(p).startsWith(q) && (tag(p).includes(q) || full(p).includes(q))).sort(bySeed)]
      : [...inEvent].sort(bySeed);
    const players = hits.slice(0, q ? 12 : 64).map((p) => {
      const rec = playerDb.find(p);
      const d = rec ? playerDb.describe(rec) : null;
      const ch = (m) => (m ? characterByName(m.name, m.skin) : null);
      return {
        ref: d ? d.ref : null,
        tag: p.tag,
        prefix: p.prefix || (d ? d.prefix : ""),
        pronoun: d ? d.pronoun : "",
        startggPlayerId: p.playerId,
        main: d ? ch(d.main) : null,
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

    let fields;
    let rec;
    if (playerId != null) {
      const p = (eventPlayers() ?? []).find((x) => x.playerId === String(playerId));
      if (!p) return bad(res, "That player isn't in the loaded event — search again", 404);
      rec = playerDb.upsert({ playerId: p.playerId, tag: p.tag, prefix: p.prefix });
      fields = { tag: p.tag, prefix: p.prefix || rec?.prefix || "", pronoun: rec?.pronoun ?? "", playerId: p.playerId };
    } else {
      rec = recordFor(req.body, res);
      if (!rec) return;
      const d = playerDb.describe(rec);
      fields = { tag: d.tag, prefix: d.prefix, pronoun: d.pronoun, playerId: d.startggPlayerId };
    }
    const m = rec ? playerDb.preferredMain(rec) : null;
    const main = m ? characterByName(m.name, m.skin) : null;
    if (main) fields.main = main;
    store.setPlayer(side, index, fields);
    if (main && !gameLive()) store.setCharacter(side, index, main);
    refreshControlStatus();
    res.json({ ok: true, tag: fields.tag });
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

  // { ref, tag, codename, skin } pins the main shown on set load (it beats
  // what Slippi has taught); { ref, tag, codename: null } unpins.
  app.post("/api/players/pin", (req, res) => {
    const rec = recordFor(req.body, res);
    if (!rec) return;
    const { codename, skin = 0 } = req.body;
    if (codename == null) {
      playerDb.pinMain(rec, null);
    } else {
      const ch = characters.find((c) => c.codename === codename);
      if (!ch) return bad(res, `unknown character ${codename}`);
      if (!Number.isInteger(skin) || skin < 0 || skin >= Math.max(1, ch.skins)) {
        return bad(res, `${ch.name} has costumes 0-${Math.max(1, ch.skins) - 1}`);
      }
      playerDb.pinMain(rec, { name: ch.name, skin });
    }
    res.json({ ok: true, player: entry(rec, onAirRecords()) });
  });
}

module.exports = { register };
