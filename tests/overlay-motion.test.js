/**
 * The overlays' show/hide and swap animations end on the right content.
 *
 * Overlay.swap() draws a change only once the old content has left, and
 * coalesces whatever lands meanwhile; Overlay.presence() takes a chip or card
 * out before hiding it, and a hide overtaken by a show must never apply. Get
 * either wrong and the source looks healthy while it shows the score before
 * last, or a pronoun chip that's empty — or gone — for the rest of the set.
 * Overlay.reel() turns the score up for a game won and down for one taken
 * back, and must never leave its cells behind.
 *
 * Runs the real scoreboard and casters pages against the real store and
 * channel, with animations at TIME_SCALE of their real length: short enough to
 * keep the file quick, long enough that a second change (15ms later, ~30ms on
 * a Windows timer) still lands mid-animation the way a double-tapped hotkey
 * does — the shortest one here, a swap's exit, is 240ms × TIME_SCALE.
 */

const assert = require("assert");

const { ScoreboardStore } = require("../app/lib/scoreboard/store");
const { createOverlayChannel } = require("../app/lib/overlay/channel");
const { loadPayload } = require("../app/lib/event/set-model");
const { buildBracket } = require("../app/lib/event/bracket-model");
const { eventFrom } = require("./helpers/fake-startgg");
const { loadOverlay, fakeIo, sleep } = require("./helpers/overlay-sandbox");

// Each test builds its own store and page and mostly waits on animation
// timers, so they run at once and the file takes as long as its longest test.
// Results print in the order the tests are written.
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => () => console.log(`  ok   ${name}`),
    (err) => () => {
      failed++;
      console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
    }));
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

// Comfortably past each animation (overlay-client.js: exit 160 + entrance
// 480 for a swap, 220 for a hide — each × --motion-tempo, which the sandbox
// can't read from overlay.css and so takes as TEMPO_FALLBACK, 1.5).
const TIME_SCALE = 0.4;
const SWAP_DONE = 1300 * TIME_SCALE;
const HIDE_DONE = 700 * TIME_SCALE;
const settle = () => sleep(15); // a store change reaches the page on the next tick

async function setup(page, prepare) {
  const store = new ScoreboardStore({ setText: { topN: 8, topLabel: "Bo5", defaultLabel: "Flex" } });
  if (prepare) prepare(store);
  const { io, nsps } = fakeIo();
  createOverlayChannel({ io, store });
  const p = await loadOverlay({ page, nsps, timeScale: TIME_SCALE });
  await sleep(20); // first state drawn
  return { store, page: p };
}

const scoreText = (page) => page.$('.player[data-side="0"] .score .text').textContent;
const pronounChip = (page) => page.$('.chips[data-side="0"] .pronoun');
const REEL_DONE = 900 * TIME_SCALE; // past the longest turn: 520ms × TEMPO_FALLBACK 1.5 = 780ms
const reelCells = (page) => page.$$('.player[data-side="0"] .score .ov-reel-cell');
/** The transforms each reel cell started since `before` runs through. */
const turns = (page, before) => JSON.parse(JSON.stringify(page.animations.slice(before)
  .filter(({ el }) => el.classList.contains("ov-reel-cell"))
  .map(({ anim }) => anim.keyframes.map((k) => k.transform))));

