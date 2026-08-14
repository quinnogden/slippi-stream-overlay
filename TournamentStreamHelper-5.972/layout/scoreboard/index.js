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

            SetInnerHtml($(`.p${t + 1}.container .score`), String(team.score));
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

        SetInnerHtml($(`.p${t + 1}.container .score`), String(team.score));

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
