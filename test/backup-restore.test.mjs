// Tests for tools/backup-catalog.mjs and tools/restore-catalog.mjs – the round
// trip, and specifically the failure increment 12.5's security review found:
// adding the lazily-created `game_marks` to the hard-required table list made
// the WHOLE backup throw on any database that had not served a marks request
// yet, so the 18,219 rows of LLM judgement went unwritten because the cheapest
// table was missing.
//
// HOW THESE RUN WITHOUT TOUCHING THE REAL DATABASE. Both scripts resolve their
// paths from their own location (`new URL("..", import.meta.url)`), so copying
// them into a throwaway directory moves the whole world they see – the D1
// state they read and the backups/ they write – into that directory. Nothing
// here reads or writes `.wrangler/` or `backups/`. They do need the `sqlite3`
// binary, exactly as the real tools do, and they FAIL rather than skip without
// it - see requireSqlite3 below for why a skip was the wrong answer.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);

/**
 * JAMES, 2026-09-05. These tests used to skip themselves when `sqlite3` was
 * absent. They now FAIL instead.
 *
 * A skipped test renders as green, and "0 skipped" has been a checked property
 * of this suite through every review since increment 10 - a lane reads that
 * number and concludes nothing is hiding. One self-skipping file quietly makes
 * it a number nobody can trust, and the thing it would hide is the only
 * automated proof that the backup protecting 18,219 LLM-scored rows still
 * works. `sqlite3` ships with macOS and the tools it tests cannot run without
 * it either, so a missing binary is a broken environment, not a portability
 * case worth degrading to silence.
 */
function requireSqlite3() {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "sqlite3 is not on PATH. tools/backup-catalog.mjs and tools/restore-catalog.mjs " +
        "both shell out to it, so without it the backup that protects 18,219 LLM-scored " +
        "rows cannot run and cannot be verified. Install it rather than skipping this.",
    );
  }
}

/** A throwaway copy of the two tools, with a D1 state directory beside them. */
function makeFakeRepo(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sss-backup-"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  for (const f of ["backup-catalog.mjs", "restore-catalog.mjs"]) {
    fs.copyFileSync(path.join(REPO, "tools", f), path.join(dir, "tools", f));
  }
  const state = path.join(dir, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  fs.mkdirSync(state, { recursive: true });
  const db = path.join(state, "catalog.sqlite");
  execFileSync("sqlite3", [db], { input: sql, encoding: "utf8" });
  return { dir, db };
}

function run(dir, script, args = []) {
  return execFileSync(process.execPath, [path.join(dir, "tools", script), ...args], { encoding: "utf8" });
}

function headerOf(dir) {
  const text = gunzipSync(fs.readFileSync(path.join(dir, "backups/catalog.sql.gz"))).toString("utf8");
  return { text, tables: text.match(/^-- tables:\s*(.+)$/m)[1].trim() };
}

// The three tables the app always creates, plus two catalogue rows, one of
// them scored and tagged so the header's other two counters have something to
// report.
const BASE_SQL = `
create table fpm_catalog (appid integer primary key, name text, experience_score integer, tags text);
insert into fpm_catalog values (400, 'Portal', 98, 'puzzle'), (440, 'Team Fortress 2', null, null);
create table settings (key text primary key, value text);
insert into settings values ('rankFilters', '{}');
create table dismissals (appid integer primary key, name text);
insert into dismissals values (620, 'Portal 2');
`;

const MARKS_SQL = `
create table game_marks (appid integer primary key, name text, played integer not null default 0,
  finished integer not null default 0, marked_at integer, updated_at integer);
insert into game_marks values (400, 'Portal', 1, 1, 1, 2), (440, 'Team Fortress 2', 1, 0, 1, 2);
`;

test("backup + restore round-trips a database that HAS game_marks", () => {
  requireSqlite3();
  const { dir } = makeFakeRepo(BASE_SQL + MARKS_SQL);

  const out = run(dir, "backup-catalog.mjs");
  assert.match(out, /game_marks\s+2 rows/);
  assert.equal(headerOf(dir).tables, "fpm_catalog=2 settings=1 dismissals=1 game_marks=2");

  const restored = run(dir, "restore-catalog.mjs", ["--into", path.join(dir, "check.sqlite")]);
  assert.match(restored, /all counts match the backup header/);
  assert.doesNotMatch(restored, /FAIL/);
  const marks = execFileSync("sqlite3", [path.join(dir, "check.sqlite"),
    "select appid || ':' || played || finished from game_marks order by appid"], { encoding: "utf8" }).trim();
  assert.equal(marks, "400:11\n440:10", "the unrecoverable rows came back exactly");
});

test("SEC-3: backup SUCCEEDS against a database with NO game_marks table, and still writes the expensive rows", () => {
  requireSqlite3();
  // The regression: `game_marks` is created lazily, so this is the state of
  // every database that has not served a marks request – and before the fix
  // the backup threw here and wrote nothing at all.
  const { dir } = makeFakeRepo(BASE_SQL);

  const out = run(dir, "backup-catalog.mjs");
  assert.match(out, /fpm_catalog\s+2 rows/);
  assert.match(out, /game_marks\s+0 rows\s+\(no such table in this database\)/);
  assert.equal(headerOf(dir).tables, "fpm_catalog=2 settings=1 dismissals=1 game_marks=0",
    "an absent optional table is reported as zero, not left out of the header");
  assert.match(headerOf(dir).text, /-- experience_scored: 1/);

  // And the other direction: that dump restores and verifies.
  const restored = run(dir, "restore-catalog.mjs", ["--into", path.join(dir, "check.sqlite")]);
  assert.match(restored, /all counts match the backup header/);
  assert.doesNotMatch(restored, /FAIL/);
  const rows = execFileSync("sqlite3", [path.join(dir, "check.sqlite"),
    "select count(*) from fpm_catalog"], { encoding: "utf8" }).trim();
  assert.equal(rows, "2", "the LLM-scored rows survived a backup taken with no game_marks table");
});

test("a REQUIRED table is still a hard stop – the backup refuses to write a half-catalogue", () => {
  requireSqlite3();
  const { dir } = makeFakeRepo(`
    create table fpm_catalog (appid integer primary key, name text, experience_score integer, tags text);
    create table settings (key text primary key, value text);
  `);
  assert.throws(() => run(dir, "backup-catalog.mjs"), /expected tables absent from the database/);
  assert.equal(fs.existsSync(path.join(dir, "backups/catalog.sql.gz")), false, "nothing was written");
});

test("a pre-12.5 dump, whose header never mentions game_marks, still restores and verifies", () => {
  requireSqlite3();
  // The restore script iterates the header's own keys, so an older backup is
  // read on its own terms. Proved rather than assumed, because this is the
  // path a real recovery would take.
  const { dir } = makeFakeRepo(BASE_SQL + MARKS_SQL);
  run(dir, "backup-catalog.mjs");
  const file = path.join(dir, "backups/catalog.sql.gz");
  const text = gunzipSync(fs.readFileSync(file)).toString("utf8")
    .replace(/^-- tables: .+$/m, "-- tables: fpm_catalog=2 settings=1 dismissals=1");
  fs.writeFileSync(file, execFileSync("gzip", ["-c"], { input: Buffer.from(text, "utf8"), maxBuffer: 512e6 }));

  const restored = run(dir, "restore-catalog.mjs", ["--into", path.join(dir, "check.sqlite")]);
  assert.match(restored, /all counts match the backup header/);
  assert.doesNotMatch(restored, /FAIL/);
});
