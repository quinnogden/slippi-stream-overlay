/**
 * layout-static.test.js
 *
 * Static checks on the custom TSH layouts. A broken selector, a missing script
 * tag or a syntax error in a layout is invisible until it is live in OBS, and
 * the browser sources fail silently — so check what can be checked without one:
 *
 *   1. every .js parses
 *   2. every <script src> / <link href> a layout references exists on disk
 *   3. every CSS class defined in a layout's stylesheet is used by its JS/HTML
 *   4. the shared/ helpers are actually wired into the pages that need them
 *   5. nothing rebuilds the chara_2_ icon path by hand (that lives in
 *      shared/tsh-assets.js, once)
 *
 * Run after touching anything under layout/. `layout/` is also what gets copied
 * back across a TSH update, so this doubles as a post-update integrity check.
 *
 * Usage:
 *   node tests/layout-static.test.js        # summary
 *   node tests/layout-static.test.js -v     # every individual check
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO_ROOT = path.resolve(__dirname, "..");
const VERBOSE = process.argv.includes("-v") || process.argv.includes("--verbose");

// Never hardcode the TSH folder name — it carries the version and changes on
// every update. This is the same resolver the bridge and preflight use.
const { resolveTshRoot } = require("../slippi-bridge/lib/tsh-root");
const LAYOUT = path.join(resolveTshRoot(REPO_ROOT, null), "layout");

const CUSTOM = ["scoreboard", "side-panel", "bracket", "highlights", "shared"];

let fails = 0;
const fail = (m) => { fails++; console.log("  FAIL  " + m); };
const ok = (m) => { if (VERBOSE) console.log("  ok    " + m); };

// ── 1 + 2. parse JS, resolve referenced assets ──────────────────────────────
let parsed = 0;
let refs = 0;
for (const dir of CUSTOM) {
  const full = path.join(LAYOUT, dir);
  if (!fs.existsSync(full)) { fail(`${dir}/ missing`); continue; }

  for (const f of fs.readdirSync(full)) {
    const p = path.join(full, f);

    if (f.endsWith(".js")) {
      const src = fs.readFileSync(p, "utf8");
      try { new vm.Script(src, { filename: p }); parsed++; ok(`${dir}/${f} parses`); }
      catch (e) { fail(`${dir}/${f} SYNTAX: ${e.message}`); }
    }

    if (f.endsWith(".html")) {
      const src = fs.readFileSync(p, "utf8");
      const referenced = [
        ...[...src.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
        ...[...src.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
      ].filter((r) => !r.startsWith("http"));

      for (const r of referenced) {
        refs++;
        if (fs.existsSync(path.resolve(full, r))) ok(`${dir}/${f} → ${r}`);
        else fail(`${dir}/${f} references missing file: ${r}`);
      }
    }
  }
}
console.log(`  ok    ${parsed} layout scripts parse, ${refs} asset references resolve`);

// ── 3. class cross-check per layout ─────────────────────────────────────────
const PAIRS = [
  { name: "scoreboard", css: "scoreboard/index.css", consumers: ["scoreboard/index.js", "scoreboard/melee.html", "scoreboard/meleePlayers.html"] },
  { name: "side-panel", css: "side-panel/side-panel.css", consumers: ["side-panel/side-panel.js", "side-panel/side-panel.html"] },
  { name: "bracket", css: "bracket/index.css", consumers: ["bracket/index.js", "bracket/index.html", "bracket/index_expanded.html", "bracket/losers_only.html", "bracket/winners_only.html"] },
  { name: "highlights", css: "highlights/highlights.css", consumers: ["highlights/highlights.js", "highlights/highlights.html"] },
];

// Classes TSH's own vendored include/ JS creates, so a layout CSS may target
// them without any local file mentioning them.
const TSH_PROVIDED = new Set([
  "text", "text_empty", "asset", "tsh_character", "loading", "hidden",
  "fade", "fade_up", "fade_down", "fade_left", "fade_right",
  "fade_down_left_stagger", "fade_down_right_stagger",
  "anim_container_outer", "anim_container_inner",
]);

// Known-unused leftovers. Not failures — the regex matches things like a `.g`
// inside a longer selector — but a growing list means dead CSS is accumulating.
const UNUSED_BUDGET = { scoreboard: 1, "side-panel": 1, bracket: 2, highlights: 0 };

for (const pair of PAIRS) {
  const cssPath = path.join(LAYOUT, pair.css);
  if (!fs.existsSync(cssPath)) { fail(`${pair.css} missing`); continue; }
  const css = fs.readFileSync(cssPath, "utf8");

  const consumerSrc = pair.consumers
    .map((c) => path.join(LAYOUT, c))
    .filter(fs.existsSync)
    .map((p) => fs.readFileSync(p, "utf8"))
    .join("\n");

  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const unused = [...defined].filter((c) => {
    if (TSH_PROVIDED.has(c)) return false;
    return !new RegExp(`\\b${c.replace(/-/g, "\\-")}\\b`).test(consumerSrc);
  });

  const budget = UNUSED_BUDGET[pair.name] ?? 0;
  if (unused.length > budget) {
    fail(`${pair.name}: ${unused.length} unused CSS classes (budget ${budget}): ${unused.join(", ")}`);
  } else {
    ok(`${pair.name}: ${defined.size} classes defined, ${unused.length} unused (budget ${budget})`);
  }
}
console.log(`  ok    CSS classes cross-checked for ${PAIRS.length} layouts`);

// ── 4. shared helpers actually wired in ─────────────────────────────────────
const WIRING = [
  { file: "scoreboard/melee.html", needs: ["shared/tsh-assets.js", "shared/slippi-bridge-client.js"] },
  { file: "side-panel/side-panel.html", needs: ["shared/tsh-assets.js", "shared/slippi-bridge-client.js"] },
];
for (const c of WIRING) {
  const src = fs.readFileSync(path.join(LAYOUT, c.file), "utf8");
  for (const n of c.needs) {
    const base = n.split("/").pop();
    if (src.includes(base)) ok(`${c.file} loads ${base}`);
    else fail(`${c.file} does NOT load ${base}`);
  }
}
console.log("  ok    shared/ helpers wired into the pages that need them");

// ── 5. no layout rebuilds the icon path by hand ─────────────────────────────
let leftover = 0;
for (const dir of CUSTOM) {
  if (dir === "shared") continue; // the helper legitimately owns the path
  for (const f of fs.readdirSync(path.join(LAYOUT, dir))) {
    if (!/\.(js|html)$/.test(f)) continue;
    if (fs.readFileSync(path.join(LAYOUT, dir, f), "utf8").includes("chara_2_")) {
      fail(`${dir}/${f} still builds chara_2_ paths directly — use TshAssets.charIconSrc()`);
      leftover++;
    }
  }
}
if (!leftover) console.log("  ok    no layout builds chara_2_ paths directly");

// ── 6. a layout that hides its body must have something to unhide it ────────
// `opacity: 0` on body is TSH's convention: globals.js's UpdateWrapper fades it
// back in on the first state push. Copied into a layout that doesn't load
// globals.js it produces a permanently invisible overlay — which looks like a
// correct file listing and only shows up on stream. highlights/ is the layout
// this actually threatens, since it deliberately has no globals.js.
for (const dir of CUSTOM) {
  if (dir === "shared") continue;
  const files = fs.readdirSync(path.join(LAYOUT, dir));

  const hidesBody = files.some((f) =>
    f.endsWith(".css") &&
    /body\s*\{[^}]*opacity\s*:\s*0\s*[;}]/.test(fs.readFileSync(path.join(LAYOUT, dir, f), "utf8")));
  if (!hidesBody) { ok(`${dir}/ does not hide its body`); continue; }

  const loadsGlobals = files.some((f) =>
    f.endsWith(".html") &&
    fs.readFileSync(path.join(LAYOUT, dir, f), "utf8").includes("globals.js"));

  if (loadsGlobals) ok(`${dir}/ hides its body but loads globals.js to fade it back in`);
  else fail(`${dir}/ sets body { opacity: 0 } but loads no globals.js — the overlay would never become visible`);
}
console.log("  ok    no layout can render permanently invisible");

console.log(fails === 0 ? "\nLayout checks passed." : `\n${fails} failure(s).`);
process.exit(fails ? 1 : 0);
