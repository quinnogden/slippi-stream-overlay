/**
 * run.js — run every tests/*.test.js and report.
 *
 *   node tests/run.js
 *
 * Each test file is a standalone Node script that exits non-zero on failure, so
 * there is no framework and no dependency to install. Output is shown for
 * failures only; run a test file directly for its detail.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = __dirname;
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".test.js")).sort();

if (files.length === 0) {
  console.error("no *.test.js files in tests/");
  process.exit(2);
}

console.log(`Running ${files.length} test file(s)\n`);

const failed = [];
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: "utf8" });
  const ms = Date.now() - started;

  if (r.status === 0) {
    console.log(`  PASS  ${f.padEnd(32)} ${ms}ms`);
  } else {
    failed.push(f);
    console.log(`  FAIL  ${f.padEnd(32)} ${ms}ms`);
    const out = ((r.stdout || "") + (r.stderr || "")).trimEnd();
    console.log(out.split("\n").map((l) => "        " + l).join("\n"));
  }
}

console.log(failed.length
  ? `\n${failed.length} of ${files.length} failed: ${failed.join(", ")}`
  : `\nAll ${files.length} passed.`);
process.exit(failed.length ? 1 : 0);
