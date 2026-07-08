# Increment 5.5 — Best-of candidate sourcing fix (+ min-discount into the bar)

**Project:** Steam Sale Scout · **Phase 2, slice 1.5** (bug-fix follow-up to inc 5)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-5 (`423b27f`) · **Status:** Build-ready (scoped 2026-07-08)

## Why (bug proven live 2026-07-08 — see `claude-code-result-increment-5.md` Open item 1)

Best of Steam's qualification logic is correct but its candidate pool is
structurally wrong: it reuses the Deals feed, which `fetchDealsPages` sorts
`-cut` and caps at `DEALS_FETCH_CAP = 1000`. During a sale the cap saturates at
92–95% off (pure shovelware); measured live, lowering minCut 40→10 produced the
identical pool. 15 famous HoF qualifiers on real sales that day (Portal 2 80%
off, Hades 75%, Witcher 3 90%, Stardew 40%, Terraria 50%, BG3 25%…) were all
excluded below the pool floor — Best-of qualifies ~0 games by construction.
`-cut` + cap-1000 is right for the Deals tab; it's the wrong axis for "best
games on any meaningful discount."

## Build

### 1. Dedicated Best-of candidate sourcing (the fix)

Decouple entirely: new `fetchBestOfPool()` with its own ITAD paging, own KV
cache key (own prefix, 6h TTL — same cadence as deals), own config. **The Deals
tab pool is untouched.**

- **Floor: `BESTOF_MIN_CUT = 10` (config).** Low on purpose so shallow-cut
  qualifiers (BG3 at 25%) enter the pool; the bar's min-discount filter (§2)
  tightens client-side. Do NOT conflate the sourcing floor with the bar filter.
- **FIRST STEP — live probe of ITAD `/deals/v2` capabilities** (extend
  `hof-pool-probe.mjs`, key in `.dev.vars`) before building. Implement the
  highest tier that works, record which + evidence in the save-down:
  1. **Server-side rating filter.** If the v2 `filter` grammar supports Steam
     review score/rating (the ITAD site UI filters on it), request
     cut ≥ 10 AND rating ≥ 95 directly — pool arrives pre-qualified-ish and
     tiny. Best case.
  2. **Popularity/rank sort.** If `sort` accepts a popularity axis (`rank`,
     `-rank`, trending…), page at the floor sorted by popularity and take the
     top `BESTOF_FETCH_CAP = 5000` (config). All-timers with 10k+ reviews are
     by definition popular → land in the first pages; a popularity-axis cap
     cannot recreate the `-cut` saturation bug.
  3. **Un-truncated paging fallback.** Page the whole ≥10% feed with a safety
     bound `BESTOF_MAX_PAGES = 100` (×200/page = 20k deals), qualify lazily.
     Worst tier — only if 1 and 2 are unavailable.
- **Rate limits:** page size 200; worst case ~100 requests per refresh, well
  inside ITAD's 1,000 req/5min; the 6h pool cache makes it rare anyway.
- **Qualification unchanged:** `qualifiesForHof` (HOF_MIN_REVIEWS = 10,000 +
  HOF_MIN_RATIO = 0.95) over the SteamSpy trio, lazy-filled through the
  existing 1 req/sec spyQueue + 30d KV — same progressive pattern as
  `/api/recs`; `/api/best-of` returns what has qualified so far + fill status.
  Per-appid qualification results cache, so the pool converges across visits.
- Owned exclusion, discount × Wilson sort, similarity-as-secondary, badges:
  all exactly as shipped in inc 5.

### 2. Min-discount into the filter bar (inc-5 reviewer issue #3)

Wire the existing built+tested `passesMinDiscount` predicate to a bar input —
Deals + Recs + Best-of, persisted, combinable, resettable (house bar
behaviour). Retire the separate `?minCut=` UI control (the server param can
remain for Deals sourcing). This is client-side filtering; Best-of's sourcing
floor stays the §1 config.

## Out of scope

Wishlist lane (inc 6), FPM/HLTB (inc 7), settings/dismissals (inc 8),
DeckSettings battery API (backlog), any change to the 95%/10k qualification
thresholds, any deploy (local-only stands).

## Testing

- Unit: pool sourcing per implemented tier (floor honoured, paging, cap
  semantics — assert the cap axis is never `-cut`), pool KV cache round-trip,
  **Deals-pool-unchanged regression** (same params → byte-identical pool
  behaviour vs inc 5), min-discount bar wiring + persistence + combination
  with other filters.
- Regression: full inc 1–5 suites green (263 baseline).
- **Live proof (the acceptance that matters):** re-run the
  `hof-quality-probe.mjs` famous-qualifiers list — every game on that list
  that qualifies (95%/10k) AND is currently on Steam sale ≥10% MUST appear in
  `/api/best-of` once trio fill completes. Any missing → sourcing still
  broken, do not pass QA.
- Manual (James, localhost): Best-of tab is finally browsable gold —
  recognisable all-timers at real discounts; min-discount control in the bar
  steers all three sale tabs.
