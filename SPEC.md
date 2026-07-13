# Increment 7.5 — FPM lane tuning (qualification + scoring)

**Project:** Steam Sale Scout · **Phase 2, slice 3.5** (the inc-7 follow-ups, James 2026-07-12)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-7 (`ec92b99`) · **Status:** Build-ready (scoped 2026-07-12)

## Why

Inc-7 shipped correct to its own spec (352/352, live-proof passed) but James's
live review flagged two product-model problems, deferred to here:

1. **The lane is too small.** Measured funnel 2026-07-12: pool ~4,800 → top
   `FPM_POOL_CAP=300` → only ~10 pass the inherited Best-of floor
   (`qualifiesForHof`: ≥10,000 reviews AND ≥95% positive) → 9 matched. Across
   the whole pool only 14 games clear 10k/95% — the floor, not the HLTB match
   rate, is the dominant cull. Far stricter than a "quick wins" lane wants.
2. **The scoring over-rewards ultra-short games.** Pure `quality ÷ hours`
   makes 1.8h Gorogoa #1 on brevity alone (54.2 fun/hr) while identical-quality
   45.9h ETS2 comes last. James's instinct: Portal/Celeste-class games should
   be top scorers — reward sustained delight, not just density. Explore, don't
   just tweak.

This is a 5.5-style tuning increment: no new data sources, no new lanes.
Inc 8 (settings + dismissals) is unchanged and stays next.

## Build

### 1. Qualification — swap the floor, keep a floor (fix 3a)

- Replace the FPM lane's use of `qualifiesForHof` with **FPM-specific floors
  defaulting to the Recs-tier values that already exist in `src/score.js`**:
  `FPM_MIN_REVIEWS = 50`, `FPM_MIN_QUALITY = 0.7` (Wilson lower bound),
  `FPM_MIN_OWNERS = 5000` — all config in `src/hltb.js`, independent of both
  the Recs constants and Best-of (so any lane can be tuned without moving the
  others).
- **Do NOT drop the floor to zero:** `fpm = quality ÷ hours` divides by a
  small number — a 2h game with a handful of lucky reviews would top the lane
  on garbage data. The Wilson lower bound + review/owner minimums stay the
  guard.
- **Best-of lane is untouched** — it keeps `qualifiesForHof` (10k/95%). Only
  the FPM route's qualification changes.
- **Pool cap, data-driven:** keep `FPM_POOL_CAP = 300` for the build. At
  live-proof, measure lane size with the new floors; if still under ~30 games,
  flip the config to 1000 (cold fill ≈ 15 min at ~1 req/sec, one-time, then
  cache-warm — acceptable). Record the measured funnel either way in the
  save-down.

### 2. Scoring — config-selectable formulas + live comparison (fix 3b)

- **`FPM_FORMULA`** (config, in `src/hltb.js`) selects the score function.
  Ship all of these; each is a few lines:
  - `'linear'` — `q^k / h` (current behaviour at k=1; kept for comparison)
  - `'sqrt'` — `q^k / sqrt(h)` (**default**) — length matters, doesn't dominate
  - `'log'` — `q^k / log2(h + 1)` — gentler still on long games
- **`FPM_QUALITY_EXP = k`** (default 2) — biases toward the genuinely great:
  at equal length, 97% vs 90% separates much harder than linearly.
- **`FPM_BREADTH_WEIGHT = w`** (default 0) — optional breadth/delight term:
  `score × log10(max(reviews, 10))^w`. At w=0 it's off (×1 semantics must hold
  exactly); w=1 lets a broadly-loved game outrank an obscure short one at
  equal quality %. Exposed so James can A/B it, not asserted as right.
- **Live comparison, cache-only:** `/api/fpm` accepts `?formula=`, `?qexp=`,
  `?breadth=` overrides (re-rank only — served entirely from already-cached
  lengths, zero extra HLTB calls), plus a small formula picker in the FPM tab
  header (local-only app; it's a real feature, not scaffolding). This is how
  James runs the eye test — flip, look, decide.
- **Display:** `fun/hr` stays the honest raw number
  (`wilsonQuality × 100 / mainHours`); the why-line appends the active formula
  when it isn't `linear` (e.g. "… — 14.5 fun/hr · sqrt ranking") so the sort
  order is never mysterious. Sort by the formula score, at-historical-low
  tiebreak unchanged.
- **`FPM_LENGTH_FIELD`** stays a one-line lever (cache already holds all three
  lengths — no migration): if main-story reads too short during the eye test,
  `comp_plus` is the first thing to try.
- Whatever James picks at acceptance becomes the shipped default in config —
  record the choice + why in the save-down.

## Out of scope

Settings + dismissals (inc 8 — including persisting a formula choice via
settings UI; for now the default lives in config), any pool-sourcing change,
wishlist games in the FPM pool, new data sources / IGDB, any change to
Best-of/Recs/Wishlist qualification or scoring, FPM as a sort mode on other
lanes, deploy (local-only stands).

## Testing

- Unit: floor matrix (game passing 50/0.7/5000 but failing 10k/95% now
  qualifies; sub-floor junk still excluded; Best-of route still enforces
  10k/95%); formula math per formula incl. `qexp`/`breadth` params and the
  w=0 ×1 identity; override parsing (`?formula=` bad values → default, never
  a 500); ordering fixture — curated known-games set with real-ish quality ×
  hours (Gorogoa 1.8h/97.3%, Portal ~3h/98%, Celeste ~8h/97%, Hades
  ~23h/98%, ETS2 45.9h/97.3%) asserting `sqrt`+k=2 no longer ranks purely by
  brevity while `linear` does (proves the levers actually move the thing
  James flagged).
- Regression: full suites green (352 baseline).
- **Live proof:** (a) lane size before/after floor swap measured and recorded
  — expect ~9 → dozens+; (b) top-20 contains no thin-review junk (Wilson
  floor holds on real data); (c) `?formula=` flip re-ranks instantly with
  zero new HLTB requests (watch the queue); (d) Best-of lane byte-identical
  before/after; (e) if lane < ~30, flip `FPM_POOL_CAP` to 1000 and record the
  cold-fill time + final lane size.
- Manual (James, localhost): the eye test — flip formulas in the tab header;
  Portal/Celeste-class games read as top scorers under at least one setting;
  pick the default. The lane finally reads as "quick wins with substance".
