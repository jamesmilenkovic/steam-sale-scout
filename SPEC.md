# Increment 14 – Delete the five retiring routes

**Scoped:** 2026-09-13 · **Status:** APPROVED by James 2026-09-14 (§6 ruled option A)
**Ticket:** #5 (decision), under map #1. **Branch:** `experience`. **Base:** `30af417`.
**Baseline measured 2026-09-13 at `30af417`: `npm test` = 931 tests, 931 pass, 0 fail.**

---

## 1. Goal

Delete five whole routes and everything that exists only to serve them.

| Route | Handler | Handler line |
|---|---|---|
| `GET /api/library` | `handleLibrary` | `src/worker.js:311` |
| `GET /api/deals` | `handleDeals` | `:725` |
| `GET /api/recs` | `handleRecs` | `:955` |
| `GET /api/best-of` | `handleHof` | `:1167` |
| `GET /api/fpm` | `handleFpm` | `:1906` |

Nothing consumes them. `public/index.html` calls seven routes and none of these five.
After the cut they answer `501 not implemented` from the router's `/api/` catch-all at `:3213`.

**Why this increment goes first:** the login increment then authenticates thirteen route/method
pairs instead of eighteen, and this diff contains no auth, so James's gate is easy to read.

---

## 2. The correction this spec makes to the handoff

**The handoff describes the deletion as "five handler functions plus five router lines". It is
larger than that, and it has to be.** Sixteen private helpers in `src/worker.js` exist only to feed
the five dying handlers. If they stay, they keep `src/why.js` and `src/hallOfFame.js` imported, and
those two modules cannot be deleted at all. So the helpers go with the handlers.

That is not scope creep. It is the same deletion, traced honestly to its edge.

**The handoff is also wrong in the other direction about one thing.** It implies
`fetchBestOfPages` / `buildBestOfPool` / `loadBestOfPool` are all `/api/best-of`'s.
**`fetchBestOfPages` is shared.** `buildFpmPool` calls it at `:1767`, and `buildFpmPool` feeds
`loadFpmPool`, which **`handleRank` calls at `:2683`** and **`fpmSyncDeps` calls at `:2105`**.
`src/worker.js:1697` already says so in a comment. `fetchBestOfPages` stays.

### 2.1 The full worker.js deletion set, each verified by call-site trace

**Handlers (5):** `handleLibrary`, `handleDeals`, `handleRecs`, `handleHof`, `handleFpm`.

**Private helpers that lose every caller (13):**

| Helper | Line | Only callers |
|---|---|---|
| `upstreamErrorResponse` | `:217` | `:753`, `:989`, `:1203` – all three inside dying handlers |
| `dealsCacheKey` | `:455` | `handleDeals`, `loadDealsForRecs` |
| `fetchDealsPages` | `:527` | `buildDealsFeed` |
| `buildDealsFeed` | `:657` | `handleDeals`, `loadDealsForRecs` |
| `enrichDeals` | `:696` | `handleDeals` |
| `loadLibraryForRecs` | `:811` | `handleRecs`, `handleHof` |
| `loadDealsForRecs` | `:840` | `handleRecs` |
| `buildCandidatePool` | `:880` | `handleRecs`, `handleHof` |
| `bestOfPoolCacheKey` | `:1078` | `loadBestOfPool` |
| `buildBestOfPool` | `:1122` | `loadBestOfPool` |
| `loadBestOfPool` | `:1143` | `handleHof` |
| `fpmUnavailableResponse` | `:1819` | `handleFpm` |
| `parseFpmFormula` | `:1838` | `handleFpm` |
| `parseFpmScoreParam` | `:1844` | `handleFpm` |
| `peekCachedDeckCompat` | `:1861` | `enrichFpmRows` |
| `enrichFpmRows` | `:1872` | `handleFpm` |

**Module-private constants that go with them:** `FPM_VALID_FORMULAS` (`:1826`),
`FPM_QEXP_MIN`/`FPM_QEXP_MAX` (`:1831`–`:1832`), `FPM_BREADTH_MIN`/`FPM_BREADTH_MAX`
(`:1833`–`:1834`), `FPM_ENRICH_CAP` (`:1853`).

**Import names that go dead in `src/worker.js` and are dropped from the import list – the modules
themselves stay:**

