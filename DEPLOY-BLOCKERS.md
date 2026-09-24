# Deploy blockers

**Written at increment 13 (2026-09-06). This file is the reason `npm run deploy` still refuses to
run.** Increment 13 was renamed from "hosting readiness" to "hosting affordability" precisely so
that phrase would stop claiming a safety the increment does not deliver. The app is now **cheap
enough to host**. It is **not safe to host**, and this is the list of why.

---

## Blocker 1 - CLOSED at increment 15. Every route authenticates.

**Closed 2026-09-21.** Steam OpenID 2.0, a signed session cookie, an invite allow-list and a
default-deny gate landed together as increment 15. **All thirteen route/method pairs in the table
below now answer `401` without a valid signed cookie**, captured live with full response bodies.

- **One default-deny gate**, above all route matching, that **fails closed on every error path** - a
  malformed cookie, a thrown crypto call, a missing `SESSION_SECRET`, an unreadable allow-list. This
  deliberately contradicts `src/catalogCache.js:30`'s "FAIL-SOFT IS ABSOLUTE", which is right for a
  cache and catastrophic for auth.
- **A stateless HMAC-SHA256 cookie**, `__Host-sss_session`, `Secure; HttpOnly; Path=/; SameSite=Lax`,
  180 days sliding. **There is no session store**, in D1, in KV or anywhere else - ticket #7
  dissolved that question rather than answering it.
- **`ALLOWED_STEAM_IDS`, checked TWICE** - at the callback, so a refused stranger gets an honest
  answer instead of looping through Steam forever, and **in the gate on every request**, which is
  the revocation the missing session store was traded away for.
- **`steam_id TEXT NOT NULL` leads a composite primary key** on `settings`, `dismissals` and
  `game_marks`. Every statement reaching those tables carries a `steam_id` predicate. `TEXT` is
  forced, not preferred: a SteamID64 loses precision as a JavaScript number.
- **The page shows a pitch instead of a lie** when nobody is signed in, and fires exactly one
  request - `GET /api/me` - before it knows who you are.

**Four things above the gate, and the list is exactly this:** `GET /api/me` (it is the question "am
I signed in", so gating it makes it unable to answer no - it returns `{signedIn:false}` with a 200,
never a 401), `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`. The `/api/` 501
catch-all stays **below** the gate, so a signed-out caller hitting a deleted route gets 401, not 501.

**What is still true, and is not a blocker:** the token is stateless and sliding, so a captured
cookie survives a logout and can be renewed indefinitely by whoever holds it. **Rotating
`SESSION_SECRET` is the documented panic button**, and it is the only lever that covers James -
pulling himself off the allow-list would lock him out too. That is ticket #7's accepted cost, not an
open defect.

**`npm run deploy` is still a hard-fail stub**, because ticket #12 takes it down last, after the
rest of the map. Blocker 1 being closed is what makes that ticket reachable.

### The historical record - what every route served before increment 15

Kept because it is the evidence, not because it is still true. **Every row now requires a signed
cookie carrying an allow-listed SteamID64.**

The mitigation at the time was entirely environmental and would have evaporated on deploy: the
binding was loopback (`127.0.0.1:8787`), no CORS headers were set, and `npm run deploy` hard-exited.

**Thirteen route/method pairs, down from eighteen at increment 13.** Increment 14 deleted
`/api/library`, `/api/deals`, `/api/recs`, `/api/best-of` and `/api/fpm` outright - see blocker 2,
now closed. They are gone from the router, not disabled, and answer `501 not implemented`. The five
rows they held in the table below are gone with them. **This shrinks the surface auth has to cover;
it closes nothing.** Every row left is still anonymous.

| Route | Method | Authenticates? | What it returns about James |
|---|---|:--:|---|
| `/api/rank` | GET | **no** | The ranked catalogue **joined to his library** - which games he owns, hours played, what he has marked played or finished, his settings, and his taste profile's size |
| `/api/wishlist` | GET | **no** | His Steam wishlist |
| `/api/settings` | GET | **no** | Every persisted UI setting |
| `/api/settings` | PUT | **no** | **Writes** them. Anyone can change his settings |
| `/api/dismissals` | GET | **no** | Every game he has marked "not interested" |
| `/api/dismissals` | POST | **no** | **Writes** one |
| `/api/dismissals/:appid` | DELETE | **no** | **Deletes** one |
| `/api/marks` | GET | **no** | **His play history** - every game he has marked played or finished |
| `/api/marks` | POST | **no** | **Writes** one |
| `/api/marks/:appid` | DELETE | **no** | **Deletes** one |
| `/api/fpm/sync` | POST | **no** | **Starts a multi-hour catalogue sync.** Anyone can start one, repeatedly |
| `/api/fpm/sync/stop` | POST | **no** | Stops one |
| `/api/fpm/sync/status` | GET | **no** | Sync progress and counters |

