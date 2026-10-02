/**
 * The scoreboard's commands, for the dock's live strip: score, names,
 * characters, set text, sides and ports, and the two start.gg actions on the
 * loaded set (start, report).
 *
 * Every write goes through a store command, so the overlays and the dock see
 * it as one state patch — none of these routes answer with the new scoreboard,
 * the patch is the answer.
 */

const fs   = require("fs");
const path = require("path");
const { CHAR_MAP, CSS_ORDER } = require("../../char_map");
const { TEAM_COLORS } = require("../../modes/doubles");

/** 400 with a message, for a body the dock should never have sent. */
function bad(res, error) {
  return res.status(400).json({ ok: false, error });
}

const isSide = (v) => v === 0 || v === 1;
const isIndex = (v) => Number.isInteger(v) && v >= 0 && v < 4;

/** The same name, give or take capitalisation and spaces at the ends. */
const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * The picker's characters in Melee's character-select order, each with how
 * many costumes have an icon. Counted once from the icons folder — the icons
 * are committed, and a costume with no icon would be a blank tile.
 * @param {string} iconsDir
 */
function characterList(iconsDir) {
  let files = [];
  try { files = fs.readdirSync(iconsDir); } catch { /* no icons: every count is 0 */ }
  return CSS_ORDER.map((id) => {
    const { codename, display } = CHAR_MAP[id];
    const re = new RegExp(`^chara_2_${codename}_(\\d\\d)\\.png$`);
    const skins = files.filter((f) => re.test(f)).length;
    return { id, codename, name: display, skins };
  });
}

/**
 * @param {import("express").Express} app
 * @param {object} deps — { store, iconsDir, refreshControlStatus, swapPorts,
 *   switchSides, reresolvePorts, reportCurrentSet, startCurrentSet }
 */
