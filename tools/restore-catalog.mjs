#!/usr/bin/env node
// ---------------------------------------------------------------------------
// restore-catalog - rebuild the D1 catalogue from backups/catalog.sql.gz.
//
// A backup nobody has restored is a rumour, not a backup. This is the other
// half, and it is deliberately exercised in the increment that added it.
//
// SAFETY. This refuses to overwrite a live database unless --force is passed,
// because the common accident is running restore when you meant backup and
// silently replacing 6.5 hours of fresh judgement with an older snapshot.
// --into <path> restores to a throwaway file instead, which is how the round
// trip gets verified without touching anything real.
//
// RUN:  npm run restore -- --into /tmp/check.sqlite     (safe, verifies)
//       npm run restore -- --force                      (real, overwrites)
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const STATE = path.join(REPO, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const SRC = path.join(REPO, "backups/catalog.sql.gz");

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const intoIdx = argv.indexOf("--into");
const into = intoIdx !== -1 ? argv[intoIdx + 1] : null;

if (!fs.existsSync(SRC)) throw new Error(`no backup at ${SRC} - run npm run backup first`);
const text = gunzipSync(fs.readFileSync(SRC)).toString("utf8");

// Parse the header the backup wrote, so we can verify what landed.
const expect = {};
for (const m of text.matchAll(/^-- (\w+):\s*(\d+)$/gm)) expect[m[1]] = Number(m[2]);
const tableLine = text.match(/^-- tables:\s*(.+)$/m);
if (!tableLine) throw new Error("backup has no header - refusing to restore an unrecognised dump");
for (const pair of tableLine[1].trim().split(/\s+/)) {
  const [t, n] = pair.split("=");
  expect[t] = Number(n);
}

let target;
if (into) {
  target = path.resolve(into);
  if (fs.existsSync(target)) fs.unlinkSync(target);
} else {
  if (!fs.existsSync(STATE)) throw new Error(`no D1 state at ${STATE}`);
  const files = fs.readdirSync(STATE).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (files.length !== 1) throw new Error(`expected one catalogue db, found ${files.length}`);
  target = path.join(STATE, files[0]);
  if (!force) {
    const rows = Number(execFileSync("sqlite3", [target, "select count(*) from fpm_catalog"], { encoding: "utf8" }).trim());
    throw new Error(
      `refusing to overwrite the live database (${rows.toLocaleString()} rows).\n` +
      `  To verify the backup safely:  npm run restore -- --into /tmp/check.sqlite\n` +
      `  To really replace the live db: npm run restore -- --force`);
  }
  // The -wal sidecar holds writes not yet in the main file; leaving it would
  // let stale pages replay over the restored data.
  for (const s of ["-wal", "-shm"]) if (fs.existsSync(target + s)) fs.unlinkSync(target + s);
  fs.unlinkSync(target);
}

execFileSync("sqlite3", [target], { input: text, encoding: "utf8", maxBuffer: 512e6 });

/** Row count for a table the header named, or 0 if the restored database has
 * no such table. A header can honestly say `game_marks=0`: the table is
 * created lazily on the first request that touches a mark, so a backup taken
 * before that ever happened has the line but no CREATE for it. Counting
 * straight off a missing table would fail the verification of a backup that is
 * perfectly good. */
function countRows(table) {
  const exists = execFileSync("sqlite3",
    [target, `select count(*) from sqlite_master where type='table' and name='${table}'`],
    { encoding: "utf8" }).trim();
  if (exists === "0") return 0;
  return Number(execFileSync("sqlite3", [target, `select count(*) from ${table}`], { encoding: "utf8" }).trim());
}

// Verify against the header rather than trusting the exit code.
const actual = {};
for (const t of Object.keys(expect)) {
  if (t === "experience_scored" || t === "tagged") continue;
  actual[t] = countRows(t);
}
actual.experience_scored = Number(execFileSync("sqlite3", [target,
  "select count(*) from fpm_catalog where experience_score is not null"], { encoding: "utf8" }).trim());
actual.tagged = Number(execFileSync("sqlite3", [target,
  "select count(*) from fpm_catalog where tags is not null"], { encoding: "utf8" }).trim());

let bad = 0;
console.log(`restored to ${target}`);
for (const [k, want] of Object.entries(expect)) {
  const got = actual[k];
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${k.padEnd(18)} ${String(got).padStart(7)} (expected ${want})`);
}
if (bad) { console.error(`\n${bad} check(s) FAILED - the backup is not trustworthy.`); process.exit(1); }
console.log("\nall counts match the backup header.");
