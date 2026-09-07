# Deploy blockers

**Written at increment 13 (2026-09-06). This file is the reason `npm run deploy` still refuses to
run.** Increment 13 was renamed from "hosting readiness" to "hosting affordability" precisely so
that phrase would stop claiming a safety the increment does not deliver. The app is now **cheap
enough to host**. It is **not safe to host**, and this is the list of why.

---

## Blocker 1 - nothing authenticates. Not one route.

**Every route below is anonymous.** There is no session, no cookie, no Steam OpenID, no API key, no
per-user row key on any table. Deployed as-is on a public URL, every one of these serves James's
personal data to whoever asks.

Today's mitigation is entirely environmental and evaporates on deploy: the binding is loopback
(`127.0.0.1:8787`), no CORS headers are set, and `npm run deploy` hard-exits.

| Route | Method | Authenticates? | What it returns about James |
|---|---|:--:|---|
| `/api/library` | GET | **no** | His **entire Steam library**: every appid he owns, every title, playtime in minutes, and last-played timestamps |
| `/api/rank` | GET | **no** | The ranked catalogue **joined to his library** - which games he owns, hours played, what he has marked played or finished, his settings, and his taste profile's size |
| `/api/fpm` | GET | **no** | The catalogue joined to his library and owned flags |
| `/api/deals` | GET | **no** | The deals feed with his owned games excluded - which leaks ownership by omission |
| `/api/recs` | GET | **no** | Recommendations derived from his top-played games |
| `/api/best-of` | GET | **no** | As above |
| `/api/wishlist` | GET | **no** | His Steam wishlist |
| `/api/settings` | GET | **no** | Every persisted UI setting |
| `/api/settings` | PUT | **no** | **Writes** them. Anyone can change his settings |
| `/api/dismissals` | GET | **no** | Every game he has marked "not interested" |
| `/api/dismissals` | POST | **no** | **Writes** one |
| `/api/dismissals/:appid` | DELETE | **no** | **Deletes** one |
| `/api/marks` | GET | **no** | **His play history** - every game he has marked played or finished |
| `/api/marks/:appid` | PUT | **no** | **Writes** one |
| `/api/marks/:appid` | DELETE | **no** | **Deletes** one |
| `/api/fpm/sync` | POST | **no** | **Starts a multi-hour catalogue sync.** Anyone can start one, repeatedly |
| `/api/fpm/sync/stop` | POST | **no** | Stops one |
| `/api/fpm/sync/status` | GET | **no** | Sync progress and counters |

**`game_marks` is the only unrecoverable table in this project.** Increment 12.5 added it, and it
holds facts nothing upstream can ever regenerate: which games James has played and finished when
Steam has no record. Every other table can be rebuilt from Steam, SteamSpy, ITAD or an LLM run. That
one cannot. It is writable and deletable, today, by anyone who can reach the port.

**What has to exist before a deploy:** Steam OpenID 2.0 against a real return URL, a signed session
cookie with `Secure` and `SameSite` set for the hosted origin, a session store, a per-user key on
`settings`, `dismissals` and `game_marks` in **one** migration designed against a real auth model
(increment 12.5 §5 refused a speculative `user_id` column precisely so this would happen once), a
logged-out state for an eleven-route page, logout, and graceful handling of a Steam profile whose
privacy settings hide the library - "an empty library must not read as an empty product", and
**`source_owned` out of the shared catalogue snapshot**.

**That last item is not covered by per-user keys, and it is the one to read twice** (increment 13
review, SEC-9). `source_owned` is a column on `fpm_catalog`, derived from ONE user's Steam library,
and increment 13's catalogue snapshot is a **globally shared KV value** that carries it:
`src/worker.js` reads it into each row's rendered `owned` flag and `src/rank.js` uses it for pool
eligibility. SPEC.md §4.1's claim that "the rows are user-independent by construction" is true of
every other column and **not true of this one**. It is harmless today - one user, loopback - and a
per-user key on `settings` / `dismissals` / `game_marks` would NOT fix it, because the leak is a
catalogue column baked into a cache value every visitor shares. The fix is a decision for the auth
increment: strip it from the snapshot and join ownership per request, as the library already is.

