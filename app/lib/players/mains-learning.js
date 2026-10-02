/**
 * Mains learning — what each player actually played, from Slippi, into the
 * player DB, so the next set they're in opens on the right character and the
 * port map has something to match game 1 against.
 *
 * The set's game list is the buffer. Each recorded game carries the
 * characters each side played, attributed with the port map *at game end*
 * (game-end.js), and Switch Sides moves them with the sides — so by the end of
 * the set the list already reflects every correction made during it. Nothing
 * is learned per game: a mapping fixed in game 2 would otherwise leave game 1's
 * guess in the DB.
 *
 * Committed once the set is over: when it's reported, and when it leaves the
 * scoreboard (another set loaded, or cleared). Committing the same set twice
 * is skipped, so report-then-load learns once.
 *
 * What is never learned:
 *   - handwarmers (game-end.js doesn't record them) and manual games (± or a
 *     score carried in on load: no characters);
 *   - doubles — which player of a side a port is falls back to port order, and
 *     a wrong guess would teach one player their partner's character;
 *   - a typed name with no DB record: a manual set's names aren't start.gg's,
 *     and a typo shouldn't become a player.
 *
 * A pinned main (the dock's Players tab) still wins on load; learning only
 * reorders `learnedMains`.
 */

/**
 * Each singles side's characters this set, ordered so that learning them in
 * turn leaves the most-played first (ties: the one played last).
 * @param {object} sb — store.scoreboard()
 * @returns {Array<{ side: 0|1, player: object, chars: Array<{ name: string, skin: number }> }>}
 */
function mainsPlayed(sb) {
  if (!sb) return [];
  const out = [];
  sb.sides.forEach((side, i) => {
    if (side.players.length !== 1) return; // doubles: which teammate a port is can be a guess
    const seen = new Map(); // name → { name, skin, count, last }
    sb.games.forEach((g, n) => {
      const c = !g.manual && g.characters?.[i]?.[0];
      if (!c?.name) return;
      const e = seen.get(c.name) ?? { name: c.name, skin: 0, count: 0, last: -1 };
      e.count++;
      e.last = n;
      e.skin = Number(c.skin) || 0;
      seen.set(c.name, e);
    });
    if (!seen.size) return;
    const chars = [...seen.values()]
      .sort((a, b) => a.count - b.count || a.last - b.last)
      .map(({ name, skin }) => ({ name, skin }));
    out.push({ side: i, player: side.players[0], chars });
  });
  return out;
}

/**
 * @param {{ store: import("../scoreboard/store").ScoreboardStore,
 *           playerDb: import("./player-db").PlayerDb,
 *           log?: (msg: string) => void }} deps
 */
function createMainsLearning({ store, playerDb, log = (m) => console.log(`[players] ${m}`) }) {
  let lastKey = null;

  /**
   * Learn from a finished set.
   * @param {object} [sb] — the set; default the one on the scoreboard now
   * @param {string} [why] — for the log
   * @returns {Array<{ tag: string, mains: string[] }>} what was learned
   */
  function commit(sb = store.scoreboard(), why = "set over") {
    const played = mainsPlayed(sb);
    if (!played.length) return [];
    const key = JSON.stringify([sb.setId, played.map((p) => [p.player.playerId, p.player.tag, p.chars])]);
    if (key === lastKey) return [];
    lastKey = key;

    const learned = [];
    for (const { player, chars } of played) {
      const who = { playerId: player.playerId, tag: player.tag, prefix: player.prefix };
      // A start.gg player is upserted (they have an id to key on); a typed
      // name is only matched.
      const rec = player.playerId != null ? playerDb.upsert(who) : playerDb.find(who);
      if (!rec) continue;
      for (const c of chars) playerDb.learnMain(rec, c);
      learned.push({ tag: player.tag, mains: [...chars].reverse().map((c) => c.name) });
    }
    if (learned.length) log(`Learned mains (${why}): ${learned.map((l) => `${l.tag} → ${l.mains.join(", ")}`).join("; ")}`);
    return learned;
  }

  // The outgoing set, handed over just before another replaces it.
  store.on("set-closing", (sb) => commit(sb, "set replaced"));

  return { commit };
}

module.exports = { createMainsLearning, mainsPlayed };
