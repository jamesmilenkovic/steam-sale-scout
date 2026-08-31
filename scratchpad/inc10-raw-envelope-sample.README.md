# inc10-raw-envelope-sample.json

Round-1 review TC-8, **re-purposed** by round-2 review CR-9 / TC-12.

One RAW, unedited `claude -p --output-format json` envelope captured live
during the Increment 10 probes. It is a **trivial turn** – the whole answer
was the word `"ok"` – and that is now the reason to keep it, not a flaw in it.

## What it is retained for: it is the DEGENERATE COUNTEREXAMPLE

`scoringModelFromEnvelope` in `src/catalog.js` identifies the scoring model as
the `modelUsage` entry with the most output tokens. In this envelope:

| model | outputTokens |
|---|---|
| `claude-haiku-4-5-20251001` (side task) | 9 |
| `claude-opus-5` (the scorer) | **4** |

So max-output-tokens **alone picks the wrong model here**. `parseExperienceArray`
accepts `[]`, which means a real scoring batch answering `[]` lands in exactly
this shape – 25 rows would be stamped `claude-haiku-4-5-20251001`, the
model-mismatch valve would fire, and a six-hour fill would stop on a false
alarm. That is why `scoringModelFromEnvelope` has a floor
(`EXPERIENCE_SCORING_MIN_OUTPUT_TOKENS`), and this file is the live proof the
floor is needed. The numbers above are reproduced verbatim in the test
`"scoringModelFromEnvelope: a DEGENERATE reply stamps nothing rather than
stamping the side-task model"`.

## What it is NOT retained for

It is **not** the anchor for the normal case. That job now belongs to
`inc10-raw-envelope-scoring-batch.json`, a real 25-game scoring batch captured
through the hardened bridge (round-2 review TC-12).

## Key order vs token ordering – two separate claims

Its `modelUsage` puts haiku first. So does the real scoring batch, and so did
all 12 batches in `inc10-probe1-timing.json` (the only artifact whose `model`
field is `Object.keys(modelUsage)[0]`). Side-task-first is therefore real –
but it is an unspecified property of a third-party CLI's JSON object, so the
code reads output tokens instead and never a key position. Do not treat the
two claims as one.

## Provenance caveat

This capture predates the round-1 security hardening: it was taken WITHOUT
`--tools ""` / `--max-turns 1`. The envelope SHAPE is unchanged by those flags
(see `inc10-raw-envelope-scoring-batch.json`, captured through the hardened
bridge), but the scores it reports were produced under the old invocation.

Evidence, not an input – do not import it from a test.
