# Increment 11 – New scoring, and the wall comes down

**Scoped:** 2026-09-02 · **Status:** APPROVED by James 2026-09-03 (owned-games amendments 2026-09-02; open question 1 ruled 2026-09-03)
**Amended:** 2026-09-02, after James's ruling on what owned games are for. Changes are in
§1, §4.2, §4.3, §7, §8, §10 and gate 5. Every other decision is unchanged.
**Base:** `experience` @ `faff639` (increments 10 + 10.5, pushed)
**PRD:** `PRDs/2-in-progress/2026-07-04-steam-sale-recommender.md` – **Rev 3, Phase 5, increment 11**,
plus the **seven rulings of 2026-09-01** and the **Slice 0 outcome**. All three are binding and
none of them is re-opened here.

---

## 1. Problem, and the one sentence

The catalogue is finished and nothing consumes it. 18,219 games carry an `experience_score`,
a `game_score`, honest hours and a reason line, and every existing lane still ranks by
`wilson / sqrt(main_hours)` over a discount-gated pool that hides owned games. **This
increment turns the finished catalogue into one ranked answer to "what do I play next",
owned and unowned side by side, with two toggles that visibly move the order.**

**User story.** As James with 18,219 catalogued games and four free hours, I want one ranked
list built from experience value and my actual taste, with sale as a weight I can lean on,
so that I stop reading leaderboards and start picking a game.

**Owned games have two jobs, ruled by James 2026-09-02, verbatim:**

> "Owned games are important for two reasons – they can still be recommended as the next game
> to PLAY (not necessarily buy) and also they feed the recommendation engine for SIMILAR games
> which was the other big aspect to this whole project"

Both are load-bearing on this spec. **Reason 1** is served by the `default` preset (§4.2) and
by the owned exemption in the suppression clause (§7). **Reason 2** is served by
`src/profile.js`, untouched, and is explicitly protected by §4.3. Anything in the build that
would hide an owned game from the ranking, or weaken the library's role as the taste input,
is a defect against this section.

**Where the line is, stated once and plainly: there is no UI in this increment.**
`public/index.html` is not touched. The deliverable is a JSON route plus generated markdown
in the review folder, exactly as increments 10 and 10.5 delivered theirs. The answer page is
increment 12 and every temptation to pull it forward is refused below in §9.

---

## 2. Prior art / what already exists

**TLDR:** the new capability is "combine N normalised signals into one weighted score" – the
textbook Weighted Sum Model. Every off-the-shelf option is either a search engine, a trained
ranker needing labelled data we do not have, or a collaborative filter needing other users.
**Build. It is roughly 30 lines of arithmetic.** The one thing worth taking from the field is
the discipline of **normalising each signal before weighting it**, which is precisely what
stops the raw-cosine collapse described in §4.

The product-level landscape (Valve's Interactive Recommender, Play Next, ITAD, GG.deals,
SteamDB, SteamPeek, Deku Deals) is already surveyed in the PRD's Landscape table and Rev 3
evidence item 10. Per the prior-art protocol's per-capability rule, that ground is cited, not
re-walked. This section covers only the new capability.

