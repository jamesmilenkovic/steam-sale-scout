# Increment 13 - Hosting affordability

> **Note added 2026-09-14 (increment 14):** this spec refers to routes that no longer exist.
> `/api/library`, `/api/deals`, `/api/recs`, `/api/best-of` and `GET /api/fpm` were deleted at
> increment 14 and now answer `501 not implemented`. Nothing below has been rewritten - this
> file stays the record of what was true when it was approved.

**Scoped:** 2026-09-06 · **Status:** APPROVED by James 2026-09-06 
**Base:** `experience` @ `d4a458b` (increment 12.5 shipped)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md` – **Rev 3, Phase 5**, the
**"Increment 13 – Hosting readiness"** paragraph and its ⛩ REVIEW, the **"Then: the deploy epic"**
paragraph, the seven **increment 10 rulings**, the **increment 11 outcome** and the **increment
12.5 evidence** blocks. All binding. None re-opened here.

---

## 1. The one sentence, and the two numbers

**A page load reads the entire catalogue, and 16,383 of the rows it reads say "Price not known" –
including 3 of the top 10 picks.**

Two numbers, both measured 2026-09-06, and they are the whole increment:

1. **`/api/rank` costs 18,311 D1 row reads per request.** Against Cloudflare's free tier of 5M
   row-reads/day that is **273 page loads a day, total, across every user who will ever exist.**
   The app cannot be hosted at that price. It is not a performance problem – warm paint is
   0.89–1.09 s and already beat increment 12's target by 3x – it is a **cost-per-user** problem,
   and cost per user is what "hosting readiness" means.
2. **16,493 of 18,221 game rows carry no price. 14,141 of them have already been asked.** 12,413
   were checked and ITAD returned nothing at all. **This is not a "go and fetch the missing prices"
   increment.** The rows were asked, the answer came back empty, and nobody has established why.
   Until that is measured, a fill is a fill of the same nothing.

**User story.** As someone who wants to put this on a real URL for other people, I want a page load
to cost a small, known, catalogue-independent number of database reads, and I want every row to
either show a price or say honestly why it has none, so that the app is affordable to host and
stops printing the same three words on sixteen thousand rows.

---

## 2. Auth is OUT, and the increment is renamed rather than expanded

**Recommendation: auth stays in the deploy epic. Increment 13 is renamed "hosting
affordability".** This is the answer to the loudest question in scoping and it goes first because
everything else depends on it holding.

Both result files nominate increment 13 for auth (`claude-code-result-increment-12.md` §7,
`claude-code-result-increment-12.5.md` §8), and they are right that it is a hard precondition for
any deploy. They are wrong that it belongs here. Five reasons, in order of weight:

1. **Auth without a deploy protects nothing.** Today's mitigation is that the binding is loopback,
   there are no CORS headers, and `npm run deploy` hard-exits. Adding Steam OpenID locally does not
   reduce today's risk by a single byte. It spends the increment and changes nothing about the
   actual exposure.
2. **It cannot be proven where it has to work.** Steam OpenID 2.0 is a redirect dance against a
   real return URL. `localhost:8787` can fake it; it cannot test the thing that matters, which is
   the hosted origin, the cookie's `Secure`/`SameSite` behaviour and the session store. An auth
   increment that ends with "we'll find out at deploy" is not an auth increment.
3. **Increment 12.5 already ruled on the schema half, and reversing that ruling costs more than it
   saves.** SPEC.md §5 refused a speculative `user_id` column so that `settings`, `dismissals` and
   `game_marks` all take the same key **in one migration designed against a real auth model rather
   than three times against a guess**. Auth here re-opens that ruling one increment after it was
   made.
4. **It is bigger than both halves of this increment combined.** OpenID provider dance, signed
   session cookies, a session store, per-user keys on three tables, a logged-out state for an
   eleven-route page, logout, and the PRD's graceful Steam-privacy handling ("an empty library must
   not read as an empty product"). That is an epic's first increment, which is exactly where the
   PRD puts it.
5. **The two preconditions are independent and both are real.** Affordability and safety are
   different gates. Doing them in one increment means neither is provable on its own.

**So what does "hosting readiness" mean if it excludes the one thing that makes hosting safe?**
Plainly: **it does not mean the app is ready to host. It means the app has stopped being
unaffordable to host.** Those are two different sentences and this increment only earns the second.
The honest fix is not to smuggle auth in – it is to stop the phrase doing work it cannot support.
So this increment ships one small artifact that makes the remaining blocker impossible to forget:

- **`DEPLOY-BLOCKERS.md` in the repo root**, listing every route, whether it authenticates (none
  do), and exactly what personal data each returns – library, playtimes, dismissals, settings and,
  since 12.5, **play history**, which is the only unrecoverable data in the project.
- **`npm run deploy`'s hard-exit message is rewritten to name auth as the blocker.** It currently
  says "Deploy deferred to Phase 3 … local-only through Phase 1", which is stale by two revs and
  names the wrong reason. One line. It stays a hard-fail stub.

That converts "auth is out" from a dodge into a documented gate (gate 10). **James can overturn
this**, and §8 question 1 is where he does it – the overturn cost is that increment 13 becomes two
increments and neither ships this week.

---

## 3. Prior art

Per the protocol's per-capability rule, the product landscape (Valve, ITAD, GG.deals, SteamDB,
SteamPeek, Deku Deals) is in the PRD's Landscape table and Rev 3 evidence item 10, and the backlog
trackers are in SPEC.md §3. Neither is re-walked. **Two capabilities are new here: caching a
user-independent computation in a Worker, and a price source that serves non-deal prices.**

### 3.1 Caching the catalogue computation

**TLDR:** nothing external needs adopting – this is Cloudflare's own primitives and the choice is
between three of them. **The in-repo prior art is stronger than any of it**: this project has
already built a KV cache with a TTL, an error TTL and a version-able key three separate times, and
the third one (increment 12.5's `libraryCacheKey` version bump) is the exact pattern this needs.

| What | Type | State | What it does well | Why it is or isn't the answer |
|---|---|---|---|---|
| **In-repo: `src/spyQueue.js` TAG_CACHE** | Our code | Live since inc 3 | Per-appid KV with a 30-day success TTL and a 1-hour error TTL. Proves KV works under `wrangler dev` and survives restarts. | **Reusable as pattern, not as code** – it is keyed per appid, we need one large blob. The TTL split (success long, error short) is worth copying. |
| **In-repo: `libraryCacheKey` (inc 12.5)** | Our code | Live | 24h library cache **with a version segment in the key**, added precisely because a cached payload written before a shape change silently produced a wrong answer. | **This is the model.** Same trap, same fix: a snapshot written before a schema change must not be readable after it. Copy the version-segment discipline verbatim. |
| **In-repo: `loadFpmPool`** | Our code | Live | ITAD deal pool cached per request with `?refresh=1` as the manual override. | `?refresh=1` already exists on `/api/rank` and is the free manual bust. No new parameter needed. |
| [Cloudflare KV](https://developers.cloudflare.com/kv/) | Platform primitive | GA | **Global**, so a rebuild is bounded by TTL rather than by how many data centres serve traffic – which is the only reason the daily row-read arithmetic in §4.1 holds. 25 MB value ceiling, `expirationTtl` garbage-collects old versions for free. Simulated locally by `wrangler dev`. | **Chosen.** The PRD's own standing rule (Architecture §5) says KV/Cache API is right for "cheap, short-TTL data … fine to refetch" and D1 for anything with a multi-hour cold-fill cost. A 30-second rebuild is squarely the former. |
| [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) | Platform primitive | GA | Bigger objects (512 MB), no serialisation ceremony, `stale-while-revalidate` semantics come free. | **Rejected.** It is **per-colo**. The rebuild count then scales with the number of data centres serving traffic, which is precisely the unbounded quantity the gate exists to eliminate. Named as the near-miss. |
| Module-scope memo in the isolate | Platform behaviour | GA | Free, zero reads, zero latency on a warm isolate. | **Adopted as a memo over the KV snapshot, not as the cache.** On its own the bound scales with isolate churn × users, which is not a bound. As a second tier it removes a ~10 MB KV read and a JSON parse from every warm request, which is what keeps warm paint near 1 s. |
| A materialised D1 table / view | Platform primitive | GA | Durable, queryable, no size ceiling. | **Rejected: it does not solve the problem.** D1 bills row reads. Reading 18,221 pre-computed rows costs the same 18,221 as reading 18,221 raw ones. |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | Platform primitive | GA | A single instance could hold the catalogue in memory and serve every request. | **Rejected as over-engineering.** It introduces a coordination primitive, a new billing line and a single point of failure to solve a problem KV solves with `get`/`put`. Revisit only if the snapshot ever needs to be written by many callers at once. |

**Reusable pieces: two, both in-repo, both free.** The version-segment key discipline from 12.5's
`libraryCacheKey`, and the success-TTL / error-TTL split from `spyQueue.js`.

**Build vs adopt: build, and it is small** – one new module (`src/catalogCache.js`), one changed
line in `handleRank`, one KV binding. No probe could change this; the candidates are three
primitives from one vendor and the deciding property (global vs per-colo) is documented, not
measurable locally.

### 3.2 The price source – and the finding that changes this increment's cost

**TLDR: the strongest candidate is already wired into this codebase and nobody noticed.**
`IStoreBrowseService/GetItems` is live-verified in `src/deckCompat.js` (2026-07-07), anonymous with
no key, **batched at 100 appids per call**, already passing `country_code: "AU"`, and its
`store_items[]` entries carry a purchase-option block alongside the platform block we already read.
If the probe confirms it serves prices for our priceless rows, **the fill is minutes, not the 6.5
hours increment 10 took.**

| What | Type | State | What it does well | Why it is or isn't the answer |
|---|---|---|---|---|
| **ITAD `/games/prices/v2`** | Third-party API, keyed | **Live, and already our price source** (`src/catalog.js:1935`) | Natively batched at 200 ids. Carries `regular`, `cut` and the historical-low data nothing else has. Already has backoff, `retry-after` handling and write-through. | **The incumbent, and it is the thing under suspicion.** Our call reads `entry.deals[]` and takes only shop 61. 1,728 rows priced is suspiciously close to the number of games actually *on sale*. Hypothesis to test: **the endpoint is returning deals only, because we never asked it for anything else.** If so, the 12,413 empties are our bug and the fix is a query parameter. |
| **Steam `IStoreBrowseService/GetItems`** | Official Steam API, anonymous | **Live and already in our code** | Batched at 100. AUD-native via the `country_code` we already send. Returns the purchase option (final price, original price, discount %), plus `is_free` and country-restriction flags – **so it can name *why* a row has no price**, which ITAD's silence cannot. Existing KV cache, chunking and 30-day TTL. | **The strongest candidate on paper.** Unverified for the price fields specifically – `src/deckCompat.js` only ever requested `include_platforms`. The probe requests the purchase-option data and looks. |
| **Storefront `appdetails`** | Unofficial, no key | Live, used by inc 7.8 for `app_type` | Ground truth per the PRD's Data sources §5. `is_free` and `success: false` give the delisted/unavailable states. Its throttle is already characterised in `src/catalog.js:913` as "genuine and reliable". | **The PRD's named fallback, and the expensive one.** Per-appid it is ~200 req / 5 min → **16,493 rows ≈ 6.9 hours**. The probe's most valuable single question is whether `?appids=a,b,c&filters=price_overview&cc=au` returns *all* of them or silently truncates – that one answer is worth about seven hours of wall clock. |
| SteamSpy `appdetails` `price` / `initialprice` | Unofficial | Live, already crawled for tags at inc 9 | We already fetch this endpoint for all 18k rows. Prices would be nearly free. | **Rejected: wrong currency.** SteamSpy reports USD cents. This project is AUD-native end to end (PRD Data sources: "All AUD-native via ITAD `country=AU` + storefront `cc=au`"). A USD number rendered as `$` on an Australian page is a quiet lie, and converting it is a second lie. |
| [GG.deals API](https://gg.deals) | Third-party, keyed | Live, AUD-capable | Good AUD price lookup; the PRD already names it as a fallback. | **Rejected: a new vendor, a new key, a new rate limit and a new ToS question, to solve a problem three sources we already hold might solve.** Reopens only if all three probe candidates fail. |
| CheapShark / SteamDB | Third-party | Live | – | **Already excluded by the PRD** (Data sources §6): CheapShark is US/USD only; SteamDB has no API and prohibits scraping. Not re-litigated. |

**Reusable pieces: substantial, and this is the honest half of the survey.** Increment 8.5's
backfill is genuine prior art and most of it survives:

- **Keep and extend:** `selectPriceBatch` / `recordPriceResult` / `resolvePriceBatch`'s entire
  resumability model – write-through per chunk, `price_checked_at` as the cursor, retry the *same*
  chunk on a bad response, `FPM_PRICE_MAX_CONSECUTIVE_BAD` give-up, `retry-after` honoured as a
  floor on the backoff. This is proven and is not rewritten.
- **Keep:** the existing `price` / `price_cents` / `regular` / `cut` columns. A storefront response
  maps onto them exactly (`final` → `price`, `initial` → `regular`, `discount_percent` → `cut`), so
  **no new price columns are needed.** Only a state column and a source column (§5).
- **Fix, and it is a live defect:** `selectPriceBatch`'s `WHERE main_hours IS NOT NULL` gate. That
  gate belongs to the retired `/api/fpm` lane, and **increment 10 ruling 5 retired HLTB hours from
  every new metric.** It is why rows the ranked pool contains were never eligible for a price check
  at all. This is most likely the bulk of the 4,080 "genuinely unchecked".
- **Fix, and it would silently undo the fill:** `recordPriceResult` writes `regular = NULL` when a
  later check finds no live deal. A list price won by this increment's fill would be **erased by
  the next routine sale refresh.** Gate 9 exists solely for this.
- **Do not reuse:** the assumption that "ITAD returned nothing" means "there is no price". That
  assumption is the thing being tested.

**What nobody has done:** nothing novel is claimed here. This is plumbing, and the survey's job was
to find the cheap path before committing to the expensive one. It found one.

**Build vs adopt: adopt the existing machinery, and let a measured probe pick the source** – per
the protocol's "settle build-vs-adopt by measurement, not by reading" rule, and per the PRD's
explicit "probe-first" instruction for this increment. §4.2 pre-registers the decision rule so the
probe cannot be read to fit a preference.

---

## 4. Scope – exactly what gets built

Two halves, built in this order, with a declared split point between them (§4.3).

### 4.1 Half A – the catalogue snapshot

**The seam, stated precisely: `selectRankCatalogRows(env)` in `handleRank` becomes
`loadRankCatalogue(env, ctx)`. That is the only line in `handleRank` that changes.** Everything
downstream – the funnel, the IDF corpus, the profile, similarity, the blend, the sort – is
untouched and runs per request exactly as it does today.

**What is cached: the raw catalogue rows, and nothing else.** The rows are user-independent by
construction – Rev 2's binding two-layer rule. Everything the request joins onto them is per-user
and is loaded separately today and stays that way: the library (`loadLibraryForRank`), dismissals,
marks, settings, and the ITAD deal pool.

**What is deliberately NOT cached, and this is a refusal not an oversight:**

| Not cached | Why |
|---|---|
| **The IDF map** | `computeIdf` runs over the *eligible* pool's tag sets, and eligibility subtracts dismissals and low-confidence rows. Caching it would freeze one user's exclusions into every other user's similarity weights. The numeric difference would be tiny, and **a tiny change to the ranking is still a change to the ranking, which is frozen.** |
| **Similarity, normalised or raw** | Rev 2 §2: "similarity is never persisted per game: taste moves, tags don't." A cache is persistence. |
| **The `/api/rank` response, per preset** | It carries marks, dismissals, owned flags and playtimes. Caching it caches one person's library. |
| **`buildRankSpyData`'s KV reads** | Per-user by definition (the top owned games). Out of scope; noted in gate 1's attribution so it is not mistaken for catalogue cost. |

**Three tiers, one snapshot, one version.**

| Tier | Cost on a hit | Reported as |
|---|--:|---|
| Module-scope memo, keyed on the version stamp | 0 reads | `cacheState: "memory"` |
| KV value `catalog-snapshot:v1:<version>` | 0 D1 reads, 1 KV read | `cacheState: "kv"` |
| D1 full read, then write through to both | 18,311 D1 reads | `cacheState: "rebuild"` |

**Invalidation – four mechanisms, deliberately overlapping:**

1. **A version stamp**, one row in a new `catalog_meta` table (§5), bumped by
   `bumpCatalogVersion(env)` at the end of every sync step in `src/catalog.js` that writes to
   `fpm_catalog`, and by `tools/restore-catalog.mjs` after a restore. The stamp is a timestamp plus
   a random suffix, so two different databases can never collide on one.
2. **A 6-hour TTL ceiling** on the KV value (`expirationTtl`), as the safety net for any writer
   that bypasses the bump – a hand-run `sqlite3` statement, for instance. This is what makes the
   daily arithmetic below a worst case rather than a hope.
3. **`?refresh=1`**, which `handleRank` already parses. No new parameter.
4. **The version segment in the key** (`v1`), bumped by hand whenever the selected column list
   changes – the exact discipline increment 12.5 added to `libraryCacheKey` for exactly this trap.

**Serve stale, rebuild in the background.** A snapshot past its TTL is served immediately and the
rebuild is fired through `ctx.waitUntil`. Only a genuinely empty cache – first boot, or straight
after a restore – pays the cold cost. Without this, one unlucky visitor every six hours waits
~30 seconds, which is a worse product than the one we have now.

**`ensureRankExclusions` moves onto the rebuild path.** It runs `WHERE rank_exclude_checked_at IS
NULL` on every request over an unindexed column, which is a full table scan that real D1 bills even
when it returns zero rows. It only has work to do when the catalogue has changed, which is exactly
when the snapshot rebuilds. Moving it there removes a whole second full-catalogue cost that
gate 1's measurement will surface.

**The measuring instrument: `src/d1meter.js`.** A counting wrapper around `env.FPM_DB` installed at
the top of `handleRank`, summing `meta.rows_read` and `meta.rows_written` across every D1 call in
the request without any module needing to know it exists. Its output is a new **always-present**
`d1` block on `/api/rank`'s JSON:

```
"d1": { "queries": 4, "rowsRead": 41, "rowsWritten": 0,
        "cacheState": "memory", "snapshotAgeMs": 118432 }
