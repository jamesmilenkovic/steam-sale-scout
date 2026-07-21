# Increment 8 — Settings + dismissals (+ sync auto-continue)

**Project:** Steam Sale Scout · **Phase 2, final slice — the "daily-drivable" gate**
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md`
**Base:** `main` @ inc-7.8 (`7f993ee`) · **Status:** Build-ready (scoped 2026-07-21)

## Why

Slipped twice (for 7.7 and 7.8) and deliberately so: this increment persists
the lane's *final* shape, which didn't exist until the catalog was complete,
clean, and the formula locked (`sqrt`, 2026-07-21). Today every session
starts from scratch — filters reset on reload, there's no way to say "never
show me this game again," and the multi-run catalog fill needs manual
babysitting (friction felt twice in 7.8: QA mistook idle-because-nobody-
retriggered for a stall, and the operator hand-drove ~10 batches). Phase 2's
end gate is "daily-drivable"; this is the slice that makes it daily.

**Scoping decisions (PO, 2026-07-21):**

1. **D1 is the single persistence story** — `settings` (KV table) +
   `dismissals` table, both in the existing `FPM_DB` database. No
   localStorage split-brain; the app's state lives where its catalog lives.
   Thin endpoints (`GET/PUT /api/settings`, `POST/DELETE` dismissals) —
   single-user, local-only, no auth.
2. **Dismissals are app-wide across sale lanes** — Deals, Recs, Best-of,
   FPM — applied **server-side** (excluded before caps/filters, so a
   dismissal actually frees a slot). **Library and Wishlist exempt**: one
   is a factual record, the other is James's own curated list.
3. **Un-dismiss exists from day one** — a "Dismissed (N)" view with per-row
   restore. No permanent deletes; data is data.
4. **Persisted settings** = per-tab filter-bar state (every control, incl.
   FPM owned tri-state / on-sale-only / formula-picker choice), auto-saved
   on change, restored on load — plus the **recency window** (the
   PRD-promised user setting, default 12 months) surfaced in a small
   settings panel and actually re-scoring Recs on change. A restored
   formula-picker choice is a lens, not the default — `FPM_FORMULA` stays
   `sqrt` in code.
5. **Ride-along A — sync auto-continue:** one trigger walks classification
   + HLTB batches until pending = 0 (bounded loop, stoppable, existing
   pacing/backoff/give-up machinery untouched). NOT cron — still manually
   started, still local-only; it just doesn't need re-poking every ~9
   minutes.
6. **Ride-along B — Recs min-discount:** James hit "filter appears not to
   work" live during the 7.8 eye test. Investigate root cause FIRST; the
   likely candidate is 5.5's fixed sourcing floor 60 (the bar can only
   tighten above it — sub-60 values are no-ops *by design*). If that's it,
   the fix is UI honesty (annotate/disable sub-floor values), not engine
   changes. If it's a real regression, fix it. Root cause goes in the
   save-down either way.

## Build

### 1. D1 schema + endpoints

- `settings` (`key` TEXT PK, `value` TEXT/JSON, `updated_at`) and
  `dismissals` (`appid` INTEGER PK, `name` TEXT snapshot, `dismissed_at`)
  via the existing `CREATE TABLE IF NOT EXISTS` init path.
- `GET /api/settings` / `PUT /api/settings` (whole-blob vs per-key —
  Coder's call); `POST /api/dismissals` / `DELETE /api/dismissals/:appid` /
  `GET /api/dismissals`. Fail-soft: settings endpoints erroring must never
  break lane rendering (defaults apply, 7.5 discipline — never a 500 from a
  bad value).

### 2. Dismissals in the lanes

- Server-side exclusion in the Deals/Recs/Best-of/FPM handlers — join once,
  before caps, so dismissed rows free slots. Library/Wishlist untouched.
- Row UI: an unobtrusive ✕ ("Not interested") on every sale-lane row;
  optimistic client removal + POST.
- "Dismissed (N)" management view (collapsible list or tab — Coder's call)
  with per-row restore.

### 3. Settings persistence

- Per-tab filter-bar state auto-saved (debounced) + restored on load.
- Settings panel: recency window (months, default 12) wired into the
  existing recency decay. Changing it must actually take effect — probe
  what the profile/scoring cache keys on and invalidate accordingly; a
  window change that silently serves stale scores is a fail.

### 4. Sync auto-continue (ride-along A)

- `POST /api/fpm/sync?continue=1` (or equivalent): loop batches until
  classification AND HLTB pending both reach 0, honoring all existing
  pacing/backoff; hard safety bound on loop count; a stop control
  (endpoint flag or running-state toggle). Frontend: "Sync to completion"
  button + stop. Status endpoint already shows progress — no new polling
  semantics (the 7.6 lesson stands: polls stop at idle).

### 5. Recs min-discount (ride-along B)

- Investigate → root cause in the save-down → fix per finding (UI honesty
  vs real bug). No engine/sourcing changes without flagging at the diff
  gate.

## Out of scope

FPM price coverage beyond the top-300 price pool (2,918 unowned rows show
no price — James's call pending, likely a dedicated ITAD batch-price
slice); similarity sort on Recs; cron/scheduled sync; curated exclusion for
`game`-typed prologues (accepted 7.8 gap); the `/api/fpm` pagination
advisory; formula/scoring math (locked); deploy (local-only stands).

## Testing

- Unit: settings round-trip + fail-soft defaults; dismissal exclusion per
  lane incl. Library/Wishlist exemption AND slot-freeing (a dismissed row
  doesn't count toward caps); restore path; per-tab filter save/restore;
  recency-window change provably re-scores (falsifiable: same fixture, two
  windows, different decay); auto-continue loop semantics (multi-batch
  fixture runs to zero, stop flag halts mid-loop, safety bound trips);
  min-discount regression test matching the found root cause.
- Regression: full suite green (440 baseline). **With zero dismissals and
  default settings, every lane response byte-identical to 7.8** — the house
  isolation method; persistence must be invisible until used.
- **Live proof:** (a) dismiss a game in FPM → gone from Deals/Recs/Best-of
  in the same session, still gone after dev-server AND browser restart;
  (b) un-dismiss restores it everywhere; (c) per-tab filter state survives
  reload + restart; (d) recency-window change visibly re-scores Recs
  (record one example movement); (e) "Sync to completion" sustains
  unattended progress across ≥3 consecutive batches including at least one
  throttle-pause self-recovery — running the remaining ~13.6k to zero can
  finish outside the QA session, wall-clock recorded when it does;
  (f) Recs min-discount root cause demonstrated live + fix verified;
  (g) with nothing dismissed and no settings changed, lanes byte-identical
  to 7.8.
- Manual (James, localhost): daily-drive it — dismiss junk, set filters
  once, come back tomorrow and it's all still there. **Accepting this
  increment = passing the end-of-Phase-2 "daily-drivable" gate**; Phase 3
  (LLM re-rank, digest/schedule, the deploy question) unlocks behind it.
