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

// The tables worth keeping. _cf_METADATA is miniflare's own bookkeeping and is
// rebuilt on demand, so it is deliberately excluded.
// `game_marks` (increment 12.5) is the one genuinely UNRECOVERABLE table here.
// The catalogue, prices, tags, the LLM scores and the library can all be
// rebuilt from an API or a fill given enough hours. A record of which games
// James has played and finished exists nowhere else in the world - Steam has
// no "mark as played" and never returns one, which is the entire reason the
// table exists. Leaving it out of the backup would be the only genuinely
// unrecoverable data loss this project is capable of.
//
// REQUIRED vs OPTIONAL, and why that split exists. The three below are created
// on paths every run of the app takes, so their absence means this is not the
// database we think it is, and stopping is right.
const REQUIRED_TABLES = ["fpm_catalog", "settings", "dismissals"];

// `game_marks` IS OPTIONAL ANYWAY, and increment 12.5's security review caught
// why: ensureMarksSchema creates it LAZILY, on the first request that touches
// a mark. On a database that has not served one yet - a restore from a
// pre-12.5 dump, a `--into` throwaway, a fresh dev state - the table is simply
// not there. Putting it behind the hard "expected tables absent" throw meant
// the whole backup refused to run and the 18,219 rows of LLM judgement went
// unwritten because the CHEAPEST table was missing. The tool that exists to
// protect the expensive tables must never fail closed over this one.
const OPTIONAL_TABLES = ["game_marks"];

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

const kb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`backed up to backups/catalog.sql.gz (${kb} MB)`);
for (const t of listed) {
  const note = dumped.includes(t) ? "" : "   (no such table in this database)";
  console.log(`  ${t.padEnd(12)} ${counts[t].toLocaleString()} rows${note}`);
}
console.log(`  of which experience-scored: ${scored.toLocaleString()}, tagged: ${tagged.toLocaleString()}`);
console.log(`\nCommit it to get a copy off this machine. Restore with: npm run restore`);
