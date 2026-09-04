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
const TABLES = ["fpm_catalog", "settings", "dismissals"];

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

const missing = TABLES.filter((t) => !present.includes(t));
if (missing.length) throw new Error(`expected tables absent from the database: ${missing.join(", ")}`);

// Dump inside one transaction so the tables cannot skew relative to each other.
const sql = execFileSync("sqlite3", [db, ...TABLES.flatMap((t) => [".dump " + t])],
  { encoding: "utf8", maxBuffer: 512e6 });

const counts = Object.fromEntries(TABLES.map((t) =>
  [t, Number(execFileSync("sqlite3", [db, `select count(*) from ${t}`], { encoding: "utf8" }).trim())]));
const scored = Number(execFileSync("sqlite3", [db,
  "select count(*) from fpm_catalog where experience_score is not null"], { encoding: "utf8" }).trim());
const tagged = Number(execFileSync("sqlite3", [db,
  "select count(*) from fpm_catalog where tags is not null"], { encoding: "utf8" }).trim());

// A header the restore script verifies against, so a truncated or wrong-shaped
// dump fails loudly rather than restoring a partial catalogue over a good one.
const header = `-- steam-sale-scout catalogue backup
-- tables: ${TABLES.map((t) => `${t}=${counts[t]}`).join(" ")}
-- experience_scored: ${scored}
-- tagged: ${tagged}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, gzipSync(Buffer.from(header + sql, "utf8"), { level: 9 }));

const kb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`backed up to backups/catalog.sql.gz (${kb} MB)`);
for (const t of TABLES) console.log(`  ${t.padEnd(12)} ${counts[t].toLocaleString()} rows`);
console.log(`  of which experience-scored: ${scored.toLocaleString()}, tagged: ${tagged.toLocaleString()}`);
console.log(`\nCommit it to get a copy off this machine. Restore with: npm run restore`);
