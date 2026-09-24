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

/** TC-12: the two tools are READ ONCE, HERE, at module load - not copied off
 * disk inside each test. Copying at test time means a coder saving one of these
 * files while the suite runs produces a half-written copy and a spurious
 * failure, which happened twice during the coverage audit. A snapshot taken at
 * import is the same file for every test in the run, whatever happens on disk
 * afterwards. */
const TOOL_SOURCES = Object.fromEntries(
  ["backup-catalog.mjs", "restore-catalog.mjs"].map((f) => [f, fs.readFileSync(path.join(REPO, "tools", f), "utf8")]),
);

/** A throwaway copy of the two tools, with a D1 state directory beside them. */
function makeFakeRepo(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sss-backup-"));
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  for (const [f, source] of Object.entries(TOOL_SOURCES)) {
    fs.writeFileSync(path.join(dir, "tools", f), source, "utf8");
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

// The tables the app creates, plus two catalogue rows, one of them scored and
// tagged so the header's other two counters have something to report.
//
// THE PERSONAL TABLES CARRY A `steam_id` HOLDING A REAL-SHAPED SteamID64
// (increment 15). That is not decoration: SEC-1 is that these two tables were
// in the COMMITTED dump, and this repository is public, so the fixture has to
// contain the thing that must not be published or the assertions below are
// vacuous. `76561198000000001` is a syntactically valid SteamID64 that is not
// James's.
const STEAM_ID = "76561198000000001";

const BASE_SQL = `
create table fpm_catalog (appid integer primary key, name text, experience_score integer, tags text);
insert into fpm_catalog values (400, 'Portal', 98, 'puzzle'), (440, 'Team Fortress 2', null, null);
create table settings (steam_id text not null, key text not null, value text, updated_at integer,
  primary key (steam_id, key));
insert into settings values ('${STEAM_ID}', 'rankFilters', '{}', 1);
create table dismissals (steam_id text not null, appid integer not null, name text, dismissed_at integer,
  primary key (steam_id, appid));
insert into dismissals values ('${STEAM_ID}', 620, 'Portal 2', 1);
`;

const MARKS_SQL = `
create table game_marks (steam_id text not null, appid integer not null, name text,
  played integer not null default 0, finished integer not null default 0, marked_at integer,
  updated_at integer, primary key (steam_id, appid));
insert into game_marks values ('${STEAM_ID}', 400, 'Portal', 1, 1, 1, 2),
  ('${STEAM_ID}', 440, 'Team Fortress 2', 1, 0, 1, 2);
`;

test("SEC-6 / SEC-1: NO PERSONAL TABLE is in the committed dump - play history, settings and dismissals all stay here", () => {
  requireSqlite3();
  // THE RULING THIS TEST EXISTS FOR (James, 2026-09-06). The repository is
  // PUBLIC and `backups/catalog.sql.gz` is committed on every backup, so
  // anything in it is published. `game_marks` is which games James has played
  // and finished. The table was empty when this was found, so nothing leaked -
  // it would have started publishing the moment he marked a game.
  //
  // INCREMENT 15 WIDENED IT (SEC-1). `settings` and `dismissals` were in the
  // committed dump from day one, harmless for exactly as long as they held a
  // key and a value. The re-key put a live SteamID64 in every row of both, and
  // SPEC.md §9 forbids publishing that list in the same words it forbids a
  // committed `ALLOWED_STEAM_IDS`. So the assertion is no longer "no marks" -
  // it is "no personal table, and no SteamID64, anywhere in the file".
  const { dir } = makeFakeRepo(BASE_SQL + MARKS_SQL);

  run(dir, "backup-catalog.mjs");
  const { text, tables } = headerOf(dir);
  assert.equal(tables, "fpm_catalog=2", "the committed dump names ONE table and no more");
  assert.doesNotMatch(text, /game_marks/, "the string does not appear ANYWHERE in the committed dump");
  assert.doesNotMatch(text, /settings/, "nor does settings, which now carries a SteamID64 in every row");
  assert.doesNotMatch(text, /dismissals/, "nor dismissals, for the same reason");
  assert.doesNotMatch(text, /7656119[0-9]{10}/, "and NO SteamID64 - the id resolves to a live profile page");
  assert.doesNotMatch(text, /catalog_meta/, "nor does the version stamp, which is regenerable and must not be restorable");
  assert.doesNotMatch(text, /Portal.*1,\s*1/, "and no mark row survived into it");
});

test("SEC-6 / SEC-1: the personal tables ARE backed up, locally, to an untracked file beside the committed one", () => {
  requireSqlite3();
  // The other half of the ruling. `game_marks` is still the only genuinely
  // unrecoverable table the project owns - Steam has no "mark as played" and
  // never returns one - so it is dumped, just not committed. `settings` and
  // `dismissals` join it there rather than being dropped outright: they are
  // cheap to lose but free to keep, and the file is already untracked.
  //
  // THE FILE IS `private-personal.sql`, NOT `private-marks.sql`. Renamed in
  // increment 15 because it no longer holds only marks, and a filename that
  // describes yesterday's contents is how the next private table ends up in
  // the wrong list.
  const { dir } = makeFakeRepo(BASE_SQL + MARKS_SQL);

  const out = run(dir, "backup-catalog.mjs");
  assert.match(out, /game_marks\s+2 rows -> backups\/private-personal\.sql \(LOCAL ONLY, not committed\)/);
  assert.match(out, /settings\s+1 rows -> backups\/private-personal\.sql \(LOCAL ONLY, not committed\)/);
  assert.match(out, /dismissals\s+1 rows -> backups\/private-personal\.sql \(LOCAL ONLY, not committed\)/);

  const priv = fs.readFileSync(path.join(dir, "backups/private-personal.sql"), "utf8");
  assert.match(priv, /NEVER COMMIT THIS FILE/);
  assert.match(priv, /-- tables: game_marks=2 settings=1 dismissals=1/);

  // And it restores: load it into a throwaway and read the rows back.
  const check = path.join(dir, "marks-check.sqlite");
  execFileSync("sqlite3", [check], { input: priv, encoding: "utf8" });
  const marks = execFileSync("sqlite3", [check,
    "select appid || ':' || played || finished from game_marks order by appid"], { encoding: "utf8" }).trim();
  assert.equal(marks, "400:11\n440:10", "the unrecoverable rows came back exactly");
});

test("SEC-10: backups/.gitignore is DENY-BY-DEFAULT, so a future private artifact is not tracked by accident", () => {
  // It used to name `private-marks.sql` and nothing else, which protects the
  // one file we already knew about and publishes every one we do not. The
  // repository is public and this directory is where the database lands.
  const ignore = fs.readFileSync(path.join(REPO, "backups/.gitignore"), "utf8");
  const rules = ignore.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  assert.equal(rules[0], "*", "the first rule must exclude everything");
  assert.deepEqual(
    rules.slice(1).sort(),
    ["!.gitignore", "!README.md", "!catalog.sql.gz"],
    "and the allow-list is exactly the three public files - anything else added here must be a deliberate decision",
  );
  assert.equal(rules.includes("!private-marks.sql"), false, "the play-history dump is never re-admitted");
  assert.equal(rules.includes("!private-personal.sql"), false, "nor its increment-15 replacement, which also carries SteamID64s");
});

test("SEC-11: a table matched by `.dump`'s LIKE WILDCARD is REFUSED, not quietly published", () => {
  requireSqlite3();
  // sqlite3's `.dump <arg>` treats the argument as a LIKE pattern, and `_` is
  // a single-character wildcard. So `.dump fpm_catalog` also matches a table
  // called `fpmXcatalog`, and the privacy guarantee rested on nothing being
  // named that way. Here one is, carrying something private, and the backup
  // must refuse to write the committed file at all.
  const { dir } = makeFakeRepo(BASE_SQL + `
create table fpmXcatalog (appid integer primary key, secret text);
insert into fpmXcatalog values (1, 'private');
`);

  assert.throws(() => run(dir, "backup-catalog.mjs"), /REFUSING TO WRITE THE COMMITTED BACKUP[\s\S]*fpmXcatalog/);
  assert.equal(
    fs.existsSync(path.join(dir, "backups/catalog.sql.gz")),
    false,
    "and nothing was written - a refused backup must not leave a published file behind",
  );
});

test("TC-18: the FILE THAT IS ACTUALLY COMMITTED carries no play history and no version stamp", () => {
  // Every other privacy test here runs against a synthetic dump in a temp
  // directory. This one reads the real, tracked `backups/catalog.sql.gz` -
  // the bytes that are published when James commits - because that is the
  // artifact the ruling is about, and a guard that only holds for a fixture
  // is not the guarantee.
  const text = gunzipSync(fs.readFileSync(path.join(REPO, "backups/catalog.sql.gz"))).toString("utf8");

  assert.match(text, /CREATE TABLE fpm_catalog/, "sanity: this is the real catalogue dump, so the assertions below are not vacuous");
  assert.doesNotMatch(text, /game_marks/, "the committed backup names James's play history NOWHERE");
  assert.doesNotMatch(text, /catalog_meta/, "nor the snapshot version stamp, which must not be restorable");

  // SEC-1, increment 15. Every `settings` and `dismissals` row now carries a
  // live SteamID64 in its primary key, and this repository is PUBLIC - each id
  // resolves to a `steamcommunity.com/profiles/<id>` page. This is the same
  // harm SPEC.md §9 forbids for a committed `ALLOWED_STEAM_IDS`, and it was
  // arriving through the backup instead. A SteamID64 is 17 digits beginning
  // 7656119, so the pattern is exact rather than a guess.
  //
  // THE FILE IN THE TREE TODAY PREDATES THE RE-KEY, so this passes now by
  // history rather than by design - which is precisely why it is asserted on
  // the REAL committed bytes and not on a fixture. It fails the moment a
  // backup taken after the re-key is committed with the personal tables still
  // in it.
  assert.doesNotMatch(text, /7656119[0-9]{10}/, "NO SteamID64 - James's or any invited mate's - is published in the committed backup");
});

test("the committed dump still carries the EXPENSIVE tables - this is a real off-machine backup", () => {
  requireSqlite3();
  const { dir } = makeFakeRepo(BASE_SQL + MARKS_SQL);
  run(dir, "backup-catalog.mjs");
  const restored = run(dir, "restore-catalog.mjs", ["--into", path.join(dir, "check.sqlite")]);
  assert.match(restored, /all counts match the backup header/);
  assert.doesNotMatch(restored, /FAIL/);
  const scored = execFileSync("sqlite3", [path.join(dir, "check.sqlite"),
    "select count(*) from fpm_catalog where experience_score is not null"], { encoding: "utf8" }).trim();
  assert.equal(scored, "1", "the LLM judgement is what the committed dump is for");
});

test("SEC-3: backup SUCCEEDS against a database with NO game_marks table, and still writes the expensive rows", () => {
  requireSqlite3();
  // The regression: `game_marks` is created lazily, so this is the state of
  // every database that has not served a marks request – and before the fix
  // the backup threw here and wrote nothing at all. It is now in the PRIVATE
  // list rather than the optional one, and absence must still not be an error.
  //
  // INCREMENT 15 MADE THIS CASE WIDER AND MORE URGENT, not narrower: SPEC.md
  // §10 has James DROP all three personal tables by hand before the first
  // sign-in, so "some personal table is missing" is now a state the database
  // is GUARANTEED to pass through, not merely allowed to be in.
  const { dir } = makeFakeRepo(BASE_SQL);

  const out = run(dir, "backup-catalog.mjs");
  assert.match(out, /fpm_catalog\s+2 rows/);
  assert.match(out, /game_marks\s+0 rows -> \(no such table in this database\)/);
  assert.equal(headerOf(dir).tables, "fpm_catalog=2");
  assert.match(headerOf(dir).text, /-- experience_scored: 1/);

  // The private dump IS written, because `settings` and `dismissals` are
  // present - and it names only what was actually there.
  const priv = fs.readFileSync(path.join(dir, "backups/private-personal.sql"), "utf8");
  assert.match(priv, /-- tables: game_marks=0 settings=1 dismissals=1/);
  assert.doesNotMatch(priv, /CREATE TABLE game_marks/, "a table that does not exist is not invented in the dump");

  // And the other direction: that dump restores and verifies.
  const restored = run(dir, "restore-catalog.mjs", ["--into", path.join(dir, "check.sqlite")]);
  assert.match(restored, /all counts match the backup header/);
  assert.doesNotMatch(restored, /FAIL/);
  const rows = execFileSync("sqlite3", [path.join(dir, "check.sqlite"),
    "select count(*) from fpm_catalog"], { encoding: "utf8" }).trim();
  assert.equal(rows, "2", "the LLM-scored rows survived a backup taken with no game_marks table");
});

test("13 GATE 4 / TC-6: a restore MINTS A FRESH VERSION STAMP, so the next page load cannot be served a pre-restore catalogue", async () => {
  requireSqlite3();
  // One of gate 4's four invalidation paths, and it was tested by nothing. The
  // KV snapshot is keyed on `catalog_meta.catalog_version`; a restore replaces
  // every row in the database, so without a fresh stamp the restored database
  // presents the SAME version as a snapshot still sitting in KV and the page
  // keeps serving a catalogue describing a database that no longer exists.
  //
  // `catalog_meta` is deliberately NOT in the backup any more (SEC-6), so this
  // write is the only thing that sets the stamp. Both halves are asserted.
  const { dir } = makeFakeRepo(BASE_SQL + `
    create table catalog_meta (key text primary key, value text, updated_at integer);
    insert into catalog_meta values ('catalog_version', 'the-PRE-restore-stamp', 1);
  `);
  run(dir, "backup-catalog.mjs");
  assert.doesNotMatch(headerOf(dir).text, /the-PRE-restore-stamp/, "the old stamp is not even in the dump");

  const target = path.join(dir, "check.sqlite");
  const out = run(dir, "restore-catalog.mjs", ["--into", target]);
  assert.match(out, /catalogue snapshot version reset to .+ - the next page load rebuilds/);

  const stamp = execFileSync("sqlite3", [target,
    "select value from catalog_meta where key = 'catalog_version'"], { encoding: "utf8" }).trim();
  assert.notEqual(stamp, "the-PRE-restore-stamp", "the restored database does not present the old version");
  assert.match(stamp, /-restored$/, "it presents a freshly minted one, marked as coming from a restore");
});

test("13 TC-6: the stamp is minted even when the dump has no catalog_meta at all", async () => {
  requireSqlite3();
  // The normal case now: no `catalog_meta` in the backup, so the restored
  // database has no such table until the restore script creates it. A restore
  // that left the table absent would make `readCatalogVersion` return null, and
  // the cache would treat every request as first-boot.
  const { dir } = makeFakeRepo(BASE_SQL);
  run(dir, "backup-catalog.mjs");
  const target = path.join(dir, "check.sqlite");
  run(dir, "restore-catalog.mjs", ["--into", target]);

  const stamp = execFileSync("sqlite3", [target,
    "select value from catalog_meta where key = 'catalog_version'"], { encoding: "utf8" }).trim();
  assert.match(stamp, /-restored$/, "the table was created and stamped, not left missing");
});

test("a REQUIRED table is still a hard stop – the backup refuses to write a half-catalogue", () => {
  requireSqlite3();
  // The required list is `fpm_catalog` ALONE since increment 15 (SEC-1) -
  // `settings` and `dismissals` moved to the private list, where absence is
  // tolerated. So the database this fires on is one with no catalogue at all,
  // which is the case the hard stop is actually for: a database that is not
  // the one we think it is, dumped over the good backup.
  const { dir } = makeFakeRepo(`
    create table settings (steam_id text not null, key text not null, value text, updated_at integer,
      primary key (steam_id, key));
  `);
  assert.throws(() => run(dir, "backup-catalog.mjs"), /expected tables absent from the database: fpm_catalog/);
  assert.equal(fs.existsSync(path.join(dir, "backups/catalog.sql.gz")), false, "nothing was written");
});

test("a dump whose header names tables it never CREATED still restores and verifies", () => {
  requireSqlite3();
  // The restore script iterates the header's own keys and counts a missing
  // table as zero, so an older backup is read on its own terms. Proved rather
  // than assumed, because this is the path a real recovery would take.
  //
  // This used to be phrased as "a pre-12.5 dump, whose header never mentions
  // game_marks". The same tolerance is being exercised, from the other side:
  // since increment 15 the committed header names `fpm_catalog` alone, so the
  // older header is the one carrying EXTRA names - the personal tables, at
  // zero rows, which this dump quite correctly does not create.
  const { dir } = makeFakeRepo(BASE_SQL + MARKS_SQL);
  run(dir, "backup-catalog.mjs");
  const file = path.join(dir, "backups/catalog.sql.gz");
  const text = gunzipSync(fs.readFileSync(file)).toString("utf8")
    .replace(/^-- tables: .+$/m, "-- tables: fpm_catalog=2 settings=0 dismissals=0 game_marks=0");
  fs.writeFileSync(file, execFileSync("gzip", ["-c"], { input: Buffer.from(text, "utf8"), maxBuffer: 512e6 }));

  const restored = run(dir, "restore-catalog.mjs", ["--into", path.join(dir, "check.sqlite")]);
  assert.match(restored, /all counts match the backup header/);
  assert.doesNotMatch(restored, /FAIL/);
});
