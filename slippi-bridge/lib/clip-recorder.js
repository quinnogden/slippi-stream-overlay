/**
 * Combo clipper glue: highlight → OBS replay buffer → panel + overlay.
 *
 * combo-detector.js decides whether a combo qualifies; everything time-based
 * lives here so the detector stays pure and testable against a saved .slp.
 */

const path = require("path");

/** How many recent clips the panel can show after being reopened mid-set. */
const RECENT_CLIPS_MAX = 10;

/**
 * @param {object} ctx
 * @param {() => Promise<any>} refreshControlStatus — push the new clip list to the panel
 */
function createClipRecorder(ctx, refreshControlStatus) {
  const { obs, clipperSettings, portMapper, io, state } = ctx;

  /** Who threw the combo, in the operator's terms rather than a port number. */
  function describeAttacker(playerIndex) {
    if (playerIndex == null) return { name: "", teamNum: null };
    const teamNum = state.currentGameState?.players?.[playerIndex]?.teamNum
      ?? portMapper.getTeam(playerIndex, null);
    const name = portMapper.getPortName(playerIndex) || "";
    return { name, teamNum };
  }

  /**
   * A combo cleared the bar — bank a clip.
   *
   * Deliberately fire-and-forget: this runs off a game event during a live match,
   * so nothing here may throw into the poll loop or delay scoring.
   * @param {object} h — highlight from combo-detector.js
   */
  function onHighlight(h) {
    const s = clipperSettings.get();
    if (!s.enabled) return;

    const { name, teamNum } = describeAttacker(h.playerIndex);
    const who = name || (h.playerIndex == null ? "?" : `port ${h.playerIndex + 1}`);
    console.log(`[clipper] Combo by ${who}: ${h.moveCount} moves, ${h.damage}%, ` +
                `${h.durationSec}s${h.didKill ? ", kill" : ""}`);

    if (s.maxClipsPerGame > 0 && state.clipsThisGame >= s.maxClipsPerGame) {
      console.log(`[clipper] Skipped — already saved ${state.clipsThisGame} clip(s) this game (max ${s.maxClipsPerGame})`);
      return;
    }

    // One exchange can produce several qualifying conversions back to back; the
    // replay buffer would save near-identical clips of the same moment.
    const sinceLast = Date.now() - state.lastClipAtMs;
    if (state.lastClipAtMs && sinceLast < s.cooldownSec * 1000) {
      console.log(`[clipper] Skipped — ${Math.round(sinceLast / 1000)}s since the last clip (cooldown ${s.cooldownSec}s)`);
      return;
    }
    state.lastClipAtMs = Date.now();
    state.clipsThisGame++;

    // The buffer holds the last N seconds, so the combo is already in it. Waiting
    // is about the OTHER end: saving the instant the kill registers cuts off the
    // death animation and the reaction.
    setTimeout(() => {
      obs.saveReplayBuffer()
        .then((r) => recordClip(h, { name, teamNum }, r))
        .catch((e) => console.warn(`[clipper] Save failed: ${e.message}`));
    }, s.saveDelayMs);
  }

  /** Log the outcome of a save, push it to the panel and the overlay. */
  function recordClip(h, attacker, result) {
    const clip = {
      ts: Date.now(),
      playerName: attacker.name,
      teamNum: attacker.teamNum,
      moveCount: h?.moveCount ?? null,
      damage: h?.damage ?? null,
      didKill: h?.didKill ?? null,
      path: result.ok ? (result.path ?? null) : null,
      file: result.ok && result.path ? path.basename(result.path) : null,
      ok: result.ok,
      error: result.ok ? null : result.error,
    };

    state.recentClips = [clip, ...state.recentClips].slice(0, RECENT_CLIPS_MAX);

    if (result.ok) {
      console.log(`[clipper] Saved clip${clip.file ? `: ${clip.file}` : " (OBS reported no path)"}`);
      if (clipperSettings.get().notifySidePanel) io.emit("slippi_clip_saved", clip);
    } else {
      // Never silent: an operator who thinks clips are being banked and finds an
      // empty folder at the break is the worst outcome here. This goes to the
      // operator's panel, never to the broadcast overlay.
      console.warn(`[clipper] ${result.error}`);
      io.emit("slippi_clip_error", clip);
    }

    refreshControlStatus().catch(() => {});
    return clip;
  }

  return { onHighlight, recordClip };
}

module.exports = { createClipRecorder };
