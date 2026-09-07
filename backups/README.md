# Catalogue backups

`catalog.sql.gz` is a gzipped SQL dump of three D1 tables - `fpm_catalog`, `settings`,
`dismissals` - and it is **tracked in git on purpose**.

`private-marks.sql` is a plain SQL dump of **`game_marks`**, and it is **untracked on purpose**.
It never leaves this machine.

## THIS REPOSITORY IS PUBLIC, SO THE SPLIT MATTERS

James's ruling, 2026-09-06, on increment 13's security review (SEC-6). The committed dump is
published to the internet on every backup, and `game_marks` is his **play history** - which games he
has played and which he has finished. It is simultaneously the most private table the project owns
and the only genuinely unrecoverable one (Steam has no "mark as played" and never returns one), so
the two facts are split rather than traded:

| | Backed up? | Committed? |
|---|---|---|
| `fpm_catalog` - the LLM scores, the tags, prices | yes, `catalog.sql.gz` | **yes** |
| `settings`, `dismissals` | yes, `catalog.sql.gz` | **yes** |
| **`game_marks`** - play history | yes, `private-marks.sql` | **NO** - `backups/.gitignore` |
| `catalog_meta` - the snapshot version stamp | **no** | no |

`catalog_meta` is dropped outright rather than kept locally. The stamp is regenerated in one write
by `npm run restore`, and backing it up creates a restore path that can resurrect a stale-version
match - a restored database presenting the same version as a snapshot still sitting in KV. That is
the exact hazard increment 13's blocker CR-2 exists to make impossible, and there is no reason to
build a second door into it.

The verified fact, taken after the change: `gunzip -c backups/catalog.sql.gz | grep game_marks`
returns nothing. The table was empty when this was found, so nothing has ever leaked - it would have
started publishing the moment a game was marked.

There is a test for each half of this in `test/backup-restore.test.mjs`, including one asserting the
string `game_marks` appears nowhere in the committed dump.

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
the private one. `npm run restore` covers the committed dump only; the marks dump is plain SQL and
goes back in with `sqlite3 <db> < backups/private-marks.sql`.

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

## Covered by automated tests since increment 12.5

That section used to say the opposite - that both scripts shell out to `sqlite3` and were therefore
deliberately left untested. `test/backup-restore.test.mjs` has covered them since increment 12.5,
copying both tools into a throwaway directory so they never touch the real `.wrangler/` or
`backups/`. Seven tests, including the privacy split above and the `game_marks`-absent regression.