- from `./deals.js`: `BESTOF_MIN_CUT`, `DEALS_FETCH_CAP`, `DEALS_PAGE_LIMIT`, `clampMinCut`, `filterByMinCut`
- from `./score.js`: `scoreCandidates` (`cosineSimilarity` stays – `handleRank` calls it at `:2640`)
- from `./hltb.js`: `FPM_FORMULA`, `FPM_QUALITY_EXP`, `FPM_BREADTH_WEIGHT`, `fpmScore`, `funPerHourDisplay`, `qualifiesForFpm`, `sortFpmLane`, `fpmWhyLine` (`FPM_POOL_CAP` stays – `fpmSyncDeps` uses it at `:2108`)
- from `./catalog.js`: `selectMatchedCatalogRows` (its only worker call site is `:1929` inside `handleFpm`)
- from `./dismissals.js`: `excludeDismissed` (all four call sites are in dying handlers; `getDismissedAppIds` stays for `handleRank` at `:2453`)
- from `./why.js` and `./hallOfFame.js`: the whole import line, because the module goes

### 2.2 Three modules deleted outright

- **`src/why.js`** – sole caller `buildWhy` at `:1019`, inside `handleRecs`. `/api/rank`'s `why` is a D1 column (`:2759`); `/api/wishlist` has its own `wishlistWhyLine` (`:1447`). Verified.
- **`src/hallOfFame.js`** – sole callers `buildHallOfFame` (`:1217`) and `qualifiesForHof`, both in `handleHof`. Verified.
- **`public/filters.js`** – no importer outside `test/filters.test.mjs`. Verified.

### 2.3 What stays, and why it looks dead but is not

| File | Kept alive by |
|---|---|
| `public/weight.js` | `src/profile.js:23` imports `weight`/`recencyMultiplier`, and `src/rank.js:35` imports `profile.js`. **Deleting it breaks the ranking.** Misfiled, not dead. |
| `src/deals.js` | `src/catalog.js:63` imports `chunk`; `src/worker.js` still imports eleven names from it |
| `src/score.js` | `src/rank.js:36`, `src/hltb.js:55`, `src/catalog.js:62` |
| `src/profile.js` | `src/rank.js:35`, `src/score.js:6`; every export has a live `handleRank` call site at `:2599`–`:2630` |
| `src/hltb.js` | `src/catalog.js:60` |
| `src/battery.js`, `src/deckCompat.js` | `handleWishlist` at `:1601` and `:1611` |
| `libraryCacheKey` (`:259`), `fetchOwnedGames` (`:268`), `trimGame` (`:222`) | they feed `loadLibraryForRank` (`:2299`), which `handleRank` calls at `:2459` |
| `getOwnedAppIds` (`:369`) | `fpmSyncDeps` at `:2099`, `buildFpmPool` at `:1780` |
| `getDismissedAppIds` (`:415`), `getGameMarks` (`:440`) | `handleRank` at `:2453`, `:2458` |
| `fetchItadJson`, `appIdCacheKey`, `historyLowCacheKey`, `resolveAppIds`, `resolveHistoricalLows` | `handleWishlist` and `buildFpmPool` |
| `fetchBestOfPages`, `fpmPoolCacheKey`, `buildFpmPool`, `loadFpmPool` | `handleRank` at `:2683`, `fpmSyncDeps` at `:2105` |
| `parseOwnedMode` (`:1815`) | `handleRank` at `:2405` |

---

## 3. Tests

### 3.1 Delete outright – 7 files, 3,466 lines, 132 tests

| File | Lines | Tests |
|---|---:|---:|
| `test/worker-recs.test.mjs` | 985 | 29 |
| `test/worker-deals.test.mjs` | 791 | 20 |
| `test/worker-hof.test.mjs` | 753 | 13 |
| `test/worker.test.mjs` (the `/api/library` suite, generic name notwithstanding) | 348 | 10 |
| `test/hallOfFame.test.mjs` | 105 | 12 |
| `test/why.test.mjs` | 140 | 15 |
| `test/filters.test.mjs` | 344 | 33 |
| **total** | **3,466** | **132** |

### 3.2 Edit, do not delete – `test/worker-fpm.test.mjs`

1,477 lines, **39 tests**. It is mixed.

