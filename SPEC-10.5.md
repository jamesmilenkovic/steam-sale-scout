# Increment 10.5 – `game_score` (pure quality) + a derived experience-FPM

**Scoped:** 2026-08-31 · **Status:** PROPOSED – not approved · **Branch:** `experience` (in place)
**Raised by:** James at the increment 10 diff gate, on `12-eye-test-top50-300-sample.md`
**Decision needed before:** the stopped fill is resumed. It is stopped at ~2,050 of 18,221.
**Review copy:** `~/code/review/steam-sale-scout/inc-10/13-proposed-metric-change.md`

---

## 0. TLDR and the recommendation

James asked for a pure fun-per-minute number as a separate column, because a long game can
hold a high experience score while being obviously less dense than Portal.

**Recommendation: build it as increment 10.5, add ONE stored column (`game_score`) plus a
rubric-version column, derive FPM at rank time, and do NOT touch the `experience_score`
rubric text.** That gets James everything he asked for, keeps the passed gate (d) evidence
partly intact, and costs ~40 minutes of re-scoring instead of a second 6-hour run.

**Increment 10.5, not an amendment to 10.** Gate (d) has already been judged and passed on
specific evidence. Re-opening it inside inc 10 destroys the record of what was proven when.
10.5 is also this repo's established seam (7.5, 7.6, 7.7, 7.8, 8.5), and the fill being
stopped gives a clean one.

---

## 1. Problem / why

`experience_score` already blends quality against time cost – its rubric punishes no-ending
and slow-to-get-good and explicitly rewards short. What does **not** exist anywhere in the
schema is a pure "how good is this game, length ignored" number. `wilson` is not it: it is
crowd review sentiment, which is exactly the signal James flagged as inflated by a game
being free. Without a pure quality number there is nothing to divide by hours, so a real
fun-per-minute rank cannot be computed at all.

**User story.** As James scanning the top 50, I want to see quality, hours and density as
three separate numbers, so that I can tell "great and long" apart from "great and dense"
instead of arguing with a single blended score.

---

## 2. Where I disagree with the framing, plainly

**This change does not supersede the PRD's binding consequence 3, provided we leave the
`experience_score` rubric alone – and my recommendation does.**

Consequence 3, ruled by James 2026-08-28: *Disco Elysium 89, Red Dead 45, Baldur's Gate 3
40 – length alone is not the penalty; padding and time-to-value are.* That is a statement
about `experience_score`. Under this spec `experience_score`'s definition, its anchors and
its two "punish hard" clauses are byte-identical. Consequence 3 stays true of it. Disco
Elysium stays at 89 in that column, and sinks in the new FPM column, which is the point.

**What this change DOES contradict is the slice 0 pass-1 verdict.** "Fun per minute" was
tried, ranked Rocket League above Portal, and was killed. Reviving a pure FPM rank is the
thing that needs a dated PRD amendment, and §9 has the text.

**The version I recommend against:** retuning `experience_score` itself to punish length
harder. That genuinely does supersede consequence 3, it re-opens a passed gate, and it
destroys the only regression baseline the project has. If the fresh eye test shows
`experience_score` is wrong on its own terms, that is a later, separate decision with its
own evidence.

---

## 3. Schema delta

Two columns. Additive migration, same ALTER pattern as 7.8 / 8.5 / 9 / 10.

| Column | Type | Meaning | Stored or derived, and why |
|---|---|---|---|
| `game_score` | INTEGER | 0–100. How good is this game, **ignoring length and ignoring whether it ends**. Craft, design, writing, polish. | **Stored.** It is an LLM judgement costing ~6 hours of wall clock. Nothing in the schema approximates it. |
| `experience_rubric` | TEXT | Which rubric version produced the row (`v2` today, `v3` after this). | **Stored.** Required – see §5. Without it there is no legal way to trigger a re-score. |

**`experience_fpm` is DERIVED, not stored.** James asked for separate columns; a derived
value still renders as a separate column in every list and every future UI. What it does
not do is bake a tuning constant into 18,221 rows. The damping constant in §4 will be
adjusted across two or three eye tests – stored, each adjustment is a re-fill; derived, it
is a page refresh. Store the expensive judgement, derive the free arithmetic.

**Not changed:** `experience_score`, `has_ending`, `hours_to_value`, `hours_to_good`,
`experience_reason`, `experience_confidence`, `experience_checked_at`, `experience_model`.

