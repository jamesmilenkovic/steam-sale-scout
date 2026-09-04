# Catalogue backups

`catalog.sql.gz` is a gzipped SQL dump of the three durable D1 tables:
`fpm_catalog`, `settings`, `dismissals`. It is **tracked in git on purpose**.

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
npm run backup                              # overwrite the dump, then commit it
npm run restore -- --into /tmp/check.sqlite # verify, touching nothing real
npm run restore -- --force                  # really replace the live database
```

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

## Not covered by automated tests, deliberately

Both scripts shell out to `sqlite3`. The test suite is provably offline-clean
and spawns no subprocesses, and adding a test here would break that discipline
for a tool that is exercised by hand and verified by checksum. Stated as a
choice rather than left as a gap.
