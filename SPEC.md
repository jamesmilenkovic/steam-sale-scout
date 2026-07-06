# Increment 3 — Taste profile + scoring engine v1 + ranked recs

**Project:** Steam Sale Scout · **Phase 1, slice 3 of 3 — THE CORE INCREMENT**
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ `e842ca8` (inc 2) · **Status:** Build-ready (scoped 2026-07-06)
**Inc-2 handoff consumed:** `session-2026-07-06-increment-2-built.md` — its three
flags (null appids, degraded-mode exclusion, stale library cache) are handled below.

## Goal

Rank every on-sale unowned game by "how much would James actually like this",
with a *why* per pick. **This increment ends at the ⛩ Phase 1 gate:** James runs
it against a real sale week and judges the top 20. Nothing in Phase 2 gets built
until the recs feel right.

## Data: SteamSpy per-app fetch + persistent tag cache

One SteamSpy `appdetails` call per appid supplies everything the engine needs:
`tags` (with votes), `median_forever`, `positive`/`negative`. 1 req/sec limit →
the design problem is the **cold-start fetch**, not the maths.

1. **Tag cache:** KV (local via `wrangler dev`), key = appid, TTL 30 days
   (tags/medians are near-static). Store the trimmed trio: tags, median, review
   counts. Failed/empty responses cached 24h as `null` (DLC/bundles often have
   no tags — they simply never get scored).
2. **Fetch queue in the Worker:** strict 1 req/sec, needed appids =
   **top 200 owned games by inc-1 weight** (the tail is noise) + all candidate
   appids from `/api/deals` (cut ≥ current threshold). Cold start at Summer-Sale
   scale ≈ ~1,200 appids ≈ ~20 min — hence:
3. **Progressive results:** `/api/recs` never blocks. Response:
   `{ready, fetched, total, recs:[...]}` — recs computed from whatever is cached
   so far; UI polls, shows a progress bar, and the list fills in/re-ranks live.
   Warm runs are instant.

## Engine (pure modules, unit-tested)

### `profile.js` — build the taste vector

1. Per owned game (top 200 by inc-1 weight, skip < 30 min played):
   `gameWeight = playtimeNorm × recencyMult` where
   `playtimeNorm = clamp(playtime_forever / median_forever, 0.1, 4)` (median
   from SteamSpy; if median missing/0, fall back to inc-1's log-hours term) and
   `recencyMult` = the existing banded multiplier from `weight.js`
   (windowMonths setting, default 12). **This replaces the log-hours seam
   flagged in `weight.js`.**
2. Per-game tag vector: top 15 tags by votes, values = votes normalised to sum
   to 1 for that game, minus the **stoplist** (configurable constant; defaults:
   `Singleplayer, Multiplayer, Great Soundtrack, Early Access, Free to Play,
   Controller, Steam Achievements, Atmospheric`) — SteamPeek-style troll/generic
   suppression, tune at the gate.
3. `profile = L2-normalise( Σ gameWeight × gameTagVector )`.

### `score.js` — rank the candidates

1. `similarity = cosine(profile, candidateTagVector)` → shown as a % (this is
   the "% of similar" number the Phase-2 filter will use).
2. `quality = positive/(positive+negative)` clamped to [0.5, 1]; neutral 0.75
   if < 50 total reviews.
3. `rankScore = similarity × quality × (atHistoricalLow ? 1.15 : 1)`.
   (Deal depth already gated by minCut; don't double-count discount.)
4. **`appid: null` or tagless candidates: excluded from recs** (still visible in
   the Deals tab); show an excluded-count line so nothing silently vanishes.

### `why.js` — the explanation line

Per rec: top 3 overlapping tags by contribution to the cosine + the 2 owned
games that contributed most weight to those tags, with hours. Format:
_"Roguelike Deckbuilder, Turn-Based, Strategy — because Slay the Spire (180h)
and Balatro (42h)"_.

## UI — third tab: **Recs**

1. Progress state while the tag cache builds (fetched/total, partial list
   fills in live).
2. Ranked cards/rows: name, **similarity %**, AUD price + struck regular,
   % off badge, HISTORICAL LOW badge, the *why* line, Steam store link.
   Sorted by rankScore.
3. Controls: reuses the deals min-discount control; **recency window setting
   now also recomputes the profile** (client re-request, profile rebuild is
   cheap once tags are cached). Excluded-count footnote.
4. No filters beyond that (Phase 2), no dismissals (Phase 2), diagnostic styling.

## Inc-2 flag handling (for the record)

1. Null-appid deals → excluded from recs, counted (above).
2. Degraded-mode owned-exclusion (missing Steam key) → recs must **refuse to
   run** in this state (a recommender that suggests owned games is broken):
   `/api/recs` returns a clear error if the library fetch failed.
3. Library cache staleness (≤24h) is fine for scoring; `?refresh=1` on
   `/api/recs` refreshes library + deals + recomputes (not the 30-day tag KV).

## Out of scope

Phase-2 filters (price cap, min-similarity, genre), wishlist lane, dismissals,
LLM re-rank, any deploy. Local-only stands.

## Testing

- Unit (fixtures shaped from real SteamSpy payloads): playtimeNorm incl. median
  fallback + clamps, profile normalisation, stoplist, cosine, quality clamps,
  historical-low bonus, why-line selection, null/tagless exclusion, partial-
  cache ranking (recs from 40% of tags ≠ crash), refuse-on-degraded-library.
- Queue: 1 req/sec pacing, null-caching of empty responses, 30d/24h TTLs.
- Manual acceptance = **⛩ Phase 1 gate (James, on a real sale week):** let the
  cache build, then judge the top 20 — "would I click buy on most of these?"
  Tune weights/stoplist in-loop if close; park cheaply if fundamentally off.