---

## 4. How the derived FPM avoids the slice 0 pass-1 failure

Non-negotiable, and stated as arithmetic so it can be checked rather than believed.

```
experience_fpm = has_ending == 1
                   ? game_score / sqrt(max(hours_to_value, 2))
                   : NULL
```

Three guards, each killing a distinct failure mode:

1. **`has_ending` gate.** Endless games return NULL and never appear in the FPM rank. This
   is free: `normalizeExperienceFields` already forces `hours_to_value` to NULL when
   `has_ending` is 0. `has_ending IS NULL` (unknown) also yields NULL – unknown is not a
   licence to rank. **This alone kills the exact pass-1 failure**, which was an endless
   competitive ladder (Rocket League) outranking an authored short (Portal).
2. **A 2-hour denominator floor.** Without it a 15-minute game gets a 4x multiplier over a
   4-hour one for being trivially small. Two hours is roughly "one evening", below which
   shortness stops being a virtue and starts being "not enough game".
3. **`sqrt` damping, not a raw quotient.** A raw quotient is the pass-1 failure restated:
   Helltaker 1h would beat Portal 3h by 3x. Note this is not a new invention – the app
   already chose `sqrt` in increment 7 after a leaderboard eye test, for this exact reason.

**Worked numbers, using the eye-test rows and §6's proposed anchors:**

| Game | game_score (est.) | hrs to value | experience_fpm |
|---|--:|--:|--:|
| Journey | 90 | 2 | 63.6 |
| Helltaker | 85 | 1 → floored to 2 | 60.1 |
| Portal | 97 | 3 | 56.0 |
| INSIDE | 92 | 4 | 46.0 |
| Outer Wilds | 96 | 17 | 23.3 |
| Disco Elysium | 95 | 24 | 19.4 |
| Hollow Knight | 95 | 27 | 18.3 |
| Sekiro | 93 | 30 | 17.0 |
| Baldur's Gate 3 | 97 | 100 | 9.7 |
| Rocket League | 85 | endless | – |

That is the shape James asked for: Hollow Knight is no longer worth 5x Portal, it is worth
about a third of it per hour, while still reading 95 on quality. Sekiro drops out of the
head entirely. Nothing endless or trivial is near the top.

**Residual risk, named honestly:** `game_score` will compress into 80–98 for anything
decent, which flattens the FPM rank toward pure `1/sqrt(hours)`. §6 mitigates with a
low anchor and an explicit range instruction; the gate in §7 measures whether it worked.

---

## 5. What re-scores, and how

**The obvious mechanism does not work.** Bumping `EXPERIENCE_MODEL_ID` is SPEC.md §4.7's
only built re-score trigger, but `recordExperienceResult` stores what the bridge envelope
reports (`claude-opus-5`), not the constant. Set the constant to anything else and the
valve at `src/catalog.js:3020` halts the run on the first batch, permanently. Verified in
the source, not assumed. Hence `experience_rubric` in §3.

**Mechanism:** `EXPERIENCE_RUBRIC_VERSION = "v3"`. OR it into the two existing selection
predicates (`getCatalogStats` and `selectExperienceBatch`) alongside the model comparison:
a row is due when `experience_checked_at IS NULL OR experience_model != ?  OR
experience_rubric IS NULL OR experience_rubric != ?`. Stamped on every concluded attempt,
same as `experience_model`.

**Row count and cost:**

| When | Rows re-scored | LLM time at probe rate (29.3s / 25 rows) |
|---|--:|--:|
| **Now, fill stopped** | ~2,050 | **~40 min**, absorbed into the resumed fill |
| After the fill completes | 18,221 | ~5.9h, a whole second run |

Nine-to-one in favour of deciding tonight. That is the real reason this is time-sensitive.

---

## 6. Rubric delta – exactly four edits

The rubric is a test fixture (SPEC.md §3). Every edit below is additive and none touches an
existing `experience_score` line. Current text: `src/catalog.js:2096–2127`.

**Edit 1 – the definition, inserted immediately after the `experience_score` line** so the
model sees both axes adjacent and keeps them distinct:

```
game_score (0-100): how good is this game, IGNORING length and IGNORING whether it ends.
Craft, design, writing, polish. A 100-hour masterpiece and a 2-hour masterpiece both score
high here. Use the full range - most games on Steam are not great, and a game being FREE is
not quality: free-to-play titles often carry inflated review scores.
```

