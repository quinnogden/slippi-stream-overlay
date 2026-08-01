/**
 * The combo clipper's closing-window filter, and the contracts around it.
 *
 * `comboWindowSec` decides what reaches the broadcast's highlight reel, and
 * every way it can be wrong is silent: too tight and the clipper saves nothing
 * for a whole night while OBS, the bridge and the dock all look healthy; too
 * loose and it banks 30-second edgeguard chases whose qualifying burst has
 * already fallen out of the replay buffer. Either way the manual reproduction
 * step is "run a tournament", which is exactly what this suite exists for.
 *
 * ComboDetector is pure and takes a settings thunk, so this needs no sandbox
 * and no TSH state — the conversion objects below are the slippi-js shape
 * documented at the top of lib/combo-detector.js.
 */

const assert = require("assert");
const { ComboDetector } = require("../slippi-bridge/lib/combo-detector");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("combo-detector");

const FPS = 60;

/** The settings shape the detector reads, with the clipper's real defaults. */
function settings(over = {}) {
  return {
    enabled: true,
    minMoves: 4,
    minDamage: 30,
    requireKill: true,
    comboWindowSec: 0,
    maxComboDurationSec: 0,
    ...over,
  };
}

/**
 * One finished conversion. `moves` is given as [secondsBeforeEnd, damage] pairs
 * so the cases read as "this much damage this long before the kill".
 */
function conversion(moves, over = {}) {
  const endFrame = over.endFrame ?? 10000;
  const damage = moves.reduce((sum, [, d]) => sum + d, 0);
  return {
    playerIndex: 1,            // the player who GOT HIT
    lastHitBy: 0,              // the attacker
    startFrame: endFrame - 5 * FPS,
    endFrame,
    startPercent: 0,
    currentPercent: damage,
    didKill: true,
    moves: moves.map(([secBefore, d]) => ({
      playerIndex: 0,
      frame: Math.round(endFrame - secBefore * FPS),
      damage: d,
    })),
    ...over,
  };
}

/** A game whose stats hold exactly these conversions. */
const gameWith = (...conversions) => ({ getStats: () => ({ conversions }) });

/** Run one conversion through a fresh detector and return its highlight. */
function judge(conv, over) {
  const hits = new ComboDetector(() => settings(over)).scan(gameWith(conv));
  return hits[0] ?? null;
}

// A 32s conversion: a strong burst at the start, then a long chase and a lone
// finishing hit. This is the case the window was added for — by the time the
// buffer is saved, the burst is long gone from it.
const LONG_CHASE = conversion(
  [[30, 12], [29.5, 14], [29, 11], [28.5, 13], [0.2, 9]],
  { endFrame: 10000, startFrame: 10000 - 32 * FPS },
);

// A tight punish: five hits and 45% inside three seconds, ending in a stock.
const TIGHT_PUNISH = conversion(
  [[3, 9], [2.4, 9], [1.8, 9], [1.2, 9], [0.3, 9]],
  { endFrame: 10000, startFrame: 10000 - 3.2 * FPS },
);

test("window off: the long chase still qualifies (today's behaviour, unchanged)", () => {
  const h = judge(LONG_CHASE);
  assert.ok(h, "a 5-move, 59% killing conversion must pass with no window set");
  assert.strictEqual(h.moveCount, 5);
});

test("window on: the long chase is rejected — only one hit lands in the last 8s", () => {
  assert.strictEqual(judge(LONG_CHASE, { comboWindowSec: 8 }), null);
});

test("window on: a tight punish still qualifies", () => {
  const h = judge(TIGHT_PUNISH, { comboWindowSec: 8 });
  assert.ok(h, "five hits and 45% inside 3s must clear a 8s window");
});

test("the reported figures stay whole-conversion; the window is reported beside them", () => {
  const h = judge(
    conversion([[20, 20], [2, 10], [1.5, 10], [1, 10], [0.5, 10]],
               { endFrame: 10000, startFrame: 10000 - 22 * FPS }),
    { comboWindowSec: 8 },
  );
  assert.ok(h, "four hits and 40% in the last 2s must pass");
  assert.strictEqual(h.moveCount, 5, "moveCount describes the combo, not the filter");
  assert.strictEqual(h.damage, 60, "damage describes the combo, not the filter");
  assert.strictEqual(h.durationSec, 22);
  assert.deepStrictEqual(h.window, { moveCount: 4, damage: 40, durationSec: 8 });
});

