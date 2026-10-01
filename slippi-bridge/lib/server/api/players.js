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

function bad(res, error, code = 400) {
  return res.status(code).json({ ok: false, error });
}

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, playerDb, iconsDir, refreshControlStatus }
 */
function register(app, { store, playerDb, iconsDir, refreshControlStatus }) {
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