**`game_marks` is the only unrecoverable table in this project.** Increment 12.5 added it, and it
holds facts nothing upstream can ever regenerate: which games James has played and finished when
Steam has no record. Every other table can be rebuilt from Steam, SteamSpy, ITAD or an LLM run. That
one cannot. It is writable and deletable, today, by anyone who can reach the port.

**What had to exist before a deploy, and what of it shipped.** This list was written at increment
13. Increment 15 built all of it except the two items marked below.

| Required | Shipped? |
|---|---|
| Steam OpenID 2.0 against a real return URL | **yes** - proven end to end against real `steamcommunity.com` on 2026-09-21 |
| A signed session cookie with `Secure` and `SameSite` set | **yes** - `__Host-sss_session`, `SameSite=Lax` |
| A session store | **deliberately not built.** Ticket #7 dissolved the question: KV loses on 1,000 writes/day and on eventual consistency; D1 loses on paying a row read per request to re-learn what the cookie already proves. The allow-list is the revocation instead. |
| A per-user key on the three tables, in ONE migration designed against a real auth model | **yes** - and increment 12.5 §5's refusal of a speculative `user_id` column is what made it happen once |
| A logged-out state, and logout | **yes** - the pitch page and a `POST /auth/logout` |
| Graceful handling of a private Steam profile - "an empty library must not read as an empty product" | **NOT CLOSED.** See below. |
| **`source_owned` out of the shared catalogue snapshot** | **NOT CLOSED - ticket #4, increment 16.** See below. |

**Two items from that list are still open, and both are increment 16's.**

1. **`source_owned` in the globally shared snapshot (ticket #4).** Read the section below - it is
   unchanged and still correct. Per-user keys did NOT fix it, exactly as predicted.
2. **A private Steam profile still reads as an empty product.** Increment 14's QA found that both
   surviving `fetchOwnedGames` callers swallow all four distinct 502s, so a Steam outage and a
   private profile are indistinguishable from outside. Increment 15 made this *more* honest, not
   less - spec §11.5: the default-deny gate means "no session" can no longer reach those functions,
   so an empty result now means exactly one thing, that the upstream failed. **It still does not say
   which upstream failure it was.**

**A third thing, and it is operational rather than code.** Tickets #4 and #10 are both safe only
while the allow-list holds one person. **Do not add a second SteamID64 to `ALLOWED_STEAM_IDS` until
#4 and #10 ship.** The moment a mate signs in, they see James's ownership flags baked into every
catalogue row, and they can start a multi-hour crawl.

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

## Blocker 2 - CLOSED at increment 14. The retiring routes are deleted.

**Closed 2026-09-14.** Increment 12 marked `/api/fpm`, `/api/recs`, `/api/deals` and `/api/best-of`
for deletion and increment 13 deferred it (§7 item 3). Increment 14 carried it out, and took
`/api/library` with them - five routes, not four. All five are deleted from the router and answer
`501 not implemented` from the `/api/` catch-all.

- **The uncached full-catalogue read is gone.** `/api/fpm`'s `selectMatchedCatalogRows` call was the
  last unbounded D1 read in the app. **"The app costs a bounded number of row reads" is now true**,
  not just "a page load costs a bounded number".
- **Five anonymous library-joining routes left blocker 1's table**, taking it from eighteen
  route/method pairs to thirteen.
- **`public/filters.js` is deleted.** **`public/weight.js` is NOT** - the entry above was wrong to
  call it orphaned. `src/profile.js` imports `weight`/`recencyMultiplier` from it and `src/rank.js`
  imports `src/profile.js`, so deleting it would break the ranking. It is misfiled under `public/`,
  which is what made it look dead. Moving it is a tidy-up, not a cleanup blocker.
- `src/why.js` and `src/hallOfFame.js` are deleted with the handlers that were their only callers.

`POST /api/fpm/sync`, `GET /api/fpm/sync/status` and `POST /api/fpm/sync/stop` are untouched and
still live - they fill the catalogue `/api/rank` reads. Their own exposure is blocker 3.

---

## Blocker 3 - narrowed at increment 15. No rate limit, but no longer anonymous.

`POST /api/fpm/sync` starts a background pipeline that crawls SteamSpy, calls ITAD, calls Steam and
can run for hours. It is guarded by an in-isolate `fpmSyncRunning` flag, which is enough for one
person on one machine and is **not a rate limit**. On a public origin it is a way to burn the free
tier and get the app's IP throttled by three upstreams. **That part is unchanged and still open.**

**What increment 15 DID close here: the anonymous and cross-site trigger.**

- **Anonymous triggering is gone.** `POST /api/fpm/sync` sits below the default-deny gate and
  answers **401** without a valid signed cookie, proven live. A stranger cannot start a sync at all.
- **SEC-1, the cross-site trigger increment 14 left open, dies as a side effect.** That finding was
  an `<img src=".../api/fpm/sync">` on any page James had open. An `<img>` is a **subresource**
  request, and `SameSite=Lax` attaches the session cookie only to top-level navigations, so the
  cookie is simply absent and the gate returns 401. Verified by the security lane rather than
  assumed. The two `:appid` prefix routes additionally hard-405 anything that is not DELETE, and
  cross-site JSON POST is blocked because no CORS headers exist anywhere in this app.

**What is left, and who owns it.**

| Remaining | Owner |
|---|---|
| **No rate limit.** A signed-in user can still trigger repeated multi-hour syncs. | Still blocker 3. Unowned. |
| **The sync routes are not owner-only.** Any allow-listed mate can start one. | **Ticket #10, increment 16.** Spec §15 defers it explicitly: #10's remaining subject is a signed-in *mate*, and no mate exists during this epic. |

**The operational rule that keeps this safe until then:** do not add a second SteamID64 to
`ALLOWED_STEAM_IDS` until **tickets #4 AND #10** ship. One person on an allow-list cannot abuse a
trigger they already control - but #10 alone is not the whole precondition. Ticket #4 (`source_owned`
in the globally shared snapshot) has the same trigger and a different harm: the first mate
to sign in is handed James's ownership flags baked into every catalogue row. Both tickets gate the
same one action, and this line used to name only one of them.

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
| `settings`, `dismissals` - keyed to a SteamID64 since increment 15 | local D1, `.wrangler/` (gitignored) | **no** |
| `backups/private-personal.sql` - a dump of `game_marks`, `settings`, `dismissals` | `backups/`, in `backups/.gitignore` | **no** |
| `backups/catalog.sql.gz` - `fpm_catalog` only **from the next `npm run backup` onwards**; the file in the tree today still carries the pre-re-key `settings` (6 rows, no `steam_id`) and `dismissals` (0 rows) | committed | **yes, to GitHub** |
| `STEAM_API_KEY`, `ITAD_API_KEY`, `EXPERIENCE_HELPER_TOKEN` | `.dev.vars` (gitignored) | **no** |
| `catalog_meta` - the catalogue snapshot version stamp | local D1 only | **no**, and not backed up |

