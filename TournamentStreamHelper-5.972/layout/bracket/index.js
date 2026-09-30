LoadEverything().then(() => {
  gsap.config({ nullTargetWarn: false, trialWarn: false });

  /**
   * One player row in a bracket slot.
   *
   * Only .name, .char_icon and .score are ever populated — the avatar, sponsor,
   * flag and character_container divs this used to emit were never filled, so
   * they were pure markup weight repeated twice per player.
   *
   * @param {number} p — slot position, 0 or 1
   * @param {string|number} [playerId] — winners side only; losers rows omit it
   */
  function buildSlotHtml(p, playerId) {
    const idClass = playerId === undefined ? "" : `p_${playerId} `;
    return `
      <div class="${idClass}slot_p_${p} player container">
        <div class="name_twitter">
          <div class="name"></div>
        </div>
        <div class="char_icon"></div>
        <div class="score">0</div>
      </div>
    `;
  }

  // TSH calls Start() on load. The bracket has no intro animation — entryAnim
  // below plays as the rounds are built — so there is nothing to restart.
  Start = async () => {};

  var entryAnim = gsap.timeline();
  var animations = {};

  function AnimateLine(element) {
    let anim = null;

    if (element && element.get(0)) {
      element = element.get(0);
      let length = element.getTotalLength();
      anim = gsap.from(
        element,
        {
          duration: 0.4,
          "stroke-dashoffset": length,
          "stroke-dasharray": length,
          opacity: 0,
          onUpdate: function (tl) {
            let tlp = (this.progress() * 100) >> 0;
            if (element) {
              let length = element.getTotalLength();
              TweenMax.set(element, {
                "stroke-dashoffset": (length / 100) * (100 - tlp),
                "stroke-dasharray": length,
                opacity: 1,
              });
            }
          },
          onUpdateParams: ["{self}"],
        },
        0
      );
    }

    return anim;
  }

  function AnimateElement(roundKey, setIndex, set, bracket, progressionsOut) {
    let isGf = false;
    let isGfR = false;
    let GfResetRoundNum = 0;

    if (progressionsOut == 0) {
      GfResetRoundNum = Math.max.apply(
        null,
        Object.keys(bracket).map((r) => parseInt(r))
      );

      isGf = parseInt(roundKey) == GfResetRoundNum - 1;
      isGfR = parseInt(roundKey) == GfResetRoundNum;
    }

    if (animations[roundKey][setIndex]) {
      if (window.ALWAYS_EXPAND) {
        // Hide incomplete sets (-1), but not pending (-2)
        if (
          (set.playerId[0] == -1 && set.playerId[1] != -1) ||
          (set.playerId[0] != -1 && set.playerId[1] == -1)
        ) {
          return animations[roundKey][setIndex].tweenTo("hidden");
        }

        if (!isGf && !isGfR)
          return animations[roundKey][setIndex].tweenTo("done");

        if (isGf) {
          if (set.score[0] >= set.score[1] || !set.completed) {
            return animations[roundKey][setIndex].tweenTo("displayed");
          } else {
            return animations[roundKey][setIndex].tweenTo("done");
          }
        }

        if (
          progressionsOut == 0 &&
          isGfR &&
          bracket[GfResetRoundNum - 1].sets[0].score[0] <
            bracket[GfResetRoundNum - 1].sets[0].score[1] &&
          bracket[GfResetRoundNum - 1].sets[0].completed
        ) {
          return animations[roundKey][setIndex].tweenTo("displayed");
        } else {
          return animations[roundKey][setIndex].tweenTo("hidden");
        }
      } else {
        if (
          (set.playerId[0] == -2 && set.playerId[1] == -2) ||
          (set.playerId[0] == -1 && set.playerId[1] != -1) ||
          (set.playerId[0] != -1 && set.playerId[1] == -1) ||
          (progressionsOut == 0 &&
            isGfR &&
            bracket[GfResetRoundNum - 1].sets[0].score[0] >
              bracket[GfResetRoundNum - 1].sets[0].score[1])
        ) {
          return animations[roundKey][setIndex].tweenTo("hidden");
        } else if (!set.completed || (isGf && set.score[0] >= set.score[1])) {
          return animations[roundKey][setIndex].tweenTo("displayed");
        } else {
          return animations[roundKey][setIndex].tweenTo("done");
        }
      }
    }
    return null;
  }

  Update = async (event) => {
    let data = event.data;
    let oldData = event.oldData;

    if (
      !oldData || !oldData.bracket ||
      JSON.stringify(data.bracket.bracket) !=
        JSON.stringify(oldData.bracket.bracket)
    ) {
      let bracket = data.bracket.bracket.rounds;
      let players = data.bracket.players.slot;

      let progressionsOut = data.bracket.bracket.progressionsOut;
      let progressionsIn = data.bracket.bracket.progressionsIn;
      let winnersOnlyProgressions =
        data.bracket.bracket.winnersOnlyProgressions;

      let biggestRound = Math.max.apply(
        null,
        Object.values(bracket).map((r) => {
          const setMap = Object.values(r.sets).map((s) => {
            return s.playerId[0] == -1 || s.playerId[1] == -1 ? 0 : 1;
          });
          return setMap.reduce(function (result, item) {
            return result + item;
          }, 0);
        })
      );

      let containerSize = $(".winners_container").height();
      if (window.LOSERS_ONLY) containerSize = $(".losers_container").height();

      // The largest row height (capped at 32) for which the busiest round's
      // rows — two per set plus 4px — still fit the container with 20px spare.
      // This used to step down a pixel at a time, writing and re-reading the
      // CSS variable on each step; the closed form lands on the same integer.
      let size = 32;
      if (biggestRound > 0) {
        size = Math.min(32, Math.floor(((containerSize - 20) / biggestRound - 4) / 2));
      }
      $(":root").css("--player-height", size);
      $(":root").css("--name-size", Math.min(size - size * 0.42, 20));
      $(":root").css("--score-size", size - size * 0.25);

      if (
        !oldData.bracket ||
        Object.keys(oldData.bracket.players).length !=
          Object.keys(data.bracket.players).length ||
        progressionsIn != _.get(oldData, "bracket.bracket.progressionsIn") ||
        progressionsOut != _.get(oldData, "bracket.bracket.progressionsOut") ||
        Object.keys(oldData.bracket.bracket.rounds).length !=
          Object.keys(data.bracket.bracket.rounds).length ||
        _.get(oldData, "bracket.phase") != _.get(data, "bracket.phase") ||
        _.get(oldData, "bracket.phaseGroup") !=
          _.get(data, "bracket.phaseGroup")
      ) {
        // WINNERS SIDE
        let html = "";

        let winnersRounds = Object.fromEntries(
          Object.entries(bracket).filter(([round]) => parseInt(round) > 0)
        );

        Object.entries(winnersRounds).forEach(([roundKey, round], r) => {
          html += `<div class="round round_${roundKey}">`;
          html += `<div class="round_name"></div>`;
          Object.values(round.sets).forEach((slot, i) => {
            html += `<div class="slot slot_${i + 1}">`;
            Object.values(slot.playerId).forEach((playerId, p) => {
              html += buildSlotHtml(p, playerId);
            });
            html += "</div>";
          });
          html += "</div>";
        });

        $(".winners_container").html(html);

        let losersRounds = Object.fromEntries(
          Object.entries(bracket).filter(([round]) => parseInt(round) < 0)
        );

        // LOSERS SIDE
        if (!window.WINNERS_ONLY) {
          html = "";

          Object.entries(losersRounds).forEach(([roundKey, round], r) => {
            html += `<div class="round round_${roundKey}">`;
            html += `<div class="round_name"></div>`;
            Object.values(round.sets).forEach((slot, i) => {
              html += `<div class="slot slot_${i + 1}">`;
              Object.values(slot.playerId).forEach((_playerId, p) => {
                html += buildSlotHtml(p);
              });
              html += "</div>";
            });
            html += "</div>";
          });

          $(".losers_container").html(html);
        }

        // BRACKET LINES
        // .line_r_(round) = Line going from (round) set to the next set
        let slotLines = "";

        let baseClass = "winners_container";

        Object.entries(bracket).forEach(function ([roundKey, round], r) {
          if (parseInt(roundKey) < 0) {
            baseClass = "losers_container";
          } else {
            baseClass = "winners_container";
          }

          Object.values(round.sets).forEach(
            function (slot, i) {
              let lastLosers =
                parseInt(roundKey) ==
                Math.min.apply(
                  null,
                  Object.keys(bracket).map((r) => parseInt(r))
                );

              if (
                slot.nextWin &&
                !(
                  slot.playerId[0] > Object.keys(players).length ||
                  slot.playerId[1] > Object.keys(players).length ||
                  slot.playerId[0] == -1 ||
                  slot.playerId[1] == -1
                )
              ) {
                if (window.WINNERS_ONLY && parseInt(roundKey) < 0) return;
                if (window.LOSERS_ONLY && parseInt(roundKey) > 0) return;

                let slotElement = $(
                  `.${this.baseClass} .round_${roundKey} .slot_${i + 1}`
                );

                if (!slotElement || !slotElement.offset()) return;

                let winElement = $(
                  `.${this.baseClass} .round_${slot.nextWin[0]} .slot_${
                    slot.nextWin[1] + 1
                  }`
                );

                if (winElement && winElement.offset()) {
                  slotLines += `<path class="line ${
                    this.baseClass
                  } line_r_${roundKey} s_${i + 1}" d="
                  M${[
                    slotElement.offset().left + slotElement.outerWidth(),
                    slotElement.offset().top + slotElement.outerHeight() / 2,
                  ].join(" ")}
                  ${[
                    [
                      slotElement.offset().left +
                        slotElement.outerWidth() +
                        (winElement.offset().left -
                          (slotElement.offset().left +
                            slotElement.outerWidth())) /
                          2,
                      slotElement.offset().top + slotElement.outerHeight() / 2,
                    ],
                    [
                      slotElement.offset().left +
                        slotElement.outerWidth() +
                        (winElement.offset().left -
                          (slotElement.offset().left +
                            slotElement.outerWidth())) /
                          2,
                      winElement.offset().top + winElement.outerHeight() / 2,
                    ],
                    [
                      winElement.offset().left,
                      winElement.offset().top + winElement.outerHeight() / 2,
                    ],
                  ]
                    .map((point) => point.join(" "))
                    .map((point) => "L" + point)
                    .join(" ")}"
                  stroke="black" fill="none" stroke-width="5" />`;
                }

                // Lines for progressions in
                if (
                  progressionsIn > 0 &&
                  ((parseInt(roundKey) > 0 && parseInt(roundKey) == 1) ||
                    (parseInt(roundKey) < 0 &&
                      Math.abs(parseInt(roundKey)) == 1 &&
                      !winnersOnlyProgressions))
                ) {
                  slotLines += `<path class="line ${this.baseClass} line_in_r_${
                    Math.sign(parseInt(roundKey)) * Math.abs(parseInt(roundKey))
                  } s_${i + 1}" d="
                  M${[
                    slotElement.offset().left - 50,
                    slotElement.offset().top + slotElement.outerHeight() / 2,
                  ].join(" ")}
                  ${[
                    [
                      slotElement.offset().left,
                      slotElement.offset().top + slotElement.outerHeight() / 2,
                    ],
                  ]
                    .map((point) => point.join(" "))
                    .map((point) => "L" + point)
                    .join(" ")}"
                  fill="none" />`;
                }

                // Lines for progressions out
                if (
                  progressionsOut > 0 &&
                  ((parseInt(roundKey) > 0 &&
                    parseInt(roundKey) == Object.keys(winnersRounds).length) ||
                    (parseInt(roundKey) < 0 &&
                      Math.abs(parseInt(roundKey)) ==
                        Object.keys(losersRounds).length))
                ) {
                  slotLines += `<path class="line ${
                    this.baseClass
                  } line_out_r_${roundKey} s_${i + 1}" d="
                  M${[
                    slotElement.offset().left + slotElement.outerWidth(),
                    slotElement.offset().top + slotElement.outerHeight() / 2,
                  ].join(" ")}
                  ${[
                    [
                      slotElement.offset().left + slotElement.outerWidth() + 45,
                      slotElement.offset().top + slotElement.outerHeight() / 2,
                    ],
                  ]
                    .map((point) => point.join(" "))
                    .map((point) => "L" + point)
                    .join(" ")}
                  M${[
                    slotElement.offset().left + slotElement.outerWidth() + 35,
                    slotElement.offset().top +
                      slotElement.outerHeight() / 2 -
                      8,
                  ].join(" ")}
                  ${[
                    [
                      slotElement.offset().left + slotElement.outerWidth() + 45,
                      slotElement.offset().top + slotElement.outerHeight() / 2,
                    ],
                    [
                      slotElement.offset().left + slotElement.outerWidth() + 35,
                      slotElement.offset().top +
                        slotElement.outerHeight() / 2 +
                        8,
                    ],
                  ]
                    .map((point) => point.join(" "))
                    .map((point) => "L" + point)
                    .join(" ")}"
                  fill="none" />`;
                }
              }
            },
            { baseClass: baseClass }
          );
        });

        $(".lines").html(slotLines);

        // ANIMATIONS
        animations = {};

        entryAnim = gsap.timeline();

        let GfResetRoundNum = Math.max.apply(
          null,
          Object.keys(bracket).map((r) => parseInt(r))
        );

        Object.entries(bracket).forEach(function ([roundKey, round], r) {
          animations[roundKey] = {};
          Object.values(round.sets).forEach((set, setIndex) => {
            let isGfR = parseInt(roundKey) == GfResetRoundNum;

            let anim = gsap.timeline();

            anim.addLabel("hidden");

            anim.add(
              AnimateLine($(`.line_in_r_${roundKey}.s_${setIndex + 1}`)),
              0
            );

            if (isGfR && progressionsOut == 0) {
              anim.from(
                $(`.round_${roundKey} .round_name`),
                { autoAlpha: 0, duration: 0.4 },
                0.5
              );
            }

            anim.from(
              $(`.round_${roundKey} .slot_${setIndex + 1}`),
              { x: -50, autoAlpha: 0, duration: 0.4 },
              0.5
            );

            anim.addLabel("displayed");

            anim.add(
              AnimateLine($(`.line_r_${roundKey}.s_${setIndex + 1}`)),
              0.9
            );
            anim.add(
              AnimateLine($(`.line_out_r_${roundKey}.s_${setIndex + 1}`)),
              1.4
            );

            anim.addLabel("over");

            animations[roundKey][setIndex] = anim;
            anim.pause();

            entryAnim.add(
              AnimateElement(roundKey, setIndex, set, bracket, progressionsOut),
              Math.abs(parseInt(roundKey)) * 0.6
            );
          });
        });

        entryAnim.play(0);
      }

      // TRIGGER ANIMATIONS
      if (entryAnim && entryAnim.progress() >= 1) {
        Object.entries(bracket).forEach(function ([roundKey, round], r) {
          Object.values(round.sets).forEach((set, setIndex) => {
            AnimateElement(roundKey, setIndex, set, bracket, progressionsOut);
          });
        });
      }

      // UPDATE SCORES
      // Dims the loser of a finished set. The inline filter is what renders;
      // .winner / .loser are left on the rows as hooks for a theme pack.
      // winner: 0 or 1 for a decided set, null to clear both rows.
      const markResult = (slotSel, winner) => {
        [0, 1].forEach((p) => {
          const row = $(`${slotSel} .slot_p_${p}.container`);
          if (winner === null) {
            row.css("filter", "brightness(1)").removeClass("winner loser");
          } else if (p === winner) {
            row.css("filter", "brightness(1)").addClass("winner").removeClass("loser");
          } else {
            row.css("filter", "brightness(0.6)").addClass("loser").removeClass("winner");
          }
        });
      };

      Object.entries(bracket).forEach(([roundKey, round]) => {
        const side = parseInt(roundKey) < 0 ? "losers_container" : "winners_container";
        const roundSel = `.${side} .round_${parseInt(roundKey)}`;

        SetInnerHtml($(`${roundSel} .round_name`), round.name);

        Object.values(round.sets).forEach((slot, i) => {
          const slotSel = `${roundSel} .slot_${i + 1}`;

          Object.values(slot.score).forEach((score, p) => {
            SetInnerHtml(
              $(`${slotSel} .slot_p_${p}.container .score`),
              `
                  ${slot.completed ? (score == -1 ? "DQ" : score) : ""}
                `
            );
          });

          // score is indexed, not necessarily an array — hence no destructuring.
          const s0 = slot.score[0], s1 = slot.score[1];
          const winner = !slot.completed ? null : s0 > s1 ? 0 : s1 > s0 ? 1 : null;
          markResult(slotSel, winner);
        });
      });

      // UPDATE PLAYER DATA
      for (const [roundKey, round] of Object.entries(bracket)) {
        for (const [setIndex, set] of Object.entries(round.sets)) {
          for (const [index, pid] of set.playerId.entries()) {
            let element = $(
              `.round_${roundKey} .slot_${
                parseInt(setIndex) + 1
              } .slot_p_${index}`
            ).get(0);

            if (!element) continue;

            let team = players[pid];

            if (!team) {
              SetInnerHtml($(element).find(`.name`), "");
              continue;
            }

            if (Object.values(team.player).length == 1) {
              // Singles
              let player = null;

              if (players[pid]) player = players[pid].player["1"];

              SetInnerHtml(
                $(element).find(`.name`),
                `
                  <span>
                    <span class="sponsor">
                      ${player && player.team ? player.team : ""}
                    </span>
                    ${player ? await Transcript(player.name) : ""}
                  </span>
                `
              );

              let charData = player && player.character && player.character["1"];
              let iconSrc = charData
                ? TshAssets.charIconSrc(charData.codename, charData.skin)
                : null;
              SetInnerHtml($(element).find(".char_icon"),
                iconSrc ? `<img src="${iconSrc}">` : "");

            } else {
              // Doubles/Teams
              let teamName = team.name;

              if (!teamName || teamName == "") {
                let names = [];
                // Blank slots are skipped, or a half-entered team reads "A / ".
                for (const player of Object.values(team.player)) {
                  if (player && player.name) {
                    names.push(await Transcript(player.name));
                  }
                }
                teamName = names.join(" / ");
              }

              SetInnerHtml(
                $(element).find(`.name`),
                `
                  <span>
                    ${teamName}
                  </span>
                `
              );

              SetInnerHtml($(element).find(".char_icon"), "");
            }
          }
        }
      }

      SetInnerHtml($(`.tournament_name`), data.tournamentInfo.tournamentName);
      SetInnerHtml($(`.event_name`), data.tournamentInfo.eventName);
    }
  };
});
