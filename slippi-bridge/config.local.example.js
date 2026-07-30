// config.local.example.js
//
// Copy this file to `config.local.js` (same folder) and fill in your secrets.
// config.local.js is gitignored and merged OVER config.js at startup, so any
// key you set here overrides the committed default in config.js.
//
// The only secret today is the start.gg personal access token used by the
// control panel's "Report to start.gg" button:
//   1. Go to https://start.gg/admin/profile/developer
//   2. Click "Create new token", name it (e.g. "stream-bridge"), and copy it.
//      You can only view it once. Tokens expire after 1 year.
//   3. Paste it below and save this file as config.local.js.
//
// If you don't set a token, the bridge still runs normally — the report
// button just disables itself.

module.exports = {
  STARTGG_TOKEN: "",

  // Optional: point the control panel's Singles/Doubles bracket buttons at a
  // different series. The merge is a shallow Object.assign, so setting this
  // replaces the WHOLE object from config.js — copy both event kinds across,
  // not just the one you're changing. (bracket-switch.js fills anything you
  // leave out from its own defaults, but the intent is easier to read here.)
  //
  // BRACKETS: {
  //   shortLink: "my-series",   // the start.gg short link, hyphenated exactly as it appears
  //   events: {
  //     singles: { match: ["melee", "singles"], fallbackSlug: "melee-singles" },
  //     doubles: { match: ["melee", "doubles"], fallbackSlug: "melee-doubles" },
  //   },
  // },
};
