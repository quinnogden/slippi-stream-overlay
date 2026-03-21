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
    let oldData = event.oldData;

    let isTeams = Object.keys(data.score[window.scoreboardNumber].team["1"].player).length > 1;

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

            SetInnerHtml(
              $(`.p${t + 1} .flagcountry`),
              player.country.asset
                ? `
                  <div class='flag' style='background-image: url(../../${player.country.asset.toLowerCase()})'></div>
                  <div>${player.country.code}</div>
                `
                : ""
            );

            SetInnerHtml(
              $(`.p${t + 1} .flagstate`),
              player.state.asset
                ? `
                  <div class='flag' style='background-image: url(../../${player.state.asset})'></div>
                  <div>${player.state.code}</div>
                `
                : ""
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
              $(`.p${t + 1}.container .sponsor_icon`),
              player.sponsor_logo
                ? `<div style="background-image: url('../../${player.sponsor_logo}')"></div>`
                : ""
            );

            SetInnerHtml(
              $(`.p${t + 1}.container .avatar`),
              player.avatar
                ? `<div style="background-image: url('../../${player.avatar}')"></div>`
                : ""
            );

            SetInnerHtml(
              $(`.p${t + 1}.container .online_avatar`),
              player.online_avatar
                ? `<div style="background-image: url('${player.online_avatar}')"></div>`
                : ""
            );

            SetInnerHtml(
              $(`.p${t + 1} .twitter`),
              player.twitter
                ? `<span class="twitter_logo"></span>${String(player.twitter)}`
                : ""
            );

            SetInnerHtml(
              $(`.p${t + 1} .pronoun`),
              player.pronoun ? player.pronoun : ""
            );

            SetInnerHtml(
              $(`.p${t + 1} .seed`),
              player.seed ? `Seed ${player.seed}` : ""
            );

            SetInnerHtml($(`.p${t + 1}.container .score`), String(team.score));

            SetInnerHtml(
              $(`.p${t + 1}.container .sponsor-container`),
              `<div class='sponsor-logo' style="background-image: url('../../${player.sponsor_logo}')"></div>`
            );

            if ($(".sf6.online").length > 0) {
              console.log(player.twitter);
              console.log(player.pronoun);
              if (!player.twitter && !player.pronoun) {
                gsap.to($(`.p${t + 1}.chips`), { autoAlpha: 0 });
              } else {
                gsap.to($(`.p${t + 1}.chips`), { autoAlpha: 1 });
              }
            }
          }
        }
        const _charEl = document.querySelector(`.p${t + 1}.container .character_container`);
        if (_charEl) {
          // For single-player mode we do not render the color swatch; only set score vars.
          if (team.color && !tsh_settings["forceDefaultScoreColors"]) {
            document.querySelector(':root').style.setProperty(`--p${t + 1}-score-bg-color`, team.color);
          }
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

        SetInnerHtml($(`.p${t + 1} .flagcountry`), "");

        SetInnerHtml($(`.p${t + 1} .flagstate`), "");

        // await CharacterDisplay(
        //   $(`.p${t + 1}.container .character_container`),
        //   {
        //     asset_key: "base_files/icon",
        //     source: `score.${window.scoreboardNumber}.team.${t + 1}`,
        //     slice_character: [0, 1],
        //     scale_fill_x: true,
        //     scale_fill_y: true,
        //     custom_zoom: 1.0
        //   },
        //   event
        // );

        SetInnerHtml($(`.p${t + 1}.container .sponsor_icon`), "");

        SetInnerHtml($(`.p${t + 1}.container .avatar`), "");

        SetInnerHtml($(`.p${t + 1}.container .online_avatar`), "");

        SetInnerHtml($(`.p${t + 1} .twitter`), 
          playerNames != team.teamName ? playerNames : ""
        );

        SetInnerHtml($(`.p${t + 1}.container .score`), String(team.score));

        SetInnerHtml($(`.p${t + 1}.container .sponsor-container`), "");

        const _charEl = document.querySelector(`.p${t + 1}.container .character_container`);
        if (_charEl) {
          // In team-mode, show the team-color swatch when a team color is provided.
          if (team.color) {
            document.querySelector(':root').style.setProperty(`--p${t + 1}-score-bg-color`, team.color);
            _charEl.classList.add("team-color");
            _charEl.style.setProperty("--team-color", team.color);
          } else {
            _charEl.classList.remove("team-color");
            _charEl.style.removeProperty("--team-color");
          }
        }
      }
    }

    SetInnerHtml($(".tournament_name"), data.tournamentInfo.tournamentName);

    let matchHtml = '<div style="display: flex; flex-direction: column; width: 100%; text-align: center;">';
    if (data.score[window.scoreboardNumber].match) {
      matchHtml += `<div>${data.score[window.scoreboardNumber].match}</div>`;
    }
    if (data.score[window.scoreboardNumber].best_of_text) {
      matchHtml += `<div style="font-size: 0.7em; margin-top: 4px;">${data.score[window.scoreboardNumber].best_of_text}</div>`;
    }
    matchHtml += '</div>';
    SetInnerHtml($(".match"), matchHtml);

    SetInnerHtml($(".phase"), data.score[window.scoreboardNumber].phase);
  };

  // ── Slippi Bridge integration ────────────────────────────────────────────────
  // Connects to the slippi-bridge Socket.io server (port 5001).
  // Gracefully no-ops when the bridge is not running.
  (function initSlippiBridge() {
    // io() is only available after the bridge's socket.io.js has loaded.
    // We poll briefly to catch the async script load from melee.html.
    function tryConnect(attemptsLeft) {
      if (typeof io === "undefined") {
        if (attemptsLeft > 0) {
          setTimeout(() => tryConnect(attemptsLeft - 1), 300);
        }
        return;
      }

      const slippiSocket = io("http://localhost:5001", {
        reconnectionDelay: 5000,
        reconnectionDelayMax: 30000,
      });

      slippiSocket.on("connect", () => {
        console.log("[slippi-bridge] Connected");
      });

      // Game start: TSH sets the character via its API (correct icon),
      // but defaults to costume 0. We store Slippi's costume data and
      // patch the rendered img src after each TSH update to show the
      // actual costume the player is using.
      let slippiGameData = null;

      function applySlippiCostumes() {
        if (!slippiGameData) return;
        for (const [, pData] of Object.entries(slippiGameData.players)) {
          const costume = String(pData.costumeIndex ?? 0).padStart(2, "0");
          const costumedSrc = `../../user_data/games/ssbm/base_files/icon/chara_2_${pData.codename}_${costume}.png`;
          const container = document.querySelector(`.p${pData.teamNum}.container .character_container`);
          if (!container) continue;
          const img = container.querySelector("img");
          if (img && !img.src.endsWith(`chara_2_${pData.codename}_${costume}.png`)) {
            img.src = costumedSrc;
          }
        }
      }

      slippiSocket.on("slippi_game_start", (data) => {
        console.log("[slippi-bridge] Game start:", data);
        slippiGameData = data;
        // TSH will render the character icon shortly via tsh_update.
        // applySlippiCostumes() will patch the src once it's in the DOM.
      });

      // After every TSH state update, correct the costume if needed.
      // Small delay lets assetUtils.js finish rendering before we patch.
      document.addEventListener("tsh_update", () => {
        if (slippiGameData) setTimeout(applySlippiCostumes, 150);
      });

      // Game end: score was already incremented by the bridge via TSH HTTP API.
      // Optionally add a visual cue here (e.g. flash the winner's score).
      slippiSocket.on("slippi_game_end", (data) => {
        console.log("[slippi-bridge] Game end, winner team:", data.winner);
        // TSH score update arrives via the normal tsh_update event shortly after.
        // No DOM changes needed here unless you want an animation.
      });

      slippiSocket.on("disconnect", () => {
        console.log("[slippi-bridge] Disconnected — waiting to reconnect");
      });

      slippiSocket.on("connect_error", () => {
        // Bridge not running — fail silently. TSH still works normally.
      });
    }

    tryConnect(10); // try up to ~3 seconds for the async script to load
  })();
});
