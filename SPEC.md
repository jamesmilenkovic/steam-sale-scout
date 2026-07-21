# Increment 7.8 — FPM catalog hygiene: app-type classification + sync resilience

**Project:** Steam Sale Scout · **Phase 2, slice 3.8** (the contamination finding, James 2026-07-18)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-7.7 (`b3e6c4e`) · **Status:** Build-ready (scoped 2026-07-18)

## Why

James, watching the 7.7 catalog fill live: free promotional demos/prologues
and DLC rank in the FPM lane as if they were real games, skewing the
leaderboard ("we are including DLCs and free games… they are skewing the
data"). Confirmed real (7.7 result §7): `Stoneshard: Prologue`,
`The Riftbreaker: Prologue`, `Contraband Police: Prologue` and more — short
(1–4h), decently reviewed by small enthusiast audiences, indistinguishable
from real short games by anything the catalog tracks (reviews / Wilson /
owners). Exactly the shape a fun-per-hour formula over-rewards.

No in-pipeline source classifies app type (§7's live investigation):
SteamSpy bulk has no type field; `GetItems` returns `type: 0` for a
confirmed demo and ELDEN RING alike, and its `unlisted` flag is
inconsistent; title heuristics false-positive on real games
(`Half-Life: Opposing Force`, `The Binding of Isaac: Rebirth`). The one
reliable classifier is storefront `appdetails`
(`type: "game"|"dlc"|"demo"|"advertising"|…`, PRD data source #5) —
per-appid only, ~200 req/5min → a ~7.5h one-time backfill for ~18.3k rows.
Same problem shape as HLTB matching: slow, per-item, rate-limited, cached
forever, never redone. 7.7 just built the pattern (D1-persisted resumable
batches); 7.8 applies it a second time.

Also in scope: the sync-resilience QA advisories from the 7.7 result —
sequential `resolveHltbBatch` means one stuck lookup (up to 300s give-up,
never recorded) can silently zero an entire 3,000-row sync run, and the
queue's cache-hit/give-up counters aren't surfaced anywhere. With the fill
only ~26% done, the remaining runs deserve both fixes.

**Scoping decisions (PO, 2026-07-18):**

1. **Exclude-until-classified.** Unclassified rows do NOT appear in the
   lane. Include-by-default is the exact bug being fixed — a deliberate
   exception to the app's fail-soft "unknown ≠ excluded" convention, which
   stands everywhere else (Deck/battery/tags).
2. **Classify matched rows first.** Priority = already-HLTB-matched rows
   (the only displayable ones — restores the visible leaderboard in ~2h at
   ~200 req/5min for the current ~4,700), then rows in the existing HLTB
   queue priority order (owned + on-sale, then owners desc), so
   classification stays ahead of matching from then on.
3. **Non-games never reach HLTB.** `type != "game"` rows are excluded from
   the lane AND from the HLTB queue — demos/DLC currently burn HLTB budget
   for nothing. New HLTB enqueues gate on classified `type = "game"`; a
   queued row that classifies non-game leaves the queue.
4. **Formula lock moves here (4th carry, deliberate).** An eye test against
   a contaminated leaderboard would lock against skewed data. 7.8
   acceptance = the first attempt with a reference set that is both
   complete and clean.

## Build

### 1. Probe first (house rule)

`appdetails` live shape before writing the adapter: confirm the `type`
value set; whether `filters=` can slim the payload while keeping `type`;
whether `cc=au` changes anything relevant here; per-appid-only (assumed);
and the real rate-limit behavior (~200 req/5min per the PRD's existing
note — verify how throttling actually presents). 7.7's SteamSpy lesson
applies: throttles may arrive as HTTP 200 with a non-JSON body — detect by
body shape, not status code. Raw samples to `scratchpad/`.

### 2. D1 schema + classification job

- `fpm_catalog` gains `app_type` (TEXT, NULL until classified) +
  `type_checked_at`.
- Classification runs as a step of `/api/fpm/sync` (or a sibling step —
  Coder's call): pick unclassified rows in the priority order above,
  classify via `appdetails`, batched per run (`FPM_TYPE_BATCH`, config;
  suggest ~500/run ≈ 12–13 min at pace — set from the probe's real
  numbers), gentle pacing, resumable by construction: classified rows never
  re-fetch (a type never changes — no TTL refetch, ever). Failed/missing
  responses → retry after `FPM_TYPE_TTL_DAYS = 30` (same convention as
  unmatched HLTB rows).
- `GET /api/fpm/sync/status` extends with classified / non-game counts; the
  FPM tab status line becomes honest about both fills (e.g. "ranked X of Y
  qualifying games · Z awaiting classification" — exact wording Coder's
  call; both numbers visible whenever either fill is incomplete).

### 3. Lane + queue gating

- `handleFpm` serves only `app_type = 'game'` rows (matched +
  floor-passing, as now). Already-matched non-game rows stay in D1 (data is
  data) but never render.
- HLTB enqueue gates on `app_type = 'game'`: unclassified and non-game rows
  are skipped, freeing HLTB budget for real games.

### 4. Sync resilience (7.7 QA advisories 2 + 3)

- **Per-item skip-ahead in `resolveHltbBatch`:** one stuck lookup must not
  block the rest of its batch — per-item timeout, and the give-up is
  recorded (`hltb_checked_at` set, existing `match_method` convention) so
  it retries on the normal `FPM_HLTB_TTL_DAYS` cycle instead of silently
  re-blocking every future run.
- **Surface the queue counters:** `cacheHits` / `resolved` / `gaveUp` per
  batch — dev-log line and/or sync-status fields (Coder's call) — so a
  stalled vs healthy run is visible without spelunking scratchpad logs.

## Out of scope

Server-side pagination / slim sync-tick payload for `/api/fpm` (QA advisory
1 — loopback-cheap today; backlog, revisit only if latency bites once the
catalog is mostly matched); settings + dismissals (inc 8 — next after
this); formula/scoring math (the lock is a config default choice, not a
code change); the catalog as a source for any other lane; HLTB adapter
internals beyond the batch-loop skip; scheduled/cron sync; deploy
(local-only stands).

## Testing

- Unit: lane excludes non-game AND unclassified rows; already-matched
  non-game rows persist in D1 but never render; HLTB enqueue gating
  (unclassified/non-game skipped; a queued row that classifies non-game
  leaves the queue); classification batch bounds + priority order
  (matched-first, then HLTB queue order) + resumability (classified rows
  never re-fetch; failures retry after TTL); per-item HLTB skip (a stuck
  item times out, successors in the same batch still process, the give-up
  is recorded and TTL-retried); status-endpoint count fields.
- Regression: full suite green (418 baseline).
  Best-of/Recs/Wishlist/Library byte-identical (house method).
- **Live proof:** (a) the named contaminants (`Stoneshard: Prologue`,
  `The Riftbreaker: Prologue`, `Contraband Police: Prologue`) classify
  non-game and are gone from the lane; (b) false-positive guard:
  `Half-Life: Opposing Force` and `The Binding of Isaac: Rebirth` (plus any
  other colon-titled real game already matched) classify `game` and remain
  ranked; (c) classification funnel recorded: total rows → classified per
  run → non-game count → wall time per batch → observed throttle behavior;
  (d) restart mid-classification → resumes with zero re-classification
  (same D1 property 7.7 proved for HLTB); (e) zero HLTB enqueues for
  non-game/unclassified rows across a sync run; (f) a full sync run
  completes with the per-item skip in place — no zero-progress stall — and
  the new counters are visible; (g) deal lanes byte-identical.
- Manual (James, localhost): **the eye test on a clean AND complete
  leaderboard — lock `FPM_FORMULA`'s shipped default.** Pick + why go in
  the save-down. `sqrt` remains the interim default until then.
