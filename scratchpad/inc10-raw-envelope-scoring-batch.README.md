# inc10-raw-envelope-scoring-batch.json

Round-2 review, TC-12. One RAW, unedited `claude -p --output-format json`
envelope from a **real 25-game scoring batch**, captured 2026-08-30 through
the hardened `tools/claude-bridge.mjs` using the production
`buildExperiencePrompt` on the first 25 rows `selectExperienceBatch` would
pick from the live catalog.

This is the envelope that ANCHORS the fixture in
`test/catalog-experience.test.mjs`. Its predecessor,
`inc10-raw-envelope-sample.json`, is a trivial `"result":"ok"` turn and is
retained for a different job – see that file's README.

## Two SEPARATE claims, do not conflate them

TC-12's actual point. The envelope carries evidence about both, and only one
of them is something the code may rely on.

1. **Key order.** Here `modelUsage`'s first key is
   `claude-haiku-4-5-20251001`, the small side-task model. That matches
   `inc10-probe1-timing.json`, whose `model` field is literally
   `Object.keys(modelUsage)[0]` and which recorded haiku on all 12 of its
   real scoring batches. So side-task-first is genuinely what live batches
   do – but it is an unspecified property of a third-party CLI's JSON object
   and `scoringModelFromEnvelope` deliberately does not read it.
   **NOTE for anyone re-reading the round-2 review:** CR-9 cited
   `inc10-probe3-timing.json` as showing opus first on 20 batches. That file
   does not record key order at all; its `model` field is already the
   max-output-token entry. Same for `inc10-hardened-timing.json`.
2. **Output-token ordering.** This is the claim the code DOES rely on, and
   it is the well-measured one. Here: opus 2,013 output tokens, haiku 12.
   The same rule picked `claude-opus-5` on all 32 real scoring batches on
   file (20 in probe 3, 12 in the hardened re-proof).

## What it shows

| Field | Value |
|---|---|
| `num_turns` | 1 – the `--max-turns 1` cap held on a real scoring batch |
| `is_error` / `subtype` | `false` / `success` |
| `permission_denials` | `[]` – nothing tried to use a tool under `--tools ""` |
| rows returned | 25 of 25 requested, no ghosts in this batch |
| `duration_ms` | 22,828 (28.4 s wall clock through the bridge) |
| opus `outputTokens` | 2,013 – 40x `EXPERIENCE_SCORING_MIN_OUTPUT_TOKENS` |
| haiku `outputTokens` | 12 |

Nothing from this capture was written to D1. It is evidence, **not** a test
input – do not import it from a test.