```

Always present, per the project's own convention, so the exhaustive key set cannot change shape
between calls. **This is the instrument the gate is scored on, it is testable, and it stays in the
product** – "measured once in a scratch script" is how a regression gets shipped six weeks later.

**The target, and the arithmetic that makes it a hosting number rather than a perf number:**

| | today | target |
|---|--:|--:|
| D1 rows read, warm page load | 18,311 | **≤ 50** |
| Full scans of `fpm_catalog` per warm load | ≥ 1 | **0** |
| Catalogue read in full | every request | **≤ 4 x / day** (6 h TTL) |
| Free-tier D1 ceiling on page loads/day | **273** | 4 rebuilds x 18,311 = 73,244 rows, leaving 4,926,756 ÷ 50 = **~98,500** |

**And then the honest sentence, which is the point of the whole half:** at ~98,500 page loads a day
D1 is no longer the constraint. The Workers free tier's 100,000 requests/day becomes the binding
limit, at roughly **20,000 page loads a day** once page, API calls and assets are counted. That is
a **73x improvement**, and it moves the ceiling from "one person, most days" to "a small group,
comfortably".

### 4.2 Half B – the price probe, then the fill

**Stage 0 – free, no network, runs before anything is built.** One D1 query splits the 12,413 into
two very different populations:

- `price_checked_at IS NOT NULL AND price IS NULL AND itad_id IS NULL` → **ITAD could not even
  resolve an id.** ITAD does not know this game exists.
- `… AND itad_id IS NOT NULL` → **ITAD knows the game and returned no Steam price.** This is the
  population the parameter hypothesis is about.

Cross-tabulated by `source_deal`, by review-count band, and by whether the row is in the ranked
pool. **This costs one query and may settle the increment on its own.** It goes in the pre-build
checkpoint.

**Stage 1 – the sample. 200 rows, and the number is not arbitrary:** it is exactly one ITAD batch
(200), two GetItems batches (100 each), and one `appdetails` burst inside the ~200 req / 5 min
budget. Composition, fixed in advance:

| n | Stratum |
|--:|---|
| 50 | Priceless rows inside the ranked top 1,000 – the ones James actually sees |
| 50 | Priceless, `itad_id IS NOT NULL` |
| 50 | Priceless, `itad_id IS NULL` |
| 30 | Priceless, never checked (the 4,080) |
| 20 | **Named controls** – games known to be purchasable today, including *A Castle Full of Cats* (Rev 2's inc-10 spot-check title), plus one known free-to-play and one known delisted title |

**Stage 2 – all three sources, same 200 appids, four questions:**

1. **ITAD:** does `/games/prices/v2` serve non-deal prices when asked correctly? Read the live ITAD
   v2 docs first (**append "use context7"**), try the non-deal parameter, and if that fails try
   `/games/overview/v2` and `/games/info/v2`.
2. **GetItems:** request the purchase-option data alongside the platform data we already ask for.
   Does `store_items[]` carry a final price, an original price and a discount for these appids in
   AUD? Does it carry `is_free` and a country-restriction flag?
3. **`appdetails`:** does `?appids=<comma list>&filters=price_overview&cc=au` return **all** the
   ids, or truncate? Test at 5, 20, 50 and 100. **This one answer is worth ~7 hours.**
4. **All three:** for each of the 200, does the source return a price, or a *nameable reason* for
   having none – free, delisted, not sold in AU?

**The decision rule, pre-registered so the probe cannot be read to fit a preference:**

1. If a source returns a price **or a nameable reason** for ≥ 90% of the 200, it wins.
2. **On a tie, the source that can name the reason wins over the source that returns more prices.**
   The gate is "a price *or an explicit checked-no-price state*". A blank is not a state.
3. On a further tie, the source with the largest batch size wins, because that is the fill's wall
   clock.
4. ITAD keeps the deal, `cut` and historical-low lanes regardless. Nothing about the existing sale
   refresh changes.
5. **If no source clears 90%, the finding is that most of the 12,413 are genuinely unpurchasable,
   and this half of the increment becomes a classification-and-copy change, not a fill.** That
   outcome is allowed to win, and if it does, we say so and stop rather than fill anyway.

**The projected fill wall clock goes in the probe verdict, measured not guessed** – per-request
latency from the probe × chunk count. The three plausible answers:

| Winner | Batch | Requests | Projected |
|---|--:|--:|---|
| ITAD, batched | 200 | ~165 | **~2–15 min** |
| GetItems, batched | 100 | ~165 | **~5–20 min** |
| `appdetails`, batched | 50–100 | ~200–330 | **~10–30 min** |
| `appdetails`, per-appid | 1 | 16,493 | **~6.9 h** |

**Resumability is the same discipline regardless of which wins**, and it is mostly already built:
the fill's cursor is the new `price_state IS NULL` predicate, write-through per chunk, retry the
same chunk on a bad response, give up after `FPM_PRICE_MAX_CONSECUTIVE_BAD`, honour `retry-after`.
Gate 7 requires a deliberate kill-and-resume to prove the cursor, exactly as increments 9 and 10
did.

**Why `price_state` is the cursor and not `price_checked_at`:** the 12,413 have already been
stamped `price_checked_at` under the old method. Re-using that column would mean either fighting
the TTL logic or wiping a column the routine sale refresh depends on. A new column is a clean
cursor that guarantees **every row is evaluated exactly once under the new method**, and leaves the
existing refresh cycle byte-identical.

### 4.3 The declared split point

**If the probe verdict projects a fill longer than about 90 minutes, half B stops at the probe and
becomes increment 13.5.** Increment 13 then ships half A, the schema, the copy and the deploy
blocker note, and James starts a multi-hour fill as its own decision with the number in front of
him – which is the discipline increments 9 and 10 both used. Declared now, in advance, so it is a
plan rather than a rescue.

---

## 5. Schema

Three additive changes. No table is rewritten, no column is dropped, nothing is backfilled
destructively.

```sql
-- 1. Two nullable columns on fpm_catalog, appended to ALTER_TABLE_STATEMENTS
ALTER TABLE fpm_catalog ADD COLUMN price_state TEXT;    -- the cursor AND the display state
ALTER TABLE fpm_catalog ADD COLUMN price_source TEXT;   -- 'itad' | 'getitems' | 'appdetails'

