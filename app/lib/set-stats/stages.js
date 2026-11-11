/**
 * Melee's stages by Slippi stage id: the name the popup prints and the icon
 * file in a TSH stage_icon pack (served at /assets/stages/, portraits.js).
 */

const STAGES = {
  2:  { name: "Fountain of Dreams",  icon: "fountain_of_dreams" },
  3:  { name: "Pokémon Stadium",     icon: "pokemon_stadium" },
  4:  { name: "Peach's Castle",      icon: "peachs_castle" },
  5:  { name: "Kongo Jungle",        icon: "kongo_jungle" },
  6:  { name: "Brinstar",            icon: "brinstar" },
  7:  { name: "Corneria",            icon: "corneria" },
  8:  { name: "Yoshi's Story",       icon: "yoshis_story" },
  9:  { name: "Onett",               icon: "onett" },
  10: { name: "Mute City",           icon: "mute_city" },
  11: { name: "Rainbow Cruise",      icon: "rainbow_cruise" },
  12: { name: "Jungle Japes",        icon: "jungle_japes" },
  13: { name: "Great Bay",           icon: "great_bay" },
  14: { name: "Hyrule Temple",       icon: "temple" },
  15: { name: "Brinstar Depths",     icon: "brinstar_depths" },
  16: { name: "Yoshi's Island",      icon: "yoshis_island" },
  17: { name: "Green Greens",        icon: "green_greens" },
  18: { name: "Fourside",            icon: "fourside" },
  19: { name: "Mushroom Kingdom",    icon: "mushroom_kingdom" },
  20: { name: "Mushroom Kingdom II", icon: "mushroom_kingdom_ii" },
  22: { name: "Venom",               icon: "venom" },
  23: { name: "Poké Floats",         icon: "pokefloats" },
  24: { name: "Big Blue",            icon: "big_blue" },
  25: { name: "Icicle Mountain",     icon: "icicle_mountain" },
  27: { name: "Flat Zone",           icon: "flat_zone" },
  28: { name: "Dream Land",          icon: "dream_land" },
  29: { name: "Yoshi's Island 64",   icon: "yoshis_island_64" },
  30: { name: "Kongo Jungle 64",     icon: "kong_jungle_64" },
  31: { name: "Battlefield",         icon: "battlefield" },
  32: { name: "Final Destination",   icon: "final_destination" },
};

/** @returns {{ id: number|null, name: string, icon: string|null }} */
function stageOf(id) {
  const s = STAGES[id];
  return s ? { id, name: s.name, icon: s.icon } : { id: id ?? null, name: id == null ? "" : `Stage ${id}`, icon: null };
}

module.exports = { STAGES, stageOf };
