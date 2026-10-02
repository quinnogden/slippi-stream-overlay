/**
 * dock-static.test.js
 *
 * The dock's wiring, checked without running it — each a way the dock fails
 * silently, at the desk, mid-event:
 *
 *   - every element the script looks up by id exists in the page (a missing
 *     one throws inside a render, and the dock keeps showing stale values);
 *   - every /api route it calls exists, with the method it uses (a 404 comes
 *     back as a toast at best, and as nothing at all from a fire-and-forget);
 *   - it loads nothing from off the app, and every file it loads is there
 *     (the fonts are self-hosted so venue wifi can't restyle the console);
 *   - every tab has a panel, and the clipper form covers every setting;
 *   - every overlay url the Setup tab hands out for OBS is served.
 *
 * Usage: node tests/dock-static.test.js
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const { resolveOverlayPath } = require("../app/lib/server/overlays");
const { FIELDS: CLIPPER_FIELDS } = require("../app/lib/clipper-settings");
const { OVERLAYS: SETUP_OVERLAYS } = require("../app/lib/server/api/setup");

const ROOT = path.resolve(__dirname, "..");
const DOCK = path.join(ROOT, "app", "public", "dock");
const API  = path.join(ROOT, "app", "lib", "server", "api");
const html = fs.readFileSync(path.join(DOCK, "index.html"), "utf8");
const js   = fs.readFileSync(path.join(DOCK, "dock.js"), "utf8");
const css  = fs.readFileSync(path.join(DOCK, "dock.css"), "utf8");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("dock-static");

const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test("every id the script looks up exists in the page", () => {
  const looked = new Set([
    ...[...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
  ]);
  assert.ok(looked.size > 30, `only ${looked.size} lookups found — did the pattern stop matching?`);
  const missing = [...looked].filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, [], `read but never declared: ${missing.join(", ")}`);
});

test("every tab has a panel, and the script knows exactly these tabs", () => {
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const listed = JSON.parse(/const TABS = (\[[^\]]*\])/.exec(js)[1].replace(/'/g, '"'));
  assert.deepStrictEqual(tabs, listed);
  for (const t of tabs) assert.ok(declared.has(`panel-${t}`), `tab ${t} has no #panel-${t}`);
});

test("every /api route the dock calls exists, with the method it uses", () => {
  const routes = new Set();
  for (const f of fs.readdirSync(API)) {
    const src = fs.readFileSync(path.join(API, f), "utf8");
    for (const m of src.matchAll(/app\.(get|post)\("(\/api\/[^"]+)"/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  // api(path) is a GET, api(path, body) a POST; act() always posts.
  const calls = new Set();
  for (const m of js.matchAll(/\b(api|act)\(\s*"(\/api\/[^"?]+)(?:\?[^"]*)?"([^;]*)/g)) {
    const post = m[1] === "act" || /^\s*(\+[^,]*\))?\s*,/.test(m[3]) || /^\s*,/.test(m[3]);
    calls.add(`${post ? "POST" : "GET"} ${m[2]}`);
  }
  assert.ok(calls.size >= 15, `only ${calls.size} calls found — did the pattern stop matching?`);
  const missing = [...calls].filter((c) => !routes.has(c));
  assert.deepStrictEqual(missing, [], `the dock calls routes the app doesn't have: ${missing.join(", ")}`);
});

test("the page loads nothing from off the app, and every file it loads is there", () => {
  const urls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 5);
  for (const u of urls) {
    assert.ok(u.startsWith("/") && !u.startsWith("//"), `${u} isn't served by the app`);
    if (u.startsWith("/socket.io/")) continue;
    const file = u.startsWith("/dock/")
      ? path.join(DOCK, u.slice("/dock/".length))
      : resolveOverlayPath(u, { overlaysDir: path.join(ROOT, "overlays") });
    assert.ok(file && fs.existsSync(file), `${u} doesn't resolve to a file`);
  }
  const fonts = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.strictEqual(fonts.length, 6, "six font faces");
  for (const f of fonts) {
    assert.ok(f.startsWith("./fonts/"), `${f} isn't self-hosted`);
    assert.ok(fs.existsSync(path.join(DOCK, f)), `${f} is missing`);
  }
  assert.ok(!/@import/.test(css), "no @import — the dock's stylesheet pulls nothing in");
});

test("the clipper form covers every setting but the master switch", () => {
  const block = /const CLIP_FIELDS = \[([\s\S]*?)\n  \];/.exec(js)[1];
  const keys = [...block.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]).sort();
  const settings = Object.keys(CLIPPER_FIELDS).filter((k) => k !== "enabled").sort();
  assert.deepStrictEqual(keys, settings);
  assert.ok(declared.has("clip-enabled") && declared.has("clip-fields"));
  const dup = keys.filter((k) => declared.has(`clip-${k}`));
  assert.deepStrictEqual(dup, [], `generated AND hand-written: ${dup.join(", ")}`);
});

test("every overlay the Setup tab offers for OBS is a page the app serves", () => {
  // A url pasted from there into a browser source is the one that goes on air.
  assert.ok(SETUP_OVERLAYS.length >= 6);
  for (const o of SETUP_OVERLAYS) {
    assert.ok(resolveOverlayPath(o.path, { overlaysDir: path.join(ROOT, "overlays") }), `${o.name}: ${o.path} isn't served`);
  }
});

test("no innerHTML anywhere in the script", () => {
  // Tags and names come from start.gg and from whoever typed them.
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/.test(js));
});

console.log(failed === 0 ? "dock-static: all passed" : `dock-static: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
