# Increment 4 — Quality metrics + smarter similarity (kill the shovelware)

**Project:** Steam Sale Scout · **Phase 1 gate response — gate stays open until this passes**
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ `a79a426` (inc 3) · **Status:** Build-ready (scoped 2026-07-06)

## Why (James's ⛩ gate verdict, 2026-07-06)

Recs work but **shovelware ranks high**. Two confirmed drivers (inc-3 save-down
called both): (1) the 0.75 neutral quality default means near-reviewless junk
pays no penalty; (2) generic tags (Action/Adventure/Strategy) create false
similarity. Constant-tweaks alone won't fix it — this increment builds real
quality metrics into the engine. The planned filters slice shifts to inc 5.

## Build

### 1. Quality = Wilson lower bound (replaces the clamp + neutral default)

`quality = wilsonLowerBound(positive, negative, z=1.96)` — the lower bound of
the 95% confidence interval on the true positive-review ratio.

- A 92%-positive game with 12 reviews scores ~0.64; with 4,000 reviews ~0.91.
  Thin-review shovelware **cannot** free-ride: no reviews → quality ≈ 0.
- No clamping, no neutral default. Delete `QUALITY_NEUTRAL` /
  `REVIEW_NEUTRAL_THRESHOLD` config.
- `rankScore = similarity × quality × (atHistoricalLow ? LOW_BONUS : 1)` —
  formula shape unchanged, quality term now honest.

### 2. Hard quality floors (config, applied before ranking)

- `MIN_REVIEWS` default **50** total reviews.
- `MIN_QUALITY` default **0.70** Wilson score (≈ "clearly well-reviewed").
- `MIN_OWNERS` default **5,000** (SteamSpy owners-range midpoint) — shovelware
  rarely clears it; genuinely obscure gems on deep sale usually do.
- Floored-out candidates → `qualityExcludedCount`, surfaced in the UI footnote
  (distinct from tagless/pending), so we can see what the floors are eating.

### 3. IDF tag weighting (fixes generic-tag similarity properly)

- Compute document frequency per tag across the working corpus (cached tag sets:
  top-200 owned + current candidates); `idf(tag) = ln(N / df)`.
- Apply `idf` to tag values in **both** profile and candidate vectors before
  normalisation/cosine. "Action" (in everything) → near-zero weight;
  "Roguelike Deckbuilder" → high weight. The principled fix — the stoplist
  stays only as a small backstop (keep current entries, expect to shrink it).
- Recompute IDF per recs run (cheap — it's a count over cached data).
- Why-lines automatically improve: contributions are now IDF-weighted, so the
  named tags become the distinctive ones.

### 4. Cache schema: add `owners` to the SteamSpy trio

- Trimmed entry becomes `{tags, median, reviews, owners}` — **bump the KV cache
  version** (`TAG_CACHE` key prefix `v2:`); old entries lazily refetched, which
  means one more cold crawl (~20 min, overnight-friendly). Same-call data, no
  new requests.

### 5. Small fixes pulled in from the inc-3 save-down flags

- **Failure-TTL split (flag 4):** network/5xx errors cached 1h, genuine
  empty/no-tags responses keep 24h `null` — a SteamSpy blip can no longer
  strand good games for a day.
- **`pendingCount` split (flag 3):** separate "not yet fetched" from
  "permanently tagless" in the API response + UI footnote.

### 6. UI (Recs tab)

- Each rec row adds: **review % + count** (e.g. "94% · 12,410") and an owners
  bracket on hover/small text — so quality is eyeballable at the gate.
- Footnote now itemises: pending / tagless / below-quality-floor counts.
- No new controls (floors are config this increment; they become user-facing
  filters in inc 5 alongside price/similarity/genre).

## Out of scope

Inc-5 filters (price cap, min-similarity, genre — floors become user-facing
there), wishlist lane, dismissals, LLM re-rank, external quality sources
(Metacritic/SteamDB ratings — Wilson on Steam reviews should suffice; revisit
only if the gate still fails).

## Testing

- Unit: Wilson bound (known values, 0-review, extreme n), floors incl.
  owners-midpoint parsing ("10,000 .. 20,000" strings), IDF (uniform tag →
  ~0 weight; unique tag → max; N=1 corpus edge), v2 cache versioning + lazy
  refetch, error-vs-empty TTLs, pending/tagless/floored count separation.
- Regression: inc-3 suites stay green (update fixtures for the v2 trio).
- Manual acceptance = **⛩ Phase 1 gate, take 2 (James):** rebuild cache, then
  the top-20 test again — shovelware gone, hidden gems intact. If floors are
  eating good games, tune `MIN_*` config in-loop before touching the engine.
