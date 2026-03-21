/**
 * handwarmer.js — Handwarmer detection for folder-mode games.
 *
 * Ported from Melee-Ghost-Streamer (Sheepolution/Melee-Ghost-Streamer, app/src/compute.js).
 *
 * A handwarmer is a throw-away warmup game players play before a real set.
 * Weighted score ≥ 2 → handwarmer; suppress score increment.
 *
 * Scoring:
 *   With pause disabled (gameBitfield3 < 142, the competitive setting):
 *     LRAS end (method 7)                → +1, else −1
 *     Both players used < startStocks-1  → +2  (both still have multiple stocks)
 *   With pause enabled:
 *     Each player's kill count ≤ 1       → +1  (if startStocks > 2)
 *   Always:
 *     Each player's totalDamage < 50     → +1, else −1
 *     Duration < 45s                     → +1  (if startStocks > 2)
 */

const { GameEndMethod } = require("@slippi/slippi-js");

const LRAS_METHOD = 7; // GameEndMethod.NO_CONTEST

/**
 * @param {import("@slippi/slippi-js").SlippiGame} game
 * @returns {boolean}
 */
function wasHandwarmer(game) {
  if (!game.getGameEnd()) return false;

  let score = 0;

  const settings    = game.getSettings();
  const startStocks = settings?.players?.[0]?.startStocks ?? 4;
  const stats       = game.getStats();
  const gameEnd     = game.getGameEnd();
  const lastFrame   = game.getLatestFrame();
  const metadata    = game.getMetadata();

  // ── Guard: can't score without damage stats ───────────────────────────────
  if (!stats?.overall?.length) return false;

  // ── Per-player damage check (+1 / −1) ────────────────────────────────────
  if (stats.overall.every((p) => (p.totalDamage ?? 0) < 150)) {
    score += 1;
  } else {
    score -= 1;
  }

  // ── Pause-detection branch ────────────────────────────────────────────────
  const gameBitfield3 = settings?.gameInfoBlock?.gameBitfield3 ?? 0;
  const pauseDisabled = gameBitfield3 < 142;

  if (pauseDisabled) {
    if (gameEnd.gameEndMethod === LRAS_METHOD) {
      score += 1;
    } else {
      score -= 1;
    }

    const bothHaveMultipleStocks = lastFrame?.players
      ? Object.values(lastFrame.players)
          .filter(Boolean)
          .every((p) => (p.post?.stocksRemaining ?? 0) > 1)
      : false;
    if (bothHaveMultipleStocks) score += 2;
  } else {
    if (startStocks > 2 && stats.overall.every((p) => (p.killCount ?? 0) <= 1)) {
      score += 1;
    }
  }

  // ── Duration check (+1, only when startStocks > 2) ────────────────────────
  if (startStocks > 2 && metadata?.lastFrame != null) {
    if ((metadata.lastFrame + 123) / 60 < 45) score += 1;
  }

  return score >= 2;
}

module.exports = { wasHandwarmer };
