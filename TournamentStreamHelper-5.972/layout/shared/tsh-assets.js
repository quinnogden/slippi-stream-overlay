/**
 * Shared asset-path helpers for this repo's custom layouts.
 *
 * Lives in layout/shared/ rather than layout/include/ on purpose: include/ is
 * vendored TSH and a version update overwrites it, but layout/ is what gets
 * copied across after an update (see docs/FRESH-INSTALL.md).
 *
 * Every layout here is one directory below layout/, so `../shared/tsh-assets.js`
 * resolves from scoreboard/, side-panel/ and bracket/ alike.
 */
(function (global) {
  "use strict";

  /** Layout HTML sits at layout/<name>/, so user_data is two levels up. */
  var ASSET_ROOT = "../../user_data/games";

  /**
   * Path to a character's icon.
   *
   * The scoreboard, bracket and side panel each used to build this string
   * themselves, two of them hardcoding both the folder and the game id.
   *
   * @param {string} codename — TSH character codename, e.g. "fox"
   * @param {number|string} skin — costume index; padded to 2 digits
   * @param {string} [game="ssbm"] — TSH game id
   * @returns {string|null} null when there is no codename to build from
   */
  function charIconSrc(codename, skin, game) {
    if (!codename) return null;
    var padded = String(skin ?? 0).padStart(2, "0");
    return ASSET_ROOT + "/" + (game || "ssbm") +
           "/base_files/icon/chara_2_" + codename + "_" + padded + ".png";
  }

  /** The filename charIconSrc would end with — for comparing against a live src. */
  function charIconFile(codename, skin) {
    if (!codename) return null;
    return "chara_2_" + codename + "_" + String(skin ?? 0).padStart(2, "0") + ".png";
  }

  global.TshAssets = { charIconSrc: charIconSrc, charIconFile: charIconFile };
})(window);