That is an epic's first increment, which is where the PRD puts it. Increment 13 §2 argues the case
for keeping it there: auth built without a deploy protects nothing today, and cannot be proven at
`localhost:8787`, because the whole mechanism is a redirect dance against an origin that does not
yet exist.

---

## Blocker 2 - four retiring routes are still live, and one of them is expensive

Increment 12 marked `/api/fpm`, `/api/recs`, `/api/deals` and `/api/best-of` for deletion. Increment
13 pushed that to the deploy epic's cleanup rather than doing it mid-probe (§7 item 3). **The honest
cost of that deferral is recorded here rather than forgotten:**

- **`/api/fpm` runs its own uncached full-catalogue read** (`selectMatchedCatalogRows`, 14,679 rows).
  Increment 13 took `/api/rank` from 36,620 D1 row reads per request to 9, so **"a page load costs a
  bounded number of row reads" is now true**. "The app costs a bounded number of row reads" is
  **not**, and will not be until these four are gone.
- All four are anonymous and all four join the library, so they are covered by blocker 1 as well.
- `public/filters.js` and `public/weight.js` are orphaned front-end modules belonging to the same
  cleanup.

---

## Blocker 3 - no rate limit on the sync trigger

`POST /api/fpm/sync` starts a background pipeline that crawls SteamSpy, calls ITAD, calls Steam and
can run for hours. It is guarded by an in-isolate `fpmSyncRunning` flag, which is enough for one
person on one machine and is not a rate limit. On a public origin it is a way to burn the free tier
and get the app's IP throttled by three upstreams.

---

## What is NOT a blocker, and why

- **Cost.** Increment 13 fixed it. A warm page load reads **9 D1 rows** instead of 36,620; the
  catalogue is read in full at most a few times a day regardless of traffic. The free-tier ceiling
  moves from **136 page loads a day to roughly 20,000**, where the binding limit becomes Workers'
  100,000 requests/day rather than D1's row reads.
- **Speed.** Also not a blocker, and worth stating plainly because the cost fix is easily mistaken
  for a speed fix: a warm page load was already ~0.9 s before this increment and is ~0.75 s after.
  The occasional ~30 s load is the 24-hour Steam library refresh, which is per-user, upstream, and
  untouched by any of this.
- **Secrets.** `STEAM_API_KEY`, `ITAD_API_KEY` and `EXPERIENCE_HELPER_TOKEN` live in `.dev.vars`,
  which is gitignored, and would move to Worker secrets at deploy. Not a blocker, but it is a step.

---

## What leaves this machine, and what does not

Not a deploy blocker, but the same class of question and it belongs beside them: **this repository
is public**, so anything committed is published. James ruled on the split on 2026-09-06, after
increment 13's security review (SEC-6).

| Data | Where it lives | Leaves the machine? |
|---|---|---|
| Steam library, playtimes, `game_marks` (play history) | local D1, `.wrangler/` (gitignored) | **no** |
| `backups/private-marks.sql` - a dump of `game_marks` | `backups/`, in `backups/.gitignore` | **no** |
| `backups/catalog.sql.gz` - `fpm_catalog`, `settings`, `dismissals` | committed | **yes, to GitHub** |
| `STEAM_API_KEY`, `ITAD_API_KEY`, `EXPERIENCE_HELPER_TOKEN` | `.dev.vars` (gitignored) | **no** |
| `catalog_meta` - the catalogue snapshot version stamp | local D1 only | **no**, and not backed up |

**The committed backup used to include `game_marks`.** It was added in increment 12.5 for the right
reason - it is the only genuinely unrecoverable table the project owns - and nobody asked the second
question, which is that this repo is public. The table was empty throughout, so nothing leaked; it
would have started publishing the moment a game was marked. It is now dumped locally and excluded
from the committed file, and there is a test asserting the string does not appear in it.

**`catalog_meta` was dropped from the backup entirely**, for a different reason: the version stamp
is regenerable in one write, and restoring an old one creates a path to a stale-version match
against a snapshot still sitting in KV.

**Still true, and worth restating here:** every route serves this data to anyone who asks, and three
accept writes. That is blocker 1, and none of the above changes it.

---

## Status

**`npm run deploy` is a hard-fail stub and stays one.** Its message names blocker 1. It exits
non-zero. Nothing in increment 13 changes that, and nothing should until blocker 1 is closed.
