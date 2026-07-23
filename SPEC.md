# Increment 8.5 — FPM price coverage + Deals cap headroom (hardening slice)

**Type:** Data-integrity / hardening slice. **No engine, ranking-formula, or floor changes.**
**Base:** `main` @ `401ccfa` (inc 8; Phase-2 "daily-drivable" gate passed)
**Scoped:** 2026-07-22 (PO, Cowork)
**Why now:** four of James's six recurring queries run on clipped or price-blind data today. Both fixes are *upstream* of inc 9's LLM re-rank — clean the candidate set before improving the ranker.

---

## Problem

Two data-integrity gaps, both sitting directly under James's real usage. Neither is polish; both make the tool give **incomplete answers** (the failure class that produced the app-wide historical-low bug and the DLC/demo contamination — both caught late).

### A. FPM price coverage — 2,918 unowned rows are price-blind
Since 7.7, FPM is catalog-wide with its own D1 database; price/discount on an FPM row is a **lookup annotation** from the top-300 ITAD batch-price pool (`loadFpmPool` demoted to price-annotation in 7.7). Any floor-passing FPM game **outside the top-300 pool has no price** → invisible to the on-sale filter and the min-price control. 2,918 unowned rows affected (7.8 finding).

### B. `DEALS_FETCH_CAP=1000` at 99% saturation
Measured live at **990/1000** during inc-8 review under real sale volume. ITAD `/deals/v2` default ordering is trending/recency, **not** cut depth — so heavily-discounted-but-untrending titles past the cap can be silently dropped. The inc-8 awareness comment ("never reached in practice") is measurably wrong.

---

## Usage evidence (James, 2026-07-22)

His six recurring queries, mapped:

1. Top FPM ranking — FPM only, no price. ✅ fine today.
2. "Will any FPM make me play something now" — FPM only. ✅ fine today.
3. "Any FPM on sale?" — needs price on FPM rows → **hit by A.**
4. "What's recommended to me (no discount)" — pure taste. ✅ fine today (this is inc 9's target).
5. "Heavily discounted + high FPM / similar" — **hit by A and B.**
6. "Outrageously discounted, relevant to me" — deepest cuts → **hit by B.**

Items 3, 5, 6 are getting incomplete answers now. That is why hardening precedes inc 9.

---

## Scope (committed — two items, nothing else)

### A. FPM price coverage
- Extend price annotation to **all floor-passing unowned FPM rows**, not just the top-300 pool.
- Source = the **same ITAD batch-price endpoint** the top-300 pool already uses. Batched, hard-cached (own cache key, ≥6h TTL). If a one-shot pass exceeds the ITAD rate budget, reuse the catalog-fill discipline (D1-backed, resumable, batch-per-run) rather than a blocking loop.
- **Probe-first** (use context7): confirm the batch-price endpoint's batch size / limits before writing.
- Respect ITAD **1,000 req / 5 min**. No 429 storm.
- Rows ITAD genuinely has no price for → explicit "no price" state **with a visible count**, never a silent blank (fail-soft, but honest — the count is the QA signal).
- Owned rows keep current behavior (Owned badge wins; price optional).

### B. Deals cap headroom + honesty
- Re-measure live saturation on a real sale day.
- **Confirm the deals-fetch sort order.** If it is *not* cut-sorted, source a deep-cut title that was sitting past the old cap and show it now appears (the load-bearing proof for query 6).
- Raise `DEALS_FETCH_CAP` to a **documented headroom value** (rationale in the comment), bounded by the ITAD rate budget. Correct the wrong "never reached in practice" comment.
- No sourcing-logic change beyond the cap value + comment. `BESTOF_FETCH_CAP` / any Recs cap: note saturation if observed, but **only change** if the same saturation is demonstrated live — don't touch on spec.

---

## Non-goals (explicitly deferred — do not build)

- LLM re-rank → **inc 9**
- Similarity sort on Recs → inc 9 territory (re-ranking relevance is that increment's whole point)
- Cron / scheduled sync → **blocked on the deploy decision**, pointless local-only
- `/api/fpm` pagination → localhost-latency-only, not biting
- Curated prologue exclusion → accepted cosmetic gap (7.8)
- Deploy question → separate Phase-3 decision, not an increment
- `FPM_FORMULA` (`sqrt`) — **LOCKED, do not touch**
- FPM qualification floors — **do not touch**

---

## Acceptance / live-proof QA (gates a–f)

- **(a)** Every on-sale **unowned** FPM row shows price + discount. Count of price-blind unowned FPM rows → **0**, or a residual with a logged per-row reason (ITAD truly has no price). "Any FPM on sale?" returns the complete set.
- **(b)** Regression demo: a "high FPM + heavily discounted" title that was hidden by the price gap now surfaces.
- **(c)** `DEALS_FETCH_CAP` — live saturation re-measured; deals-fetch sort order confirmed; if not cut-sorted, a deep-cut title past the old cap is proven to now source.
- **(d)** Rate budget respected — no ITAD 429 storm; price backfill cache-hard and (if batched) resumable across dev-server restarts.
- **(e)** Zero-diff regression: FPM ranking order unchanged where price was already present; Best-of / Recs / Deals rankings unchanged **except** newly-sourced deep-cut deals appearing.
- **(f)** Full unit suite green + new tests: price-coverage completeness, cap-headroom, cache-hardness, fail-soft "no price" state.

---

## Constraints

Local-only (`wrangler dev`, no deploy). Probe-first for the ITAD batch-price shape. `use context7` on any ITAD / D1 / wrangler API touch. Fail-soft everywhere. Library + Wishlist exemptions and dismissals behavior intact. `sqrt` formula and FPM floors are **locked** — any change to either is out of scope and a review-blocker.
