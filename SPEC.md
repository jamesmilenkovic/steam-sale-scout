# Increment 7.6 — FPM independent pool + owned games

**Project:** Steam Sale Scout · **Phase 2, slice 3.6** (the inc-7.5 follow-ups, James 2026-07-13)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-7.5 (`d9a4a1e`) · **Status:** Build-ready (scoped 2026-07-13)

## Why

7.5 fixed the floors and the formula, but James's eye test hit one root
cause twice: **FPM sources from `loadBestOfPool`**, which applies two
server-side exclusions before the client sees anything —
`filterByMinCut(merged, BESTOF_MIN_CUT)` (fixed 10% discount floor,
`src/deals.js:49`) and `excludeOwned(...)`. So the bar's "Any" discount can't
surface sub-10% games (never fetched), owned games can never appear, and the
eye test had no reference points (games James knows are all owned). The
formula default (`sqrt`) shipped on Coder/Reviewer live evidence, pending
James's re-test with owned games visible.

**Scoping decisions (James, 2026-07-13):** owned games mixed into the lane
with an **"Owned" badge**, shown **by default**, with a **filter-bar toggle
to hide** — the lane doubles as buying guide and backlog prioritizer.

## Build

### 1. FPM's own candidate pool (decouple from Best-of)

- New `loadFpmPool` alongside `loadBestOfPool` (`src/worker.js`): **same
  ITAD rank-sorted sourcing** (rank ASC = most-popular-first, cap 5000 —
  no new pagination), but **no `filterByMinCut`** for FPM's copy. Keep
  `excludeOwned` on the deal side — owned games enter via §2, so no dupes
  by construction.
- **Not a shared-config change:** `BESTOF_MIN_CUT` and `loadBestOfPool` are
  untouched — Best-of must stay byte-identical (7.5 discipline). No shared
  constant may couple the two pools.
- Own Cache-API key (`fpm-pool`, 6h) mirroring the Best-of pool cache.
- `FPM_POOL_CAP = 300` still slices the top of the deal side (unchanged,
  per the 7.5 pool-cap decision).

### 2. Owned games in the lane

- **Source:** GetOwnedGames (already fetched for exclusion + Library) —
  owned titles become FPM candidates: SteamSpy via the existing `spyQueue`
  (quality/reviews/owners), HLTB via the existing `hltb` queue (match on the
  owned game's name from GetOwnedGames `include_appinfo`). Both queues are
  throttled + cached already; the fill is progressive like everything else.
- **`FPM_OWNED_CAP = 0`** (config; 0 = no cap). If James's library makes the
  first cold fill obnoxious, the cap is the lever — record library size +
  cold-fill time in the save-down so the decision is data-driven.
- **Qualification: the SAME FPM floors apply to owned games**
  (`qualifiesForFpmFloor` — 50 reviews / 0.7 Wilson / 5000 owners). Decision
  rationale: the floor guards the *score's data quality* (a Wilson numerator
  on 12 reviews is noise, owned or not), not taste. An owned game below the
  floors simply doesn't appear. James can veto at the diff gate.
- **No price data, gracefully:** owned entries carry no
  `price`/`cut`/`atHistoricalLow` — price/discount cells render `—`, an
  **"Owned" badge** renders where the discount would, `atHistoricalLow`
  treated as false (tiebreak unaffected), why-line unchanged otherwise.
  Store-page link still works (appid known).
- **Toggle:** "Show owned" checkbox in the FPM filter bar (FPM tab only —
  must not leak to other lanes), **default ON**. Server param `?owned=0|1`
  (default 1): at `owned=0` the owned side is not sourced at all (zero owned
  queue work), not merely hidden client-side. Bad values → default, never a
  500 (7.5 override discipline).
- **Discount bar filter on FPM now genuinely spans from "Any"** — sub-10%
  deals appear (pool no longer pre-floored); owned entries are exempt from
  the discount filter (they have no cut) but respect tag/Deck/battery
  filters via the shared enrichment they already get.

### 3. Eye test + lock the formula default (carried from 7.5 §4)

- With owned reference points visible, James re-runs the eye test via the
  in-tab picker and **confirms or changes `FPM_FORMULA`'s shipped default**.
  The pick + why go in the save-down. No formula code changes in scope.

### 4. Curated-fixture pair fix (carried from 7.5 §2 flag)

- SPEC's original Gorogoa/ETS2 pair has identical Wilson quality, so no
  quality exponent can flip it by construction. Update the curated ordering
  fixture to ALSO assert a real quality-gap flip, using the live-verified
  pair shape (e.g. Thronefall 96%/7.9h overtakes Lara Croft 91%/6.3h under
  `sqrt`+`qexp=2` but not under `linear`). Keep the existing
  score-gap-collapse assertion.

## Out of scope

Settings + dismissals (inc 8 — incl. persisting the toggle/formula choices;
defaults live in config), any change to Best-of/Recs/Wishlist pools,
qualification, or scoring, new formulas or formula-code changes, HLTB
adapter changes (`src/hltb.js` handshake/matching untouched beyond reuse),
owned games in any other lane, playtime-aware scoring ("remaining fun" —
a later idea, not this slice), deploy (local-only stands).

## Testing

- Unit: pool independence (FPM pool has no min-cut while `loadBestOfPool` /
  `BESTOF_MIN_CUT` are untouched and no constant is shared); owned merge
  (badge + `—` price rendering fields, `atHistoricalLow` false, dedup by
  construction — an owned appid never appears twice); `?owned=` matrix
  (0 → zero owned rows AND zero owned queue enqueues; bad values → default);
  floors applied to owned candidates (below-floor owned excluded); discount
  filter exempts owned but applies to sub-10% deal rows; curated fixture
  quality-gap flip (§4).
- Regression: full suites green (375 baseline). Best-of route tests
  unchanged and passing.
- **Live proof:** (a) with bar at "Any", sub-10% deals appear in FPM while
  Best-of still floors at 10; (b) owned games appear with the badge, `—`
  price, correct HLTB hours (spot-check 3 against howlongtobeat.com);
  (c) toggle off → owned rows gone AND no owned-side HLTB/SteamSpy traffic
  in wrangler logs; (d) Best-of byte-identical (diff + live schema check,
  7.5 method); (e) record the owned funnel: library size → floors → matched,
  plus cold-fill time; (f) `hltb:` cache keys from 7.5 still hit (no
  re-fetch of already-matched games).
- Manual (James, localhost): eye test with real reference points → lock the
  formula default; the lane reads as one honest list — "buy this" and "you
  already own this, play it" side by side, steerable by the bar.