| What | Type | State | What it does well | Why it isn't the answer |
|---|---|---|---|---|
| [Vespa ranking expressions](https://docs.vespa.ai/en/ranking-expressions-features.html) | Search/serving engine, Apache-2.0 | Actively developed | The closest match in existence: first-phase/second-phase ranking expressions blending arbitrary signals with tunable weights at query time | A JVM serving cluster. We rank 18k rows inside a Cloudflare Worker against SQLite. The infrastructure is orders of magnitude larger than the problem. |
| [Elasticsearch `function_score`](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-function-score-query.html) / OpenSearch | Query DSL | Mature | `field_value_factor` + `weight` + `score_mode` is exactly our blend, expressed declaratively | Same objection, plus a licence question. Nothing here needs an inverted index; there is no text query. |
| [Typesense](https://typesense.org/docs/) / Meilisearch | Search engine, GPL/MIT | Mature | Lightweight, ranking rules and numeric sort tiebreakers | Ranking rules are lexicographic tiers, not a weighted blend. Would need the blend computed anyway, then indexed. Pure overhead. |
| [TensorFlow Ranking](https://github.com/tensorflow/ranking) / LightGBM `rank:pairwise` | Learning-to-rank | Mature | Learns weights instead of guessing them | Needs labelled relevance judgements or a click log. We have one user and zero clicks. The weights are the product decision here, not something to fit. |
| [LightFM](https://github.com/lyst/lightfm), [implicit](https://github.com/benfred/implicit), RecBole | Recommender libraries | Mature | Hybrid and collaborative recommendation | Needs many users' interaction histories. Explicitly ruled out in the PRD's core-engine section from the start, for exactly this reason. Unchanged. |
| [scikit-criteria](https://github.com/quatrope/scikit-criteria) | Multi-criteria decision analysis, BSD | Maintained | Names our problem correctly – WSM/TOPSIS over normalised criteria, with the normalisation step first-class | Python, and the whole library reduces to `sum(w_i * norm(x_i))` for our single method. Take the method, not the dependency. |

**Reusable pieces:** none as code. As method: normalise-then-weight (WSM), and the choice of
normaliser (min-max vs percentile rank) as an explicit, measured decision rather than a
default – see §4.2 and gate 3.

**What nobody has done:** rank a whole Steam catalogue by *judged complete-experience value
per hour* crossed with library-derived taste, with the owned games left in. The PRD's white
space is intact.

**Build vs adopt: build.** The arithmetic is trivial; the expensive parts (the LLM judgement,
the tags) are already stored. Adopting anything above would add infrastructure larger than
the app to avoid writing 30 lines.

---

## 3. Scope – exactly what gets built

1. **One new route, `GET /api/rank`.** The headline lane. Sourced from `fpm_catalog`, not
   from the deals feed, so owned games are in the pool by construction.
2. **The blend** (§4), with three named presets and raw weight overrides.
3. **Similarity computed per request** from the stored inc-9 tags against the live taste
   profile, with leave-one-out for owned games (§4.3). Never persisted – Rev 2's binding
   two-layer rule.
4. **The blended `experienceFpm`** as a secondary sort inside the same route (§5).
5. **Prologue exclusion** as a stored, auditable column (§6).
6. **Low-confidence suppression** as a default-on filter with an owned exemption and a
   settings key (§7).
7. **An honest funnel** on the response: 18,306 rows down to the ranked set, every
   subtraction named and adding up (§8).
8. **A dev script** that renders the three preset runs to markdown in the review folder.

Nothing else. Six existing lanes stay byte-identical – §10.

---

## 4. The ranking formula

### 4.1 The blend

```
E    = experience_score / 100                       // 0..1, headline. Ruling 3.
S    = normalise(cosine(profile, tagVector))        // 0..1, co-pillar. See 4.2.
P    = (cut ?? 0) / 100                             // 0..1, sale strength. 0 when no price.

base = wE * E + wS * S                              // wE + wS = 1
rank = base * (1 + wSale * P * (atHistoricalLow ? 1.15 : 1))
```

`1.15` is the existing `HISTORICAL_LOW_BONUS` in `src/score.js`. No new constants.

**Why additive for E and S, multiplicative for sale.** E and S are co-pillars, so a weight
must behave like a weight – multiplying them means a near-zero similarity annihilates a 98
experience score, which is the opposite of what "co-pillar" means and would put *Portal*
nowhere. Sale is explicitly **a boost, never a gate** (Rev 3 decision table), and a
multiplier is what "boost" means: at `wSale = 0` the sale term is exactly 1.0 and the
ranking is unchanged, which is what makes the default preset provably sale-blind.

### 4.2 The presets, and what each toggle is FOR

| Preset | `wE` | `wS` | `wSale` | The lens |
|---|--:|--:|--:|---|
| `default` | 0.70 | 0.30 | 0.00 | **"What do I play next."** Experience value leads, taste breaks ties, sale is arithmetically absent. Owned and unowned compete purely on experience and taste. |
| `sale` | 0.70 | 0.30 | 0.50 | **"What do I buy."** Same base order, then a 90%-off historical low earns up to +52%. |
| `similarity` | 0.40 | 0.60 | 0.00 | "More like what I play." Taste leads; experience value becomes the floor that keeps shovelware out. |

**`default` is the lens that serves James's reason 1, and it is the default for that reason.**
With `wSale = 0` the sale multiplier is exactly 1.0 for every row, so an owned game and an
unowned game are ranked by the same two numbers. Nothing about ownership touches the score.

**`sale` is a buying lens and owned games cannot win it. Stated here rather than discovered at
the gate.** Measured against live D1: **only 1 of the 552 scored owned games carries a
discount.** So under `sale` an owned row gets a multiplier of 1.0 while a discounted unowned
row gets up to 1.52, and owned games are arithmetically pushed down. That is correct – "what
should I buy" is a question about things you do not own – but it means `sale` is never the
answer to "what do I play tonight", and increment 12 must not make it the landing state.

Also accepts `?we=`, `?ws=`, `?wsale=` as clamped overrides, mirroring `handleFpm`'s existing
`?qexp=` / `?breadth=` pattern. Presets are the reviewed surface; overrides are for tuning at
the gate without a redeploy.

**The normaliser is the load-bearing choice and it gets measured, not assumed.**
IDF-weighted cosine over 18k rows is expected to compress hard near zero. If it does, min-max
normalisation leaves `S` compressed too, `wS` stops having force, and the ⛩ gate fails on
"the order must visibly move". **Recommendation: percentile rank across the eligible pool**,
which is uniform on 0..1 by construction and therefore guarantees `wS` real force. The raw
cosine is returned on every row alongside it, so nothing is hidden. Gate 3 prints the
distribution and the top 20 under both normalisers side by side, and James picks.

### 4.3 Owned games – what they are for, and the self-match trap

**Reason 2 first, because it is the thing most easily broken by accident.**
**The owned library remains the sole input to the taste vector, and nothing in this increment
changes that.** `src/profile.js` is untouched: `buildProfile` still sums every owned game's
tag vector weighted by `gameWeight` (playtime normalised against the SteamSpy median, times
the recency multiplier over the configured window), still IDF-weights it, still L2-normalises
it. That is the recommendation engine, it is the "other big aspect" James named, and it is
not on the change list.

**Leave-one-out does not weaken that.** An owned game's tags helped build the profile, so
scoring it against that profile is circular – under the `similarity` preset the top would
fill with games James has already sunk 200 hours into. So for an owned candidate, subtract
**that one game's** contribution from the summed profile vector, re-normalise, then score.
`buildProfile` already returns per-game `contributions` with `tagWeights`, so this is an
O(tags) subtraction per owned candidate, not a profile rebuild. Every other owned game still
contributes in full – to that candidate's score and to every other candidate's. The library's
role as the engine's source is intact; only the one-game self-match is removed.

**Reason 1: owned games are ranked and annotated, never excluded.** `owned: true` and
`hoursPlayed` on the row. `?owned=all|hide|only` reuses the existing `parseOwnedMode` helper;
default `all`. No playtime penalty is invented on spec – whether a 200-hour owned game should
sink is a presentation decision, and it belongs to increment 12 with the answer page in front
of him.

### 4.4 Games with no tags

Ranked with `S = 0` rather than dropped – `experience_score` is the headline and a missing
co-pillar is not a reason to hide a game. This is a deliberate difference from
`scoreCandidates`, which drops tagless candidates. Counted in the funnel as `taglessCount`.

---

## 5. The old FPM, reconciled

**The `sqrt` unlock lands here, and here is exactly what it means.**

1. **`wilson / sqrt(main_hours)` is retired as the project's ranking metric.** Nothing new
   consumes HLTB hours. Ruling 5 stands: `hours_to_value` is the honest number.
2. **`/api/fpm` keeps it, byte-identical, and dies at increment 12** with the rest of the old
   tabs. Rewriting a lane that is three weeks from deletion is waste. `FPM_FORMULA = "sqrt"`
   stays where it is, now governing only the legacy lane it was written for. The lock is
   lifted in the sense that it no longer binds the product's ranking.
3. **The secondary "shortest to finish" sort lives inside `/api/rank`** as
   `?sort=experience|fpm`, and it is ruling 4's blended formula, superseding increment 10.5's
   `game_score / sqrt(...)`:

```
experienceFpm = hasEnding === 1
  ? sqrt(game_score * experience_score) / sqrt(max(hours_to_value, 2))
  : null
```

10.5's version was only ever rendered into review markdown, never returned by an API, so this
supersession has **zero API diff**. The scale is near-identical, so the inc-10 artifacts stay
readable next to the new ones. Worked check against the published catalogue rows – the point
is that this reproduces ruling 4's claimed movement rather than asserting it:

| Game | quality | exp | hrs | 10.5 FPM | blended FPM | effect |
|---|--:|--:|--:|--:|--:|---|
| Journey | 92 | 95 | 2 | 65.1 | 66.1 | unmoved at the top |
| Portal | 97 | 98 | 3 | 56.0 | 56.3 | unmoved |
| Melatonin | 88 | 90 | 2 | 62.2 | 62.9 | unmoved (ruling 4: 20th to 19th) |
| DoDonPachi Resurrection | 90 | 74 | 2 | 63.6 | 57.7 | sinks |
| GAROU: Mark of the Wolves | 90 | 60 | 2 | 63.6 | 51.96 | sinks hardest (ruling 4: 5th to 401st) |

**`experience_score` remains the default sort. Ruling 3, not re-opened.** FPM is one query
parameter away and never the headline.

---

## 6. Prologue exclusion – where the list lives

**Two additive columns on `fpm_catalog`, same ALTER pattern as 7.8 / 8.5 / 9 / 10 / 10.5.**

| Column | Type | Meaning |
|---|---|---|
| `rank_exclude_reason` | TEXT | `'prologue'` today, NULL for everything rankable. Extensible without a schema change. |
| `rank_exclude_checked_at` | INTEGER | Epoch ms. Makes the fill self-healing for rows a future crawl adds. |

**Why a column and not a regex in the ranking path, and not a settings list:**

1. **Auditable.** James opens one table and sees all ~108 caught rows and every near-miss.
   A regex in the hot path can only be reviewed by reading code.
2. **Precedent.** This is `app_type` from increment 7.8 exactly – classify once, gate the
   lane on the column. Consistency beats novelty.
3. **Architecture.** Prologue-ness is a property of the game, not of a user. The Rev 2
   binding two-layer rule puts it in the global layer. A settings-driven list would put
   per-user data in charge of a catalogue fact, which is the one thing that rule forbids.
   Dismissals stay what they are – per-user "not interested", already joined at rank time,
   and not conflated with this.

**Mechanism.** A pure exported classifier with **word-boundary matching** (`\bprologue\b`,
case-insensitive), plus a small appid allowlist for false positives, driven by an idempotent
`ensureRankExclusions(env)` called at the top of the rank handler. It selects rows with
`rank_exclude_checked_at IS NULL`, classifies in JS, and write-throughs in batches. No
network, no rate limit, no new route, no change to the sync pipeline or its status endpoint.
First call pays a one-time ~18k-row pass; every call after is a no-op. **This is not a
re-fill** – no LLM, no external API, seconds not hours.

**Scope, hard: `prologue` only.** Demos, DLC and soundtracks are not leaking (ruling 6: 10
demo-named rows and 1 soundtrack survive in 18,219), and the naive `%demo%` search that
would kill *HYPER DEMON*, *Book of Demons* and *Democratic Socialism Simulator* is exactly
what word boundaries exist to prevent. Those three are mandatory negative-control fixtures.

**Pre-build checkpoint.** The full match list and the negative controls are written to
`~/code/review/steam-sale-scout/inc-11/01-prologue-exclusions.md` and **the build stops for
James's ruling before a single row is written.** Legitimate titles carrying the word
(*Prologue: Go Wayback!*) are found by his eye, not by a rule, and land in the allowlist.

---

## 7. Low confidence, and the two checked-no-score rows

Ruling 2 makes suppression optional. **The call: suppress, default ON, one WHERE clause,
with an owned exemption, and a settings key to turn it off.**

```
suppressed = experience_confidence = 'low'
             AND (positive + negative) < 1000
             AND source_owned = 0          -- owned games are never suppressed
```

**Why suppress at all.** Under the `default` preset this is close to a no-op – low-confidence
rows are overwhelmingly obscure and score low anyway. It becomes genuinely load-bearing under
the `similarity` preset, where `wS` rises to 0.6 and an obscure game with a perfect tag match
and a bluffed score is exactly the row that surfaces. Increment 12 puts this in front of
strangers; a bluffed score on the front page is the one failure this product cannot absorb.

**Why owned games are exempt, and this is not a nicety.** Suppression exists for exactly one
purpose: to stop a bluffed score reaching a stranger's front page as a *purchase*
recommendation. **An owned game is never that case** – James already bought it, so the only
question left is whether to play it, and a shaky one-line score is not a reason to hide a game
sitting in his own library from a list whose entire job is "what do I play next".

Measured against live D1: **552 owned games are scored, and 11 of them would be suppressed
without this clause** – *Sol Cesto* (exp 66, 879 reviews), *Abalon: Roguelike Tactics CCG*
(63), *Archons* (62), *Galactic Glitch* (58), *Necroking* (57) among them. Those are real play
candidates. Hiding them contradicts James's reason 1 directly, so the exemption is a
requirement, not a tuning choice. Gate 5 asserts it rather than trusting it.

Settings key `suppressLowConfidence` (boolean, default true) is upserted through the existing
increment-8 settings lane. `GET /api/settings` returns only what is stored, so an untouched
store yields an unchanged response – no zero-diff breach. **The owned exemption is not behind
the key:** it holds whether suppression is on or off.

**The 2 checked-no-score rows are excluded from ranking** – no headline number means no rank –
and appear in the funnel by name. Never a silent drop.

---

## 8. Endless games – confirmed, and what is owed

**4,822 endless rows (26%) stay in the headline ranking and sink on their merits.**
`experience_score` is defined for them and correctly brutal: EVE Online 4, Rocket League 25,
CS:GO 14, AdVenture Capitalist 4. They are excluded only from the FPM secondary sort, by
construction, where `hasEnding = 0` yields NULL.

This confirms Slice 0 binding consequence 2 – *multiplayer is effectively out of the headline
ranking* – **accepted by James 2026-08-28**. No change, no repair, no special lane.

**What the API owes them, and it is the whole obligation this increment carries:** every row
returns `hasEnding` and `experienceFpm: null` explicitly, so increment 12 can render an
honest badge ("endless – no ending, so no per-hour figure") rather than a blank cell. Shipping
the field is this increment. Shipping the badge is increment 12.

### The funnel – every subtraction named

Printed on the response and in the review folder. Figures marked *confirm* are recomputed at
build; they must add up exactly.

| Step | Rows |
|---|--:|
| `fpm_catalog` total | 18,306 |
| less non-game / unclassified `app_type` | ~87 *confirm* |
| less checked-no-score | 2 |
| less `rank_exclude_reason` (prologues) | ~108 *confirm* |
| less dismissed | *confirm* |
| less low-confidence suppressed (**owned exempt – 11 rows spared**) | *confirm* |
| **= ranked** | *confirm* |
| of which owned | 552 *confirm* |
| of which endless (ranked, `experienceFpm` null) | 4,822 *confirm* |
| of which tagless (ranked, `S = 0`) | *confirm* |
| of which priced (the sale toggle can move them) | 1,727 *confirm*, **of which owned: 1** |

---

## 9. Out of scope – hard

- **All UI.** `public/index.html` is not touched. Increment 12.
- **Retiring the old tabs or lanes.** `/api/fpm`, `/api/recs`, `/api/deals`, `/api/best-of`,
  `/api/wishlist` all keep working exactly as they do. Increment 12.
- **Changing sourcing in `/api/recs` and `/api/deals`.** See open question 1 – this is a
  deliberate, flagged deviation from the PRD paragraph's letter, still awaiting James's call.
- **HLTB edition-suffix normalisation. Explicitly deferred, and here is the reason.** The
  PRD offered "here or at increment 9". Ruling 5 removed HLTB hours from every new metric, so
  normalising *Divinity: Original Sin 2 – Definitive Edition* now improves exactly one number:
  the FPM of a lane that dies at increment 12. It buys the headline ranking nothing. Reopen at
  increment 13 only if a real consumer appears.
- **Any re-fill of the 18,219 LLM-scored rows.** Nothing in this spec triggers one. If a
  proposal during the build would, the recommendation is against it and it comes back to
  James before a row is written.
- **Any change to `src/profile.js` or the taste-vector machinery.** §4.3 – it is the
  recommendation engine and it is out of bounds this round.
- Price coverage for the ~16,600 priceless rows, and caching the whole-catalogue read
  (`src/catalog.js:493`). Increment 13. This route reads the catalogue per request, same as
  `handleFpm` already does; the row-read count is recorded as gate 8 input, not fixed here.
- Wishlist folding, the "all-time greats on deep sale" alert, and dismissal changes.
  Increment 12.
- Retuning the `experience_score` rubric, or any change to `game_score`, `has_ending`,
  `hours_to_value`, `hours_to_good`. Increment 10.5's §2 reasoning stands.
- Table rename `fpm_catalog` -> `game_catalog`.

---

## 10. The zero-diff boundary

**Deliberately changed:** `/api/rank` (new), `fpm_catalog` (+2 columns), `src/settings.js`
consumers (+1 optional key), the derived FPM formula (no API surface).

**Must stay byte-identical against `faff639`**, proven by golden-response tests in the same
style increments 7.8 through 10.5 used:

| Lane | Why it must not move |
|---|---|
| `/api/fpm` | Legacy lane, retires at 12. Nothing here consumes the new columns. |
| `/api/recs` | Sourcing unchanged – see open question 1. |
| `/api/deals` | Untouched. |
| `/api/best-of` | Untouched. |
| `/api/wishlist` | Untouched. |
| `/api/library` | Untouched. |
| `/api/fpm/sync` + `/sync/status` | The exclusion fill runs outside the sync pipeline precisely so this stays still. |
| `/api/settings`, `/api/dismissals` | Shape unchanged; a new key only appears once written. |

**How it is tested — amended 2026-09-03 to describe what was actually built (round-2 review,
TC-9).** No golden-response fixtures were recorded. The original wording promised responses
"captured at `faff639` and compared byte-for-byte", and the repo does not keep that promise, so
the promise is withdrawn rather than left standing.

What the zero-diff claim actually rests on, and why it is sufficient:

1. **The handlers were not edited.** `git diff faff639 -- src/worker.js` has zero deletions
   inside the six lane handlers and the shared catalogue read. A golden fixture proves a
   response did not move; an empty deletion set proves the code that builds it did not move,
   which is the stronger statement and the one a reviewer can check in a second.
2. **Each of the six lanes already carries an exhaustive `Object.keys(entry).sort()` deepEqual**
   against its pre-increment-10 key set. Any field added to a lane's SELECT and passed through
   its response builder fails one of those first.
3. **`test/helpers/laneShape.mjs` walks every lane body** and fails on any key matching the
   increment-10, 10.5 or 11 column patterns at any depth, so a nested leak is named rather than
   only diffed.

`/api/rank` gets its own exhaustive key-set assertion, top level and per row, so its shape is
pinned from day one for increment 12.

**Suite constraint:** stays at 695+ passing, 0 skipped, provably offline-clean. Nothing in
this spec needs a network call in a test. New coverage:

1. The prologue classifier fixture – positives *Black Book: Prologue*, *Not For Broadcast:
   Prologue*; negatives *HYPER DEMON*, *Book of Demons*, *Democratic Socialism Simulator*.
2. Both normalisers, and the blend at all three presets.
3. `wSale = 0` proving arithmetic identity with `base`.
4. Leave-one-out on an owned candidate, **plus a test that every OTHER owned game still
   contributes in full to that candidate's profile** – the guard on James's reason 2.
5. **A `source_owned = 1`, `low`-confidence, sub-1,000-review row surviving suppression with
   the settings key both on and off** – the guard on James's reason 1.
6. `experienceFpm` NULL for `has_ending` 0 and for `has_ending` NULL.
7. Tagless rows scoring `S = 0` rather than being dropped.
8. The funnel summing exactly to the catalogue row count.

---

## 11. Gates

| # | Gate | Pass condition |
|--:|---|---|
| 1 | Migration + self-healing exclusion fill | Additive ALTER for both columns; `ensureRankExclusions` is idempotent – second call is a no-op; kill and restart `wrangler dev` loses nothing |
| 2 | **Prologue list ruled before it is written** | `01-prologue-exclusions.md` in the review folder, build stopped, James's allowlist applied. All three negative controls survive. |
| 3 | **Normaliser chosen by measurement** | `02-normalisation-probe.md` shows the cosine distribution and the top 20 under percentile and min-max side by side. James picks; the pick is a named constant, not a buried default. |
| 4 | **The toggles visibly move the order** | Against `default`, each of `sale` and `similarity` changes **at least 20 of the top 50**, and pulls **at least one row up by 100+ ranks**. If `sale` cannot clear this over the 1,727 priced rows, `wSale` is the lever and the value is set at the gate. |
| 5 | Funnel adds up; suppression measured; **owned never suppressed** | §8's table computed live, every line summing exactly to 18,306; top 50 rendered with suppression on and off. **Hard assertion: zero `source_owned = 1` rows appear in the suppressed set, and all 552 scored owned games are present in the ranked pool.** The 11 spared games are listed by name in the artifact as proof, not asserted. |
| 6 | Ruling 3 held | Default sort is `experience_score`. *Portal* is #1 of the ranked set under `default`. FPM is reachable only via `?sort=fpm`. |
| 7 | Zero-diff | The eight surfaces in §10 byte-identical vs `faff639` |
| 8 | Tests + cost | Full suite green, 695+ passing, 0 skipped, offline-clean; `/api/rank` has an exhaustive key-set assertion; D1 row-reads per `/api/rank` call recorded for increment 13 |

---

## 12. Open questions – each with a recommendation

1. **RULED 2026-09-03: leave them alone.** James: *"leave it alone, as we could filter out
   easily on the frontend I think"* - the owned/unowned split becomes a frontend filter at
   increment 12, which is a second reason on top of the one below. Closed, not open.

   ~~**Do `/api/recs` and `/api/deals` get their sourcing changed?**~~ The PRD paragraph names
   them. **Recommend: no – deviate deliberately.** The owned-games unlock is what matters, and
   the new lane delivers it by sourcing from `fpm_catalog`, where owned games already live.
   Both named lanes retire at increment 12, so rewriting their sourcing is work thrown away
   three weeks later, on top of two zero-diff surfaces we would then lose. **Still open –
   James has not ruled.**
2. **Preset weights (0.70/0.30, 0.40/0.60, `wSale` 0.50).** *Recommend as written.* They are
   overridable by query param, so gate 4 tunes them with the real top 50 in front of you
   rather than on paper.
3. **Normaliser.** *Recommend percentile rank*, because min-max cannot guarantee gate 4 if
   the cosines compress. Settled by the gate-3 artifact, not by this recommendation.
4. **Low-confidence suppression default.** *Recommend ON at under 1,000 reviews, with owned
   games exempt*, per §7. The exemption is now a requirement from James's 2026-09-02 ruling,
   not an option; only the default-on state of the key itself is still a choice.
5. **Route name `/api/rank`.** *Recommend it.* `/api/next` reads better as a product name but
   the route is a ranking API that increment 12 consumes, and the product name is parked in
   the PRD anyway.

---

## 12b. Gate rulings – James, 2026-09-03, after the two pre-build checkpoints

These close the checkpoints. They override the spec text above where they conflict.

**1. Low-confidence threshold: under 200 reviews, not under 1,000.** James: *"let's pull
everything over 200 reviews, we can always suppress later."* §7's "close to a no-op" claim was
wrong - measured, the 1,000 bar removed **6,812 rows, 37% of the catalogue**. The 200 bar removes
**4,209** and the ranked pool goes 11,327 to **14,010**. What comes back is not noise: *Desvelado*
(exp 91), *Re:Fresh* (88), *The Happyhills Homicide 2* (88), *Mr. Rainer's Solve-It Service* (86)
were all hidden purely for being obscure. The owned exemption is unchanged and still sits outside
the settings key.

**2. Normaliser: percentile for `default` and `sale`, min-max for `similarity`.** The spec's
premise for recommending percentile did not survive contact with the data - the cosines do not
collapse (median 0.147, max 0.625, only 5.9% below 0.05), so both were live options. The ruling
splits them by what each lens is for. Percentile scores a game by its rank against the pool, so a
good-but-not-perfect match still earns taste credit and experience leads. Min-max scores it by
distance from the single best match, so only near-perfect matches earn credit - which is correct
when the user has explicitly asked for "more like what I play", and wrong as a default, where it
put deckbuilders at exp 76-81 above *Portal 2* at 96.

`sale` takes `default`'s normaliser because it shares its base weights; letting the sale toggle
also swap the normaliser would change two things at once and make gate 4's movement measurement
meaningless.

**3. `KINGDOM HEARTS HD 2.8 Final Chapter Prologue` is spared**, via an explicit
`RANK_EXCLUDE_ALLOWLIST`, so the rule stays `/\bprologue\b/i` and the exception stays visible.
It is a paid retail game whose title merely ends in the word, and §6 anticipated exactly this
case as one found by eye rather than by rule.

**4. Gate 6's wording is corrected.** "Portal at #1 of the ranked set" is unachievable and always
was: at `wS = 0.3` the similarity term genuinely moves things, which is the toggle working.
*Portal* is **1st of 18,219 on `experience_score` alone** and lands **10th under
`default`/percentile**. The gate now reads: *Portal* is 1st on `experience_score`, and inside the
top 10 under `default`.

---

## ⛩ REVIEW

**Gate TLDR:** one ranked list over all 18,219 catalogued games answers "what do I play next"
with owned and unowned side by side – *Portal* at the top, no prologues in it, all 552 owned
games present including the 11 low-confidence ones, endless games sunk on their merits – and
both the sale and similarity toggles visibly reorder the top 50.

**Output (what James holds while reviewing):**

1. `01-prologue-exclusions.md` – every title matched by `\bprologue\b`, the three negative
   controls, and the near-misses. **Opened before any row is written; the build stops here.**
2. `02-normalisation-probe.md` – the IDF-cosine distribution across the pool, and the top 20
   under percentile vs min-max side by side. **Opened before the blend is finalised; the build
   stops here too.**
3. `03-top50-default.md` – the answer, and the "what do I play next" lens. Experience,
   quality, hours, similarity, FPM, owned flag, price and the why-line, per row.
4. `04-top50-sale.md` – the "what do I buy" lens, with `wSale = 0.5`. Expect owned games to
   fall; §4.2 says why, and that is the point of showing both.
5. `05-top50-similarity.md` – the same run with `wS = 0.6`.
6. `06-toggle-movement.md` – rows changed and biggest climbers between each preset and
   `default`, measured against gate 4's numbers. **The gate artifact.**
7. `07-funnel-and-suppression.md` – §8's table computed live and summing to 18,306, the top 50
   with low-confidence suppression off for comparison, **the 11 owned low-confidence games
   named and shown present in the ranked pool**, and D1 row-reads per request.

Items 1 and 2 are pre-build checkpoints. Per review protocol Rule 3 the Coder writes them into
the review folder as part of the work and halts – James is never asked to review from a chat
message, a scratchpad or a code block.

**Review folder:** `~/code/review/steam-sale-scout/inc-11/`
**Index:** `/AI/projects/personal-projects/steam-sale-scout/reviews/inc-11.md`

**Decision this gate needs:** approve the ranking as the product's headline and unblock
increment 12's answer page, or send the weights back for another pass.

---

## 13. Constraints

1. Local-only (`wrangler dev`). No deploy.
2. D1 for durable data, KV for cheap short-TTL. No new storage shapes.
3. **Nothing that requires re-filling the 18,219 rows.** Nothing here does; if the build finds
   something that would, it stops and reports rather than running it.
4. Suite stays 695+ passing, 0 skipped, provably offline-clean, exhaustive key sets per lane.
5. Fail-soft everywhere: a missing `FPM_DB`, an empty library or a failed Steam fetch degrades
   `/api/rank` to an honest response, never a 500.
6. Append **"use context7"** on any task touching a third-party library API.
7. **En dashes, never em dashes**, in every artifact.
8. Stop before commit. An explicit in-session "commit"/"push" from James is sufficient
   authorization; never initiate one.
