# Increment 9 — Tag backfill (Phase 4, slice 1: the global layer completes)

**Scoped:** 2026-07-25 (PO session; PRD Rev 2 approved same day)
**Base:** `main` @ `e8c7fcc` (inc 8.5)
**Branch suggestion:** `tags`
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md` — Rev 2, Phase 4, increment 9

---

## 1. Goal

Persist per-appid SteamSpy tags into the D1 catalog for every floor-passing row.
Tags are the entire similarity input and the one static per-game fact the
catalog is missing. After this increment the global layer is complete enough
for inc 11 (Recs sourcing swap) to be a pure sourcing change.

**This increment changes NO user-visible behaviour** beyond sync/funnel
counters. Recs keeps its current (deal-feed) sourcing until inc 11. FPM,
Best-of, Deals, Wishlist, scoring, `FPM_FORMULA` (locked `sqrt`), and all
floors are untouched.

## 2. Schema (additive migration, same pattern as 7.8 / 8.5 columns)

Add to `fpm_catalog`:

- `tags` TEXT — JSON object exactly as SteamSpy returns it (`{"Roguelike": 4123, ...}`,
  tag name → vote count). Store the live shape; do not invent a normalised form
  in this increment (inc 11 consumes it via the existing scoring code, which
  already understands SteamSpy tag dicts).
- `tags_checked_at` INTEGER — epoch ms, set whenever a fetch attempt concludes
  (success, empty, or give-up), the same freshness-stamp discipline as
  `hltb_checked_at` / `type_checked_at` / `price_checked_at`.

## 3. Fill mechanics

1. **Source:** SteamSpy `appdetails?appid=N` — the exact endpoint `spyQueue`
   already calls. ~1 req/sec, existing throttle lesson applies (throttle =
   HTTP 200 with a plain-text body — detect by body shape, cooldown >60s).
2. **Resumable D1 batch job** in `src/catalog.js`, mirroring the established
   discipline: `selectTagsBatch` / `recordTagsResult` pair, wired into
   `runFpmSyncPipeline` / `startFpmSync` / auto-continue so one trigger walks
   to pending=0 unattended (inc-8 behaviour). Write-through per row; survives
   `wrangler dev` restarts by construction.
3. **KV seed first (free wins):** the per-request tag cache (30d KV) already
   holds tags for every game that has ever entered a candidate pool. Before
   fetching, read KV; on hit, write through to D1 and count it as a KV-seeded
   fill (no SteamSpy request). Count these separately in the funnel.
4. **Priority order:** `source_owned=1` first (owned games' tags are the taste
   -profile input for inc 11), then on-sale rows, then remainder by `owners`
   descending.
5. **Outcome recording:** success (non-empty tags) / empty (SteamSpy returns
   no tags — record `{}`, stamp checked, count it) / give-up after the
   standard per-item skip pattern (inc-7.8 discipline: one stuck item must
   never zero a batch). All three visible as counters on the sync status
   endpoint (`tagged / kv_seeded / empty / pending / skipped`).
6. **No re-fetch policy:** rows with `tags_checked_at` set are done for this
   increment. Tags are near-static; any refresh TTL is a future decision, not
   built now.
7. **Sizing expectation:** ≤18,306 SteamSpy requests at ~1 req/sec ≈ ~5h
   worst-case, minus KV seeds. Auto-continue owns it; record actual wall-clock
   + funnel in the result file.

## 4. Mandatory first step — live probes (before writing code)

1. SteamSpy `appdetails` current response: confirm `tags` is a name→votes
   dict on a known game (e.g. Celeste 504230) and confirm the empty-tags shape
   on some obscure appid (SteamSpy returns `"tags": []` as an ARRAY when
   empty — historical quirk; confirm live and handle both shapes).
2. Confirm the bulk `all` feed still carries no tags field (spec assumption).
3. Confirm throttle behaviour unchanged (200 + plain-text body).
4. Fixtures must mirror the live shapes captured in the probe (inc-6 lesson:
   green tests with wrong-shaped mocks are worthless).

## 5. Out of scope (hard)

- Recs sourcing/scoring changes (inc 11). Similarity is NOT computed here.
- Table rename `fpm_catalog` → `game_catalog` (deferred to inc 11+, when the
  catalog stops being FPM-branded; a rename in a data slice is risk for zero
  behaviour).
- Full price coverage (inc 10).
- Any UI beyond sync-status counters.
- `FPM_FORMULA`, floors, Best-of/Deals/Wishlist paths.

## 6. Gates

| Gate | Pass condition |
|---|---|
| (a) Migration + durability | Additive migration; kill + restart `wrangler dev` mid-fill → resume with zero loss, zero re-fetch of checked rows (the 7.7 acceptance-critical property, re-proven for tags) |
| (b) Unattended fill | One trigger + auto-continue walks tags to pending=0 with no manual re-triggering; wall-clock recorded |
| (c) Honest funnel | `tagged / kv_seeded / empty / pending / skipped` counters on the sync status endpoint; numbers add up to the catalog row count; no silent blanks |
| (d) Rate discipline | ~1 req/sec ceiling respected; throttle detection works live; KV seeds make zero SteamSpy requests |
| (e) Zero-diff regression | `/api/fpm`, Recs, Best-of, Deals, Wishlist responses byte-identical vs base (nothing consumes tags yet) |
| (f) Tests | Full suite green; new tests mirror live probe shapes; at least one test proves the empty-tags array/dict duality and one proves resume-without-refetch |

## 7. ⛩ REVIEW

- **Gate TLDR:** tags stored for the overwhelming majority of floor-passing
  rows, the remainder in a visible funnel — and nothing else changed.
- **Output (produce as part of the increment, in the result file):**
  1. The final funnel: tagged / kv_seeded / empty / skipped counts + total
     wall-clock, from the live sync status endpoint.
  2. A 10-row spot-check table — games James knows (suggested: Celeste, Hades,
     Slay the Spire, Balatro, Stardew Valley, Terraria, The Witcher 3, Vampire
     Survivors, A Castle Full of Cats, Euro Truck Simulator 2) — with each
     row's top-8 tags by votes, straight from D1. James eyeballs that the tags
     look like the games.
