/**
 * The overlays' show/hide and swap animations end on the right content.
 *
 * Overlay.swap() draws a change only once the old content has left, and
 * coalesces whatever lands meanwhile; Overlay.presence() takes a chip or card
 * out before hiding it, and a hide overtaken by a show must never apply. Get
 * either wrong and the source looks healthy while it shows the score before
 * last, or a pronoun chip that's empty — or gone — for the rest of the set.
 *
 * Runs the real scoreboard and casters pages against the real store and
 * channel, at real animation speed (timeScale 1), so a second change can land
 * mid-animation the way a double-tapped hotkey does.
 */

const assert = require("assert");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createOverlayChannel } = require("../app/lib/overlay/channel");
const { loadPayload } = require("../app/lib/event/set-model");
const { buildBracket } = require("../app/lib/event/bracket-model");
const { eventFrom } = require("./helpers/fake-startgg");
const { loadOverlay, fakeIo, sleep } = require("./helpers/overlay-sandbox");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

const graph = (() => {
  const { phaseGroup, sets } = eventFrom("hundred-acres-49", "singles");
  return buildBracket(sets, { phaseGroupId: phaseGroup.id });
})();
/** A real set, as if nothing had been played yet. */
const unplayed = () => {
  const set = Object.values(graph.sets).find((s) => s.name === "Grand Final");
  const p = loadPayload(graph, set.id);
  return { ...p, sides: p.sides.map((x) => ({ ...x, score: 0 })) };
};

// Comfortably past each animation (overlay-client.js: exit 200 + entrance
// 480 for a swap, 260 for a hide — each × --motion-tempo, which the sandbox
// can't read from overlay.css and so takes as TEMPO_FALLBACK, 1.5).
const SWAP_DONE = 1300;
const HIDE_DONE = 700;
const settle = () => sleep(15); // a store change reaches the page on the next tick

async function setup(page, prepare) {
  const store = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
  if (prepare) prepare(store);
  const { io, nsps } = fakeIo();
  createOverlayChannel({ io, store });
  const p = await loadOverlay({ page, nsps, timeScale: 1 });
  await sleep(20); // first state drawn
  return { store, page: p };
}

const scoreText = (page) => page.$('.player[data-side="0"] .score .text').textContent;
const pronounChip = (page) => page.$('.chips[data-side="0"] .pronoun');

(async () => {
  console.log("overlay-motion");

  await test("a score bumped twice inside one swap ends on the newest score", async () => {
    const { store, page } = await setup("scoreboard", (s) => s.loadSet(unplayed()));
    assert.strictEqual(scoreText(page), "0");
    store.bump(0, 1);
    await settle();
    assert.strictEqual(scoreText(page), "0", "the old score should still be leaving");
    store.bump(0, 1); // lands mid-exit
    await settle();
    await sleep(SWAP_DONE);
    assert.strictEqual(scoreText(page), "2");
  });

  await test("a pronoun cleared then refilled before its chip has gone keeps the chip, with the new text", async () => {
    const { store, page } = await setup("scoreboard", (s) => {
      s.loadSet(unplayed());
      s.setPlayer(0, 0, { pronoun: "he/him" });
    });
    const chip = pronounChip(page);
    assert.ok(!chip.classList.contains("empty"), "the chip should start shown");

    store.setPlayer(0, 0, { pronoun: "" });
    await settle();
    assert.ok(!chip.classList.contains("empty"), "the chip vanished instead of leaving");
    store.setPlayer(0, 0, { pronoun: "they/them" }); // before the hide ends
    await settle();
    await sleep(HIDE_DONE);
    assert.ok(!chip.classList.contains("empty"), "the overtaken hide still hid the chip");
    assert.strictEqual(chip.textContent, "they/them");
  });

  await test("a cleared pronoun's chip leaves, then hides and empties", async () => {
    const { store, page } = await setup("scoreboard", (s) => {
      s.loadSet(unplayed());
      s.setPlayer(0, 0, { pronoun: "he/him" });
    });
    const chip = pronounChip(page);
    store.setPlayer(0, 0, { pronoun: "" });
    await settle();
    await sleep(HIDE_DONE);
    assert.ok(chip.classList.contains("empty"), "the chip never hid");
    assert.strictEqual(chip.textContent, "");
  });

  await test("a caster added after the page is up is shown, and one cleared is hidden", async () => {
    const { store, page } = await setup("casters", (s) => s.setCasters([{ tag: "First" }]));
    const cards = () => page.document.querySelectorAll(".caster");
    assert.strictEqual(cards().length, 1);
    assert.ok(!cards()[0].classList.contains("empty"), "the first caster should be shown");

    store.setCasters([{ tag: "First" }, { tag: "Second" }]);
    await settle();
    await sleep(HIDE_DONE);
    assert.strictEqual(cards().length, 2);
    assert.ok(!cards()[1].classList.contains("empty"), "a caster added later stayed hidden");
    assert.strictEqual(cards()[1].querySelector(".name").textContent, "Second");

    store.setCasters([{ tag: "" }, { tag: "Second" }]);
    await settle();
    await sleep(HIDE_DONE);
    assert.ok(cards()[0].classList.contains("empty"), "a cleared caster is still on screen");
    assert.ok(!cards()[1].classList.contains("empty"));
  });

  console.log(failed === 0 ? "overlay-motion: all passed" : `overlay-motion: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
