/**
 * combo-detector.js — live highlight detection over a game's conversions.
 *
 * Pure logic: no I/O, no timers, no socket. It is handed a SlippiGame that is
 * still being written and answers "which conversions just finished and are worth
 * clipping". Rate limiting, delays and the OBS call all live in index.js, so
 * this module has no notion of wall-clock time and stays trivially testable
 * against a saved .slp.
 *
 * How slippi-js models a conversion (verified against @slippi/slippi-js 6.5):
 *
 *   - A conversion object is pushed into stats.conversions the frame it STARTS,
 *     with `endFrame: null`, and is then MUTATED IN PLACE as it develops. So a
 *     conversion appearing in the array means nothing on its own — only
 *     `endFrame != null` means it's finished and safe to judge.
 *   - `conversion.playerIndex` is the player who GOT HIT, not the one doing the
 *     hitting. The attacker is `lastHitBy`. Getting this backwards would name
 *     the victim in the clip toast.
 *   - Conversions are computed for SINGLES ONLY
 *     (getSinglesPlayerPermutationsFromSettings bails unless players.length === 2),
 *     so stats.conversions is permanently empty in doubles. Crew battles are
 *     1v1 per game and work fine. Nothing here can change that — it's upstream.
 */

const FRAMES_PER_SECOND = 60;

class ComboDetector {
  /**
   * @param {() => object} getSettings — returns the live clipper settings.
   *   Read fresh on every scan so the control panel can retune mid-game.
   */
  constructor(getSettings) {
    this._getSettings = getSettings;
    this._seen = new Set();
  }

  /** Master toggle — game-source.js skips the scan entirely when false. */
  isEnabled() {
    return Boolean(this._getSettings()?.enabled);
  }

  /** Called when a new .slp file is picked up. Conversion keys are per-game. */
  reset() {
    this._seen.clear();
  }

  /**
   * Find conversions that finished since the last scan and clear the bar.
   *
   * Safe to call on every poll tick: a conversion is only ever considered once
   * (keyed victim:startFrame) and an unfinished one is left unmarked so it gets
   * judged properly on a later tick.
   *
   * @param {import("@slippi/slippi-js").SlippiGame} game
   * @returns {Array<{playerIndex: number|null, victimIndex: number, startFrame: number,
   *                  endFrame: number, moveCount: number, damage: number,
   *                  didKill: boolean, durationSec: number}>}
   */
  scan(game) {
    const s = this._getSettings();
    if (!s?.enabled) return [];

    const conversions = game?.getStats()?.conversions;
    if (!Array.isArray(conversions) || conversions.length === 0) return [];

    const hits = [];
    for (const c of conversions) {
      // Still in progress — no key recorded, so it gets another look next tick.
      if (c?.endFrame == null) continue;

      const key = `${c.playerIndex}:${c.startFrame}`;
      if (this._seen.has(key)) continue;
      this._seen.add(key);

      const highlight = this._evaluate(c, s);
      if (highlight) hits.push(highlight);
    }
    return hits;
  }

  /** Apply the operator's thresholds to one finished conversion. */
  _evaluate(c, s) {
    const moveCount = Array.isArray(c.moves) ? c.moves.length : 0;
    // endPercent is only populated in some end conditions; currentPercent is the
    // running value and is always present.
    const damage = (c.currentPercent ?? 0) - (c.startPercent ?? 0);
    const durationSec = (c.endFrame - c.startFrame) / FRAMES_PER_SECOND;

    if (moveCount < s.minMoves) return null;
    if (damage < s.minDamage) return null;
    if (s.requireKill && c.didKill !== true) return null;
    if (s.maxComboDurationSec > 0 && durationSec > s.maxComboDurationSec) return null;

    return {
      // The attacker. `lastHitBy` is set when the conversion starts; the last
      // move's owner is the fallback for the odd trade case where it's null.
      playerIndex: c.lastHitBy ?? c.moves?.[moveCount - 1]?.playerIndex ?? null,
      victimIndex: c.playerIndex,
      startFrame: c.startFrame,
      endFrame: c.endFrame,
      moveCount,
      damage: Math.round(damage * 10) / 10,
      didKill: c.didKill === true,
      durationSec: Math.round(durationSec * 10) / 10,
    };
  }
}

module.exports = { ComboDetector };
