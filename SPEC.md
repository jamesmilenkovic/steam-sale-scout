# Increment 7.7 — FPM catalog: all games, own database

**Project:** Steam Sale Scout · **Phase 2, slice 3.7** (the Celeste finding, James 2026-07-14)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-7.6 (`928d2ff`, pushed, in sync with origin) · **Status:** Build-ready (scoped 2026-07-14)

## Why

James's 7.6 eye test found Celeste missing. Root-caused live (7.6 result §6,
confirmed not a bug): every pool in the app pages ITAD's `deals/v2` rank feed,
and that rank is **deal-activity popularity** — a full-price, unowned,
non-promoted evergreen title can't enter any lane at any cap. Raising
`FPM_POOL_CAP`/`BESTOF_FETCH_CAP` cannot fix it; Celeste isn't in the top
5000 by that rank at all.

The FPM lane's real product — James's original standalone FPM project
(Mar 2026), now fully absorbed here — is **"every Steam game worth ranking,
by fun density."** Ownership and sale status stop being sourcing criteria
and become annotations you filter on. 7.5/7.6 already built the hard parts
(floors, formula machinery, HLTB adapter + queue, the no-price row shape);
7.7 swaps what feeds them.

**Scoping decisions (James, 2026-07-14):** **ALL floor-passing games, no
permanent cap** — "FPM is all games, filtered after" (supersedes the earlier
top-N answer from the same session; the quality floors are the only bound on
the catalog). The expensive HLTB matching fills **top-down in batches per
sync run** until the full set is matched — coverage is complete by
construction, just not in one sitting. **D1 as the lane's own database**
(the multi-run fill must survive dev restarts). **Single stream** — the
catalog replaces the deal pool as the lane's only candidate source; deals +
owned demote to annotation joins; owned / discount / on-sale / Deck /
battery / tags are all post-hoc filters on one list.

## Build

### 1. Catalog source — SteamSpy bulk pages (probe first)

