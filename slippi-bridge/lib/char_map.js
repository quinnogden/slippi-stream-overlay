// Maps Slippi character ids to codenames and display names.
// IDs match the @slippi/slippi-js Character enum exactly.
//
// Icon files (TSH's stock icons, kept under TSH's names):
//   overlays/assets/icons/chara_2_{codename}_{costume:02d}.png
// Costume index comes from player.characterColor in getSettings(). Display
// names are what the player DB records mains as (TSH's `mains.ssbm`).

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
 * Slippi character ids in the order of Melee's character select screen, row
 * by row (9 · 10 · 7), Sheik beside Zelda. The dock's picker is laid out this
 * way because it is where an operator's eye already goes for a character.
 */
const CSS_ORDER = [
  22, 8, 7, 5, 12, 17, 1, 0, 25,
  20, 2, 11, 14, 4, 16, 18, 19, 6, 21,
  24, 13, 15, 10, 3, 9, 23,
];

/**
 * Resolves a Slippi character ID + costume to display info.
 *
 * Deliberately returns no icon path: the overlays build `chara_2_{codename}_{skin}.png`
 * themselves (Overlay.icon()), so a path here would be read by nothing.
 *
 * @param {number} charId       - Slippi character ID (0–25)
 * @param {number} costumeIndex - Slippi characterColor field (0-based)
 * @returns {{ codename, display, charId, costumeIndex } | null}
 */
function resolveCharacter(charId, costumeIndex) {
  const char = CHAR_MAP[charId];
  if (!char) return null;

  return {
    charId,
    costumeIndex: costumeIndex ?? 0,
    codename: char.codename,
    display: char.display,
  };
}

/**
 * The scoreboard character for a display name — how the player DB records mains
 * (TSH's `mains.ssbm` entries are `[displayName, skin]`). Case-insensitive.
 *
 * @param {string} name — e.g. "Captain Falcon"
 * @param {number} [skin]
 * @returns {{ codename: string, name: string, skin: number } | null}
 */
function characterByName(name, skin = 0) {
  const want = String(name ?? "").trim().toLowerCase();
  const char = Object.values(CHAR_MAP).find((c) => c.display.toLowerCase() === want);
  return char ? { codename: char.codename, name: char.display, skin: Number(skin) || 0 } : null;
}

module.exports = { CHAR_MAP, CSS_ORDER, resolveCharacter, characterByName };
