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

  const { h, text, swap, presence, reel, glide, squeeze, fitText, icon } = Overlay;
  const ov = Overlay.connect({ tag: "scoreboard" });

  const sides = [0, 1].map((i) => ({
    card:  document.querySelector(`.player[data-side="${i}"]`),
    chips: document.querySelector(`.chips[data-side="${i}"]`),
  }));
  const q = (root, sel) => (root ? root.querySelector(sel) : null);

  const roundEl = document.querySelector(".match .round");
  // Only index.html has the pill; players.html shows no best-of.
  const bestOfPill = document.querySelector(".best-of-pill");
  const ROUND_MIN_PX = 11; // below this the round stops being legible on stream

  ov.select("scoreboard", (sb) => {
    sb.sides.forEach((side, i) => drawSide(sides[i], side, sb.isDoubles, crewChip(sb.crew, i)));
    drawRound(sb.round || "");
    // The dock's "None" is an empty label, which hides the pill entirely.
    text(q(bestOfPill, ".text"), sb.bestOfLabel || "", { emptyOn: bestOfPill });
  });

  /* ── The logo makes way for the stats popup (players.html) ────────────────
     /o/set-stats's window comes down over the badge's place, so the badge
     sinks back into the round card — the way it rose out of it, under the
     card's edge and its own mask — while the window grows up out of the bar
     (set-stats.js holds the window WINDOW_IN_DELAY for it). Going down, the
     window clears and the badge climbs back out as it does: `backDelay` is
     about when the window's exit is mostly gone. Both pages get the same
     state patch, so the two halves start together. Down only when the popup
     is: shown, with stats to show (it never goes up without them).
     --logo-y is a registered property, so script can animate it; the CSS
     entrance stays as it is underneath (a script animation wins over it). */
  const logo = document.querySelector(".logo");
  const LOGO = { outMs: 280, inMs: 560, backDelay: 380 };
  const popup = { shown: false, available: false };
  let tucked = null;   // null until the first state: a page loaded under the popup starts tucked, unanimated
  let tuckAnims = [];
  let tuckQueued = false;

  function placeLogo() {
    tuckQueued = false;
    const want = popup.shown && popup.available;
    if (want === tucked) return;
    const first = tucked === null;
    tucked = want;
    if (first && !want) return;
    const instant = first || document.body.classList.contains("no-animate");
    const cs = getComputedStyle(logo);
    const y = (cs.getPropertyValue("--logo-y") || "").trim() || "0%";
    const op = cs.opacity || "1";
    tuckAnims.forEach((a) => a.cancel());
    const timing = (dur, delay) => ({
      duration: instant ? 0 : Overlay.motion.ms(dur),
      delay: instant ? 0 : Overlay.motion.ms(delay),
      easing: Overlay.motion.ease("out"),
      fill: "both",
    });
    tuckAnims = want
      ? [logo.animate([{ "--logo-y": y }, { "--logo-y": "100%" }], timing(LOGO.outMs, 0)),
         logo.animate([{ opacity: op }, { opacity: op, offset: 0.6 }, { opacity: "0" }], timing(LOGO.outMs, 0))]
      : [logo.animate([{ "--logo-y": y }, { "--logo-y": "0%" }], timing(LOGO.inMs, LOGO.backDelay)),
         logo.animate([{ opacity: op }, { opacity: "1" }], timing(LOGO.inMs, LOGO.backDelay))];
  }
  /** Both sections arrive in one state message: decide once they have. */
  function queueLogo() {
    if (!logo || !logo.animate || tuckQueued) return;
    tuckQueued = true;
    Promise.resolve().then(placeLogo);
  }
  ov.select("statsShot.shown", (v) => { popup.shown = !!v; queueLogo(); });
  ov.select("setStats.available", (v) => { popup.available = !!v; queueLogo(); });

  /** The round shrinks to fit the card instead of spilling past it. */
  function drawRound(round) {
    swap(roundEl, round, (node) => {
      node.textContent = round;
      node.classList.toggle("empty", !round);
      fitText(node, ROUND_MIN_PX);
    });
  }

  /**
   * A crew battle's crew name, for the chip under the player in. With nobody
   * in, the name card is the crew's name already, so the chip would repeat it.
   */
  function crewChip(crew, i) {
    return crew && crew.active[i] != null ? crew.teams[i].name : "";
  }

  /** A name card's pieces, made once so each can come and go on its own. */
  function nameParts(nameText) {
    if (nameText.__parts) return nameText.__parts;
    const sponsor = h("span", "sponsor empty");
    const prefix = h("span");
    sponsor.append(prefix);
    const tag = h("span", "tag");
    const losers = h("span", "losers empty", "L");
    nameText.replaceChildren(sponsor, tag, losers);
    glide(sponsor, tag, losers);
    return (nameText.__parts = { sponsor, prefix, tag, losers });
  }

  function drawSide(el, side, isDoubles, crewName) {
    const p = side.players[0] ?? {};

    // Name: sponsor prefix + tag in singles; the team name (or the tags) in
    // doubles. [L] in grand finals. Each piece changes on its own — a sponsor
    // or [L] comes and goes whole, a new tag swaps — and what's left slides
    // over to make room, as it does when the character icon beside it arrives.
    const prefix = isDoubles ? "" : p.prefix;
    const name = isDoubles
      ? side.teamName || side.players.map((x) => x.tag).filter(Boolean).join(" / ")
      : p.tag;
    const nameText = q(el.card, ".name .text");
    if (nameText) {
      const part = nameParts(nameText);
      text(part.prefix, prefix || "", { emptyOn: part.sponsor });
      swap(part.tag, name || "", (node) => {
        node.textContent = name || "";
        squeeze(nameText);
      });
      presence(part.losers, !!side.losers);
      nameText.classList.toggle("empty", !name);
      squeeze(nameText);
    }

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
    });

    // The score turns like a reel in its clipped box: up for a game won,
    // down for one taken back.
    reel(q(el.card, ".score .text"), side.score, scoreDigits, { clip: q(el.card, ".score") });

    const chip = q(el.chips, ".pronoun");
    text(q(chip, ".text"), isDoubles ? "" : p.pronoun, { emptyOn: chip });
    const crew = q(el.chips, ".crew");
    text(q(crew, ".text"), crewName, { emptyOn: crew, fit: 12 });
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
