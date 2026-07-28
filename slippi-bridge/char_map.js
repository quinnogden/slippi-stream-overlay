// Maps Slippi ids to TSH codenames — characters and stages.
// IDs match the @slippi/slippi-js Character and Stage enums exactly.
//
// Icon files live at (relative to TSH root):
//   user_data/games/ssbm/base_files/icon/chara_2_{codename}_{costume:02d}.png
//   user_data/games/ssbm/stage_icon/{codename}.png
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

// Slippi stage ID → TSH stage codename. Codenames are the basenames of
// user_data/games/ssbm/stage_icon/*.png, which is also what TSH's
// /scoreboard{N}-set-current-stage endpoint expects.
//
// Covers every stage TSH ships an icon for. Target-test stages (33+) and any
// unknown id resolve to null — the caller skips reporting rather than guessing.
// Note ICETOP (26) shares icicle_mountain: TSH has no separate icetop asset.
const STAGE_MAP = {
  2:  "fountain_of_dreams",
  3:  "pokemon_stadium",
  4:  "peachs_castle",
  5:  "kongo_jungle",
  6:  "brinstar",
  7:  "corneria",
  8:  "yoshis_story",
  9:  "onett",
  10: "mute_city",
  11: "rainbow_cruise",
  12: "jungle_japes",
  13: "great_bay",
  14: "temple",              // Slippi HYRULE_TEMPLE
  15: "brinstar_depths",
  16: "yoshis_island",
  17: "green_greens",
  18: "fourside",
  19: "mushroom_kingdom",
  20: "mushroom_kingdom_ii",
  22: "venom",
  23: "pokefloats",          // Slippi POKE_FLOATS
  24: "big_blue",
  25: "icicle_mountain",
  26: "icicle_mountain",     // Slippi ICETOP — no separate TSH asset
  27: "flat_zone",
  28: "dream_land",          // Slippi DREAMLAND
  29: "yoshis_island_64",
  30: "kong_jungle_64",      // note: TSH spells this "kong", not "kongo"
  31: "battlefield",
  32: "final_destination",
};

/**
 * Resolves a Slippi stage ID to the TSH stage codename.
 * @param {number} stageId — Slippi stage ID from getSettings().stageId
 * @returns {string|null} codename, or null when unmapped
 */
function resolveStage(stageId) {
  return STAGE_MAP[stageId] ?? null;
}

module.exports = { CHAR_MAP, resolveCharacter, STAGE_MAP, resolveStage };
