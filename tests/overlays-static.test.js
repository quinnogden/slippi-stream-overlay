/**
 * Every overlay page loads what it asks for.
 *
 * A browser source fails silently: a mistyped script url is a blank source, a
 * mistyped stylesheet an unstyled one, and a theme url resolved against the
 * wrong folder a missing logo — and OBS shows none of it as an error. So each
 * page's urls are resolved through lib/server/overlays.js's own tables (the
 * ones the app serves from), not checked against the folder layout by hand.
 *
 * Also: every overlay script parses, the scripts load in the order they need,
 * every stylesheet sits one level under /o/ (a theme pack's --logo-url is
 * resolved against the stylesheet using it), and the icon url the overlays
 * build names a real file for every character and costume.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const vm     = require("vm");

const { PAGES, resolveOverlayPath } = require("../slippi-bridge/lib/server/overlays");
const { resolveTshRoot } = require("../slippi-bridge/lib/tsh-root");
const { CHAR_MAP } = require("../slippi-bridge/lib/char_map");
const Overlay = require("../overlays/shared/overlay-client");

const REPO = path.join(__dirname, "..");
const roots = {
  overlaysDir: path.join(REPO, "overlays"),
  themeRoot: path.join(resolveTshRoot(REPO, null), "layout"),
};
const SOCKET_IO = "/socket.io/socket.io.js"; // served by socket.io itself

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

const resolveFrom = (base, ref) => new URL(ref, `http://app${base}`).pathname;
const read = (url) => fs.readFileSync(resolveOverlayPath(url, roots), "utf8");

function pageRefs(url) {
  const html = read(url);
  return {
    scripts: [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => resolveFrom(url, m[1])),
    styles:  [...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((m) => resolveFrom(url, m[1])),
  };
}

/** Every url() and @import in a stylesheet, resolved, except those inside custom properties. */
function cssRefs(url) {
  const css = read(url).replace(/\/\*[\s\S]*?\*\//g, "");
  const refs = [];
  for (const line of css.split(/;|\n/)) {
    if (/^\s*--/.test(line)) continue;
    for (const m of line.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (/^(https?:|data:)/.test(m[1])) continue;
      refs.push(resolveFrom(url, m[1]));
    }
  }
  return refs;
}

console.log("overlays-static");

test("every page url serves a file", () => {
  for (const url of Object.keys(PAGES)) {
    assert.ok(resolveOverlayPath(url, roots), `${url} → nothing`);
    assert.ok(resolveOverlayPath(`${url}/`, roots), `${url}/ (trailing slash) → nothing`);
    assert.ok(resolveOverlayPath(`${url}?animate=false`, roots), `${url} with a query → nothing`);
  }
});

test("every script and stylesheet a page links resolves, whichever way OBS was given the url", () => {
  for (const url of Object.keys(PAGES)) {
    for (const variant of [url, `${url}/`]) {
      const { scripts, styles } = pageRefs(variant);
      for (const ref of [...scripts, ...styles]) {
        if (ref === SOCKET_IO) continue;
        assert.ok(resolveOverlayPath(ref, roots), `${variant}: ${ref} → nothing`);
      }
    }
  }
});

test("scripts load socket.io, then the overlay client, then the page", () => {
  for (const url of Object.keys(PAGES)) {
    const { scripts } = pageRefs(url);
    assert.strictEqual(scripts[0], SOCKET_IO, `${url}: socket.io first`);
    assert.strictEqual(scripts[1], "/o/shared/overlay-client.js", `${url}: overlay client second`);
    assert.ok(scripts.length >= 3, `${url}: no page script`);
  }
});

test("every stylesheet sits one level under /o/, so a pack's --logo-url resolves", () => {
  for (const url of Object.keys(PAGES)) {
    for (const ref of pageRefs(url).styles) {
      assert.match(ref, /^\/o\/[^/]+\/[^/]+\.css$/, `${url}: ${ref}`);
    }
  }
});

test("every url() and @import in the overlays' stylesheets, the switch and the active pack resolves", () => {
  const sheets = new Set(Object.keys(PAGES).flatMap((u) => pageRefs(u).styles));
  const seen = new Set();
  const queue = [...sheets];
  while (queue.length) {
    const sheet = queue.shift();
    if (seen.has(sheet)) continue;
    seen.add(sheet);
    for (const ref of cssRefs(sheet)) {
      assert.ok(resolveOverlayPath(ref, roots), `${sheet}: ${ref} → nothing`);
      if (ref.endsWith(".css")) queue.push(ref);
    }
  }
  assert.ok([...seen].some((s) => /^\/o\/themes\/[^/]+\/theme\.css$/.test(s)), "the active pack was never reached");
});

test("the active pack's logo and sponsor resolve from an overlay stylesheet", () => {
  const pack = cssRefs("/o/theme.css").find((r) => /^\/o\/themes\/[^/]+\/theme\.css$/.test(r));
  assert.ok(pack, "theme.css imports no pack");
  const css = read(pack);
  for (const prop of ["--logo-url", "--sponsor-url"]) {
    const m = css.match(new RegExp(`${prop}\\s*:\\s*url\\(\\s*["']?([^"')]+)`));
    assert.ok(m, `${pack} sets no ${prop}`);
    const ref = resolveFrom("/o/scoreboard/scoreboard.css", m[1]);
    assert.ok(resolveOverlayPath(ref, roots), `${prop} → ${ref} → nothing`);
  }
});

test("every overlay script parses", () => {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "assets") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  })(roots.overlaysDir);
  assert.ok(files.length >= 3);
  for (const f of files) {
    try {
      new vm.Script(fs.readFileSync(f, "utf8"), { filename: f });
    } catch (err) {
      throw new Error(`${path.relative(REPO, f)}: ${err.message}`);
    }
  }
});

test("the icon url the overlays build names a real file for every character and costume", () => {
  const icons = fs.readdirSync(path.join(roots.overlaysDir, "assets", "icons"));
  for (const { codename } of Object.values(CHAR_MAP)) {
    const skins = icons.filter((f) => f.startsWith(`chara_2_${codename}_`)).length;
    assert.ok(skins > 0, `${codename}: no icons`);
    for (let skin = 0; skin < skins; skin++) {
      for (const s of [skin, String(skin)]) {
        const url = Overlay.icon({ codename, skin: s });
        assert.ok(resolveOverlayPath(url, roots), `${codename} skin ${JSON.stringify(s)} → ${url} → nothing`);
      }
    }
  }
  assert.strictEqual(Overlay.icon(null), null);
  assert.strictEqual(Overlay.icon({ codename: "" }), null);
});

test("the url resolver can't be walked out of its folders", () => {
  assert.strictEqual(resolveOverlayPath("/o/../slippi-bridge/config.local.js", roots), null);
  assert.strictEqual(resolveOverlayPath("/o/%2e%2e/slippi-bridge/config.js", roots), null);
  assert.strictEqual(resolveOverlayPath("/assets/../../slippi-bridge/config.js", roots), null);
});

console.log(failed === 0 ? "overlays-static: all passed" : `overlays-static: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