-- 2. One tiny table – the snapshot's version stamp, and a general catalogue k/v
CREATE TABLE IF NOT EXISTS catalog_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

-- 3. One index, so the exclusion fill's predicate stops being a full table scan
CREATE INDEX IF NOT EXISTS idx_catalog_rank_exclude_unchecked
  ON fpm_catalog (rank_exclude_checked_at);
```

**`price_state` is a closed vocabulary, and the values are exactly the states the page can render:**

| Value | Meaning |
|---|---|
| `priced` | A real price is in `price` / `regular` / `cut` |
| `free` | Free to play. The source said so; we are not inferring it from a zero |
| `delisted` | Not sold on Steam any more |
| `region` | Sold on Steam, not available in AU |
| `unknown` | Checked, and the source could not say. **The count of these is the increment's honesty line** |

`NULL` means *never checked under the new method*, which is what makes it the fill's cursor. It is
a different state from `unknown`, and conflating the two is the null-versus-zero mistake this
project has now caught twice (increment 12's `hoursPlayed`, increment 12.5's "never played").

**No new price columns.** `price`, `price_cents`, `regular` and `cut` already exist and a storefront
response maps onto them one for one. Refused on the grounds that a `list_price` column duplicating
`regular` would create two places to look and one of them would go stale.

**`catalog_meta` joins `TABLES` in `tools/backup-catalog.mjs`**, and `tools/restore-catalog.mjs`
writes a **fresh** version value after restoring – so a restore can never leave a KV snapshot
describing a database that no longer exists. Both covered by the existing
`test/backup-restore.test.mjs`, which already caught exactly this class of defect at SEC-3.

> **CORRECTION, 2026-09-06, at review (round 2, CR-18).** The sentence above is left exactly as it
> was written; it is no longer what the code does, and **ruling 17 is why**. `catalog_meta` is NOT
> in the backup at all – it is dropped outright, because a restored stale stamp can resurrect a
> version match, which is the hazard blocker CR-2 exists to close. And `game_marks`, which this
> section never named, moved the other way: it is dumped to an UNTRACKED
> `backups/private-marks.sql` and kept out of the committed file. `tools/restore-catalog.mjs`
> still writes a fresh stamp after restoring, which is the half of the sentence that survived.

**One new KV binding in `wrangler.toml`: `CATALOG_CACHE`.** A separate namespace from `TAG_CACHE`
rather than a key prefix inside it, because the two have completely different lifetimes and value
sizes, and because at deploy time they should be separately creatable and separately clearable.
Four lines of config.

**If the serialised snapshot measures over 8 MB**, it is written as N chunks of 4,000 rows plus a
manifest key rather than one value. The rule is stated up front so it is a decision, not a surprise
at the 25 MB ceiling. Measured at gate 3.

---

## 6. What the page shows

**One function changes: `statusLine()` in `public/rankFilters.js`.** It is the tested seam, its
current form is three lines, and its own header comment already flags the problem:

```js
if (price == null) return "Price not known";   // renders on ~16,600 of 18,306 rows
```

**Proposed strings, and James rules on these at the pre-build checkpoint, not after they are
built:**

| `price_state` | Renders |
|---|---|
| `priced`, `cut > 0` | `$14.98 – 50% off` *(unchanged)* |
| `priced`, no cut | `$29.95` *(unchanged)* |
| `free` | `Free to play` |
| `delisted` | `Not sold on Steam any more` |
| `region` | `Not sold in Australia` |
| `unknown` | `Price not known` *(unchanged wording, on a much smaller number of rows)* |
| `NULL` | `Price not known` |

**Three things worth saying about this table.** First, `"Price not known"` **survives** – it is the
right sentence for a row we genuinely cannot answer for, and the fix is to stop saying it 16,383
times, not to find a nicer phrase for the same ignorance. Second, price is still suppressed
entirely for owned games and that does not change. Third, if the probe's answer turns out to be
that most of the 12,413 are free-to-play or delisted, **then this table is most of the increment's
visible value** and the fill is the smaller half – which is exactly why the strings are ruled on
before the fill is run rather than after.

**The funnel gains a price block**, in `/api/rank`'s existing `funnel` object, under the same
discipline every other funnel line already follows – **the states must partition `ranked` exactly
and sum back to it**:

```
"price": { "priced": n, "free": n, "delisted": n, "region": n, "unknown": n, "unchecked": n }
```

This replaces the PRD's "refreshed Coverage sheet" wording. **Stated as a deliberate deviation:**
the increment 9/10 coverage workbooks were one-off xlsx artifacts and no tool for them exists in
the repo. A funnel block is live, re-measurable forever, testable in the suite, and already the
project's own convention for exactly this job. Gate 8's artifact is a markdown table rendered from
it.

---

## 7. Out of scope – hard, and where I refused

1. **Auth, Steam OpenID, sessions, per-user keys, `user_id` columns, and any deploy.** §2.
   `npm run deploy` stays a hard-fail stub. This is the biggest refusal in the spec and the one
   most likely to be overturned.
2. **`?limit=` on `/api/rank`.** Pre-authorised at increment 12, and I am declining it. Four
   reasons, and the third is the one that decides it. (a) It does not serve this gate – the gate is
   D1 row reads, and half A takes those to ~50 whether the response is 10 MB or 10 KB.
   (b) Cloudflare does not bill Workers egress, so the 10.1 MB costs nothing on the free tier.
   (c) **`public/rankFilters.js` filters the browse list client-side over the full array.** A limit
   either breaks browse or forces every filter server-side, which is a UX increment wearing a
   hosting increment's clothes. (d) Warm paint already beats target by 3x. **The counter-argument I
   owe James:** a 128 MB isolate holding a 10 MB snapshot, an 18k-row array and a 10 MB response
   string under concurrency is a real hosting risk. So gate 3 **measures** the snapshot's bytes and
   the response build, and if that measurement says it is a problem, `?limit=` gets scoped properly
   with the filters, rather than bolted on here. §8 question 2.
3. **Deleting the retiring routes** (`/api/fpm`, `/api/recs`, `/api/deals`, `/api/best-of`) **and
   `public/filters.js` / `public/weight.js`.** Increment 12 §6 parked these here, and I am pushing
   them one increment further, to the deploy epic's cleanup. **The honest cost of that refusal:**
   `/api/fpm` runs its own uncached full-catalogue read (`selectMatchedCatalogRows`), so the
   sentence "the app costs a bounded number of row reads" is false while it lives, even though "a
   page load costs a bounded number" is true. **Mitigation in scope, and it is cheap:**
   `DEPLOY-BLOCKERS.md` names them and their cost, so it is a recorded liability rather than a
   forgotten one. §8 question 3 – this is the refusal James is most likely to overturn, and the
   overturn is bounded and mechanical.
4. **Any ranking change.** Weights, presets, normalisers, the blend, pool membership,
   `src/profile.js`, `src/rank.js`'s scoring. Frozen since increment 11. Gate 5 proves it rather
   than asserting it.
5. **Caching the IDF map, similarity, or the `/api/rank` response.** §4.1. This is item 4 seen from
   the cache's side, and it is the specific door through which a cache would move the ranking.
6. **Any re-fill of the 18,219 LLM-scored rows.** Nothing here triggers one. `price_state`,
   `price_source` and `catalog_meta` are additive columns and a new table; no LLM column is read,
   written or invalidated. **If anything in the build looks like it would trigger one, it stops and
   reports before running.** That data is 6.5 hours of Opus time plus ~5 hours of tag crawling and
   it is not re-earnable this week.
7. **Marks, dismissals or settings entering the snapshot.** Rev 2's two-layer rule. They are loaded
   per request and stay that way.
8. **A `list_price` column.** §5 – `regular` already is it.
9. **A new price vendor (GG.deals).** §3.2 – three sources we already hold get probed first.
10. **SteamSpy prices.** §3.2 – USD on an AUD-native page.
11. **A migrations directory.** `ensureCatalogSchema`'s ALTER list is the project's convention and
    this increment is not the place to change persistence ceremony.
12. **`GetPlayerAchievements`.** SPEC.md §8 question 5 deferred it and nothing here reopens it.
13. **The three open items from increment 12** – a failed lens click wiping the picks, the undo
    toast under the tenth card, the ASCII before/after cards from 12.5. Known, captured, not this.
14. **The `fpm_catalog` → `game_catalog` rename.** Rev 2 named it; it is a pure rename touching
    every module and every test, with zero user-visible effect, and it belongs in the same cleanup
    pass as item 3.
15. **The name change.** Still parked.
16. **Mobile layout.** Readable at laptop width, as before.

**Where I refused, gathered in one place because James asks for it:** items 1, 2, 3, 5, 9 and 14.
Items 1 and 3 are the two where the refusal has a real, named cost, and §8 is where he overturns
either. **Item 5 is the one I would not accept an overturn on without re-opening increment 11** –
it is the door through which a caching increment silently becomes a ranking increment.

---

## 8. Open questions – each with a recommendation

1. **Auth: in or out?** **Recommend OUT**, and rename the increment to "hosting affordability" so
   the phrase stops claiming safety it does not deliver. §2 is the full argument; the short version
   is that auth without a deploy protects nothing, cannot be proven at `localhost:8787`, and
   re-opens 12.5's deliberate schema ruling one increment after it was made. **What ships instead:**
   `DEPLOY-BLOCKERS.md` and a `npm run deploy` message that names auth as the blocker.
   **Overturn cost:** increment 13 becomes two increments, half B slips, and the auth half still
   cannot be gated properly until there is a hosted origin.
2. **Does `?limit=` land here?** **Recommend no**, §7 item 2 – it does not serve this gate, egress
   is free, and the browse list filters client-side so a limit breaks it. **But the memory question
   is real**, so gate 3 measures the snapshot bytes and the response build and James rules with the
   number in front of him. **Overturn cost:** the browse filters move server-side, which is a UX
   increment, so an overturn should scope that rather than adding a parameter that breaks the page.
3. **Do the four retiring routes get deleted here?** **Recommend no, defer to the deploy epic's
   cleanup** – but this is the closest call in the spec and I want to name why. For: `/api/fpm` is
   a second uncached full-catalogue read and an unauthenticated one, which is a genuine hosting
   liability, and increment 12 explicitly parked the deletion *here*. Against: it is four handlers,
   four exhaustive key-set test files and two orphaned front-end modules, in an increment that
   already has a probe and a fill in it, and it is mechanical work with zero user-visible effect.
   **If James wants it in, it is gate 12 and it is deletion only – no rewrites, no refactor** – and
   half B's split point (§4.3) becomes much more likely to fire.
4. **6-hour TTL, or 24?** **Recommend 6.** With the version stamp doing the real invalidation, the
   TTL is only the safety net for a writer that bypasses the bump, and 6 h costs 73,244 rows/day
   against a 5M ceiling – 1.5%. 24 h saves 55,000 rows/day we do not need and risks a stale price
   surviving most of a day after a hand-run write. Cheap either way; 6 is the safer default.
5. **Does the fill re-check the 1,728 rows that already have a price?** **Recommend yes.** They are
   the control group: if the new source disagrees with ITAD on a row where ITAD *did* answer, that
   is a finding James needs before trusting 16,493 new numbers. It costs ~9 extra batched requests.
6. **Does `price_source` get shown on the page?** **Recommend no.** It is a debugging column and
   "where we got this number" is not a fact about the game. It lives in the funnel and in the
   probe verdict where it belongs. One nullable column, zero UI.
7. **Is a stranger drive re-run needed?** **Recommend no.** Increment 12's gate was that the page
   answers without touching a control, and this increment changes one sentence on each card from
   "Price not known" to a price. That can only make the answer better. Gate 8's top-50 capture plus
   James's own eye is the honest cost; booking a stranger to look at a price string is
   gold-plating.

---

## 9. Constraints

1. **Local-only** (`wrangler dev`, port 8787). No deploy, nothing bound beyond loopback, no CORS
   headers. **`npm run deploy` remains a hard-fail stub** – its message changes, its exit code does
   not.
2. **Auth remains a precondition for any deploy**, restated in `DEPLOY-BLOCKERS.md` rather than
   built. §2.
3. **No ranking changes.** §7 items 4 and 5. Gate 5 proves it.
4. **No re-fill of the 18,219 LLM-scored rows.** §7 item 6. If the build would trigger one, it
   stops and reports before running.
5. **`npm run backup` runs before any schema change** – gate 0, non-negotiable. The database holds
   6.5 hours of LLM scoring, ~5 hours of tag crawling and the only unrecoverable table in the
   project (`game_marks`).
6. **Suite stays at ≥ 860 passing, 0 skipped**, with §9.5's amended properties as of 2026-09-05:
   **no network access and no spawning of the app's own services; `sqlite3` is permitted where a
   tool under test genuinely shells out to it.** Tests fail loudly rather than skipping.
7. **The probe and the fill are the only things in this increment that touch the network**, and
   neither runs from the test suite. Both are run by hand, and both write their output into the
   review folder as they go.
8. **Append "use context7"** on the ITAD v2 and Cloudflare KV tasks – both are third-party APIs
   whose current parameter sets are load-bearing, and the ITAD one is the entire hypothesis.
9. **Fail-soft everywhere.** A missing `CATALOG_CACHE` binding, a KV error, a corrupt snapshot or a
   `catalog_meta` read failure falls back to the direct D1 read and reports `cacheState:
   "rebuild"`. **The cache must never be able to take the page down**, and it must never serve a
   row the database no longer has.
10. **En dashes, never em dashes**, in every artifact.
11. **Stop before commit.** An explicit in-session "commit"/"push" from James is sufficient
    authorisation; never initiate one.

---

## 10. Gates

| # | Gate | Pass condition |
|--:|---|---|
| 0 | **Backup first** | `npm run backup` run against the live database **before any schema change**, row counts recorded. One command, and the database it protects is worth ~11 hours of fills. |
| 1 | **The instrument is trusted before it is used** | `01-cost-and-copy-checkpoint.md`: (a) does local `meta.rows_read` count rows **scanned** or rows **returned**? Proven by a query that full-scans an unindexed column and returns zero rows. If it reports ~0, local accounting understates real D1 and **full scans are reported as a separate number**. (b) The ~30 s cold load attributed across its phases – exclusion fill, catalogue read, KV spy reads, profile build, JSON serialise – summing to the measured total ±10%. (c) The **16,383 vs 13,924 reconciliation**: the priceless count is stated against the ranked pool that actually renders. Pass = we know what 18,311 and 30 s are made of, before anything is optimised. |
| 2 | **The seam is where the spec says it is** | `git diff` on `handleRank` shows exactly one changed line – `selectRankCatalogRows(env)` → `loadRankCatalogue(env, ctx)` – plus the meter installation. Funnel order, IDF, profile, similarity, blend and sort textually unchanged. |
| 3 | **Bounded, measured, and it is the row reads that are bounded** | `03-page-cost-before-after.md`: the `d1` block captured for cold rebuild, KV hit, memory hit, all three lenses and a reload. Pass = **warm ≤ 50 rows read, 0 full scans of `fpm_catalog`**, the daily arithmetic of §4.1 written out, **and the snapshot's serialised byte size** (which decides §5's chunking rule and §8 question 2). |
| 4 | **Invalidation works in both directions** | A price write bumps the version and the next request rebuilds; `npm run restore` bumps it; `?refresh=1` forces it; the 6 h TTL bounds it; a missing `CATALOG_CACHE` binding degrades to a direct read rather than a 500. Captured as a sequence with `cacheState` at each step. Plus the negative: **a stale snapshot never serves a row the database no longer holds.** |
| 5 | **The ranking is frozen, and the cache cannot move it** | `05-top-50-unmoved.md`: all three lenses' top 50 – appid sequence **and** `rankScore` – identical from the uncached path and the cached path, same `wrangler dev` session, `ITAD_API_KEY` unset so the historical-low premium cannot make the run non-deterministic. Plus empty `git diff d4a458b -- src/profile.js` and no change to `src/rank.js`'s scoring. Same shape as increment 12.5's gate 5, including its multi-lens CI net. |
| 6 | **The probe answers, on the rule that was written first** | `02-probe-verdict.md`: stage 0's free D1 triage of the 12,413; the 200-row sample across all three sources; the `appdetails` and GetItems batch-size findings; the named controls including *A Castle Full of Cats*; and the source picked **by §4.2's pre-registered rule, quoted, not by preference**. Plus the projected fill wall clock, measured. **THE BUILD HALTS HERE FOR JAMES.** |
| 7 | **The fill runs, resumably, and reports what it did** | `06-fill-log.md`: the run's `{attempted, priced, free, delisted, region, unknown, gaveUp}`, **at least one deliberate kill-and-resume proving the `price_state IS NULL` cursor loses nothing**, and the actual wall clock against the projection. Same discipline as increments 9 and 10. |
| 8 | **Every ranked row has a state, and the states sum** | `04-price-coverage.md`: the funnel's price block **partitions `ranked` exactly** and sums back to it. **Zero rows in any lens's top 50 show the `Price not known` fallback.** Named spot-checks with the string each produces: *A Castle Full of Cats* shows a list price, one free-to-play title, one delisted title. Before/after counts for all six states. |
| 9 | **A list price won cannot be erased by the next sale refresh** | The defect §3.2 names: `recordPriceResult` writes `regular = NULL` on a no-deal check. Proven closed by running the existing ITAD refresh over a row carrying a fill-won list price and no live deal, and showing `regular` survives. **Covered by a test in the suite**, because this is the failure that would silently undo the whole fill weeks later. |
| 10 | **The deploy stub names its blocker** | `07-deploy-blockers.md` in the review folder and `DEPLOY-BLOCKERS.md` in the repo: every route, whether it authenticates (none do), and what personal data each returns – including the play history 12.5 added. `npm run deploy` still exits non-zero, with a message naming auth rather than "Phase 3". |
| 11 | **Suite and diff** | `08-diff-and-suite.md`: full suite green, **≥ 860 passing, 0 skipped**, offline-clean, no app-service spawns. **Exactly one route key set changes** – `/api/rank`, gaining `d1` and the funnel's `price` block – and the other nine are shown untouched by an empty diff. New coverage named: `loadRankCatalogue`'s three tiers, the version-stamp bump, the fail-soft path, `src/d1meter.js`'s counting, `statusLine` over all six `price_state` values, and gate 9's `regular`-survives test. |

---

## Rulings – James, 2026-09-06, at scoping

**1. Auth stays out, and the increment is renamed.** Accepted as argued in §2: auth without a
deploy protects nothing, cannot be proven at `localhost:8787`, and would reverse increment
12.5's per-user schema ruling one increment after it was made. `DEPLOY-BLOCKERS.md` ships
instead. The rename matters on its own - "hosting readiness" claims a safety this increment
does not deliver, and the phrase would have been quoted later as though it did.

**2. Build the full scope**, not the price half alone.

**3. The price triage was run at scoping and it settles the increment's shape.** Live query:

| | rows |
|---|--:|
| `price_checked_at` set, `price` null, **`itad_id` NULL** (ITAD never knew the game) | **1** |
| `price_checked_at` set, `price` null, **`itad_id` NOT NULL** (ITAD knew it, we stored nothing) | **12,412** |

**It is our bug, not ITAD's silence.** We resolved an ITAD id for 12,412 games and then read
only `entry.deals[]`, storing nothing when there was no active discount - so the 1,728 "priced"
rows are essentially just the games currently on sale. The PRD framed this as coverage for rows
"that have none", implying a 16,000-row crawl. It is a field we already fetch. **The fill is
minutes, not increment 10's 6.5 hours**, and the increment is therefore mostly the caching work
plus repairing what is quietly broken.

**4. Both increment 8.5 defects are confirmed live and must be fixed here.**
- `selectPriceBatch` gates on `WHERE main_hours IS NOT NULL`, a dead column from the retired
  `/api/fpm` lane. **That is why ranked rows were never eligible for a price check at all.**
- `recordPriceResult` writes `regular = NULL` on a no-deal check, so **a list price won by this
  increment would be erased by the next routine sale refresh.** Fixing the fetch without fixing
  this would look like it worked and then silently undo itself.

**5. `IStoreBrowseService/GetItems` is confirmed as already wired.** `src/deckCompat.js`
live-verified it in July: anonymous, no key, batched at 100 appids, already sending
`country_code: "AU"`. It only ever asked for `include_platforms`. Its `store_items[]` also carry
`is_free` and country-restriction flags, so it can name **why** a row has no price, which ITAD's
silence cannot. The probe still runs - the pattern of probing before filling has changed the
plan in increments 9, 10 and now 13 - but it starts from a source we already trust.

**6. Gate 1's instrument gets validated before it scores anything.** The spec's own doubt is
right to carry: 18,311 is suspiciously close to the catalogue total plus five, while
`handleRank` makes two full-catalogue passes. If local `meta.rows_read` counts rows *returned*
rather than *scanned*, the gate would be scored on a flattering number.

---

## Rulings – James, 2026-09-06, at checkpoint 01

**7. The three new price strings ship as proposed:** `Free to play`, `Not sold on Steam any
more`, `Not sold in Australia`. The two existing priced strings and `Price not known` keep their
wording; `Price not known` simply lands on far fewer rows. Shorter variants were offered and
rejected - "Delisted" is jargon, and this page's gate is that a stranger understands it.

**8. `ensureCatalogSchema`'s repeated column checks get fixed here.** Not in the spec; found
while measuring. It runs on **every request**, attempting 23 `ALTER TABLE ADD COLUMN` statements
for columns that have existed for weeks, catching 23 errors and discarding them. That is
**~140 ms, roughly 15% of a warm page load.** The pattern was correct when increment 7.8
introduced it - it is how a column is added safely to a live table - but nothing ever made it
stop running once the columns existed. **It belongs in this increment because this increment is
about what a page load costs.** Do not change how columns are added; change how often the check
runs.

> **CORRECTION, 2026-09-06, at review (CR-6).** James's ruling above is left exactly as he made it;
> this line is appended because the number he was given was mine and it was wrong. **The ~140 ms /
> ~15% figure came from the Node measuring harness, not the product.** Measured inside `workerd`
> against the same live database it is **~23 ms, about 2.6%** of a warm page load. **The change
> still stands, on a different ground:** it removes **23 guaranteed-to-throw statements per
> request** and takes `/api/rank` from **32 statements to 10** - and a statement count matters far
> more against remote D1, where every statement is a network round trip, than it does locally, where
> miniflare runs SQLite in-process. Keep it for the statement count, not for the latency.
> Separately: the D1 meter used to count only statements that SUCCEEDED, so those 23 throwing
> statements were invisible to it while this was being measured. Statement counts were re-taken;
> `rowsRead` and the 36,620 → 9 headline are unaffected, because a failed `ALTER` reads zero rows.
> Full disclosure in `03-page-cost-before-after.md`.

**9. Two numbers I gave the Coder were wrong, and the checkpoint corrected both.**
- **A page load costs 36,620 D1 row reads, not 18,311.** Ruling 6's suspicion was right.
  `ensureRankExclusions` scans all 18,306 rows and **returns none**, so it is invisible to any
  measurement that counts rows returned. Today's free-tier ceiling is **136 page loads a day, not
  273.** The instrument itself was validated first: local `meta.rows_read` counts rows *scanned*,
  proved with a full scan of an unindexed column returning zero rows and still reporting 18,306.
- **11,922 ranked rows read "Price not known", not 16,383.** The larger figure counted rows the
  page never draws.

**10. The spec's implication about the slow first load is wrong, and the gate must not claim it.**
The ~30 s cold load is **not** the catalogue read - it is the Steam library refresh. A fresh
worker serves `/api/rank` in **0.98 s** with the 24 h library cache warm and 24.5-46.3 s with it
cold, reproduced three times. **Half A fixes the cost problem and does not fix the slow-first-load
problem.** Say so plainly in the artifacts rather than letting the improvement imply it.

---

## Rulings – James, 2026-09-06, at checkpoint 02 (the probe)

**11. Gate 8 is AMENDED: an honest checked `unknown` is allowed in a top 50.** The gate required
zero rows reading "Price not known" and **cannot pass, because it was written assuming every game
has a findable price.** *Half-Life 2: Episode Two* is pick #3 on the default lens and genuinely has
no standalone price - Valve folded the episodes into *Half-Life 2*. Steam, ITAD and `appdetails`
all agree: the page exists, `is_free: false`, nothing to buy.

Rejected: showing *Half-Life 2*'s price on it (a different product with a different page - the app
asserting something untrue, which is the exact failure the last two increments spent their reviews
removing), and dropping unpriceable games out of the picks (costs a great game at #3 for a reason
unrelated to whether James would enjoy it). **The new pass condition: every top-50 row shows a
price, a named reason, or an `unknown` that has genuinely been checked - and the artifact names
every `unknown` so the count is read rather than assumed.**

**12. The fill is approved. Build it and run it.** 184 requests, **~7 minutes measured**, not
projected - 711 ms per request plus 500 ms pacing, plus 18,306 writes at a measured 11.08 ms.
Against §4.3's 90-minute split point this is not close: **there is no increment 13.5.** Do not
batch the writes; it saves 160 s and weakens gate 7's kill-and-resume proof.

**13. The bundle guard is a build blocker, not a nicety.** `best_purchase_option` is not always
the game. *Castle Crashers* resolves to a two-game bundle at A$6.40, *GTA: Vice City Definitive*
to the trilogy at A$89.95; ~190 rows catalogue-wide have no single-game option at all. **The fill
must require `packageid` with `included_game_count === 1`.** A naive read would have put confidently
wrong prices on the page and looked correct - write this guard before the fill runs, not after.

**14. The probe found the root cause and it is one parameter.** `nondeals=true` takes ITAD from
19 of 200 rows priced to 156. Without it `/games/prices/v2` returns only games with a live
discount, which is ruling 3's diagnosis proven at the wire: **ITAD was never silent, we never
asked.** Steam `GetItems` still won at 91.5% against a 90% bar, because ITAD even fixed cannot say
*why* a row has no price - on a delisted game and one refused classification in Australia it
returns nothing, indistinguishable from an error. On the 154 rows both sources priced, **not one
differed by more than a cent.**

**15. `extractAppId` in `src/deckCompat.js` must not be reused as-is.** A delisted row returns
`appid: 0` and the requested id survives only in `id`; that function reads `appid` first. Harmless
where it lives, **not harmless in a fill that would then skip exactly the rows it exists to
classify.**

**16. `nondeals=true` STAYS, and it overrides rule 4.** (James, 2026-09-06, at review.) §4.2's
pre-registered rule 4 said *"Nothing about the existing sale refresh changes"*, and adding
`nondeals=true` to `fetchItadPricesBatch` changed it. Ruling 14 recorded the finding but authorised
no product change, so the parameter shipped outside approved scope. **It is now ruled IN, and this
ruling overrides rule 4.** Its value is real - it takes ITAD from 19 of 200 rows priced to 156, and
it is what stops the six-hourly refresh overwriting a good list price with nothing.

**It is ruled in WITH TWO GUARDS, and it is not approved without them** (they are blocker CR-1):

1. **`fetchItadPricesBatch` drops any entry whose `price.amount` is `0`.** ITAD reports
   free-to-play games at $0.00, and `nondeals=true` is precisely what makes those entries start
   arriving - the probe measured it (174 against 156 once the zero-price rows were counted
   generously). A zero from ITAD is not a price. **Free is established by Steam's own `is_free` and
   by nothing else** (ruling 7's string, §5's vocabulary).
2. **The sale lane may refresh a price; it may not reclassify a row.** `RECORD_PRICE_DEAL_SQL` now
   carries `AND (price_state IS NULL OR price_state = 'priced')`, so a `free`, `delisted`, `region`
   or `unknown` row cannot be walked back to `priced` by a refresh. Without it, 1,891 free rows -
   1,369 of which already carry an `itad_id` - would have started rendering **`$0.00`** within a
   day or two of the fill. That is gate 9's failure mode on a different column, and it is the third
   time this project has hit "a later refresh silently undoes the fix".

**17. THE BACKUP IS SPLIT: public tables are committed, play history is not, and the version
stamp is not backed up at all.** (James, 2026-09-06, at review.) This overrides §5's sentence
"`catalog_meta` joins `TABLES` in `tools/backup-catalog.mjs`", which is left in place with a
dated correction beneath it rather than edited away.

**The reason is that this repository is PUBLIC and `backups/catalog.sql.gz` is committed on
every run of `npm run backup`.** Everything in that file is published. Three tables get sorted
by that fact:

| Table | Backed up | Committed | Why |
|---|---|---|---|
| `fpm_catalog`, `settings`, `dismissals` | `backups/catalog.sql.gz` | **yes** | 18,219 rows of LLM judgement and 18,306 rows of tags – hours of wall clock and real spend, and none of it private. Committing is what makes it a real off-machine backup. |
| **`game_marks`** | `backups/private-marks.sql` | **NO** | It is James's **play history** – which games he has played and finished – and it is also the only genuinely **unrecoverable** table the project owns. Those two facts pull opposite ways, so the backup keeps it and the commit does not. The table was empty when this was found, so nothing has leaked; it would have started publishing the moment he marked a game. |
| `catalog_meta` | **not at all** | no | The stamp is regenerable in one write, and restoring an old one can present a version a KV snapshot still matches – the exact hazard blocker CR-2 closes. |

**And the split is enforced at runtime, not by table naming** (round-2 review, SEC-10 / SEC-11):
`backups/.gitignore` is deny-by-default, and `tools/backup-catalog.mjs` refuses to write the
committed file at all if the dump it built contains a `CREATE TABLE` for anything outside its own
list – because `sqlite3`'s `.dump` argument is a LIKE pattern and `_` is a wildcard.

---

## ⛩ REVIEW

**Gate TLDR:** the free-tier ceiling on this app moves from **273 page loads a day to about
20,000** – because a warm page load reads ≤ 50 D1 rows instead of 18,311, and the catalogue is read
in full at most four times a day no matter how many people use it – while every ranked row stops
saying "Price not known" and says a price, "free to play", "not sold on Steam any more" or "not
sold in Australia" instead, with the top-50 order under all three lenses provably unmoved.

**Output (what James holds while reviewing):**

1. `01-cost-and-copy-checkpoint.md` – **pre-build checkpoint, and the build stops here.** What the
   18,311 reads and the ~30 s cold load are actually made of, phase by phase; whether local
   `rows_read` can be trusted; the free D1 triage splitting the 12,413 into "ITAD never knew this
   game" versus "ITAD knew it and said nothing"; and **the six proposed price strings for James to
   rule on before a line of them is built.**
2. `02-probe-verdict.md` – **the second halt.** Which source won, against the decision rule quoted
   as it was written before the probe ran, the batch-size findings for `appdetails` and GetItems,
   and **the projected fill wall clock James approves before the fill starts.**
3. `03-page-cost-before-after.md` – the `d1` block captured cold, KV-warm and memory-warm, across
   three lenses, with the daily free-tier arithmetic and the snapshot's byte size.
4. **The running page at `http://localhost:8787/`** – the landing state, nothing touched, ten picks,
   **and a price on every card that has one and an honest sentence on every card that does not.**
