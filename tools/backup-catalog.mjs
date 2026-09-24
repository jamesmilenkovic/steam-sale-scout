#!/usr/bin/env node
// ---------------------------------------------------------------------------
// backup-catalog - export the durable D1 tables to a compressed SQL dump.
//
// WHY THIS EXISTS. `.wrangler/state/v3` is gitignored, has never been backed
// up, and holds the two most expensive things this project owns:
//   - 18,219 rows of LLM judgement (experience_score, game_score and friends),
//     ~6.5 hours of wall clock and real model spend, increments 10 and 10.5.
//   - 18,306 rows of SteamSpy tags, ~5 hours of throttled crawling, increment 9.
// Everything else in the table (owners, review counts, wilson, prices,
// app_type, main_hours) is re-crawlable in an afternoon. Those two are not.
// The security review raised the missing backup twice, in increments 10 and 11.
//
// WHY A SQL DUMP AND NOT A FILE COPY. Copying the .sqlite file means also
// copying its -wal sidecar at exactly the right moment, and it ties the backup
// to miniflare's internal layout, which is not ours to depend on. A dump is
// plain text, restores into any sqlite, and can be read by eye.
//
// WHY ONE FIXED FILENAME RATHER THAN TIMESTAMPS. Timestamped dumps accumulate
// forever and nobody prunes them. This overwrites one tracked file, so git
// history IS the backup history - `git log backups/` lists every snapshot and
// `git show <sha>:backups/catalog.sql.gz` recovers any of them. Committing it
// also gets a copy off this machine, which a local timestamped folder never does.
//
// WHAT IS AND IS NOT IN THE COMMITTED FILE. See the WHAT LEAVES THIS MACHINE
// block below. In short: `fpm_catalog` - expensive and entirely public - is
// committed, and the three PERSONAL tables (`game_marks`, `settings`,
// `dismissals`, all keyed to a SteamID64 since increment 15) are dumped to an
// UNTRACKED file beside it and never leave the machine.
//
// RUN:      npm run backup
// RESTORE:  npm run restore   (see tools/restore-catalog.mjs)
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const STATE = path.join(REPO, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const OUT = path.join(REPO, "backups/catalog.sql.gz");

// ---------------------------------------------------------------------------
// WHAT LEAVES THIS MACHINE, AND WHAT DOES NOT. James's ruling, 2026-09-06,
// on the increment 13 security review (SEC-6).
//
// THIS REPOSITORY IS PUBLIC. `backups/catalog.sql.gz` is committed, so every
// table named here is published to the internet on every backup.
//
// `game_marks` (increment 12.5) is James's PLAY HISTORY - which games he has
// played and finished. It is the one genuinely unrecoverable table the project
// owns, and it is also the one genuinely PRIVATE one. Those two facts pull in
// opposite directions and the ruling splits them: it is backed up LOCALLY, to
// an untracked file, and it is not in the committed dump. The table is empty
// today, so nothing has leaked; it would have started publishing the moment he
// marked a game.
//
// `settings` AND `dismissals` JOINED IT IN INCREMENT 15 (SEC-1). They were in
// the committed dump from the day this tool was written, and that was harmless
// for exactly as long as they held nothing but a key and a value. Increment 15
// gave all three personal tables a `steam_id TEXT NOT NULL` leading their
// primary key, so every row in both now carries a live SteamID64 - James's,
// and every mate he invites. Each one resolves to a live
// `steamcommunity.com/profiles/<id>` page, and SPEC.md §9 forbids committing
// exactly that list for exactly that reason. The next `npm run backup` after
// the re-key would have published them.
//
// WHY THEY MOVE RATHER THAN HAVING THE COLUMN STRIPPED. `fpm_catalog` is the
// 18,306-row asset this backup exists to protect. `settings` is a handful of
// UI knob positions and `dismissals` is a short list of "not interested" -
// both regenerable in a minute of clicking, neither worth a text-rewriting
// pass over a SQL dump that would produce CREATE TABLEs the app cannot use.
// The private list already exists, is already tested, and is the mechanism
// this question has an answer in.
//
// `catalog_meta` is dropped for a different reason: the catalogue snapshot
// version stamp is regenerable in one write, and backing it up creates a
// restore path that can resurrect a stale-version match - a restored database
// presenting the same version as a snapshot still sitting in KV, which is
// exactly what increment 13's blocker CR-2 exists to make impossible.
//
// What stays in the committed dump is what makes it a real off-machine backup:
// 18,219 rows of LLM judgement and 18,306 rows of SteamSpy tags, neither of
// which is private and both of which cost hours and real money to rebuild.
//
// REQUIRED vs OPTIONAL, and why that split exists. The table below is created
// on a path every run of the app takes, so its absence means this is not the
// database we think it is, and stopping is right.
//
// It used to also list `settings` and `dismissals`. They are not merely
// dropped from the committed dump - they moved to PRIVATE_TABLES below, where
// absence is tolerated, and that tolerance is now REQUIRED rather than merely
// convenient: SPEC.md §10 has James DROP all three personal tables by hand
// before the first sign-in, and the app recreates them lazily. A backup run in
// that window would have refused to write anything at all, taking the 18,306
// expensive rows down with it - the same regression increment 12.5's review
// found when `game_marks` was made hard-required.
const REQUIRED_TABLES = ["fpm_catalog"];

// Nothing optional goes into the committed dump any more. Kept as an explicit
// empty list rather than deleted, because the next person to add a table needs
// to see that the question "does this leave the machine?" is asked here.
const OPTIONAL_TABLES = [];

// Backed up, but LOCALLY ONLY - `backups/` ignores it, git never sees it.
// increment 12.5's security review is why this is a separate list rather than
// a hard requirement: ensureMarksSchema creates `game_marks` LAZILY, on the
// first request that touches a mark, so on a fresh dev state or a `--into`
// throwaway the table is simply absent and that is not an error.
const PRIVATE_TABLES = ["game_marks", "settings", "dismissals"];
// RENAMED from `private-marks.sql` in increment 15, because it no longer holds
// only marks. A filename that describes yesterday's contents is how the next
// private table gets added to the wrong list without anyone noticing. Any
// existing `private-marks.sql` is left where it is - it is a backup, and
// nothing here deletes one.
const PRIVATE_OUT = path.join(REPO, "backups/private-personal.sql");
const PRIVATE_OUT_NAME = path.relative(REPO, PRIVATE_OUT);

function findDb() {
  if (!fs.existsSync(STATE)) throw new Error(`no D1 state at ${STATE} - has the app ever run?`);
  const files = fs.readdirSync(STATE).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (files.length === 0) throw new Error(`no catalogue .sqlite under ${STATE}`);
  if (files.length > 1) throw new Error(`expected one catalogue db, found ${files.length}: ${files.join(", ")}`);
  return path.join(STATE, files[0]);
}

const db = findDb();
const present = execFileSync("sqlite3", [db, "select name from sqlite_master where type='table'"], { encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const missing = REQUIRED_TABLES.filter((t) => !present.includes(t));
if (missing.length) throw new Error(`expected tables absent from the database: ${missing.join(", ")}`);

// What actually gets dumped: the required three, plus whichever optional
// tables this particular database happens to have.
const dumped = [...REQUIRED_TABLES, ...OPTIONAL_TABLES.filter((t) => present.includes(t))];
const listed = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];

// Dump inside one transaction so the tables cannot skew relative to each other.
const sql = execFileSync("sqlite3", [db, ...dumped.flatMap((t) => [".dump " + t])],
  { encoding: "utf8", maxBuffer: 512e6 });

// THE RUNTIME GUARD ON WHAT IS ACTUALLY IN THE FILE (increment 13 review,
// SEC-11). `.dump <arg>` treats its argument as a LIKE PATTERN, and `_` is a
// LIKE wildcard - so `.dump fpm_catalog` also matches a table shaped
// `fpm?catalog`, and a future `game_marks_v2` would be matched by a pattern
// meant for `game_marks`. Nothing matches today and the current artifact is
// clean, but that is a fact about how the tables happen to be named, not a
// guarantee. This turns it into one: every table the dump actually CREATES has
// to be a table we chose to dump, or the backup refuses to write a file at
// all. The repository is PUBLIC and this file is committed on every run - a
// table quietly joining the dump is the failure that matters here.
const created = [...sql.matchAll(/^\s*CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["'`\[]?([A-Za-z0-9_$]+)/gim)]
  .map((m) => m[1]);
const unexpected = created.filter((t) => !dumped.includes(t));
if (unexpected.length) {
  throw new Error(
    `REFUSING TO WRITE THE COMMITTED BACKUP: it would publish ${[...new Set(unexpected)].join(", ")}, ` +
    `which is not in the dump list (${dumped.join(", ")}). ` +
    `sqlite3's .dump argument is a LIKE pattern - '_' is a wildcard - so a new table can be matched by an existing pattern. ` +
    `Add it to REQUIRED_TABLES/OPTIONAL_TABLES if it is public, or to PRIVATE_TABLES if it is not.`,
  );
}

const counts = Object.fromEntries(dumped.map((t) =>
  [t, Number(execFileSync("sqlite3", [db, `select count(*) from ${t}`], { encoding: "utf8" }).trim())]));
// An absent optional table is reported as zero rows rather than left out of the
// header, so a reader can tell "there were no marks" from "this dump predates
// marks entirely". restore-catalog.mjs tolerates a table the dump never
// created, and both directions are covered in test/backup-restore.test.mjs.
for (const t of OPTIONAL_TABLES) if (!(t in counts)) counts[t] = 0;
const scored = Number(execFileSync("sqlite3", [db,
  "select count(*) from fpm_catalog where experience_score is not null"], { encoding: "utf8" }).trim());
const tagged = Number(execFileSync("sqlite3", [db,
  "select count(*) from fpm_catalog where tags is not null"], { encoding: "utf8" }).trim());

// A header the restore script verifies against, so a truncated or wrong-shaped
// dump fails loudly rather than restoring a partial catalogue over a good one.
const header = `-- steam-sale-scout catalogue backup
-- tables: ${listed.map((t) => `${t}=${counts[t]}`).join(" ")}
-- experience_scored: ${scored}
-- tagged: ${tagged}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, gzipSync(Buffer.from(header + sql, "utf8"), { level: 9 }));

// THE PRIVATE HALF, WRITTEN SECOND AND NEVER COMMITTED. Plain, uncompressed
// SQL: it is tiny, it is meant to be readable by eye, and the one thing that
// must be obvious about this file is what is in it. `backups/.gitignore`
// excludes it; there is a test asserting the committed dump does not contain
// the string `game_marks`.
const privatePresent = PRIVATE_TABLES.filter((t) => present.includes(t));
const privateCounts = Object.fromEntries(PRIVATE_TABLES.map((t) => [t,
  privatePresent.includes(t)
    ? Number(execFileSync("sqlite3", [db, `select count(*) from ${t}`], { encoding: "utf8" }).trim())
    : 0]));
if (privatePresent.length) {
  const privateSql = execFileSync("sqlite3", [db, ...privatePresent.map((t) => ".dump " + t)],
    { encoding: "utf8", maxBuffer: 64e6 });
  fs.writeFileSync(PRIVATE_OUT,
    `-- steam-sale-scout PRIVATE backup - NEVER COMMIT THIS FILE.\n` +
    `-- Every row here is keyed to a SteamID64. This repository is PUBLIC.\n` +
    `-- tables: ${PRIVATE_TABLES.map((t) => `${t}=${privateCounts[t]}`).join(" ")}\n` +
    privateSql, "utf8");
} else if (fs.existsSync(PRIVATE_OUT)) {
  // The table is gone from the database but a dump of it is still on disk.
  // Leave the file rather than deleting it - this is the only copy.
}

const kb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`backed up to backups/catalog.sql.gz (${kb} MB)`);
for (const t of listed) {
  const note = dumped.includes(t) ? "" : "   (no such table in this database)";
  console.log(`  ${t.padEnd(12)} ${counts[t].toLocaleString()} rows${note}`);
}
console.log(`  of which experience-scored: ${scored.toLocaleString()}, tagged: ${tagged.toLocaleString()}`);
for (const t of PRIVATE_TABLES) {
  const where = privatePresent.includes(t) ? `${PRIVATE_OUT_NAME} (LOCAL ONLY, not committed)` : "(no such table in this database)";
  console.log(`  ${t.padEnd(12)} ${privateCounts[t].toLocaleString()} rows -> ${where}`);
}
console.log(`\nCommit backups/catalog.sql.gz to get a copy off this machine. Restore with: npm run restore`);
console.log(`Do NOT commit ${PRIVATE_OUT_NAME} - it is your play history and your SteamID64, and this repo is public.`);
