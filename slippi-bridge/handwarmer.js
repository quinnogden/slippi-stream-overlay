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
 *     Each player's kill count ≤ 1       → +1  (if startStocks > 2, singles only)
 *   Always:
 *     Each player's totalDamage < 150     → +1, else −1
 *     Duration < 60s                     → +1  (if startStocks > 2)
 */

const { GameEndMethod } = require("@slippi/slippi-js");

const LRAS_METHOD = 7; // GameEndMethod.NO_CONTEST

/**
 * @param {import("@slippi/slippi-js").SlippiGame} game
 * @returns {boolean}
 */
function wasHandwarmer(game) {
  if (!game.getGameEnd()) return false;

  const settings    = game.getSettings();

  // Detect doubles: 4 active players. Some checks (kill count) are unreliable
  // for 4-player stat computation in slippi-js, so they are guarded below.
  const activePlayers = (settings?.players ?? []).filter(
    (p) => p != null && p.characterId != null
  );
  const isDoublesGame = activePlayers.length > 2;

  let score = 0;
  const logLines = [];

  const startStocks = settings?.players?.[0]?.startStocks ?? 4;
  const stats       = game.getStats();
  const gameEnd     = game.getGameEnd();
  const lastFrame   = game.getLatestFrame();
  const metadata    = game.getMetadata();

  logLines.push(`mode=${isDoublesGame ? "doubles" : "singles"} players=${activePlayers.length}`);

  // ── Guard: can't score without damage stats ───────────────────────────────
  if (!stats?.overall?.length) {
    console.log("[handwarmer] score=0 → NOT handwarmer | no damage stats available");
    return false;
  }

  // ── Per-player damage check (+1 / −1) ────────────────────────────────────
  const damages = stats.overall.map((p) => (p.totalDamage ?? 0).toFixed(1));
  if (stats.overall.every((p) => (p.totalDamage ?? 0) < 150)) {
    score += 1;
    logLines.push(`damage: +1 (all < 150: [${damages.join(", ")}])`);
  } else {
    score -= 1;
    logLines.push(`damage: -1 (some >= 150: [${damages.join(", ")}])`);
  }

  // ── Pause-detection branch ────────────────────────────────────────────────
  const gameBitfield3 = settings?.gameInfoBlock?.gameBitfield3 ?? 0;
  const pauseDisabled = gameBitfield3 < 142;

  if (pauseDisabled) {
    if (gameEnd.gameEndMethod === LRAS_METHOD) {
      score += 1;
      logLines.push(`LRAS: +1 (method ${gameEnd.gameEndMethod})`);
    } else {
      score -= 1;
      logLines.push(`end method: -1 (method ${gameEnd.gameEndMethod}, not LRAS)`);
    }

    const stockCounts = lastFrame?.players
      ? Object.values(lastFrame.players).map((p) => p?.post?.stocksRemaining ?? 0)
      : [];
    const bothHaveMultipleStocks = stockCounts.length > 0 && stockCounts.every((s) => s > 1);
    if (bothHaveMultipleStocks) {
      score += 2;
      logLines.push(`stocks: +2 (all > 1: [${stockCounts.join(", ")}])`);
    } else {
      logLines.push(`stocks:  0 (not all > 1: [${stockCounts.join(", ")}])`);
    }
  } else {
    if (!isDoublesGame && startStocks > 2 && stats.overall.every((p) => (p.killCount ?? 0) <= 1)) {
      score += 1;
      const kills = stats.overall.map((p) => p.killCount ?? 0);
      logLines.push(`kills: +1 (all <= 1: [${kills.join(", ")}])`);
    } else if (isDoublesGame) {
      logLines.push(`kills:  0 (skipped for doubles)`);
    }
  }

  // ── Duration check (+1, only when startStocks > 2) ────────────────────────
  if (startStocks > 2 && metadata?.lastFrame != null) {
    const durationSec = ((metadata.lastFrame + 123) / 60).toFixed(1);
    if (Number(durationSec) < 60) {
      score += 1;
      logLines.push(`duration: +1 (${durationSec}s < 60s)`);
    } else {
      logLines.push(`duration:  0 (${durationSec}s >= 60s)`);
    }
  }

  const verdict = score >= 2 ? "HANDWARMER" : "NOT handwarmer";
  console.log(`[handwarmer] score=${score} → ${verdict} | ${logLines.join(" | ")}`);

  return score >= 2;
}

module.exports = { wasHandwarmer };