- **26 tests die** – every `GET /api/fpm` test: the four fail-soft tests, the lane-math, app-type, owned/deal-annotation, scoring-override and enrichment sections, plus the final `gate (f)` key-set tripwire at `:1431`.
- **13 tests survive** – the `POST /api/fpm/sync`, `/sync/status` and `/sync/stop` sections from `:1042` to `:1418`. These are ticket #10's subject.

Trim the file's header comment and its now-unused imports to match what is left.

### 3.3 Retire, do not rewrite – `test/worker-rank.test.mjs:966`, "gate 7"

The test is *"gate 7: /api/fpm is byte-identical before and after the rank columns exist AND are
filled"*. It fetches `/api/fpm` twice around a rank-exclusion fill and asserts the bytes match. Its
subject was the legacy lane. **Delete the lane and the gate has no subject.**

Do **not** re-express it against `/api/rank`. That asserts a different property, which is not what
gate 7 meant and may not even be true.

**Keep the middle assertion**, which is a genuine rank property standing on its own:

```js
const filled = await env.FPM_DB
  .prepare("SELECT count(*) AS n FROM fpm_catalog WHERE rank_exclude_checked_at IS NOT NULL")
  .first("n");
assert.equal(filled, 2, "the fill really did write to both rows");
```

The test survives as one test under a new title covering only the fill, with the two `/api/fpm`
fetches, the byte-identical assertion and the ITAD/SteamSpy stubs removed. **Test count unchanged.**
A comment in the file must say the gate was retired with the route, so a future reader does not read
it as lost coverage.

### 3.4 Untouched

`test/deals.test.mjs` (tests `src/deals.js` directly), `test/lane-shape-guard.test.mjs` (synthetic
bodies, never calls `worker.fetch`), `test/weight.test.mjs`, `test/score.test.mjs`,
`test/profile.test.mjs`, `test/hltb.test.mjs`, and every other suite.

### 3.5 Expected test count

```
931 baseline
− 132  seven deleted files
−  26  GET /api/fpm tests in test/worker-fpm.test.mjs
±   0  gate 7 retired in place
= 773
```

**The suite must report exactly 773 tests, 773 pass, 0 fail.** A different number means something
was deleted that should not have been, and the increment stops there.

---

## 4. Documentation

- **`DEPLOY-BLOCKERS.md`** – blocker 2 closes entirely and is rewritten as closed. Blocker 1's table
  drops the five `GET` rows, from eighteen route/method pairs to thirteen; the surrounding prose that
  counts routes is updated to match. **Blocker 3 is not touched** – that is ticket #10's.
- **Stale cross-references.** Deleting the files leaves comments pointing at them:
  `src/hltb.js:47`, `:96`, `:507` and `test/hltb.test.mjs:237`, `:240` name
  `hallOfFame.js`'s `qualifiesForHof`; `src/settings.js:10` and `public/rankFilters.js:4`, `:69`
  name `public/filters.js`. Each gets a short "(deleted at increment 14)" note. No prose rewrites.
- **`SPEC*.md`** – a dated one-line note where a spec points at a now-deleted route.
  **History is not rewritten.** The older specs stay as the record of what was true then.

---

## 5. Out of scope

- The five sync-internal `source_owned` uses. Ruled out by ticket #4.
- `tools/rank-review.mjs:387`'s broken cache key (it omits `&v=2` and silently reads an empty
  library). Real, pre-existing, recorded on ticket #6.
- The three wrong comments in `wrangler.toml` lines 47, 58, 79. A separate one-line commit.
- **Any behaviour change in `src/rank.js`, `src/profile.js` or `src/score.js`. The ranking is frozen.**
- **Shrinking `src/deals.js` and `src/hltb.js`.** Ruled out by James on 2026-09-14. See §6.

---

## 6. Decided: the caller-less exports stay

**James ruled option A on 2026-09-14. They stay. Do not prune them in this increment.**

`clampMinCut`, `filterByMinCut`, `DEALS_FETCH_CAP`, `DEALS_PAGE_LIMIT`, `MIN_CUT_DEFAULT`,
`MIN_CUT_MIN`, `MIN_CUT_MAX` and `BESTOF_MIN_CUT` in `src/deals.js`, and `fpmScore`,
`funPerHourDisplay`, `qualifiesForFpm`, `sortFpmLane`, `fpmWhyLine`, `FPM_FORMULA`,
`FPM_QUALITY_EXP` and `FPM_BREADTH_WEIGHT` in `src/hltb.js`, lose their last `src/` caller in this
increment. They keep working, and their own unit tests keep passing, because those tests import them
directly.

