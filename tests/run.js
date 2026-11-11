/**
 * run.js — run the tests/*.test.js files and report.
 *
 *   node tests/run.js              every file
 *   node tests/run.js dock crew    only files whose name contains "dock" or "crew"
 *
 * Each test file is a standalone Node script that exits non-zero on failure, so
 * there is no framework and no dependency to install. The files run in
 * parallel (each has its own temp dir and port 0 — keep it that way); output is
 * shown for failures only. Run a file directly for its detail.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DIR = __dirname;
const filters = process.argv.slice(2);
const files = fs.readdirSync(DIR)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();

if (files.length === 0) {
  console.error(filters.length ? `no test file matches ${filters.join(", ")}` : "no *.test.js files in tests/");
  process.exit(2);
}

// The sandboxed overlay files time real animations, so leave them some CPU.
const CONCURRENCY = Math.max(1, Math.min(files.length, os.cpus().length - 1, 8));

function runOne(f) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(DIR, f)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ f, ok: code === 0, ms: Date.now() - started, out }));
  });
}

(async () => {
  const started = Date.now();
  console.log(`Running ${files.length} test file(s), ${CONCURRENCY} at a time\n`);

  const queue = [...files];
  const results = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) results.push(await runOne(queue.shift()));
  }));

  results.sort((a, b) => a.f.localeCompare(b.f));
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.f.padEnd(32)} ${r.ms}ms`);
    if (!r.ok) console.log(r.out.trimEnd().split("\n").map((l) => "        " + l).join("\n"));
  }

  const failed = results.filter((r) => !r.ok).map((r) => r.f);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(failed.length
    ? `\n${failed.length} of ${files.length} failed in ${secs}s: ${failed.join(", ")}`
    : `\nAll ${files.length} passed in ${secs}s.`);
  process.exit(failed.length ? 1 : 0);
})();
