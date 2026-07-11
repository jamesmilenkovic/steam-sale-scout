# Increment 6 — Wishlist lane

**Project:** Steam Sale Scout · **Phase 2, slice 2**
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-5.5 (`0b73754`) · **Status:** Build-ready (scoped 2026-07-08)

## Why

Explicit intent is the strongest signal we have — stronger than any inferred
similarity. Wishlist games on sale or at historical lows get their own
top-billed section (PRD core goal #5). This is the last "new lane" before FPM.

## Build

### 1. Wishlist sync (the risky bit — isolate it)

- **Source:** `IWishlistService/GetWishlist` (api.steampowered.com), James's
  SteamID64 from existing config. Returns appid / priority / date_added.
  **Zero official Valve documentation — could change without notice** (it
  replaced the wishlistdata endpoint Valve killed Nov 2024, and there is no
  fallback if this one dies too).
- **FIRST STEP — live curl before building:** confirm endpoint path/version,
  auth (documented as no-key-required, but verify), and response shape.
  Record findings in the save-down. Requires James's wishlist privacy visible
  — if the live call comes back empty/denied, STOP and ask James to check
  Steam privacy settings before proceeding.
- **Isolation:** own module (`src/wishlist.js`) with a single parse function —
  when Valve changes it, the repair surface is one file. **Fail-soft:** any
  fetch/parse failure hides the lane with a small notice ("wishlist
  unavailable"); it must never break the rest of the app.
- Cache: own key, 24h TTL (library cadence), `?refresh=1` bypass — same
  pattern as `/api/library`.

### 2. Price/deal resolution for wishlist appids

Wishlist games are mostly NOT in the deals pools (any cut, not just deep), so
resolve them directly, batched:

- appid → ITAD id (reverse of the inc-2 lookup — verify exact endpoint live,
  expected `/lookup/id/shop/61/v1` POST batch), then batched current
  prices/cuts (`/games/prices/v2`-family, `country=AU`, Steam only) + the
  existing historical-low lookup.
- A wishlist is tens-to-low-hundreds of games → a handful of batched calls,
  trivially inside ITAD limits. Cache resolved prices 6h (deals cadence).

### 3. Lane rules

- **Qualify:** current Steam cut ≥ `WISHLIST_MIN_CUT = 10` (config — low on
  purpose; explicit intent beats discount depth) **OR** at/near historical low
  (existing near-low logic), even on a shallow cut.
- **Sort:** at-historical-low first, then cut depth; Steam wishlist `priority`
  as tiebreak if present.
- **Why-line:** "On your wishlist since <date_added>" (+ low/near-low badge).
  No similarity scoring needed — intent is the reason.
- Enrichment reuse: tags via the existing spyQueue lazy-fill, Deck + battery
  badges — same pipeline as the other lanes. No owned-exclusion needed (Steam
  auto-removes purchased games from wishlists) — don't add one.

### 4. UI

- **Top-billed section above the Recs list** (PRD placement), with an item
  count in its header; collapsible; empty state: "Nothing on your wishlist is
  on sale today."
- **Bar filters apply** (min discount, max price, tag include/exclude, Deck,
  battery) **except min similarity — recs-only, per PRD.** Persisted/reset
  behaviour identical to inc 5.
- Rows link out to the Steam store page as everywhere else.

## Out of scope

FPM/HLTB (inc 7), settings + dismissals (inc 8), wishlist priority feeding the
taste profile (note as a possible inc-8 tweak), any qualification/threshold
changes to other lanes, any deploy (local-only stands).

## Testing

- Unit: wishlist parse (incl. missing/renamed-field fail-soft → lane hidden,
  app alive), lane qualification (cut-only / low-only / both / neither), sort
  order incl. priority tiebreak, filter matrix (similarity exempt, others
  apply), cache round-trips.
- Regression: full suites green (270 baseline).
- **Live proof:** cross-check the rendered lane against James's actual Steam
  wishlist — every wishlist game on a ≥10% Steam sale or at historical low
  today appears; spot-check 3–5 known items' prices/cuts against the store.
- Manual (James, localhost): lane shows his real wishlist bargains top-billed
  above the recs; filters steer it; fail-soft verified by killing the key/net.