5. `04-price-coverage.md` – the six price states partitioning the ranked pool exactly, before and
   after, with the named spot-checks.
6. `05-top-50-unmoved.md` – the three lenses' top 50, cached versus uncached, identical, and the
   empty `git diff` on `src/profile.js`.
7. `06-fill-log.md` – what the fill did, the kill-and-resume proof, and the wall clock against the
   projection.
8. `07-deploy-blockers.md` – every route, what it exposes, and why `npm run deploy` still refuses
   to run.
9. `08-diff-and-suite.md` – the one changed key set, the nine untouched, and the suite count with
   all four properties named.

Items 1 and 2 are halts. Per review protocol Rule 3 the Coder writes each into the review folder as
part of the work and stops – James is never asked to review from a chat message, a scratchpad or a
code block. Every mid-build ruling in §8 lands in one of those two files before it is asked for.

**Review folder:** `~/code/review/steam-sale-scout/inc-13/`
**Index:** `/AI/projects/personal-projects/steam-sale-scout/reviews/inc-13.md`

**Decisions this gate needs from James:**

- **Auth in or out** (§8 q1). Recommend out, and rename the increment to "hosting affordability" so
  the phrase stops claiming a safety this increment does not deliver.
- **`?limit=`** (§8 q2). Recommend no, ruled with gate 3's memory and byte measurements in hand.
- **The four retiring routes** (§8 q3). Recommend defer; the closest call in the spec, and the
  refusal has a named cost.
- **The six price strings** (§6), at checkpoint 01, before they are built.
- **Whether to start the fill**, at checkpoint 02, with its measured duration in front of him.