function register(app, deps) {
  const {
    store, iconsDir, refreshControlStatus, swapPorts, switchSides, reresolvePorts,
    reportCurrentSet, startCurrentSet,
  } = deps;

  const characters = characterList(iconsDir);

  app.get("/api/characters", (req, res) => {
    res.json({ ok: true, characters });
  });

  // { side, delta: 1 | -1 } adds or removes a game; { side, score } sets it outright.
  app.post("/api/score", (req, res) => {
    const { side, delta, score } = req.body ?? {};
    if (!isSide(side)) return bad(res, "side must be 0 or 1");
    if (delta === 1 || delta === -1) store.bump(side, delta);
    else if (Number.isInteger(score) && score >= 0 && score <= 9) store.setScore(side, score);
    else return bad(res, "send delta (1 or -1) or score (0-9)");
    refreshControlStatus();
    res.json({ ok: true });
  });

  // A player's displayed name fields: { side, index, tag?, prefix?, pronoun? }.
  //
  // A changed tag or prefix means the scoreboard isn't the start.gg set any
  // more, so it's unlinked from it (store.detachSet: no report, no seed, no
  // team name hiding the new tags). A changed tag is also a different person,
  // so the start.gg player id goes too — the side panel can't show the old
  // player's stats under the new name. Capitalisation alone is a correction,
  // not a change. `detached` says it happened.
  app.post("/api/player", (req, res) => {
    const { side, index = 0, ...rest } = req.body ?? {};
    if (!isSide(side) || !isIndex(index)) return bad(res, "side (0|1) and index (0-3) required");
    const fields = {};
    for (const k of ["tag", "prefix", "pronoun"]) {
      if (rest[k] === undefined) continue;
      if (typeof rest[k] !== "string") return bad(res, `${k} must be a string`);
      fields[k] = rest[k].trim().slice(0, 40);
    }
    const before = store.scoreboard().sides[side].players[index] ?? {};
    const changed = (k) => fields[k] !== undefined && !sameName(fields[k], before[k]);
    if (changed("tag")) fields.playerId = null;
    const detached = (changed("tag") || changed("prefix")) && store.detachSet();
    store.setPlayer(side, index, fields);
    refreshControlStatus();
    res.json({ ok: true, detached });
  });

  // The character shown for a player: { side, index, codename, skin } or
  // { side, index, codename: null } to show none.
  //
  // Also recorded as the player's `main` for this set: the operator is saying
  // what the player is on, and the port map matches the next game's Slippi
  // characters against exactly that until a game has been played.
  app.post("/api/character", (req, res) => {
    const { side, index = 0, codename, skin = 0 } = req.body ?? {};
    if (!isSide(side) || !isIndex(index)) return bad(res, "side (0|1) and index (0-3) required");
    if (codename == null) {
      store.setCharacter(side, index, null);
      return res.json({ ok: true });
    }
    const ch = characters.find((c) => c.codename === codename);
    if (!ch) return bad(res, `unknown character ${codename}`);
    if (!Number.isInteger(skin) || skin < 0 || skin >= Math.max(1, ch.skins)) {
      return bad(res, `${ch.name} has costumes 0-${Math.max(1, ch.skins) - 1}`);
    }
    const character = { codename: ch.codename, name: ch.name, skin };
    store.setCharacter(side, index, character);
    store.setPlayer(side, index, { main: character });
    res.json({ ok: true });
  });

  // Overrides for the derived set text: { round?, bestOf?, losers?: [bool|null, bool|null] }.
  // null clears an override (back to start.gg's round, the Flex/Bo5 rule, the GF [L]).
  // bestOf "None" shows no best-of at all (set-text.js NO_BEST_OF).
  app.post("/api/set-text", (req, res) => {
    const { round, bestOf, losers } = req.body ?? {};
    for (const [k, v] of [["round", round], ["bestOf", bestOf]]) {
      if (v !== undefined && v !== null && typeof v !== "string") return bad(res, `${k} must be a string or null`);
    }
    if (losers !== undefined && (!Array.isArray(losers) || losers.length !== 2
        || losers.some((l) => l !== null && typeof l !== "boolean"))) {
      return bad(res, "losers must be [bool|null, bool|null]");
    }
    store.setOverrides({
      round: typeof round === "string" ? round.trim().slice(0, 60) : round,
      bestOf: typeof bestOf === "string" ? bestOf.trim().slice(0, 12) : bestOf,
      losers,
    });
    res.json({ ok: true });
  });

  // Back to 0–0 on the set that's loaded (Ctrl+Shift+0 does the same).
  app.post("/api/clear-score", (req, res) => {
    store.clearScore();
    refreshControlStatus();
    res.json({ ok: true });
  });

  // Singles or doubles by hand: { on: boolean }. A doubles game with no
  // start.gg set loaded turns it on by itself.
  app.post("/api/doubles", (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return bad(res, "on must be true or false");
    store.setDoubles(on);
    refreshControlStatus();
    res.json({ ok: true, doubles: on });
  });

  // A doubles side's team colour, as TSH's colour picker: { side, color:
  // "red" | "blue" | "green" | null }. The next doubles game start sets it
  // again from Slippi's teams.
  app.post("/api/side-color", (req, res) => {
    const { side, color } = req.body ?? {};
    if (!isSide(side)) return bad(res, "side must be 0 or 1");
    if (color !== null && !Object.hasOwn(TEAM_COLORS, color)) {
      return bad(res, `color must be one of ${Object.keys(TEAM_COLORS).join(", ")}, or null`);
    }
    store.setSideColor(side, color === null ? null : TEAM_COLORS[color]);
    res.json({ ok: true });
  });

  // An empty scoreboard, for a set that isn't on start.gg (friendlies, an
  // exhibition): the names are then typed into the live strip.
  app.post("/api/clear-set", (req, res) => {
    store.clearSet();
    refreshControlStatus();
    res.json({ ok: true });
  });

  // The ports are the wrong way round: flip which side each port plays for.
  // The scoreboard stays put (same as Ctrl+Shift+S).
  app.post("/api/swap", (req, res) => {
    const result = swapPorts();
    refreshControlStatus();
    res.json(result);
  });

  // Throw away the port map and re-derive it from the players' mains.
  app.post("/api/reresolve", (req, res) => {
    const result = reresolvePorts();
    refreshControlStatus();
    res.json(result);
  });

  // The two sides trade columns on the scoreboard — names, scores, entrant ids
  // and the per-game list together (store.switchSides). The port map follows.
  app.post("/api/swap-sides", (req, res) => {
    switchSides();
    refreshControlStatus();
    res.json({ ok: true });
  });

  // start.gg's "Start match" for the loaded set. No body: the set is whatever
  // the scoreboard has loaded, which is what the dock is showing.
  app.post("/api/start-set", async (req, res) => {
    res.json(await startCurrentSet());
  });

  app.post("/api/report", async (req, res) => {
    res.json(await reportCurrentSet());
  });
}

module.exports = { register, characterList, sameName };