The final clause is James's own objection, made an instruction.

**Edit 2 – the anchor block becomes two-column**, reusing the *same ten titles* so the model
learns the difference by contrast on games it is already calibrated on:

```
Calibration anchors, match both scales exactly (experience_score / game_score):
Portal 98/97, Celeste 96/96, INSIDE 93/92, Hades 85/94, Stardew Valley 60/90,
Red Dead Redemption 2 45/95, Baldur's Gate 3 40/97, Rocket League 25/85,
Team Fortress 2 15/80, Rust 10/60.
```

Red Dead 45/95 and Baldur's Gate 40/97 are the load-bearing pairs: they teach the axis in
one line. Rust at 60 exists to open the bottom of the scale against compression.

**Edit 3 – the JSON shape line** gains `"game_score":0-100` after `"experience_score"`.

**Edit 4 – `normalizeExperienceFields`** clamps and rounds `game_score` identically to
`experience_score` (type test, clamp 0–100, NULL when absent – never a fabricated 0).

Nothing else changes. The two "punish hard" clauses, the reward paragraph, the `Also
return` list, the never-invent-an-appid line and the batch size of 25 are untouched.

---

## 7. Gates

| Gate | Status | Pass condition |
|---|---|---|
| (a) Migration + durability | Re-run | Additive migration for both columns; resume mid-fill loses nothing |
| (d1) **Non-disturbance** – replaces old (d) | **New baseline: the SAME slice-0 fixture** | The 300 games re-scored under rubric v3 keep their `experience_score` within **Spearman >= 0.95** of `scored-v2-300-games.json`, with **all ten calibration anchors within +/-5**. This proves the added field did not disturb the existing one, which is the single biggest risk of any rubric edit. The old (d) proved *reproduction*; (d1) proves *non-disturbance*. |
| (d2) **`game_score` baseline** | New | A written fixture, `slice-0-reference/scored-v3-300-games.json`, becomes the baseline every future rubric change diffs against. It has no prior, so it is judged by James's eye at the ⛩ gate, not by a number. |
| (d3) **Range health** | New | `game_score` across the 300 spans at least 55 points and no more than 40% of rows fall in any single 10-point band. Fails = compression, and the anchors get another pass before the fill resumes. |
| (e) Ghost guard | Unchanged, re-run | Out-of-batch appid dropped and counted |
| (f) Zero-diff | Unchanged | `/api/fpm`, Recs, Best-of, Deals, Wishlist byte-identical. Nothing consumes `game_score` yet. |
| (h) Tests | Extended | New tests cover `game_score` clamping, the `experience_rubric` re-score predicate, and `experience_fpm` returning NULL for endless and for `has_ending IS NULL` |

**Invalidated and explicitly retired:** the old gate (d) 0.986 Spearman figure as a
*shipping* claim, and `12-eye-test-top50-300-sample.md` as the eye test of record. Both stay
on disk as history. Gates (b), (c) and (g) belong to the fill and are untouched.

**Process requirement (review protocol Rule 3):** the Coder writes the full rubric v3 text
and its diff to `~/code/review/steam-sale-scout/inc-10.5/01-rubric-v3-diff.md` and **stops
for James's ruling before a single row is re-scored.** Burning 2,050 rows on unapproved
fixture text is the one avoidable waste in this increment.

---

## 8. Out of scope (hard)

- **Ranking, sorting, and where `experience_fpm` surfaces. Increment 11.** This increment
  stores a number and prints one review list. It changes no user-visible lane.
- **Swapping `FPM_FORMULA`'s inputs.** `game_score / sqrt(hours_to_value)` is the honest
  version of today's `wilson / sqrt(main_hours)` – curated quality instead of crowd
  sentiment, judged hours instead of HLTB's unreliable number. That is a genuine repair of
  the existing lane rather than a competing one, and it is **increment 11's** to make.
  Recorded here as intent so inc 11 does not invent a third lane.
- Retuning `experience_score`, its anchors, or its punish clauses. See §2.
- Storing `experience_fpm`. See §3.
- Any UI. Increment 12. Price coverage. Increment 13. Table rename.

---

## 9. PRD amendment – ready to paste

Insert at the end of the **"Slice 0 outcome – metric corrected, gate PASSED (2026-08-28)"**
section, before "Open questions".

