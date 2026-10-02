/**
 * The player database stays a file TSH can read back, and the app's own
 * additions never clobber what the operator typed.
 *
 * local_players.json is shared ground: each machine has its own, the operator
 * has hand-edited it for years, and the rollback plan is handing it back to
 * TSH. So the failures that matter are quiet ones —
 *
 *   - a field this app doesn't know about dropped on the first save;
 *   - TSH's odd-but-real shapes (`mains` as the string "{}", null prefix/name,
 *     the fresh-install `{}` stub) crashing a read or getting "fixed";
 *   - every save rewriting the whole file (non-ASCII unescaped, LF for CRLF),
 *     which turns one learned main into a 200-record diff;
 *   - start.gg data overwriting a pronoun or twitter typed by hand.
 *
 * Records here are synthetic; the real file stays out of the repo.
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { PlayerDb, serialize } = require("../app/lib/players/player-db");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "player-db-"));
let n = 0;
/** Write `records` the way TSH would (indent 2, ASCII-escaped, CRLF) and open it. */
function dbWith(records, { raw } = {}) {
  const file = path.join(dir, `players-${++n}.json`);
  fs.writeFileSync(file, raw ?? serialize(records, "\r\n"));
  return { file, db: new PlayerDb(file, { debounceMs: 1 }) };
}

const RECORDS = [
  {
    prefix: "Team1", gamerTag: "Ålpha", name: "Real Name", twitter: "alpha_tw", pronoun: "she/her",
    custom_textbox: "", mains: { ssbm: [["Fox", 2, ""], ["Falco", 0, ""]] },
    country_code: "US", state_code: "CA", some_future_tsh_field: { kept: true },
  },
  { prefix: null, gamerTag: "Bravo 🎮", name: null, twitter: "", pronoun: "", custom_textbox: "",
    mains: "{}", country_code: "", state_code: "" },
  { prefix: "", gamerTag: "Charlie", name: "", twitter: "", pronoun: "he/him", custom_textbox: "",
    mains: { ssbm: [] }, country_code: "", state_code: "" },
];

console.log("player-db");

test("an unchanged save is byte-identical to TSH's own file (escapes, CRLF, key order)", () => {
  const { file, db } = dbWith(RECORDS);
  const before = fs.readFileSync(file);
  db.saveNow();
  assert.strictEqual(Buffer.compare(before, fs.readFileSync(file)), 0);
  assert.ok(fs.readFileSync(file, "utf8").includes("\\u00c5lpha"), "non-ASCII escaped as Python does");
  assert.ok(fs.readFileSync(file, "utf8").includes("\\ud83c\\udfae"), "astral as a surrogate pair");
});

test("a change touches only its record; unknown fields round-trip", () => {
  const { file, db } = dbWith(RECORDS);
  db.learnMain(db.find({ tag: "Charlie" }), { name: "Marth", skin: 3 });
  db.saveNow();
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(after[0], RECORDS[0], "other records untouched, future field kept");
  assert.deepStrictEqual(after[1], RECORDS[1], "mains: \"{}\" left as TSH wrote it");
  assert.deepStrictEqual(after[2].learnedMains, [["Marth", 3]]);
});

test("the fresh-install {} stub and a missing file read as empty, and can be written to", () => {
  const stub = dbWith(null, { raw: "{}" });
  assert.strictEqual(stub.db.size, 0);
  stub.db.upsert({ playerId: 77, tag: "New" });
  stub.db.saveNow();
  assert.strictEqual(JSON.parse(fs.readFileSync(stub.file, "utf8"))[0].gamerTag, "New");
  const missing = new PlayerDb(path.join(dir, "nope", "players.json"));
  assert.strictEqual(missing.size, 0);
  assert.strictEqual(missing.find({ tag: "x" }), null);
});

test("find: start.gg id first, then prefix+tag, then bare tag — case-insensitive", () => {
  const { db } = dbWith(RECORDS);
  const alpha = db.find({ tag: "ålpha", prefix: "team1" });
  assert.strictEqual(alpha?.gamerTag, "Ålpha");
  assert.strictEqual(db.find({ tag: "Ålpha", prefix: "Other" }), alpha, "a new sponsor still finds them");
  db.upsert({ playerId: "123", tag: "Ålpha", prefix: "Team1" });
  assert.strictEqual(db.find({ playerId: 123, tag: "Renamed" }), alpha, "a tag change is followed by id");
  assert.strictEqual(db.find({ tag: "Bravo 🎮" })?.prefix, null, "null prefix tolerated");
});

test("upsert fills only what's missing — never a hand-typed field", () => {
  const { db } = dbWith(RECORDS);
  const rec = db.upsert({ playerId: "9", tag: "Charlie", prefix: "Sponsor" });
  assert.strictEqual(rec.pronoun, "he/him");
  assert.strictEqual(rec.prefix, "Sponsor", "empty prefix filled");
  db.upsert({ playerId: "9", tag: "Charlie", prefix: "OtherSponsor" });
  assert.strictEqual(rec.prefix, "Sponsor", "a set prefix is not overwritten");
  const fresh = db.upsert({ playerId: "10", tag: "Delta" });
  assert.deepStrictEqual(Object.keys(fresh).slice(0, 4), ["prefix", "gamerTag", "name", "mains"]);
  assert.strictEqual(db.size, 4);
});

test("preferred main: pinned, then most recently learned, then TSH's mains list", () => {
  const { db } = dbWith(RECORDS);
  const alpha = db.find({ tag: "Ålpha" });
  assert.deepStrictEqual(db.preferredMain(alpha), { name: "Fox", skin: 2 });
  db.learnMain(alpha, { name: "Sheik", skin: 1 });
  assert.deepStrictEqual(db.preferredMain(alpha), { name: "Sheik", skin: 1 });
  db.pinMain(alpha, { name: "Falco", skin: 0 });
  assert.deepStrictEqual(db.preferredMain(alpha), { name: "Falco", skin: 0 });
  db.pinMain(alpha, null);
  assert.deepStrictEqual(db.preferredMain(alpha), { name: "Sheik", skin: 1 });
  assert.strictEqual(db.preferredMain(db.find({ tag: "Bravo 🎮" })), null, "mains: \"{}\" is no main");
});

test("learned mains: newest first, one entry per character, at most five", () => {
  const { db } = dbWith(RECORDS);
  const c = db.find({ tag: "Charlie" });
  for (const name of ["Fox", "Marth", "Peach", "Sheik", "Falco", "Puff"]) db.learnMain(c, { name, skin: 0 });
  db.learnMain(c, { name: "Peach", skin: 4 });
  assert.deepStrictEqual(c.learnedMains, [["Peach", 4], ["Puff", 0], ["Falco", 0], ["Sheik", 0], ["Marth", 0]]);
});

test("flush writes only when something is pending", () => {
  const { file, db } = dbWith(RECORDS);
  fs.writeFileSync(file, "sentinel");
  db.flush();
  assert.strictEqual(fs.readFileSync(file, "utf8"), "sentinel", "no pending change, no write");
  db.update(db.find({ tag: "Charlie" }), { twitter: "c_tw" });
  db.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8"))[2].twitter, "c_tw");
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? "player-db: all passed" : `player-db: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
