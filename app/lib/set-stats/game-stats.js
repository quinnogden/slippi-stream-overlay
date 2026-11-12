/**
 * game-stats.js — one singles game's numbers, per port, from its .slp.
 *
 * Read with slippi-js's own stats (the same ones slippi-set-stats prints), plus
 * what those don't say directly: the biggest punish, the longest combo, the
 * percents each kill came at, self-destructs, and how far behind the winner
 * ever was. Runs in the stats worker (worker.js) — a parse is ~0.5s, too long
 * to hold the app's event loop.
 *
 * Gotchas this file relies on (CLAUDE.md):
 *   - a conversion's `playerIndex` is the player who was HIT; the attacker is
 *     `lastHitBy`;
 *   - stocks left come from the last frame, not `stats.stocks` alone.
 *
 * A game is per port, never per side: which side a port played for is the
 * scoreboard's (the game's `replay.players`), and Switch Sides moves it.
 */

const { funStats } = require("./fun-stats");

/** Frames before Slippi's frame 0 (the countdown). */
const FIRST_FRAME = -123;
/** A kill's conversion ends within this many frames of the stock it took. */
const KILL_WINDOW = 12;

const ratio = (r) => (r && Number.isFinite(r.ratio) ? r.ratio : null);
const round = (v, dp = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const max = (list) => (list.length ? Math.max(...list) : null);
const min = (list) => (list.length ? Math.min(...list) : null);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

/** A conversion's damage: where it ended (or got to, if the game ended mid-way) minus where it started. */
const convDamage = (c) => (c.endPercent ?? c.currentPercent ?? c.startPercent) - c.startPercent;

/**
 * @param {string} file
 * @returns {{ ok: true, players: object, stageId: number|null, lastFrame: number|null, seconds: number|null,
 *             winnerPort: number|null, endMethod: number|null, complete: boolean }
 *          | { ok: false, error: string }}
 */
function readGameStats(file) {
  const { SlippiGame } = require("@slippi/slippi-js");
  const game = new SlippiGame(file);
  const settings = game.getSettings();
  const players = (settings?.players ?? []).filter((p) => p && p.characterId != null);
  if (players.length !== 2) return { ok: false, error: players.length ? "not a singles game" : "no players in the file" };
  const raw = game.getStats();
  if (!raw) return { ok: false, error: "no stats in the file" };
  // A file read very early can be missing a list: an empty one reads as "nothing happened yet".
  const stats = { ...raw };
  for (const k of ["stocks", "conversions", "combos", "overall", "actionCounts"]) if (!Array.isArray(stats[k])) stats[k] = [];
  const end = game.getGameEnd();
  const latest = game.getLatestFrame();
  const lastFrame = stats.lastFrame ?? latest?.frame ?? null;

  const ports = players.map((p) => p.playerIndex);
  const lostStocks = (port) => stats.stocks.filter((s) => s.playerIndex === port && s.endFrame != null);
  const killedBy = (stock, attacker) => stats.conversions.some((c) =>
    c.playerIndex === stock.playerIndex && c.lastHitBy === attacker && c.didKill
    && c.endFrame != null && Math.abs(c.endFrame - stock.endFrame) <= KILL_WINDOW);

  // The stock count over the game, for the biggest deficit each player came back from.
  const startStocks = Object.fromEntries(players.map((p) => [p.playerIndex, p.startStocks || 4]));
  const left = { ...startStocks };
  const deficit = Object.fromEntries(ports.map((p) => [p, 0]));
  for (const s of stats.stocks.filter((x) => x.endFrame != null).sort((a, b) => a.endFrame - b.endFrame)) {
    left[s.playerIndex]--;
    for (const p of ports) {
      const o = ports.find((x) => x !== p);
      deficit[p] = Math.max(deficit[p], left[o] - left[p]);
    }
  }
  const firstLoss = stats.stocks.filter((x) => x.endFrame != null).sort((a, b) => a.endFrame - b.endFrame)[0];

  const out = {};
  for (const p of players) {
    const me = p.playerIndex;
    const opp = ports.find((x) => x !== me);
    const ov = stats.overall.find((x) => x.playerIndex === me) ?? {};
    const ac = stats.actionCounts.find((x) => x.playerIndex === me) ?? {};
    const mine = stats.conversions.filter((c) => c.lastHitBy === me && c.playerIndex === opp);
    const combos = stats.combos.filter((c) => c.lastHitBy === me && c.playerIndex === opp);
    const kills = lostStocks(opp).filter((s) => killedBy(s, me)).map((s) => s.endPercent ?? s.currentPercent).filter(Number.isFinite);
    const sds = lostStocks(me).filter((s) => !killedBy(s, opp)).length;
    const lc = ac.lCancelCount ?? {};
    const lcTries = (lc.success ?? 0) + (lc.fail ?? 0);
    const techs = ac.groundTechCount ?? {};
    const stocksLeft = latest?.players?.[me]?.post?.stocksRemaining;
    out[me] = {
      port: me,
      characterId: p.characterId,
      costume: p.characterColor ?? 0,
      kills: ov.killCount ?? null,
      damage: round(ov.totalDamage, 0),
      opk: round(ratio(ov.openingsPerKill), 1),
      dpo: round(ratio(ov.damagePerOpening), 1),
      neutral: ov.neutralWinRatio?.count ?? null,
      counter: ov.counterHitRatio?.count ?? null,
      punish: round(max(mine.map(convDamage)), 0),
      combo: max(combos.map((c) => c.moves?.length ?? 0)),
      earliest: round(min(kills), 0),
      avgkill: round(mean(kills), 0),
      lcancel: lcTries >= 5 ? round((100 * (lc.success ?? 0)) / lcTries, 0) : null,
      ipm: round(ratio(ov.inputsPerMinute), 0),
      sd: sds,
      stocksLeft: Number.isFinite(stocksLeft) ? stocksLeft : null,
      wavedash: ac.wavedashCount ?? null,
      techMiss: techs.fail ?? null,
      ledgegrabs: ac.ledgegrabCount ?? null,
      maxDeficit: deficit[me],
      firstBlood: !!firstLoss && firstLoss.playerIndex === opp,
    };
  }

  // The numbers the accolades read (accolades.js): what each player did, not how well.
  // A frame walk on top of slippi-js's stats; a failure here costs the trivia, never the ledger.
  let extra = null;
  try {
    extra = funStats(game, stats, players, settings.stageId);
  } catch (err) {
    extra = null;
  }
  for (const p of players) out[p.playerIndex].fun = extra ? extra.ports[p.playerIndex] : null;

  const winner = end?.placements?.find((x) => x.position === 0)?.playerIndex;
  return {
    ok: true,
    players: out,
    leadChanges: extra ? extra.leadChanges : null,
    bothLastStock: extra ? extra.bothLastStock : null,
    stageId: settings.stageId ?? null,
    lastFrame,
    seconds: lastFrame == null ? null : Math.max(0, Math.round((lastFrame - FIRST_FRAME) / 60)),
    winnerPort: Number.isInteger(winner) ? winner : null,
    endMethod: end?.gameEndMethod ?? null,
    complete: !!end,
  };
}

module.exports = { readGameStats };
