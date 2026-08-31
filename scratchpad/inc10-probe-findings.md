# Increment 10 – live probe findings (spec §6), 2026-08-29/30

All three mandatory probes ran BEFORE any fill code was written, per the handoff.
Raw artifacts are alongside this file in `scratchpad/inc10-probe*`.

## Probe 1 – prompt-drift regression (spec §6.1, gate (d)). PASS.

Re-scored the 300 `slice-0-reference/sample-300-games.json` games through the verbatim
`score-v2.mjs` rubric, with tags read from D1 (increment 9) instead of fetched live.
Diffed against `slice-0-reference/scored-v2-300-games.json`.

| Measure | Result |
|---|---|
| Compared | 300 of 300 |
| Spearman rank correlation | **0.986** |
| Mean absolute score change | 2.7 points |
| Median / p90 / max | 2 / 7 / 28 |
| Within ±5 | 255/300 (85%) |
| Within ±10 | 291/300 (97%) |
| `has_ending` flips | 15 |
| Endless count | 144 → 145 |
| low confidence | 0 → 3 |
| Failed batches | 0 |
| Ghost appids | 1 (`444360`, not present in `fpm_catalog`) |

**Anchors held exactly.** Portal 98→98, Portal 2 97→97, INSIDE 93→93, Hades 85→85,
Stardew Valley 60→60, RDR2 45→45, Baldur's Gate 3 40→40, Rocket League 25→25,
Team Fortress 2 15→15, Rust 10→10. Journey 91→92 is the only anchor that moved.

**The one real outlier: Call of Duty: Modern Warfare 2 (2009), 40 → 68 (+28).** Slice 0
read that appid as the multiplayer client ("endless prestige ladder"); this run read it
as the campaign. Both readings are defensible – appid 10180 is the multiplayer half of a
split release. Not prompt drift; an ambiguous appid.

Next largest are all <= 18 points and all are genuine judgement-call hybrids
(VTOL VR -18, A Dance of Fire and Ice +16, Battlefront II Classic +15). The three
non-game utilities in the sample (Wallpaper Engine, Soundpad, Blender) all rose 11–13
points but stayed in the bottom band, so ranking is unaffected.

The 15 `has_ending` flips are every sandbox/campaign hybrid in the sample – RimWorld,
Valheim, Bannerlord, Total War: WARHAMMER III, Deep Rock Galactic, Palworld. Each is
genuinely arguable in both directions. Score movement across the flips is small
(max 15, mean well under 5), so the flip does not drag the ranking.

**Verdict: the rubric is stable. Copy it verbatim into the fill and do not reword it.**

## Probe 2 – tags-from-D1 parity (spec §6.2). PASS.

| Check | Result |
|---|---|
| Sample appids present in `fpm_catalog` | 300 / 300 |
| With non-empty stored tags | 300 / 300 |
| Classified `app_type = 'game'` | 300 / 300 |
| Rows with empty stored tags | **0** |

Whole-catalog coverage: 18,306 rows, 18,306 tagged, 0 empty, 18,221 of type `game`.

Slice 0 took SteamSpy's raw key order (`Object.keys(...).slice(0,20)`, then 12 at score
time). Increment 9 stores the dict sorted by vote count descending, capped at 40 entries.
Taking the first 12 keys from the stored dict therefore yields the top 12 tags by votes –
equal or better than slice 0's raw order, never worse. Probe 1's 0.986 correlation is the
empirical confirmation that the swap is safe.

A tag-by-tag diff against slice 0 is not possible: slice 0's `tagged.json` was not saved
into `slice-0-reference/` (only the fetcher `tags.mjs` was). Probe 1's outcome is the
substitute evidence, and it is stronger.

## Probe 3 – Route A sizing, 500 real catalog rows (spec §6.3, §5). PASS.

500 rows sampled deterministically across the whole `app_type='game'` catalog (every
Nth row by appid), scored through `claude -p --model opus`, 25 per batch.

