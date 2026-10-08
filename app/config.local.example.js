// config.local.example.js
//
// Copy this file to `config.local.js` (same folder) and fill in your secrets.
// config.local.js is gitignored and merged OVER config.js at startup, so any
// key you set here overrides the committed default in config.js.
//
// The only secret today is the start.gg personal access token (Start, Report
// and the side panel's stats):
//   1. Go to https://start.gg/admin/profile/developer
//   2. Click "Create new token", name it (e.g. "stream-bridge"), and copy it.
//      You can only view it once. Tokens expire after 1 year.
//   3. Paste it below and save this file as config.local.js.
//
// Without a token the app still runs: brackets load through start.gg's web
// endpoint, and Start / Report / stats are off.

module.exports = {
  STARTGG_TOKEN: "",

  // Optional: a luckystats.gg API key — the side panel's Lucky Rank, class,
  // Elo and win projection. Create one in your luckystats.gg account settings
  // (the account must be claimed). Without it those cards just don't appear.
  LUCKYSTATS_KEY: "",

  // Optional: point the dock's Singles/Doubles buttons at a different series.
  // The merge is shallow, so this replaces the WHOLE object from config.js —
  // copy both event kinds across, not just the one you're changing.
  //
  // BRACKETS: {
  //   shortLink: "my-series",   // the start.gg short link, hyphenated exactly as it appears
  //   events: {
  //     singles: { match: ["melee", "singles"], fallbackSlug: "melee-singles" },
  //     doubles: { match: ["melee", "doubles"], fallbackSlug: "melee-doubles" },
  //   },
  // },
};