**Increment 15 (SEC-1) took `settings` and `dismissals` out of the committed backup too.** The
re-key put a live SteamID64 in every row of both, and each one resolves to a
`steamcommunity.com/profiles/<id>` page - the same harm `SPEC.md` §9 forbids for a committed
`ALLOWED_STEAM_IDS`, arriving through the backup instead. The next `npm run backup` after the re-key
would have published James's id and every invited mate's. Nothing leaked: the file committed before
increment 15 predates the re-key. `backups/private-personal.sql` (renamed from `private-marks.sql`)
now holds all three personal tables, locally.

**The committed backup used to include `game_marks`.** It was added in increment 12.5 for the right
reason - it is the only genuinely unrecoverable table the project owns - and nobody asked the second
question, which is that this repo is public. The table was empty throughout, so nothing leaked; it
would have started publishing the moment a game was marked. It is now dumped locally and excluded
from the committed file, and there is a test asserting the string does not appear in it.

**`catalog_meta` was dropped from the backup entirely**, for a different reason: the version stamp
is regenerable in one write, and restoring an old one creates a path to a stale-version match
against a snapshot still sitting in KV.

**No longer true, and corrected here:** this paragraph used to say every route served this data to
anyone who asks. **Blocker 1 closed at increment 15** - see the top of this file. All thirteen
route/method pairs answer `401` without a valid signed cookie, so reaching any of the data above now
requires a session on the allow-list. What the split in this section protects against is a different
reader entirely: **anyone on the internet with a copy of this public repository.** A committed backup
needs no route and no cookie.

---

## Status

**`npm run deploy` is a hard-fail stub and stays one, for now.** It still exits non-zero, and
`test/deploy-stub.test.mjs` still passes unchanged. **Its message is now out of date**: it names
blocker 1, which closed at increment 15.

**That is deliberate and it is not an oversight.** Ticket #12 takes the stub down **last**, after
the rest of the map, by its own ruling - it also moves `SESSION_SECRET`, `ALLOWED_STEAM_IDS`,
`STEAM_API_KEY`, `ITAD_API_KEY` and `EXPERIENCE_HELPER_TOKEN` from `.dev.vars` to real Worker
secrets, and rewriting the refusal message is part of that same change rather than a drive-by here.

**Blocker 3's rate limit and ticket #10's owner check are the remaining gates on a real deploy**,
together with ticket #4's `source_owned`. Increment 16 owns #4 and #10.