test("no window set means no window field to mislead the log line", () => {
  assert.strictEqual("window" in judge(TIGHT_PUNISH), false);
});

test("window damage counts in-window moves only — a move just outside is excluded", () => {
  // 10 + 10 + 10 + 10 = 40 inside, plus one 40% move a hair outside the edge.
  const conv = conversion(
    [[8.1, 40], [3, 10], [2, 10], [1, 10], [0.5, 10]],
    { endFrame: 10000, startFrame: 10000 - 9 * FPS },
  );
  assert.strictEqual(judge(conv, { comboWindowSec: 8, minDamage: 45 }), null);
  assert.ok(judge(conv, { comboWindowSec: 8, minDamage: 40 }),
            "the four in-window moves total exactly 40%");
});

test("windowing is strictly stricter — it can never let through what the whole conversion fails", () => {
  const weak = conversion([[2, 5], [1.5, 5], [1, 5], [0.5, 5]]);   // 4 moves, 20%
  assert.strictEqual(judge(weak), null);
  assert.strictEqual(judge(weak, { comboWindowSec: 8 }), null);
});

test("no move data falls back to the whole conversion rather than rejecting", () => {
  // A missing/empty moves array gives nothing to place in time. Clipping one
  // loose combo is recoverable; clipping nothing all night is not.
  for (const moves of [undefined, []]) {
    const conv = { ...conversion([[1, 10]]), moves, currentPercent: 60, startPercent: 0 };
    // moveCount falls to 0 with no array, so minMoves is what refuses it —
    // the point is that the WINDOW didn't, i.e. no crash and no silent reject
    // path of its own.
    assert.strictEqual(judge(conv, { comboWindowSec: 8, minMoves: 0 }) === null, false,
                       `moves=${JSON.stringify(moves)} must be judged, not dropped`);
  }
});

test("requireKill still applies inside a window", () => {
  const noKill = { ...TIGHT_PUNISH, didKill: false };
  assert.strictEqual(judge(noKill, { comboWindowSec: 8 }), null);
  assert.ok(judge(noKill, { comboWindowSec: 8, requireKill: false }));
});

test("maxComboDurationSec still measures the WHOLE conversion, not the window", () => {
  // The tail is dense enough for the window, but the sequence ran 22s overall.
  const conv = conversion([[2, 10], [1.5, 10], [1, 10], [0.5, 10]],
                          { endFrame: 10000, startFrame: 10000 - 22 * FPS });
  assert.ok(judge(conv, { comboWindowSec: 8 }));
  assert.strictEqual(judge(conv, { comboWindowSec: 8, maxComboDurationSec: 10 }), null);
});

test("an unfinished conversion is left unjudged, and re-judged once it ends", () => {
  const live = { ...TIGHT_PUNISH, endFrame: null };
  const d = new ComboDetector(() => settings({ comboWindowSec: 8 }));
  assert.deepStrictEqual(d.scan(gameWith(live)), [],
                         "endFrame == null means still in progress");
  // Same conversion object, now finished in place — slippi-js mutates rather
  // than replacing, so the detector must not have keyed it as seen already.
  live.endFrame = TIGHT_PUNISH.endFrame;
  assert.strictEqual(d.scan(gameWith(live)).length, 1);
});

test("a finished conversion is only ever judged once", () => {
  const d = new ComboDetector(() => settings({ comboWindowSec: 8 }));
  const game = gameWith(TIGHT_PUNISH);
  assert.strictEqual(d.scan(game).length, 1);
  assert.deepStrictEqual(d.scan(game), [], "a second tick must not re-clip it");
  d.reset();
  assert.strictEqual(d.scan(game).length, 1, "reset() re-arms for the next game");
});

test("the master toggle short-circuits before any window work", () => {
  assert.deepStrictEqual(
    new ComboDetector(() => settings({ enabled: false, comboWindowSec: 8 })).scan(gameWith(TIGHT_PUNISH)),
    [],
  );
});

console.log(failed ? `\n${failed} failure(s)` : "\nall passed");
process.exit(failed ? 1 : 0);