- New `src/catalog.js`: page SteamSpy `all` (owner-sorted descending, 1,000
  rows/page). **Probe the live shape before building** (house rule, same
  discipline as the HLTB probe): confirm current fields, the owners format,
  and the `all`-specific rate limit (believed 1 req/60s — stricter than the
  1 req/s appdetails limit; verify, don't assume).
- Bulk rows carry `positive`/`negative`/`owners` → `qualifiesForFpmFloor`
  (50 reviews / 0.7 Wilson / 5000 owners, unchanged) is computable **per-row
  from the bulk feed alone** — no per-appid SteamSpy calls for qualification.
- Owners may arrive as a range string — **reuse the existing owners parsing**
  from the SteamSpy path, don't fork it.
- **No catalog cap:** collect **every** floor-passer. Owner-descending
  order means deeper pages pass floors progressively less often; page until
  a full page yields zero floor-passers (expect ~8–12k rows total — record
  the real number). The floors are the only bound on catalog membership.

### 2. D1 — the catalog's own database

- New D1 binding (e.g. `FPM_DB`), table `fpm_catalog`: `appid` PK, `name`,
  `owners`, `positive`, `negative`, `wilson`, `main_hours` (NULL until
  matched), `match_method`, `source` flags (catalog/owned/deal —
  informational), `spy_synced_at`, `hltb_checked_at`. Schema via
  `wrangler d1 migrations` or `CREATE TABLE IF NOT EXISTS` on the sync path —
  Coder's call, local-only app.
- Local persistence (`.wrangler/state`) survives dev restarts — **that's the
  point**: the hours-class HLTB cold fill happens once, ever, not per
  restart. HLTB results write through to D1 as the durable record (Cache API
  may stay as a hot layer if convenient, but D1 is truth).

### 3. Sync job

- `POST /api/fpm/sync` (manual trigger; local-only, no cron): pull bulk
  pages → upsert **all** floor-passers → union owned floor-passers
  (GetOwnedGames) and current deal-pool floor-passers (`loadFpmPool`
  top-300) for the `source` flags → enqueue HLTB via the existing `hltb`
  queue for rows with NULL `main_hours`, **in priority order, batched per
  run**: `FPM_SYNC_BATCH = 3000` (config) rows per sync, prioritized owned
  + on-sale first (James's reference points and buy candidates), then by
  owners/reviews descending — so the top of the leaderboard matches first
  and each successive sync extends coverage down the tail until the full
  set is matched. The lane is useful after batch one, complete after ~3–4.
- **Resumable by construction:** re-running sync skips matched rows; only
  NULLs enqueue. Existing `hltb:` cache keys from 7.5/7.6 should hit for
  already-matched titles (~600 games pre-warmed — record the hit rate).
- Staleness: `spy_synced_at` older than `FPM_SPY_TTL_DAYS = 7` → stats
  refresh next sync. `hltb_checked_at` older than `FPM_HLTB_TTL_DAYS = 30`
  AND unmatched → retry next sync. Matched lengths are near-static — never
  refetched.
- Pace gently: HLTB is an unofficial endpoint that already drifts; the
  existing queue throttle stands, no burst mode.
- `GET /api/fpm/sync/status`: counts (total / matched / pending) straight
  from D1. **This replaces per-request `ready` convergence** and
  by-design retires 7.6's perpetual-progress-bar paper cut (result 3e): the
  frontend polls sync status only while a sync is running and stops at
  idle. The FPM tab shows an honest "ranked X of Y qualifying games"
  line whenever pending > 0, so partial coverage is never mistaken for
  the full leaderboard.

### 4. Lane rewire — single stream

- `handleFpm` reads floor-passing matched rows from D1 and scores with the
  existing formula machinery **unchanged** (`fpmScore`, `FPM_FORMULA` /
  `FPM_QUALITY_EXP` / `FPM_BREADTH_WEIGHT`, `?formula=`/`?qexp=`/`?breadth=`
  overrides, in-tab picker) — overrides become zero-external-call re-ranks
  against D1.
- **Annotation joins at request time:** owned set → `owned: true` + badge;
  deal pool (`loadFpmPool` **kept but demoted** from candidate source to
  price lookup) → `price`/`cut`/`historicalLow`/`atHistoricalLow` onto
  matching appids. Badge precedence: **Owned wins over discount** (an owned
  game's sale price is irrelevant; price cell stays `—`). Neither → no
  badge, `—` price (the 7.6 row shape, third variant).
- 7.6's `ownedFpmCandidate` dual-stream merge retires as a *sourcing* path.
  **The filter bar is the product** — one list, filtered after:
  - Owned three-state: **Show all / Hide owned / Only owned**
    (`?owned=all|hide|only`, default `all`; bad values → default, never a
    500 — 7.5 discipline).
  - "On sale only" checkbox (filters on the deal annotation); min-discount
    bar applies to annotated cuts; rows with no deal remain exempt (7.6
    semantics generalized).
  - **Deck compat / battery / tag include+exclude — the existing inc-5
    shared filter machinery must work on catalog rows.** Deck/battery data
    comes from the existing GetItems enrichment; for catalog-scale row
    counts, enrich displayed/top rows lazily with caching rather than the
    whole table eagerly (Coder's call on mechanism; probe GetItems batch
    limits if unsure). A catalog row with no enrichment yet is treated as
    unknown, not excluded (fail-soft, matching existing lanes).
- With ~8–12k eventual rows, the client shouldn't render the whole table:
  display cap / lazy render with an explicit "showing top N — filter to
  narrow" affordance (Coder's call; the 7.6 UI comfortably rendered ~600).
- Best-of / Recs / Wishlist / Library: **untouched.** They are deal/library
  lanes and stay sourced from deals; no shared constants, no shared pool.

### 5. Eye test + lock the formula default (carried 7.5 → 7.6 → here)

- Twice now the lock has been blocked by an incomplete reference set. With
  the full leaderboard (owned + on-sale + evergreen side by side), James
  runs the eye test and **locks `FPM_FORMULA`'s shipped default**. Pick +
  why go in the save-down.

## Out of scope

Price display for unowned not-on-sale rows (ITAD batch price
decorate = a future polish slice); the catalog as a source for any other
lane; settings + dismissals (inc 8 — incl. persisting the new filters);
HLTB adapter internals; formula/scoring changes; scheduled/cron sync;
deploy (local-only stands).

## Testing

- Unit: floor-pass from bulk rows (incl. owners-range parsing reuse); batch
  semantics (priority order owned/on-sale → owners-desc; `FPM_SYNC_BATCH`
  bounds per-run enqueues; successive syncs extend, never repeat); one row
  per appid with badge precedence (owned+deal → Owned); D1 upsert
  idempotence; sync resumability (matched rows never re-enqueue); `?owned=`
  tri-state matrix incl. fail-safe parsing; overrides re-rank with zero
  HLTB traffic; min-discount exempts non-deal rows; on-sale-only filter;
  Deck/battery/tag filters on catalog rows incl. unknown-is-not-excluded.
- Regression: full suites green (383 baseline). Best-of/Recs/Wishlist
  byte-identical (7.5 diff + live-schema method).
- **Live proof:** (a) **Celeste appears** — unowned, full price, no badge,
  `—` price, correct ~8h main story (the named acceptance criterion of the
  whole increment); (b) funnel recorded: pages pulled → total floor-passers
  (the real "all games" number) → batches run → HLTB matched, plus per-batch
  wall time and pre-warmed `hltb:` hit rate; (c) restart `wrangler dev`
  mid-fill and post-fill → lane serves from D1 instantly, zero HLTB refetch
  (the persistence win); (d) owned tri-state + on-sale + Deck filters
  verified live on catalog rows; (e) sync status reaches idle, the "ranked
  X of Y" line is accurate, and the frontend poll actually stops (7.6 3e
  paper cut gone); (f) deal lanes byte-identical.
- Manual (James, localhost): the complete-leaderboard eye test → lock the
  formula default. The lane finally reads as what it was always meant to
  be: Steam, ranked by fun per minute, steerable by owned/sale filters.
