LoadEverything().then(() => {

  var durationTime = 2;
  
  gsap.config({ nullTargetWarn: false, trialWarn: false });

  let startingAnimation = gsap
    .timeline({ paused: true })
    .from(
      [".fade"],
      {
        duration: durationTime,
        autoAlpha: 0,
        ease: "power2.out",
      },
      0
    )
    .from(
      [".fade_down_left_stagger:not(.text_empty)"],
      {
        autoAlpha: 0,
        stagger: {
          each: 0.05,
          from: 'end',
          opacity: 0,
          y: "-20px",
        },
        duration: durationTime,
      },
      0
    )
    .from(
      [".fade_down_right_stagger:not(.text_empty)"],
      {
        autoAlpha: 0,
        stagger: {
          each: 0.05,
          from: 'end',
          opacity: 0,
          y: "-20px",
        },
        duration: durationTime,
      },
      0
    )
    .from(
      [".p1 .fade_stagger:not(.text_empty)"],
      {
        autoAlpha: 0,
        stagger: {
          each: 0.05,
          from: 'end',
          opacity: 0,
        },
        duration: durationTime,
      },
      0
    )
    .from(
      [".p2 .fade_stagger:not(.text_empty)"],
      {
        autoAlpha: 0,
        stagger: {
          each: 0.05,
          from: 'end',
          opacity: 0,
        },
        duration: durationTime,
      },
      0
    )
    .from(
      [".p1 .fade_stagger_reverse:not(.text_empty)"],
      {
        autoAlpha: 0,
        stagger: {
          each: 0.05,
          from: 'start',
          opacity: 0,
        },
        duration: durationTime,
      },
      0
    )
    .from(
      [".p2 .fade_stagger_reverse:not(.text_empty)"],
      {
        autoAlpha: 0,
        stagger: {
          each: 0.05,
          from: 'start',
          opacity: 0,
        },
        duration: durationTime,
      },
      0
    )
    .from(
      [".fade_right_stagger:not(.text_empty)"],
      {
        autoAlpha: 0,
        stagger: {
          each: 0.05,
          from: 'end',
          opacity: 0,
        },
        duration: durationTime,
      },
      0
    )
    .from(
      [".fade_down"],
      {
        duration: durationTime,
        y: "-20px",
        ease: "power2.out",
        autoAlpha: 0,
      },
      0
    )
    .from(
      [".fade_right"],
      {
        duration: durationTime,
        x: "-20px",
        ease: "power2.out",
        autoAlpha: 0,
      },
      0
    )
    .from(
      [".fade_left"],
      {
        duration: durationTime,
        x: "+20px",
        ease: "power2.out",
        autoAlpha: 0,
      },
      0
    )
    .from(
      [".fade_up"],
      {
        duration: durationTime,
        y: "+20px",
        ease: "power2.out",
        autoAlpha: 0,
      },
      0
    )

  Start = async () => {
    startingAnimation.restart();
  };

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

     Degrades to today's behaviour: an unsupported metric gives NaN, the guard
     skips it, and the var falls back to 0. */
  async function CalibrateScoreDigits() {
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

  CalibrateScoreDigits();

  /* Per-digit because the 0 needs its own figure. Crew battles also put stock
     totals like "10" and "20" in this box, so the wrap has to be per glyph
     rather than a single offset on the container.
     data-d rather than an inline style deliberately: SetInnerHtml re-runs its
     fade whenever the serialized HTML differs from what is already there, so
     anything the browser might normalise on the way back out would re-animate
     the score on every TSH state push. A bare attribute round-trips verbatim. */
  function ScoreHtml(value) {
    return String(value).replace(/[0-9]/g, (d) => `<span class="digit" data-d="${d}">${d}</span>`);
  }

  Update = async (event) => {
    let data = event.data;

    let playerCount = Object.keys(data.score[window.scoreboardNumber].team["1"].player).length;
    let isTeams     = playerCount > 1;

    if (!isTeams) {
      for (const [t, team] of [
        data.score[window.scoreboardNumber].team["1"],
        data.score[window.scoreboardNumber].team["2"],
      ].entries()) {
        for (const [p, player] of [team.player["1"]].entries()) {
          if (player) {
            SetInnerHtml(
              $(`.p${t + 1}.container .name`),
              `
                <span class="sponsor">
                  ${player.team ? player.team : ""}
                </span>
                ${await Transcript(player.name)}
                ${team.losers ? "<span class='losers'>L</span>" : ""}
              `
            );

            await CharacterDisplay(
              $(`.p${t + 1}.container .character_container`),
              {
                asset_key: "base_files/icon",
                source: `score.${window.scoreboardNumber}.team.${t + 1}`,
                scale_fill_x: true,
                scale_fill_y: true,
                custom_zoom: 1.0
              },
              event
            );

            SetInnerHtml(
              $(`.p${t + 1} .pronoun`),
              player.pronoun ? player.pronoun : ""
            );

            SetInnerHtml($(`.p${t + 1}.container .score`), ScoreHtml(team.score));
          }
        }
        const _charEl = document.querySelector(`.p${t + 1}.container .character_container`);
        if (_charEl) {
          // Singles never shows the team-color swatch.
          _charEl.classList.remove("team-color");
          _charEl.style.removeProperty("--team-color");
        }
      }
    } else {
      for (const [t, team] of [
        data.score[window.scoreboardNumber].team["1"],
        data.score[window.scoreboardNumber].team["2"],
      ].entries()) {
        let teamName = team.teamName;

        let names = [];
        for (const [p, player] of Object.values(team.player).entries()) {
          if (player && player.name) {
            names.push(await Transcript(player.name));
          }
        }
        let playerNames = names.join(" / ");

        if (!team.teamName || team.teamName == "") {
          teamName = playerNames;
        }

        SetInnerHtml(
          $(`.p${t + 1}.container .name`),
          `
            ${teamName}
            ${team.losers ? "<span class='losers'>L</span>" : ""}
          `
        );

        // Doubles has no per-player character icon — the team-color swatch below
        // replaces it.
        SetInnerHtml($(`.p${t + 1}.container .character_container`), "");

        SetInnerHtml($(`.p${t + 1}.container .score`), ScoreHtml(team.score));

        const _charEl = document.querySelector(`.p${t + 1}.container .character_container`);
        if (_charEl) {
          // In team-mode, show the team-color swatch when a team color is provided.
          if (team.color) {
            _charEl.classList.add("team-color");
            _charEl.style.setProperty("--team-color", team.color);
          } else {
            _charEl.classList.remove("team-color");
            _charEl.style.removeProperty("--team-color");
          }
        }
      }
    }

    let matchHtml = '<div style="display: flex; flex-direction: column; width: 100%; text-align: center;">';
    if (data.score[window.scoreboardNumber].match) {
      matchHtml += `<div>${data.score[window.scoreboardNumber].match}</div>`;
    }
    if (data.score[window.scoreboardNumber].best_of_text) {
      matchHtml += `<div style="font-size: 0.7em; margin-top: 4px;">${data.score[window.scoreboardNumber].best_of_text}</div>`;
    }
    matchHtml += '</div>';
    SetInnerHtml($(".match"), matchHtml);
  };

  // ── Slippi Bridge integration ────────────────────────────────────────────────
  // TSH sets the character via its own API (correct icon) but always defaults to
  // costume 0. We keep Slippi's costume data and patch the rendered <img> src
  // after each TSH update so the icon matches what the player actually picked.
  //
  // The socket plumbing lives in ../shared/slippi-bridge-client.js; this no-ops
  // when the bridge isn't running.
  let slippiGameData = null;

  function applySlippiCostumes() {
    if (!slippiGameData) return;
    // If TSH is currently in doubles/teams mode (any container has team-color),
    // clear leftover icons and skip singles patching — even if slippiGameData
    // still holds stale singles data from before the TSH config switch.
    const inTeamsMode = !!document.querySelector(".character_container.team-color");
    if (slippiGameData.isDoubles || inTeamsMode) {
      document.querySelectorAll(".character_container img").forEach((img) => {
        img.removeAttribute("src");
      });
      return;
    }
    for (const [, pData] of Object.entries(slippiGameData.players)) {
      const container = document.querySelector(`.p${pData.teamNum}.container .character_container`);
      if (!container) continue;
      const img = container.querySelector("img");
      const wanted = TshAssets.charIconFile(pData.codename, pData.costumeIndex);
      if (img && wanted && !img.src.endsWith(wanted)) {
        img.src = TshAssets.charIconSrc(pData.codename, pData.costumeIndex);
      }
    }
  }

  // After every TSH state update, correct the costume if needed. The small delay
  // lets assetUtils.js finish rendering before we patch.
  document.addEventListener("tsh_update", () => {
    if (slippiGameData) setTimeout(applySlippiCostumes, 150);
  });

  // meleePlayers.html shares this file but is a name-only list with no
  // .character_container, so it doesn't load the shared bridge client at all.
  if (typeof SlippiBridge !== "undefined") {
    SlippiBridge.connectBridge({
      // TSH renders the character icon shortly after, via tsh_update;
      // applySlippiCostumes() patches the src once it's in the DOM.
      slippi_game_start: (data) => { slippiGameData = data; },
      // Game end needs no DOM work: the bridge already incremented the score
      // through TSH's HTTP API, and that arrives as a normal tsh_update.
    }, { tag: "scoreboard" });
  }
});