| Measure | Result |
|---|---|
| Batches | 20, **0 failed** |
| Mean batch wall-clock | 29.3 s (slowest 31.3 s) |
| 500 rows | 9.8 min |
| Model actually used | `claude-opus-5` |
| Cash cost | **$0** (existing plan) |
| CLI-reported list-price equivalent | $3.54 |
| Plan limits hit | none observed |
| Ghost appids | **4 of 500 (0.8%)** |
| Reasons over the 15-word cap | 0 |
| Score range | 5 – 94 |

**Extrapolated to the full 18,221-row catalog (729 batches):**

- Wall-clock **≈ 5.9 hours** serial. Better than the spec's 10-hour estimate, because
  batches ran at 29 s rather than slice 0's 50 s.
- Cash **$0**. List-price equivalent ≈ **$129**.
- Expected invented appids at the observed rate: **≈ 146**.

### Finding 1 – the ghost rate is far worse on the real catalog than on the sample

Slice 0 saw 1 ghost per run. Probe 1 saw 1 in 300. Probe 3 saw **4 in 500 (0.8%)** –
`544470`, `1217650`, `1779640`, `1835930`. **All four are absent from `fpm_catalog`**, so
every one was fabricated rather than mis-copied from a neighbouring batch. Projected
across the full fill that is roughly 146 rows that would be written to appids the
catalog does not contain. The §4.4 guard is load-bearing and its count must be surfaced.

### Finding 2 – `experience_model` must not be read naively from the CLI envelope

`claude -p --output-format json` reports `modelUsage` for **every** model the session
touched, including the small side-task model. The first key is
`claude-haiku-4-5-20251001`, not the scorer. The scorer is `claude-opus-5`. The fill must
pick the entry with the highest `outputTokens`, not the first key, or `experience_model`
records the wrong vintage and §4.7's re-score trigger fires on the wrong condition.

### Finding 3 – 33% of deep-catalog rows come back `low` confidence

On the adversarial 300-game sample (well-known titles) low confidence was 0–3. On 500
rows drawn from the whole catalog it is **166 of 500 (33%)** – medium 233, high 101. The
deep catalog is mostly obscure titles the model genuinely does not know, and it is
correctly declining to bluff. Spec §9 output 4 already asks for the low-confidence count
and the worst offenders by review count; on this evidence that list is the important one
to read, and the number will be large.

### Finding 4 – 4 rows returned `has_ending: false` with a non-null `hours_to_value`

0.8% of rows contradict spec §2 ("NULL if endless"). The fill must normalise this at the
write boundary – `has_ending` false forces `hours_to_value` to SQL NULL – rather than
trusting the model to be self-consistent.

### Finding 5 – a Cloudflare Worker cannot invoke `claude -p`

Spec §4.3 places the fill in `src/catalog.js`, wired into `runFpmSyncPipeline`. A Worker
under `wrangler dev` has no shell and cannot spawn a process, so Route A cannot be called
from inside the Worker directly. Route A therefore requires a small local helper process
that the Worker reaches over `fetch` to `127.0.0.1`, which shells out to `claude -p` on
the Worker's behalf. All D1 discipline – batch selection, write-through, resumability,
auto-continue, the ghost guard, the counters – stays in `src/catalog.js` exactly as §4.3
requires; the helper only carries the prompt out and the JSON back. Local-only, so this
does not breach constraint §10.1.

**Route verdict: Route A.** $0, 5.9 hours, zero failed batches across 32 probe batches,
and no API key needed. The plan-limit risk over a sustained 6-hour run is real and
genuinely unmeasured – the probes covered ~16 minutes of continuous use, not 6 hours –
but it is cheap, because the job is resumable by construction: every row is written
through to D1 as it is scored, so a limit pauses the fill and auto-continue resumes it
with zero re-scoring. Route B stays the fallback if limits prove to bite hard.
**Chosen by James 2026-08-30.**
