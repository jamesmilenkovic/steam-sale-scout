# Increment 5 — Filters, Steam Deck signals + "Best of Steam" lane

**Project:** Steam Sale Scout · **Phase 2, slice 1** (⛩ Phase 1 gate PASSED 2026-07-07 after inc 4)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-4 result · **Status:** Build-ready (scoped 2026-07-07)

## Why (James's post-gate asks, 2026-07-07)

Recs are now good; James wants to steer them: genre toggles, Steam Deck
suitability (he plays on Deck), and a taste-agnostic "unanimously excellent
games on deep discount" lane. Fun-per-minute merge is **increment 7**, not here.

## Build

### 1. Filter bar (persisted, applies across tabs as marked)

All persisted to localStorage, combinable, with a "reset filters" control:

1. **Min discount %** (existing control, moves into the bar) — Deals + Recs + Best-of.
2. **Max price (AUD)** — all tabs.
3. **Min similarity %** — Recs only.
4. **Genre/tag toggles** — include + exclude chip sets, built from the tags
   present in the current candidate pool (top ~30 by frequency, searchable for
   the tail). Filtering acts on raw cached tags (IDF is a scoring concern, not
   a filtering one). All tabs.
5. **Quality floors user-facing** — min reviews / min quality / min owners
   move from config-only to advanced controls (defaults unchanged). Recs +
   Best-of.
6. **☑ Steam Deck: Verified only / Verified+Playable** (see §2) — all tabs.
7. **☑ Battery friendly** (see §3) — all tabs.

### 2. Steam Deck compatibility (new data, the only new fetch)

- **Source:** `IStoreBrowseService/GetItems` (api.steampowered.com, anonymous,
  batch `ids` via `input_json`) with platform info → deck compat category.
  **Verify field name/shape live at build time** — research flags: (a) exact
  field (`steam_deck_compat_category` per protobuf dumps) unconfirmed; (b) the
  Verified program split per-device in 2026 (Deck / Machine / Frame) so **store
  per-device**: `{deck: 0-3}` minimum, keep others if present.
- Fallback if GetItems doesn't carry it: per-app
  `store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=`
  at ≤1 req/sec through the existing queue pattern.
- Cache: KV alongside the SteamSpy trio (own key prefix, 30d TTL). Batch-fetch
  for candidates only (not the owned library).
- UI: badge per row — ✅ Verified / 🟡 Playable / (nothing for
  unsupported/unknown), on Deals + Recs + Best-of.

### 3. Battery-friendly heuristic (no reliable data source exists — be honest)

- **There is no official battery-per-game data.** Community DeckSettings API is
  the only structured source (coverage unknown) — **backlog, not this
  increment**. Ship a **tag heuristic**:
  `batteryFriendly(tags)` = true when the game's top tags hit the LOW_POWER
  list (config: `2D, Pixel Graphics, Turn-Based Strategy, Turn-Based Tactics,
  Card Game, Card Battler, Visual Novel, Puzzle, Point & Click, Roguelike
  Deckbuilder, Board Game`) and miss the HIGH_POWER list (config: `Open World,
  Realistic, Photorealistic, Racing, VR, MMORPG`).
- UI: 🔋 badge + the filter toggle; tooltip states plainly it's a tag-based
  estimate, not measured data.

### 4. "Best of Steam" lane (fourth tab)

Taste-agnostic: **unanimously excellent games at deep discount**, even outside
James's wheelhouse.

- Candidates from the same deals pool (owned still excluded), qualifying on
  config thresholds: `HOF_MIN_REVIEWS = 10,000` total + `HOF_MIN_RATIO = 0.95`
  positive (≈ Overwhelmingly Positive tier).
- Sort: discount depth × Wilson quality (config-weighted); historical-low
  badge; show similarity % as a secondary column ("it's also 74% you") without
  ranking on it.
- No new data — reviews/owners are already in the v2 trio.

## Out of scope

Wishlist lane (inc 6), fun-per-minute / HLTB (inc 7), DeckSettings battery API
(backlog), dismissals + recency-window-in-bar (inc 8), any deploy.

## Testing

- Unit: each filter predicate + combinations, persistence round-trip, deck
  category parsing incl. per-device shape + missing-field fallback, battery
  heuristic (both lists, edge: no tags), HoF qualification + ordering, badge
  render logic.
- Regression: inc 1–4 suites green.
- Manual acceptance (James): filter bar steers Recs sensibly; Deck badges match
  a spot-check against the store page (3–4 known games, e.g. one Verified, one
  Playable, one Unsupported); Best-of tab surfaces recognisable all-timers at
  real discounts; battery toggle behaves plausibly.
