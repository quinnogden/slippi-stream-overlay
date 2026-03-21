// Maps Slippi character IDs to TSH codenames.
// IDs match @slippi/slippi-js Character enum exactly.
//
// Icon files live at (relative to TSH root):
//   user_data/games/ssbm/base_files/icon/chara_2_{codename}_{costume:02d}.png
// Costume index comes from player.costumeIndex in getSettings().

const CHAR_MAP = {
  0:  { codename: "captain_falcon", display: "Captain Falcon"  },
  1:  { codename: "donkey_kong",    display: "Donkey Kong"     },
  2:  { codename: "fox",            display: "Fox"             },
  3:  { codename: "game_and_watch", display: "Mr. Game & Watch"},
  4:  { codename: "kirby",          display: "Kirby"           },
  5:  { codename: "bowser",         display: "Bowser"          },
  6:  { codename: "link",           display: "Link"            },
  7:  { codename: "luigi",          display: "Luigi"           },
  8:  { codename: "mario",          display: "Mario"           },
  9:  { codename: "marth",          display: "Marth"           },
  10: { codename: "mewtwo",         display: "Mewtwo"          },
  11: { codename: "ness",           display: "Ness"            },
  12: { codename: "peach",          display: "Peach"           },
  13: { codename: "pikachu",        display: "Pikachu"         },
  14: { codename: "ice_climbers",   display: "Ice Climbers"    },
  15: { codename: "jigglypuff",     display: "Jigglypuff"      },
  16: { codename: "samus",          display: "Samus"           },
  17: { codename: "yoshi",          display: "Yoshi"           },
  18: { codename: "zelda",          display: "Zelda"           },
  19: { codename: "sheik",          display: "Sheik"           },
  20: { codename: "falco",          display: "Falco"           },
  21: { codename: "young_link",     display: "Young Link"      },
  22: { codename: "dr_mario",       display: "Dr. Mario"       },
  23: { codename: "roy",            display: "Roy"             },
  24: { codename: "pichu",          display: "Pichu"           },
  25: { codename: "ganondorf",      display: "Ganondorf"       },
};

/**
 * Resolves a Slippi character ID + costume to display info and icon path.
 * @param {number} charId       - Slippi character ID (0–25)
 * @param {number} costumeIndex - Slippi characterColor field (0-based)
 * @param {string} tshRoot      - Path to TSH install root
 * @returns {{ codename, display, charId, costumeIndex, iconPath } | null}
 */
function resolveCharacter(charId, costumeIndex, tshRoot) {
  const char = CHAR_MAP[charId];
  if (!char) return null;

  const costume = String(costumeIndex ?? 0).padStart(2, "0");
  const iconPath = `${tshRoot}/user_data/games/ssbm/base_files/icon/chara_2_${char.codename}_${costume}.png`;

  return {
    charId,
    costumeIndex: costumeIndex ?? 0,
    codename: char.codename,
    display: char.display,
    iconPath,
  };
}

module.exports = { CHAR_MAP, resolveCharacter };
