# Increment 10 – LLM catalog enrichment (the `experience_score` fill)

**Scoped:** 2026-08-29
**Base:** `tags` @ `bb669c9` (inc 9), or `main` once `tags` is merged
**Branch suggestion:** `experience`
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md` – **Rev 3, Phase 5**,
increment 10. **Read the "Slice 0 outcome" section first: it is binding on this spec.**
**Reference implementation:** `projects/personal-projects/steam-sale-scout/slice-0-reference/`

---

## 1. Goal

Persist the headline metric for every floor-passing catalog row: an `experience_score`
judged once by an LLM, plus three inspectable components and a reason line, stored in D1.

After this increment the global layer holds everything increment 11's ranking needs.

**This increment changes NO user-visible behaviour** beyond sync/funnel counters. No
scoring change, no ranking change, no formula change, no floors. Rev 3 lifted the `sqrt`
lock, but **the unlock happens at increment 11, not here.** Zero-diff on every lane.

## 2. Schema (additive migration – same ALTER pattern as 7.8 / 8.5 / 9)

Add to `fpm_catalog`:

| Column | Type | Meaning |
|---|---|---|
| `experience_score` | INTEGER | 0–100. The headline number. |
| `has_ending` | INTEGER | 0/1. Does the game conclude? |
| `hours_to_value` | REAL | Honest hours to get the game's worth. **NULL if endless.** Not copied from HLTB – judged. |
| `hours_to_good` | REAL | Hours before it becomes fun for a newcomer. James's MOBA objection, made measurable. |
| `experience_reason` | TEXT | <= 15 words. Concrete. |
| `experience_confidence` | TEXT | `low` / `medium` / `high`. |
| `experience_checked_at` | INTEGER | Epoch ms, stamped on every concluded attempt. |
| `experience_model` | TEXT | Which model produced the row. **Required:** a model change invalidates the score, and without this column there is no way to tell mixed vintages apart. |

## 3. The rubric is a FIXTURE, not prose to improve

Copy the rubric and the calibration anchors **verbatim** from
`slice-0-reference/score-v2.mjs`.

Slice 0 ran two passes over the same 300 games. Pass 1 ("session fit") **failed** James's
eye test: it ranked *Rocket League* above *Portal*. Pass 2 ("experience value") **passed**.
The only difference between them is the prompt text. Treat that text as a test fixture.
Any reword requires re-running the §6.1 regression before it can ship.

## 4. Fill mechanics

1. **Batch 25 rows per request.** Proven at that size across 24 batches in slice 0.
2. **Input per row:** name, `app_type`, review counts, `wilson`, `main_hours` **labelled as
   possibly meaningless**, and the **stored tags from increment 9** (slice 0 fetched these
   live; they now come from D1 for free).
3. **Resumable D1 batch job** in `src/catalog.js`, mirroring increment 9 exactly:
   `selectExperienceBatch` / `recordExperienceResult`, wired into `runFpmSyncPipeline` /
   `startFpmSync` / auto-continue so one trigger walks to pending=0 unattended.
   Write-through per row; survives `wrangler dev` restarts by construction.
4. **GUARD – mandatory.** Drop any returned appid that was not in the requested batch, and
   count it. The model invented an appid on **both** slice 0 runs. A ghost row silently
   written into the catalog is the worst possible outcome of this increment.
5. **Outcome recording:** `scored / ghosts_dropped / failed_batches / pending`, all visible
   on the sync status endpoint. Numbers must add up to the catalog row count.
6. **Per-batch fail-soft.** One bad batch must never zero the run (inc-7.8 and inc-9
   discipline; inc 9 proved a single stuck row can stall a fill forever).
7. **No re-score policy:** rows with `experience_checked_at` set are done, **unless**
   `experience_model` differs from the current run's model. That is the only re-score
   trigger built here.

## 5. Route decision – probe before committing (spec §6.3)

Two ways to run 18,221 rows. **Do not pick on spec. Measure first.**

- **Route A – `claude -p` CLI on James's existing plan. $0.** Proven end to end in slice 0.
  Measured there at ~50s per 25-game batch, so ~729 batches ≈ **10 hours serial**.
  Auto-continue already owns multi-hour fills (inc 9 ran ~5h). **Honest risk: sustained
  plan usage over 10 hours may hit limits.** That is what the probe measures.
- **Route B – paid Batch API.** ~$9–18 one-time for the full catalog, per the PRD costing.
  Needs an `ANTHROPIC_API_KEY`; there is none on the machine as of 2026-08-29.

**Recommend: probe Route A on 500 rows, measure wall-clock and whether limits bite, then
decide.** Record the verdict and the reasoning in the result file. Route B is the fallback,
not a failure.

## 6. Mandatory first step – live probes (before writing the fill)

1. **The prompt-drift regression.** Re-score the 300 games in
   `slice-0-reference/sample-300-games.json` through the new code path and diff against
   `slice-0-reference/scored-v2-300-games.json`. Scores must land in a sane band. Report
   every outlier. **This is the single most important probe in the increment** – it is the
   only thing standing between a reworded prompt and a silently worse catalog.
2. **Tags-from-D1 parity.** Slice 0 fetched tags live. Confirm the stored inc-9 tags
   produce equal or better results, and note any row where the stored tags are empty.
3. **Route A sizing.** 500 rows. Measure per-batch wall-clock and plan-limit behaviour.

## 7. Out of scope (hard)

- Ranking, scoring or sorting changes. **Increment 11.**
- `FPM_FORMULA`, floors, Best-of / Deals / Wishlist / Recs paths.
- Similarity computation and sale weighting. Increment 11.
- Any UI beyond sync-status counters. Increment 12.
- Table rename `fpm_catalog` -> `game_catalog`.
- Price coverage for the ~16,000 priceless rows. Increment 13.

## 8. Gates

| Gate | Pass condition |
|---|---|
| (a) Migration + durability | Additive migration; kill + restart `wrangler dev` mid-fill resumes with zero loss and zero re-scoring of checked rows |
| (b) Unattended fill | One trigger + auto-continue walks to pending=0 with no manual re-triggering; wall-clock recorded |
| (c) Honest funnel | `scored / ghosts_dropped / failed_batches / pending` on the sync status endpoint; adds up to the catalog row count; no silent blanks |
| (d) **Prompt-drift regression** | The 300 slice-0 games re-score within tolerance of the saved fixture; every outlier listed and explained |
| (e) Ghost guard proven | At least one test proves an out-of-batch appid is dropped and counted, never stored |
| (f) Zero-diff regression | `/api/fpm`, Recs, Best-of, Deals, Wishlist responses byte-identical vs base (nothing consumes the new columns yet) |
| (g) Cost recorded | Route used, wall-clock, and either dollars spent or observed plan impact |
| (h) Tests | Full suite green; new tests cover the ghost guard, resume-without-rescore, and the endless/`hours_to_value` NULL case |

## 9. ⛩ REVIEW

- **Gate TLDR:** every floor-passing row carries an experience score and a reason, or an
  explicit checked-no-score state with a visible count – and nothing else changed.
- **Output (produce as part of the increment, in the result file):**
  1. The final funnel: scored / ghosts_dropped / failed / pending, plus total wall-clock
     and the route verdict from §5.
  2. **The whole-catalog top 50 by `experience_score`**, with reason lines, `has_ending`
     and `hours_to_value`. This is the first time James sees the actual product across all
     18,221 games rather than a 300-game sample. It is the load-bearing artifact.
  3. The 10 biggest disagreements against the slice-0 fixture, with the reason line from
     each run side by side, so drift is visible rather than asserted.
  4. A count of rows scored `low` confidence, and the 10 worst of them by review count –
     popular games the model did not recognise are the ones that will embarrass the
     front page.

## 10. Constraints

1. Local-only (`wrangler dev`); no deploy.
2. **Zero-diff on every existing lane.** Floors and `FPM_FORMULA` untouched here.
3. D1 is the durable store; KV stays for cheap short-TTL data.
4. Append **"use context7"** on any task touching a third-party library API (the Anthropic
   SDK and wrangler/D1 included).
5. Fail-soft everywhere. One bad row or batch never zeroes the run.
6. **En dashes, never em dashes**, in every artifact.
7. Stop before commit. An explicit in-session "commit"/"push" from James is itself
   sufficient authorization; never initiate one.
