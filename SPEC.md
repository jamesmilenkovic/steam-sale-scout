# Increment 7 — Fun-per-minute lane (FPM)

**Project:** Steam Sale Scout · **Phase 2, slice 3** (the FPM merge, decided 2026-07-07)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-6 (`bcc34be`) · **Status:** Build-ready (scoped 2026-07-11)

## Why

The old Fun Per Minute idea (Mar 2026): with limited play time, a short
brilliant game beats a long good one. FPM = Wilson quality ÷ main-story length
— a lane where quick wins surface. Merged into Sale Scout as increment 7
because everything except the length signal already exists here.

**Scoping decisions (James, 2026-07-11):** pure FPM only — price plays no role
in the ranking (it's on every row anyway). Denominator = HLTB **Main Story**
(`comp_main`), config-exposed. FPM is a **new top-level lane** (like
Best-of/Wishlist), sourced from the existing Best-of pool. Games with no HLTB
match are **excluded, with a count** shown ("n games had no length data").

## Build

### 1. HLTB adapter (the risky bit — isolate it)

- **Source:** HowLongToBeat — **no official API.** Current unofficial shape
  (verified via maintained wrappers, Jul 2026): the search endpoint has moved
  repeatedly (`/api/search` → `/api/seek` → now `/api/s/…`, with the path
  embedded in the site's JS bundle); auth = GET `/api/s/init` returning
  token headers (`x-auth-token`, `x-hp-key`, `x-hp-val`); requests need
  browser-like `User-Agent` + `Referer`/`Origin: https://howlongtobeat.com`.
  Response entries carry `game_id`, `game_name`, lengths in **seconds**
  (`comp_main`, `comp_plus`, `comp_100`), and (to confirm live) a
  `profile_steam` field holding the Steam appid.
- **FIRST STEP — live probe before building** (the wishlist/best-of
  discipline): from the repo, hit `/api/s/init`, then run 2–3 real searches
  with the tokens. Confirm: exact endpoint path (and whether it must be
  scraped from the JS bundle or a static path works), auth handshake, response
  shape, presence/reliability of `profile_steam`. **Record findings in the
  save-down.** If the handshake can't be made to work from the Worker, STOP —
  fallback decision (IGDB `game_time_to_beat`, needs Twitch OAuth secrets from
  James) is a James call, not a build call.
- **Isolation:** own module (`src/hltb.js`) — handshake + fetch + **one parse
  function** = the single repair surface when HLTB drifts. Mirror the
  howlongtobeatpy approach, minimally (only what the probe proves necessary).
- **Fail-soft, two levels:** (a) source level — init/search/parse failure hides
  the lane with a notice ("Fun-per-minute unavailable"), app never breaks;
  (b) per-game level — no/ambiguous match just excludes that game and
  increments the unmatched count.
- **Cache:** length is near-static — per-appid resolved record
  `{hltbId, compMain, matchMethod}` cached **30d**; negative results (no match)
  cached **7d**; `?refresh=1` bypass. Own cache keys.
- **Throttle + cost:** one search per unmatched game → reuse the spyQueue
  pattern: own queue, ~1 req/sec, progressive lane fill (like `/api/recs`).
  Cap the pool at `FPM_POOL_CAP = 300` (config) top rank-sorted candidates so
  a cold refresh is ~5 min of lazy-fill once, then cache-warm. Polite by
  design (throttle + long TTL) — it's an unofficial endpoint.

### 2. appid → length matching

- **Primary:** `profile_steam` == appid, if the probe confirms the field.
- **Fallback:** normalized-title similarity (existing GetItems `name`, cached
  30d) vs `game_name`, threshold `FPM_MATCH_THRESHOLD = 0.75` (config);
  below threshold = unmatched (never a wrong-game length — a bad match is
  worse than no match).
- Store `matchMethod` (`steam-id` / `name` / `none`) in the cached record so
  the save-down and any later debugging can see match quality.

### 3. Lane rules

- **Pool:** reuse `loadBestOfPool` (rank-sorted most-popular, cut ≥ 10,
  owned excluded) — top `FPM_POOL_CAP` entries. **No new sourcing, no changes
  to the Best-of pool itself.**
- **Qualify:** matched with `compMain > 0` AND main-story hours ≥
  `FPM_MIN_LENGTH_HOURS = 1` (config — blocks degenerate sub-hour entries) AND
  the existing Best-of quality floors (Wilson numerator must be trustworthy).
- **Score:** `fpm = wilsonQuality / mainStoryHours`, displayed as
  `fun/hr = round(wilsonQuality × 100 / mainStoryHours, 1)`. Denominator field
  = `FPM_LENGTH_FIELD = 'comp_main'` (config; switching to `comp_plus` later
  is one line).
- **Sort:** fpm desc; at-historical-low as tiebreak.
- **Why-line (deterministic):** "94% quality ÷ 6.5h main story — 14.5 fun/hr"
  + existing badges (low, Deck, battery).
- Enrichment reuse: spyQueue tags/battery, `resolveDeckCompat`, historical-low
  — same pipeline as other lanes.

### 4. UI

- New top-level tab **"Fun per minute"** alongside Best of Steam, same
  progressive-fill rendering as Recs (rows appear as the queue resolves).
- **Footer count:** "n games had no length data" (per-game fail-soft made
  visible, no fake numbers).
- **Bar filters apply** (min discount — Best-of-style floor-10 semantics, max
  price, tag include/exclude, Deck, battery) **except min similarity —
  recs-only, per PRD.**
- Rows link to the Steam store; fail-soft notice on source failure; empty
  state: "No length data yet — still matching…" while the queue runs.

## Out of scope

IGDB fallback build-out (contingency only, James-gated at the probe), fun-per-
dollar / any price term in the score, FPM as a sort mode on other lanes,
wishlist games in the FPM pool, settings + dismissals (inc 8), any change to
existing lane qualification / sourcing pools / shared enrichment shapes, any
deploy (local-only stands).

## Testing

- **Fixtures must mirror the REAL probe-captured response shape** (nested
  as-is — the inc-6 historical-low lesson; a flat "convenient" mock is a bug).
- Unit: parse fn (real-shape fixture; drifted/missing fields → throw → lane
  hides, app alive), matching (steam-id hit / fuzzy hit / below-threshold
  miss), FPM math + min-length floor + missing-length exclusion + unmatched
  count, sort + at-low tiebreak, filter matrix (similarity exempt, others
  apply), cache round-trips incl. negative cache + `?refresh=1`.
- Regression: full suites green (301 baseline).
- **Live proof:** (a) spot-check 5 well-known lane entries' main-story hours
  against howlongtobeat.com by hand — match within rounding; (b) a known-short
  high-quality game on sale ranks above a similar-quality long game;
  (c) unmatched count is plausible against the pool (indies missing, AAA
  matched); (d) kill the HLTB handshake live → lane hides with notice, every
  other tab keeps serving.
- Manual (James, localhost): the lane reads as "quick wins" — short great
  games on top; filters steer it; footer count sane.
