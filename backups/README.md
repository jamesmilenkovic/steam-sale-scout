# Catalogue backups

`catalog.sql.gz` is a gzipped SQL dump of the catalogue and it is **tracked in git on purpose**.

**From the next `npm run backup` onwards it holds ONE table, `fpm_catalog`.** The file sitting in the
tree right now still holds three - `fpm_catalog`, plus the pre-re-key `settings` (6 rows) and
`dismissals` (0 rows) it was taken with on 2026-09-06. Those two carry no `steam_id` and so no
SteamID64, which is why nothing has leaked, and `npm run restore` drops them on the way in rather
than replaying them (see the restore section below). Retaking the backup is step 0 of the hand-run
list in the increment 15 review folder, and it is what makes the sentence above unconditional.

`private-personal.sql` is a plain SQL dump of the three PERSONAL tables - **`game_marks`,
`settings`, `dismissals`** - and it is **untracked on purpose**. It never leaves this machine.
(It was called `private-marks.sql` before increment 15, when it held only marks.)

## THIS REPOSITORY IS PUBLIC, SO THE SPLIT MATTERS

James's ruling, 2026-09-06, on increment 13's security review (SEC-6). The committed dump is
published to the internet on every backup, and `game_marks` is his **play history** - which games he
has played and which he has finished. It is simultaneously the most private table the project owns
and the only genuinely unrecoverable one (Steam has no "mark as played" and never returns one), so
the two facts are split rather than traded:

| | Backed up? | Committed? |
|---|---|---|
| `fpm_catalog` - the LLM scores, the tags, prices | yes, `catalog.sql.gz` | **yes** |
| **`game_marks`** - play history | yes, `private-personal.sql` | **NO** - `backups/.gitignore` |
| **`settings`, `dismissals`** - keyed to a SteamID64 since increment 15 | yes, `private-personal.sql` | **NO** - `backups/.gitignore` |
| `catalog_meta` - the snapshot version stamp | **no** | no |

**`settings` and `dismissals` moved out of the committed dump in increment 15 (SEC-1).** They were
in it from the day this tool was written, and that was harmless for exactly as long as they held
nothing but a key and a value. Increment 15 gave all three personal tables a leading
`steam_id TEXT NOT NULL`, so every row of both now carries a live SteamID64 - James's, and every
mate he invites - each of which resolves to a `steamcommunity.com/profiles/<id>` page. `SPEC.md` §9
forbids committing exactly that list, for exactly that reason. **The next `npm run backup` after the
re-key would have published it.** Nothing leaked: the file committed before increment 15 predates
the re-key and carries no ids, and `test/backup-restore.test.mjs` now asserts that against the real
tracked bytes.

`catalog_meta` is dropped outright rather than kept locally. The stamp is regenerated in one write
by `npm run restore`, and backing it up creates a restore path that can resurrect a stale-version
match - a restored database presenting the same version as a snapshot still sitting in KV. That is
the exact hazard increment 13's blocker CR-2 exists to make impossible, and there is no reason to
build a second door into it.

The verified fact, taken after the change: `gunzip -c backups/catalog.sql.gz | grep game_marks`
returns nothing. The table was empty when this was found, so nothing has ever leaked - it would have
started publishing the moment a game was marked.

There is a test for each half of this in `test/backup-restore.test.mjs`, including one asserting the
strings `game_marks`, `settings` and `dismissals` appear nowhere in the committed dump, and one
asserting no `7656119**********` SteamID64 appears in the real, tracked `catalog.sql.gz`.

## Why this exists

`.wrangler/state/v3` is gitignored and holds the two most expensive things this
project owns:

- **18,219 rows of LLM judgement** (`experience_score`, `game_score`,
  `has_ending`, `hours_to_value`, `hours_to_good`, the reason lines) - about
  6.5 hours of wall clock and real model spend, from increments 10 and 10.5.
- **18,306 rows of SteamSpy tags** - roughly 5 hours of throttled crawling,
  from increment 9.

Everything else in the table (owners, review counts, wilson, prices, app_type,
`main_hours`) is re-crawlable in an afternoon. Those two are not.

The security review raised the missing backup in increment 10 and again in
increment 11. This closes it.

## Why it is committed rather than kept locally

A backup on the same disk as the thing it protects is not a backup. Committing
it puts a copy on GitHub, which is the only off-machine copy that exists. It
compresses to about 3 MB, which is a reasonable price for the crown jewels.

One fixed filename, overwritten each time, so **git history is the backup
history**:

```
git log --oneline backups/            # every snapshot ever taken
git show <sha>:backups/catalog.sql.gz # recover any of them
```

Timestamped files were the alternative and were rejected: they accumulate
forever and nobody prunes them.

## Use it

```
npm run backup                              # writes BOTH dumps; commit only catalog.sql.gz
npm run restore -- --into /tmp/check.sqlite # verify, touching nothing real
npm run restore -- --force                  # really replace the live database
```

`npm run backup` prints which file each table went to, and prints a line telling you not to commit
the private one. `npm run restore` covers the committed dump only.

