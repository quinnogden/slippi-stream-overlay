/**
 * Crew battles (lib/crew/), for the dock's Crew tab: starting and ending one,
 * sending players in, stock corrections and live roster edits — and the saved
 * crews the tab loads rosters from.
 *
 * As with the scoreboard's routes, nothing answers with the new state: the
 * store's patch is the answer. A refusal from the rules (a player who is out,
 * a played member taken off the roster) is a 409 with the reason, for the dock
 * to show.
 */

const Crew = require("../../crew/crew-model");
const { bad, isSide, sameName } = require("./scoreboard");
const { asCharacter } = require("./players");

const FIELD_MAX = 40;
const NO_CREW = "No crew battle on the scoreboard";
const NO_SAVED = "Saved crews aren't available";

const text = (v) => (typeof v === "string" ? v.trim().slice(0, FIELD_MAX) : "");

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, playerDb, savedCrews?, refreshControlStatus, gameLive }
 */
function register(app, { store, playerDb, savedCrews = null, refreshControlStatus, gameLive = () => false }) {
  /**
   * A member as the dock sent it — { id?, tag, prefix?, pronoun?, ref? } — with
   * what the player DB knows filled in: a blank prefix or pronoun, and their
   * main. The record is the one the dock picked (`ref`, while its tag still
   * matches), else a lookup by name; a typed name with no record is still a
   * member, just with no main.
   * @returns {{ member: object } | { error: string }}
   */
  function memberFrom(m) {
    if (!m || typeof m !== "object") return { error: "a member must be an object" };
    if (m.id != null && !Number.isInteger(m.id)) return { error: "a member's id must be a whole number" };
    const tag = text(m.tag);
    const prefix = text(m.prefix);
    const picked = m.ref != null ? playerDb.at(m.ref) : null;
    const rec = (picked && sameName(picked.gamerTag, tag) ? picked : null) ?? (tag ? playerDb.find({ tag, prefix }) : null);
    const d = rec ? playerDb.describe(rec) : null;
    const member = { tag, prefix: prefix || d?.prefix || "", pronoun: text(m.pronoun) || d?.pronoun || "" };
    if (m.id != null) member.id = m.id;
    // Left out with no record, so an edited member keeps the main they had.
    if (d) member.main = asCharacter(d.main);
    return { member };
  }

  /** @returns {{ team: { name: string, members: object[] } } | { error: string }} */
  function teamFrom(t) {
    if (!t || typeof t !== "object" || !Array.isArray(t.members)) return { error: "each crew needs a name and a list of members" };
    const members = [];
    for (const m of t.members) {
      const r = memberFrom(m);
      if (r.error) return r;
      members.push(r.member);
    }
    const team = { name: text(t.name), members };
    const error = Crew.teamError(team);
    return error ? { error } : { team };
  }

  /** A store command's { ok, error }, as the response. */
  function answer(res, r) {
    if (!r.ok) return bad(res, r.error, 409);
    refreshControlStatus();
    res.json({ ok: true });
  }

  // { stocksEach?: 1-9, teams: [{ name, members: [member…] }, { … }] } — teams[0]
  // is the left column. Replaces whatever is on the scoreboard (the dock asks
  // first when that's a set with games).
  app.post("/api/crew/start", (req, res) => {
    const { teams, stocksEach = Crew.DEFAULT_STOCKS } = req.body ?? {};
    if (Crew.stocksOf(stocksEach) == null) return bad(res, `stocks each must be a whole number from 1 to ${Crew.MAX_STOCKS}`);
    if (!Array.isArray(teams) || teams.length !== 2) return bad(res, "send two crews");
    const parsed = [];
    for (const t of teams) {
      const r = teamFrom(t);
      if (r.error) return bad(res, r.error);
      parsed.push(r.team);
    }
    store.startCrew({ teams: parsed, stocksEach });
    refreshControlStatus();
    res.json({ ok: true });
  });

  // The battle off the scoreboard, leaving it blank.
  app.post("/api/crew/end", (req, res) => {
    if (!store.isCrew()) return bad(res, NO_CREW, 409);
    store.clearSet();
    refreshControlStatus();
    res.json({ ok: true });
  });

  // Send a member in: { side, id }, or { side, id: null } for nobody. Mid-game
  // the side keeps Slippi's character rather than the member's last one.
  app.post("/api/crew/pick", (req, res) => {
    const { side, id } = req.body ?? {};
    if (!isSide(side) || !(id === null || Number.isInteger(id))) return bad(res, "side (0|1) and id (a member's, or null) required");
    answer(res, store.crewPick(side, id, { keepCharacter: gameLive() }));
  });

  // ± one stock for any member: { side, id, delta: 1 | -1 }.
  app.post("/api/crew/stock", (req, res) => {
    const { side, id, delta } = req.body ?? {};
    if (!isSide(side) || !Number.isInteger(id) || (delta !== 1 && delta !== -1)) {
      return bad(res, "side (0|1), id and delta (1 or -1) required");
    }
    answer(res, store.crewStock(side, id, delta));
  });

  // A live roster edit: { side, name, members: [member…] } in the new order.
  // A member with an id keeps their stocks; one without is new.
  app.post("/api/crew/roster", (req, res) => {
    const { side, name, members } = req.body ?? {};
    if (!isSide(side)) return bad(res, "side must be 0 or 1");
    const r = teamFrom({ name, members });
    if (r.error) return bad(res, r.error);
    answer(res, store.crewRoster(side, r.team));
  });

  // The saved crews, A–Z. Saving and deleting answer with the new list.
  app.get("/api/crews", (req, res) => {
    if (!savedCrews) return bad(res, NO_SAVED, 503);
    res.json({ ok: true, crews: savedCrews.list() });
  });

  // { name, members: [{ tag, prefix?, pronoun? }] } — replaces a crew of the same name.
  app.post("/api/crews/save", (req, res) => {
    if (!savedCrews) return bad(res, NO_SAVED, 503);
    const r = savedCrews.save({ name: req.body?.name, members: req.body?.members });
    if (!r.ok) return bad(res, r.error);
    res.json({ ok: true, replaced: r.replaced, crews: savedCrews.list() });
  });

  // { name }
  app.post("/api/crews/delete", (req, res) => {
    if (!savedCrews) return bad(res, NO_SAVED, 503);
    const name = text(req.body?.name);
    if (!name) return bad(res, "name required");
    const r = savedCrews.remove(name);
    if (!r.ok) return bad(res, r.error, 500);
    res.json({ ok: true, removed: r.removed, crews: savedCrews.list() });
  });
}

module.exports = { register };