(async () => {
  console.log("overlay-motion");

  await test("a game won turns the score up, and a second one mid-turn ends on the newest score", async () => {
    const { store, page } = await setup("scoreboard", (s) => s.loadSet(unplayed()));
    const before = page.animations.length;
    store.bump(0, 1);
    await settle();
    // The new score comes up from below as the old one leaves out the top.
    assert.deepStrictEqual(turns(page, before), [
      ["translateY(0px)", "translateY(-100px)"],
      ["translateY(100px)", "translateY(0px)"],
    ]);
    store.bump(0, 1); // lands mid-turn
    await settle();
    await sleep(REEL_DONE);
    assert.strictEqual(scoreText(page), "2");
    assert.strictEqual(reelCells(page).length, 0, "cells left behind");
  });

  await test("a game taken back turns the score down; a jump turns through the scores in between", async () => {
    const { store, page } = await setup("scoreboard", (s) => { s.loadSet(unplayed()); s.bump(0, 1); s.bump(0, 1); });
    let before = page.animations.length;
    store.bump(0, -1);
    await settle();
    // The new score comes down from above.
    assert.deepStrictEqual(turns(page, before), [
      ["translateY(0px)", "translateY(100px)"],
      ["translateY(-100px)", "translateY(0px)"],
    ]);
    await sleep(REEL_DONE);
    assert.strictEqual(scoreText(page), "1");

    before = page.animations.length;
    store.setScore(0, 4); // one command, one patch: 1 → 4
    await settle();
    const t = turns(page, before);
    assert.strictEqual(t.length, 4, "1, 2, 3, 4");
    assert.deepStrictEqual(t[3], ["translateY(300px)", "translateY(0px)"]);
    await sleep(REEL_DONE);
    assert.strictEqual(scoreText(page), "4");
    assert.strictEqual(reelCells(page).length, 0, "cells left behind");
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

  await test("a crew battle's name is a chip under the player in, not their sponsor, and follows Switch Sides", async () => {
    const { store, page } = await setup("scoreboard", (s) => s.startCrew({ stocksEach: 4, teams: [
      { name: "ACRES", members: [{ tag: "Zodd", prefix: "HA" }] },
      { name: "SALTY", members: [{ tag: "Nav" }] },
    ] }));
    const crewChip = (i) => page.$(`.chips[data-side="${i}"] .crew`);
    const card = (i, sel) => page.$(`.player[data-side="${i}"] .name ${sel}`);
    await sleep(HIDE_DONE);
    assert.strictEqual(card(0, ".tag").textContent, "ACRES", "nobody in: the card is the crew's name");
    assert.ok(crewChip(0).classList.contains("empty"), "nobody in: the chip only repeats the card");

    store.crewPick(0, store.scoreboard().crew.teams[0].members[0].id);
    await settle();
    await sleep(SWAP_DONE);
    assert.strictEqual(card(0, ".tag").textContent, "Zodd");
    assert.strictEqual(card(0, ".sponsor").textContent, "HA", "the player's own sponsor, not the crew");
    assert.ok(!crewChip(0).classList.contains("empty"), "the crew chip should show with someone in");
    assert.strictEqual(crewChip(0).textContent, "ACRES");

    store.switchSides();
    await settle();
    await sleep(SWAP_DONE);
    assert.strictEqual(crewChip(1).textContent, "ACRES", "the chip moves with its crew");
    assert.ok(crewChip(0).classList.contains("empty"), "SALTY has nobody in");
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

  await test("a name, a cleared chip and a character icon all leave the same way: up, unscaled", async () => {
    const { store, page } = await setup("scoreboard", (s) => {
      s.loadSet(unplayed());
      s.setPlayer(0, 0, { pronoun: "he/him" });
      s.setCharacter(0, 0, { codename: "fox", name: "Fox", skin: 0 });
    });
    const before = page.animations.length;
    store.setPlayer(0, 0, { tag: "Renamed", pronoun: "" });
    store.setCharacter(0, 0, { codename: "marth", name: "Marth", skin: 0 });
    await settle();
    const exits = page.animations.slice(before).map(({ anim }) => anim.keyframes[anim.keyframes.length - 1].transform);
    assert.ok(exits.length >= 3, `only ${exits.length} exits started`);
    for (const t of exits) {
      assert.match(t, /translate\(0px, -6px\) scale\(1\)$/, `an exit that isn't the text motion: ${t}`);
    }
  });

  test("the name slides over when the character icon arrives or a sponsor comes in, rather than jumping", async () => {
    const { store, page } = await setup("scoreboard", (s) => {
      s.loadSet(unplayed());
      s.setCharacter(0, 0, null);
      s.setPlayer(0, 0, { prefix: "" });
    });
    const card = page.$('.player[data-side="0"]');
    const chars = card.querySelector(".character_container");
    const tag = card.querySelector(".name .tag");
    const sponsor = card.querySelector(".name .sponsor");
    // The sandbox has no layout: the centred tag sits 24px further left with
    // the icon in, and 30px further right with a sponsor before it.
    tag.offsetParent = card;
    tag.offsetTop = 0;
    Object.defineProperty(tag, "offsetLeft", {
      get: () => 200 - (chars.children.length ? 24 : 0) + (sponsor.classList.contains("empty") ? 0 : 30),
    });
    const tagMoves = (from) => JSON.parse(JSON.stringify(page.animations.slice(from)
      .filter(({ el }) => el.classList.contains("tag"))
      .map(({ anim }) => anim.keyframes)));

    let before = page.animations.length;
    store.setCharacter(0, 0, { codename: "fox", name: "Fox", skin: 0 });
    await settle();
    await sleep(SWAP_DONE / 4); // the icon's exit has drawn
    assert.deepStrictEqual(tagMoves(before), [[{ left: "24px", top: "0px" }, { left: "0px", top: "0px" }]],
      "the tag slides left from where it was");

    before = page.animations.length;
    store.setPlayer(0, 0, { prefix: "SPON" });
    await settle();
    assert.deepStrictEqual(tagMoves(before), [[{ left: "-30px", top: "0px" }, { left: "0px", top: "0px" }]],
      "the tag slides right for the sponsor, and isn't redrawn");
    assert.ok(!sponsor.classList.contains("empty"), "the sponsor came in");
  });

  for (const report of await Promise.all(pending)) report();
  console.log(failed === 0 ? "overlay-motion: all passed" : `overlay-motion: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
