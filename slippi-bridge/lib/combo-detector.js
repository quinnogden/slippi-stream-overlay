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
   *                  didKill: boolean, durationSec: number,
   *                  window?: {moveCount: number, damage: number, durationSec: number}}>}
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

  /**
   * The closing window: the last `comboWindowSec` seconds of the conversion.
   *
   * A conversion does not end when the pressure stops — slippi-js keeps it open
   * until the victim regains neutral or dies — so an offstage chase is ONE
   * conversion whose total duration is mostly dead air. Judging the whole span
   * therefore clips 30s sequences on the strength of a burst that, by the time
   * the buffer is saved, has already fallen out of it: OBS holds the last N
   * seconds, so what qualified the combo isn't in the clip.
   *
   * Anchoring at `endFrame` is the point — it makes the qualifying action and
   * the captured footage the same thing.
   *
   * @returns {{moveCount: number, damage: number, durationSec: number}|null}
   *   null when windowing can't apply (off, or no move data to window over), in
   *   which case the caller judges the whole conversion as before.
   */
  _window(c, s) {
    const windowSec = s.comboWindowSec ?? 0;
    if (windowSec <= 0) return null;
    // No move array means no way to place hits in time. Falling back to the
    // whole conversion is the safe direction: silently clipping nothing for a
    // whole night is a far worse failure than one loose clip.
    if (!Array.isArray(c.moves) || c.moves.length === 0) return null;

    const from = c.endFrame - windowSec * FRAMES_PER_SECOND;
    const moves = c.moves.filter((m) => (m?.frame ?? -Infinity) >= from);

    return {
      moveCount: moves.length,
      // The move sum is the only per-move damage figure slippi-js exposes, so
      // this counts move damage only and slightly undercounts non-move damage
      // (Blast Zone chip, self-damage). That makes the threshold conservative,
      // which is the right direction for a filter.
      damage: moves.reduce((sum, m) => sum + (m?.damage ?? 0), 0),
      durationSec: windowSec,
    };
  }

  /** Apply the operator's thresholds to one finished conversion. */
  _evaluate(c, s) {
    const moveCount = Array.isArray(c.moves) ? c.moves.length : 0;
    // endPercent is only populated in some end conditions; currentPercent is the
    // running value and is always present.
    const damage = (c.currentPercent ?? 0) - (c.startPercent ?? 0);
    const durationSec = (c.endFrame - c.startFrame) / FRAMES_PER_SECOND;

    // With a window active, minMoves/minDamage are measured against it rather
    // than the whole conversion. The window is a subset, so this is strictly
    // stricter than the unwindowed check — never a way to let more through.
    const win = this._window(c, s);
    const judged = win ?? { moveCount, damage };

    if (judged.moveCount < s.minMoves) return null;
    if (judged.damage < s.minDamage) return null;
    // The kill is by definition at the end of the conversion, so it is always
    // inside a closing window — no windowed variant of this check is needed.
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
      // Whole-conversion figures: the panel and the overlay toast describe the
      // combo, not the filter that let it through.
      damage: Math.round(damage * 10) / 10,
      didKill: c.didKill === true,
      durationSec: Math.round(durationSec * 10) / 10,
      // Present only when a window actually decided this — the operator's only
      // feedback while tuning the number.
      ...(win ? { window: { ...win, damage: Math.round(win.damage * 10) / 10 } } : {}),
    };
  }
}

module.exports = { ComboDetector };