```markdown
### Amendment – 2026-08-31: `game_score` added, pure FPM reinstated as a second lane

Raised by James at the increment 10 diff gate, reviewing the top 50 of the 300-game sample:
22 of the top 50 carried `hours_to_value` over 10h, Sekiro sat at #48 on 30h (6h before it
is fun), and Hollow Knight (27h, 84) read as worth five times Portal (3h, 98). His ruling,
verbatim: *"So I think a long game can have a high GAME SCORE, however it's Fun Per Minute
would inevitably be lower... I imagine these should be separate columns."*

**What changes.** Increment 10.5 adds one stored column, `game_score` (0-100): how good the
game is, length ignored and ending ignored. `experience_fpm` is then derived at rank time as
`game_score / sqrt(max(hours_to_value, 2))`, NULL for any game without a known ending.

**What does NOT change.** `experience_score`'s definition, anchors and both punish clauses
are untouched. **Binding consequence 3 above therefore stands unamended:** length alone is
still not the penalty *in `experience_score`*, and Disco Elysium still scores 89 there.
Length becomes a proportional penalty only in the new derived FPM column.

**What this DOES supersede:** the slice 0 pass-1 verdict that "fun per minute" is a dead
metric. It is reinstated as a secondary lane, under three guards that pass 1 lacked – an
`has_ending` gate, a 2-hour denominator floor, and `sqrt` damping. Pass 1's failure was an
endless ladder (Rocket League) outranking an authored short (Portal); the `has_ending` gate
makes that outcome structurally impossible rather than unlikely.

**Cost accepted:** re-scoring the ~2,050 rows already filled under rubric v2 (~40 min),
retiring the 0.986 gate-(d) drift figure as a shipping claim, and a fresh eye test from
James. Decided now rather than after the fill because after the fill the same change costs
18,221 re-scores and a second 6-hour run.

**Standing risk added:** two LLM opinions per game instead of one, and `game_score` is prone
to compressing into 80-98. Gate (d3) measures the compression rather than assuming it away.
```

---

## 10. Open questions – each with a recommendation, none blocking

1. **`game_score` anchor values (§6 edit 2).** *Recommend the ten pairs as written.* They
   are chosen so Red Dead and Baldur's Gate teach the axis by contrast and Rust holds the
   floor open. James overrules any number by saying a different one.
2. **The denominator floor.** *Recommend 2 hours.* At 1h, Helltaker leads the FPM rank
   outright; at 3h, Journey and Portal collapse into a tie and the column stops
   discriminating at the top. 2 is the value that keeps the head interesting.

---

## ⛩ REVIEW

**Gate TLDR:** the same 300 games carry a quality score that is high for Hollow Knight and
Baldur's Gate *and* an FPM that puts them well below Portal – with `experience_score` proven
unmoved, and nothing endless or trivial anywhere near the top of the FPM rank.

**Output (what James holds while reviewing):**

1. `01-rubric-v3-diff.md` – rubric v3 in full, with the four edits marked. **Opened before
   any row is re-scored; the build stops here for his ruling.**
2. `02-top50-three-columns.md` – the 300 sample's top 50 by `experience_score`, each row
   showing `game_score`, `hours_to_value` and `experience_fpm` beside it. The list that
   started this.
3. `03-top30-by-fpm.md` – the same 300 ranked by `experience_fpm`, top 30 plus the bottom
   10. This is the pass-1 failure check: he is looking for anything endless, trivial or
   obviously wrong near the top.
4. `04-james-cases.md` – Portal, Journey, Helltaker, Hollow Knight, Sekiro, Disco Elysium,
   Baldur's Gate 3, Red Dead 2, Outer Wilds, Rocket League. All three numbers per row. The
   direct answer to "is Hollow Knight really worth 5x Portal".
5. `05-gate-d1-non-disturbance.md` – `experience_score` under v3 vs the slice-0 fixture:
   Spearman, the ten anchors, and every row that moved more than 10.
6. `06-gate-d3-range-health.md` – the `game_score` distribution histogram across the 300,
   with the span and the worst 10-point band.
7. `scored-v3-300-games.json` – the new baseline fixture, in the review folder and in
   `slice-0-reference/`.

**Review folder:** `~/code/review/steam-sale-scout/inc-10.5/`
**Index:** `/AI/projects/personal-projects/steam-sale-scout/reviews/inc-10.5.md`

**Decision this gate needs:** resume the fill under rubric v3, or revert to v2 and ship
increment 10 as built.