### Putting the PRIVATE dump back, and the one check that has to come first

The personal dump is plain SQL replayed by hand, so it gets **no** tool and therefore no guard of its
own. **Check its shape before you replay it.** A dump taken before increment 15's re-key has
un-keyed `CREATE TABLE`s and 6-column `INSERT`s; replayed into the current 7-column tables the
`CREATE TABLE`s no-op (the tables already exist) and **every `INSERT` errors on column count**. This
is the file holding `game_marks`, the only unrecoverable table the project owns, so the check is not
optional:

```sh
if grep -q 'steam_id' backups/private-personal.sql; then
  sqlite3 <db> < backups/private-personal.sql
else
  echo 'REFUSING: backups/private-personal.sql predates increment 15 - no steam_id column.'
  echo 'Load it into a THROWAWAY db (sqlite3 /tmp/old.sqlite < backups/private-personal.sql),'
  echo 'read the rows out, and re-enter them in the app. Never replay it into the live database.'
fi
```

`backups/private-marks.sql`, the older file left on disk from before the rename, **fails that check
by construction** - it predates the re-key. It is a readable record, not a replayable one.

`npm run restore` with no arguments **refuses** and tells you both options. The
accident it guards against is running restore when you meant backup, and
silently replacing fresh judgement with an old snapshot.

Both scripts verify against a header the dump carries - table counts, scored
rows, tagged rows - so a truncated or wrong-shaped file fails loudly instead of
restoring a partial catalogue over a good one.

## The round trip has been exercised, not assumed

On 2026-09-04 the dump was restored into a throwaway database and a SHA-256 over
`appid, experience_score, game_score, has_ending, hours_to_value,
experience_reason, tags, rank_exclude_reason` for all 18,306 rows, ordered by
appid, was compared against the live database:

```
live     058cd7f72fc2e83dc85f3b651350781bcbc71589d83f0c602ebbc74e22e8bbc2
restored 058cd7f72fc2e83dc85f3b651350781bcbc71589d83f0c602ebbc74e22e8bbc2
```

Identical. Re-run that check whenever the schema changes.

**It was not re-run when increment 15 re-keyed the three personal tables, and the restore path was
broken by it (SEC-2).** A dump taken before the re-key carries the old un-keyed `settings` and
`dismissals`; restoring it creates those tables, the app's own `CREATE TABLE IF NOT EXISTS` then
does nothing because a table of that name already exists, and every `WHERE steam_id = ?` throws
`no such column: steam_id`. The handlers fail-soft, so the symptom is a 200 with empty data - an app
that looks like it is working and shows you nothing.

**`npm run restore` now DROPS the personal tables on the way in**, whatever shape they are in, and
says loudly that it did. It does not refuse. A sentence in a README is not a guard; that drop is.

It refused, in the first cut of the fix, and that was wrong (SEC-8 / CR-12). The tracked
`catalog.sql.gz` **is** a pre-re-key dump, so the refusal blocked the only off-machine copy of the
18,219 LLM-scored rows - including `--into`, which cannot touch the live database at all and is the
verification recipe three blocks up. It then advised running `npm run backup`, which is exactly what
someone who has just lost `.wrangler/` cannot do. Dropping ends the hazard instead of trading it:
since increment 15 the personal tables have no business in a committed dump at all, and what the app
needs is for them to be **absent**, so its own `CREATE TABLE IF NOT EXISTS` builds them in the
current keyed shape on the next request. The `DROP`s ride the same `sqlite3` input stream as the
dump, appended after its `COMMIT`, so no completed restore ever leaves an un-keyed table behind.

## The table shapes, as of increment 15

`fpm_catalog` is unchanged. The three personal tables each lead their primary key with
`steam_id TEXT NOT NULL` - `TEXT` is forced, not preferred, because D1 returns rows to JS as numbers
and a SteamID64 loses precision as one.

```sql
CREATE TABLE settings (
  steam_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at INTEGER,
  PRIMARY KEY (steam_id, key)
)
CREATE TABLE dismissals (
  steam_id TEXT NOT NULL, appid INTEGER NOT NULL, name TEXT, dismissed_at INTEGER,
  PRIMARY KEY (steam_id, appid)
)
CREATE TABLE game_marks (
  steam_id TEXT NOT NULL, appid INTEGER NOT NULL, name TEXT,
  played INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
  marked_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (steam_id, appid)
)
```

All three are created by `CREATE TABLE IF NOT EXISTS` on the request path, so **an existing table is
never re-shaped**. That is the whole reason the restore guard above has to exist.

## Covered by automated tests since increment 12.5

That section used to say the opposite - that both scripts shell out to `sqlite3` and were therefore
deliberately left untested. `test/backup-restore.test.mjs` has covered them since increment 12.5,
copying both tools into a throwaway directory so they never touch the real `.wrangler/` or
`backups/`. Eleven tests, including the privacy split above, the `game_marks`-absent regression and increment
15's SteamID64-absent guard on the real committed file.
