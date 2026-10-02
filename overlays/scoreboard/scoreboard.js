/**
 * The scoreboard overlays — index.html (the Melee scoreboard) and
 * players.html (the thin name bar). One script for both: each draws only the
 * parts its markup has.
 *
 * Everything comes from the store's `scoreboard` section, including the live
 * character and costume — Slippi writes them to the store at game start.
 */
(function () {
  "use strict";

  const { h, text, swap, squeeze, fitText, icon } = Overlay;
  const ov = Overlay.connect({ tag: "scoreboard" });

  const sides = [0, 1].map((i) => ({
    card:  document.querySelector(`.player[data-side="${i}"]`),
    chips: document.querySelector(`.chips[data-side="${i}"]`),
  }));
  const q = (root, sel) => (root ? root.querySelector(sel) : null);

  const roundEl = document.querySelector(".match .round");
  // Only index.html has the pill; players.html shows no best-of.
  const bestOfPill = document.querySelector(".best-of-pill");
  const ROUND_MIN_PX = 12; // below this the round stops being legible on stream

  ov.select("scoreboard", (sb) => {
    sb.sides.forEach((side, i) => drawSide(sides[i], side, sb.isDoubles));
    drawRound(sb.round || "");
    // The dock's "None" is an empty label, which hides the pill entirely.
    text(q(bestOfPill, ".text"), sb.bestOfLabel || "", { emptyOn: bestOfPill });
  });

  /** The round shrinks to fit the card instead of spilling past it. */
  function drawRound(round) {
    swap(roundEl, round, (node) => {
      node.textContent = round;
      node.classList.toggle("empty", !round);
      fitText(node, ROUND_MIN_PX);
    });
  }

  function drawSide(el, side, isDoubles) {
    const p = side.players[0] ?? {};

    // Name: sponsor prefix + tag in singles; the team name (or the tags) in
    // doubles. [L] in grand finals.
    const prefix = isDoubles ? "" : p.prefix;
    const name = isDoubles
      ? side.teamName || side.players.map((x) => x.tag).filter(Boolean).join(" / ")
      : p.tag;
    const nameText = q(el.card, ".name .text");
    swap(nameText, JSON.stringify([prefix, name, side.losers]), (node) => {
      node.replaceChildren();
      if (prefix) node.append(h("span", "sponsor", prefix));
      node.append(h("span", "tag", name || ""));
      if (side.losers) node.append(h("span", "losers", "L"));
      node.classList.toggle("empty", !name);
      squeeze(node);
    });

    // Character: singles shows the icon (doubles has four, so none); doubles
    // shows the team colour swatch instead.
    const chars = q(el.card, ".character_container");
    const src = isDoubles ? null : icon(p.character);
    const color = isDoubles ? side.color : null;
    swap(chars, `${src}|${color}`, (node) => {
      node.replaceChildren();
      node.classList.toggle("team-color", !!color);
      if (color) node.style.setProperty("--team-color", color);
      else node.style.removeProperty("--team-color");
      if (src) {
        const img = h("img");
        img.src = src;
        img.alt = p.character?.name ?? "";
        node.append(h("div", "char"));
        node.lastChild.append(img);
      }
    }, { motion: "pop" });

    // The score box clips, so the old digit rolls up out of it and the new
    // one up into it.
    swap(q(el.card, ".score .text"), side.score, (node) => {
      node.replaceChildren(...scoreDigits(side.score));
    }, { motion: "roll" });

    const chip = q(el.chips, ".pronoun");
    text(q(chip, ".text"), isDoubles ? "" : p.pronoun, { emptyOn: chip });
  }

  /* ── Optically centring the score digits ─────────────────────────────────
     .score centres with flex, which aligns the LINE BOX. The renderer sizes
     that box from the font's ascent/descent, and nothing requires those to be
     symmetric about the digits' ink — so "centred" by layout can still read as
     off-centre on stream. BabyDoll misses on both available counts:

       - usWinAscent 1716 / usWinDescent 418, with USE_TYPO_METRICS unset. That
         is the pair Windows Chrome (and so OBS's CEF) uses, putting the line-box
         centre 649/2048 em above the baseline while the digits' ink centres sit
         near 513 — every digit ~3.3px low in the 64px box at font-size 50.
       - its zero is a short glyph, 836 units tall against 952-1016 for 1-9,
         which drops that one a further ~1.8px. Hence the 0 standing out.

     So this is not a per-font constant to hand-tune: it is per font, per GLYPH,
     and per renderer — a Mac reads the typo metrics (1434/-410, centre 512) and
     needs no correction at all. Measure it instead. Canvas reports both boxes
     for the font actually in use: fontBoundingBox* is the line box the layout
     centres, actualBoundingBox* is the ink. Half the difference between their
     centres is the correction. Emitted as em so one measurement covers .score
     and .fgc.thin .score alike, and published on :root so it lands on digits
     that are already on screen rather than needing a re-render.

     Degrades to plain flex centring: an unsupported metric gives NaN, the
     guard skips it, and the var falls back to 0. */
  async function calibrateScoreDigits() {
    const el = document.querySelector(".score");
    if (!el || !document.fonts) return;

    const cs   = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (!size) return;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;

    /* fonts.ready alone can resolve before a face this page hasn't drawn yet is
       requested, which would measure the fallback and bake in its metrics. */
    try { await document.fonts.load(font, "0123456789"); } catch (e) { /* fall through */ }
    await document.fonts.ready;

    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    ctx.font = font;

    for (const digit of "0123456789") {
      const m = ctx.measureText(digit);
      /* A digit whose ink clears the baseline entirely gives a NEGATIVE
         actualBoundingBoxDescent. That is meaningful here — do not clamp it. */
      const box = (m.fontBoundingBoxAscent   - m.fontBoundingBoxDescent)   / 2;
      const ink = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
      if (!isFinite(box) || !isFinite(ink)) continue;
      document.documentElement.style.setProperty(
        `--score-nudge-${digit}`, `${((ink - box) / size).toFixed(4)}em`
      );
    }
  }

  calibrateScoreDigits();

  /* Per-digit, because the 0 needs its own figure (see above). */
  function scoreDigits(value) {
    return [...String(value)].map((d) => {
      const span = h("span", "digit", d);
      span.dataset.d = d;
      return span;
    });
  }
})();