Ticket #5's "the module shrinks; it does not go" reads as an instruction to prune them. **It is
deferred, not carried out.** The reason is that this increment's whole value is a diff with one idea
in it. A second, unrelated subject in the same diff is the thing most likely to cost James a careful
read at the gate, and pruning would also remove the single clean arithmetic check on the test count.

The follow-up whose subject is that pruning is **not** filed by this increment. §8 flags it for
James to file or drop as he sees fit.

**Consequence for the build:** `src/deals.js` and `src/hltb.js` are not edited at all, beyond the
stale-cross-reference comment notes in §4. `test/deals.test.mjs`, `test/hltb.test.mjs` and
`test/score.test.mjs` are untouched. The expected count stays exactly **773**.

---

## 7. Verification, in order

1. `npm test` → **773 tests, 773 pass, 0 fail.** Any other number stops the increment.
2. `npm run dev` starts.
3. `GET /api/rank` returns real data. **Assert a row count, not a 200** – an empty database returns
   200 all day. **Expect `catalogTotal: 18306`.**
4. The five deleted routes each return **`501 not implemented`**.
5. `/api/rank`, `/api/wishlist`, `/api/marks`, `/api/settings` and `/api/dismissals` all still work,
   each asserted on content rather than status.
6. `POST /api/fpm/sync/status` (GET) still answers – the sync lane is untouched.

---

## 8. Done means

The diff is shown to James and the increment stops. **No commit, no push.** The report states the
new test count against the 931 baseline, accounts for the difference line by line, and flags
anything found that contradicts the handoff – §2 already holds two such findings.

It also surfaces, for James to file or drop, the deferred pruning of the caller-less exports in
`src/deals.js` and `src/hltb.js` that §6 rules out of this increment.

---

## ⛩ REVIEW

**Gate TLDR:** the five routes that served James's whole Steam library, playtimes, ownership and
recommendations to anyone who asked are **deleted, not disabled** – the unauthenticated surface
falls from eighteen route/method pairs to thirteen, the suite falls from 931 to **exactly 773** with
every missing test accounted for by name, and `/api/rank` still returns its 18,306 catalogue rows
with the ranking bit-for-bit unmoved.

**Output (what James holds while reviewing):**

1. `01-what-went.md` – the complete inventory of everything deleted: five routes, five handlers,
   sixteen private helpers, six constants, three modules and seven test files – each line carrying
   the call-site trace that proves it had no surviving caller.
2. `02-the-five-are-gone.md` – live `curl` against `npm run dev` showing each of the five routes
   answering **`501 not implemented`**, captured with the request and the full response body.
3. `03-nothing-else-moved.md` – live `curl` for `/api/rank`, `/api/wishlist`, `/api/marks`,
   `/api/settings`, `/api/dismissals` and `GET /api/fpm/sync/status`, each asserted on **content and
   a row count**, never on a 200. `/api/rank` shows `catalogTotal: 18306`.
4. `04-the-test-count.md` – 931 → 773, the subtraction line by line, and the real `npm test` tail.
   **The single number that says nothing extra was deleted.**
5. `05-gate-7-retired.md` – the old test and the new one side by side, and the reason the gate was
   retired with its subject rather than re-pointed at `/api/rank`.
6. `06-traps-untouched.md` – the empty `git diff` for `public/weight.js`, `src/deals.js`,
   `src/score.js`, `src/profile.js`, `src/rank.js`, `src/battery.js` and `src/deckCompat.js`, and the
   surviving library plumbing (`libraryCacheKey`, `fetchOwnedGames`, `trimGame`) with its live
   `handleRank` call site.
7. `07-deploy-blockers.md` – blocker 2 closed, blocker 1's table at thirteen rows, blocker 3
   untouched.

**Review folder:** `~/code/review/steam-sale-scout/inc-14/`
**Index:** `/AI/projects/personal-projects/steam-sale-scout/reviews/inc-14.md`
