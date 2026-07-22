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
};
