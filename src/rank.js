// Steam Sale Scout — the ranking blend (Increment 11).
//
// This is the arithmetic behind /api/rank: the one lane that answers "what do
// I play next" over the whole 18,306-row catalogue, owned and unowned side by
// side. Everything here is pure except the two rank-exclusion helpers at the
// bottom, which own their own SQL the same way src/settings.js and
// src/dismissals.js own theirs.
//
// Lives in its own module for the same load-bearing reason as spyQueue.js /
// hltb.js / catalog.js: src/worker.js is wrangler's `main` entry module and
// workerd treats every named export of the main module as a potential extra
// handler, so nothing exportable may live there. See spyQueue.js's header.
//
// WHY A WEIGHTED SUM AND NOT A LIBRARY. SPEC.md §2 walked the field (Vespa
// ranking expressions, Elasticsearch function_score, TensorFlow Ranking,
// LightFM, scikit-criteria) and every option is either a serving cluster
// larger than this app, a trained ranker needing labelled data that does not
// exist for a one-user tool, or a collaborative filter needing other users.
// The capability is the textbook Weighted Sum Model and it is about thirty
// lines of arithmetic. The ONE thing taken from the field is the discipline
// scikit-criteria makes first-class: NORMALISE EACH SIGNAL BEFORE WEIGHTING
// IT. That is what normaliseSimilarities below exists for, and skipping it is
// exactly how `wS` would stop having any force at all.
//
// WHAT IS NOT HERE, ON PURPOSE. src/profile.js is untouched by this
// increment (SPEC.md §4.3, §9). The owned library remains the sole input to
// the taste vector: buildProfile still sums every owned game's tag vector
// weighted by playtime-against-median times recency, still IDF-weights it,
// still L2-normalises it. That is the recommendation engine James named as
// "the other big aspect to this whole project" and it is out of bounds this
// round. profileWithoutGame below is the one thing that touches it, and it
// touches it by SUBTRACTION at score time — it rebuilds nothing and changes
// no stored state.

import { applyIdf } from "./profile.js";
import { HISTORICAL_LOW_BONUS } from "./score.js";

// ---------------------------------------------------------------------------
// Prologue exclusion — the classifier (SPEC.md §6, PRD ruling 6)
// ---------------------------------------------------------------------------

/**
 * WORD BOUNDARIES ARE THE WHOLE POINT, and they are not a stylistic
 * preference — they are what stops this rule doing real damage.
 *
 * The problem being solved is measured, from the finished catalogue: 108 free
 * prologues are classified `app_type = 'game'` by increment 7.8's storefront
 * classifier (correctly — Steam genuinely lists them as games), and being
 * short, free and warmly reviewed they are precisely what a per-hour metric
 * rewards. `Black Book: Prologue` ranks 91st while `Black Book` itself ranks
 * 10,811th; `Not For Broadcast: Prologue` 175th against 4,781st.
 *
 * The naive fix is a `%prologue%` / `%demo%` substring search, and a
 * substring search over 18,306 titles kills real games. The three mandatory
 * negative controls (SPEC.md §10 test 1) are HYPER DEMON, Book of Demons and
 * Democratic Socialism Simulator — all three die to `%demo%`, and none of the
 * three contains the word "demo" as a word. `\b` is what tells those apart.
 *
 * SCOPE IS HARD: `prologue` ONLY. Demos, DLC and soundtracks are NOT leaking —
 * ruling 6 measured 10 demo-named rows and 1 soundtrack surviving in 18,219,
 * which is a rounding error, and the inc-7.8 app_type classifier is what
 * holds that line. Adding a demo or soundtrack rule here would buy eleven
 * rows and risk three named real games, which is a bad trade taken knowingly.
 * A `%OST%` rule in particular must never be added case-insensitively: it
 * naively matches Ghost, Lost, Frost and Nostalgia.
 *
 * Case-insensitive because titles are inconsistently cased (`PROLOGUE`,
 * `Prologue`, `prologue` all appear). `\b` in JavaScript is ASCII-word-based,
 * which is the behaviour wanted here: in a title like `序章 Prologue` the
 * CJK character is a non-word character, so the boundary holds and the row
 * still matches.
 */
export const PROLOGUE_PATTERN = /\bprologue\b/i;

/**
 * Appids whose titles carry the word but which are real, complete games —
 * the false positives that only James's eye can find, per SPEC.md §6 and
 * gate 2. `Prologue: Go Wayback!` is the known example: a full survival game
 * that happens to be called Prologue.
 *
 * RULED AT GATE 2 (James, 2026-09-03, SPEC.md §12b.3). The pre-build
 * checkpoint put all 112 matches in front of him before a row was written; he
 * approved 111 of them and spared one.
 *
 * KEYED BY APPID, NOT TITLE, and that is deliberate: a title is a mutable
 * string SteamSpy re-crawls (publishers rename games, add and drop edition
 * suffixes), so a title-keyed exception would silently stop applying the day
 * the name changed and the game would vanish from the ranking with nothing to
 * show why. An appid is stable for the life of the app.
 *
 * The rule itself STAYS `\bprologue\b`. The exception lives here, visible,
 * rather than being smuggled into the pattern as a negative lookahead — which
 * is the whole reason §6 chose a stored column plus an allowlist over a
 * cleverer regex.
 *
 *   2552440 — KINGDOM HEARTS HD 2.8 Final Chapter Prologue. A paid retail
 *             game whose title merely ends in the word. No computable signal
 *             separates it from the 111 promotional prologues: it has no price
 *             in D1 (nothing unpriced does), a mid-table experience score of
 *             48 and an unremarkable 432 reviews. §6 anticipated exactly this
 *             case as one "found by his eye, not by a rule".
 *
 * @type {Set<number>}
 */
export const RANK_EXCLUDE_ALLOWLIST = new Set([2552440]);

/**
 * Classify one catalogue row for rank exclusion. Pure — no D1, no clock.
 *
 * Returns a REASON STRING rather than a boolean so a future exclusion class
 * (were one ever ruled) needs no schema change and no call-site change; the
 * column is TEXT for the same reason.
 *
 * @param {{appid?: number|null, name?: string|null}} row
 * @param {Set<number>} [allowlist] - appids exempted by James's gate-2 ruling.
 * @returns {string|null} 'prologue', or null for everything rankable.
 */
export function classifyRankExclusion(row, allowlist = RANK_EXCLUDE_ALLOWLIST) {
  const name = row?.name;
  if (typeof name !== "string" || name.length === 0) return null;
  // A row James has explicitly cleared is rankable whatever its title says.
  // Checked BEFORE the pattern, not after, so the allowlist is an override
  // rather than a filter on the output.
  if (row?.appid != null && allowlist.has(row.appid)) return null;
  return PROLOGUE_PATTERN.test(name) ? "prologue" : null;
}

// ---------------------------------------------------------------------------
// Prologue exclusion — the self-healing fill (SPEC.md §6, gate 1)
// ---------------------------------------------------------------------------

/** How many UPDATEs go into one D1 `.batch()` call. Same shape as
 * upsertCatalogRows' per-page batching: one round-trip per chunk rather than
 * one per row, but bounded so a kill mid-fill loses at most this many rows'
 * worth of work — and losing them costs nothing anyway, since the next call
 * simply re-selects whatever is still unstamped. */
export const RANK_EXCLUSION_WRITE_BATCH = 500;

const SELECT_UNCHECKED_SQL =
  "SELECT appid, name FROM fpm_catalog WHERE rank_exclude_checked_at IS NULL";

const RECORD_EXCLUSION_SQL =
  "UPDATE fpm_catalog SET rank_exclude_reason = ?, rank_exclude_checked_at = ? WHERE appid = ?";

/**
 * Classify and stamp every catalogue row that has never been looked at.
 *
 * IDEMPOTENT BY CONSTRUCTION (gate 1). The selection is
 * `rank_exclude_checked_at IS NULL`, and every classified row is stamped
 * whether or not it matched — a rankable row gets a timestamp and a NULL
 * reason, which is a genuinely different state from "never checked". So the
 * first call pays a one-time ~18.3k-row pass and every call after selects
 * zero rows and does nothing. Killing and restarting `wrangler dev` loses
 * nothing, because the progress is in D1, not in memory.
 *
 * SELF-HEALING for free: a row a future crawl adds arrives with a NULL
 * timestamp and is picked up on the next /api/rank request. Nobody has to
 * remember to re-run anything, and there is no new route, no cron, and no
 * change to the sync pipeline or its status endpoint — which is precisely
 * what keeps /api/fpm/sync and /sync/status byte-identical (SPEC.md §10).
 *
 * THIS IS NOT A RE-FILL. No LLM, no external API, no network of any kind —
 * it is a regex over titles already in D1. Seconds, not hours.
 *
 * FAIL-SOFT: any D1 failure returns what was done so far rather than
 * throwing, so a hiccup here degrades /api/rank to "prologues not excluded
 * this request" instead of taking the lane down (SPEC.md §13.5).
 *
 * @param {object} env - needs env.FPM_DB.
 * @param {{nowMs?: number, allowlist?: Set<number>}} [options]
 * @returns {Promise<{checked: number, excluded: number, ok: boolean}>}
 */
export async function ensureRankExclusions(env, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const allowlist = options.allowlist ?? RANK_EXCLUDE_ALLOWLIST;

  let pending;
  try {
    const result = await env.FPM_DB.prepare(SELECT_UNCHECKED_SQL).all();
    pending = result.results || [];
  } catch {
    return { checked: 0, excluded: 0, ok: false };
  }
  if (pending.length === 0) return { checked: 0, excluded: 0, ok: true };

  const stmt = env.FPM_DB.prepare(RECORD_EXCLUSION_SQL);
  let checked = 0;
  let excluded = 0;

  for (let i = 0; i < pending.length; i += RANK_EXCLUSION_WRITE_BATCH) {
    const slice = pending.slice(i, i + RANK_EXCLUSION_WRITE_BATCH);
    const statements = slice.map((row) => {
      const reason = classifyRankExclusion(row, allowlist);
      if (reason) excluded++;
      return stmt.bind(reason, nowMs, row.appid);
    });
    try {
      await env.FPM_DB.batch(statements);
    } catch {
      // Partial progress is real progress — everything already written stays
      // written and is never re-selected. Report what got through.
      return { checked, excluded, ok: false };
    }
    checked += slice.length;
  }

  return { checked, excluded, ok: true };
}

// ---------------------------------------------------------------------------
// Normalising the similarity signal (SPEC.md §4.2, gate 3)
// ---------------------------------------------------------------------------

/**
 * THE NORMALISER IS THE LOAD-BEARING CHOICE IN THIS WHOLE INCREMENT, and as
 * of gate 3 it is A PROPERTY OF THE PRESET rather than one global default.
 * RULED BY JAMES 2026-09-03, SPEC.md §12b.2.
 *
 * WHAT THE PROBE FOUND, because it overturned the spec's own reasoning.
 * §4.2 recommended percentile on the premise that IDF-cosine over 18k rows
 * would compress hard near zero, which would have left min-max unable to give
 * `wS` any force. Measured over the real pool, IT DOES NOT COMPRESS: median
 * 0.147, interquartile range 0.101–0.198, max 0.625, only 5.9% below 0.05.
 * Both normalisers were therefore live options and the recommendation had
 * nothing left to rest on. The ruling splits them by what each lens is FOR:
 *
 *  - PERCENTILE scores a game by its RANK AGAINST THE POOL, so a
 *    good-but-not-perfect match still earns taste credit and `experience_score`
 *    stays the thing that separates the top. Correct for `default`, whose job
 *    is "what do I play next" — the answer should be great games, taste-
 *    ordered.
 *  - MIN-MAX scores a game by its DISTANCE FROM THE SINGLE BEST MATCH, so only
 *    near-perfect matches earn credit. Correct when the user has explicitly
 *    asked for "more like what I play", and demonstrably wrong as a default:
 *    under it, deckbuilders at experience 76–81 outranked Portal 2 at 96.
 *
 * WHY `sale` TAKES `default`'s NORMALISER rather than its own. `sale` differs
 * from `default` in exactly one thing, `wSale`, and shares its base weights.
 * If the sale toggle ALSO swapped the normaliser it would change two
 * variables at once, and gate 4's measurement — "how many of the top 50 does
 * this toggle move" — would no longer attribute the movement to anything.
 * Keeping the normaliser tied to the base weights is what keeps that
 * measurement meaningful.
 *
 * `?norm=` overrides the preset's choice for either lens, so both lists stay
 * one URL apart, and the resolved normaliser is echoed back in the response
 * beside the weights so what actually ran is never in doubt. The RAW cosine
 * ships on every row alongside the normalised one either way, so the
 * normaliser can never hide what it did.
 */
export const RANK_NORMALISER_BY_PRESET = {
  default: "percentile",
  sale: "percentile",
  similarity: "minmax",
};

/** The fallback for a preset nobody has assigned a normaliser to. Unreachable
 * today — every key of RANK_PRESETS has an entry above, and a test asserts
 * that stays true — but a future preset added without one must degrade to the
 * headline lens's behaviour rather than to `undefined`. */
export const RANK_NORMALISER_DEFAULT = "percentile";

/** The two normalisers gate 3 chose between. `?norm=` accepts either. */
export const RANK_NORMALISERS = new Set(["percentile", "minmax"]);

/**
 * Min-max: `(v - min) / (max - min)`, the textbook WSM normaliser. Preserves
 * the SHAPE of the distribution — which is its virtue (a genuinely twice-as-
 * similar game reads twice as similar) and, if the cosines compress, its
 * fatal flaw (everything lands near zero and the weight stops mattering).
 * A degenerate pool (all values equal, or fewer than two values) returns all
 * zeros rather than dividing by zero.
 * @param {number[]} values
 * @returns {number[]} parallel array on 0..1.
 */
export function minMaxNormalise(values) {
  if (!values || values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (!(span > 0)) return values.map(() => 0);
  return values.map((v) => (v - min) / span);
}

/**
 * Percentile rank: the fraction of the pool a value STRICTLY beats.
 *
 * THE TIE RULE IS DELIBERATE AND IT MATTERS HERE MORE THAN IT USUALLY WOULD.
 * The obvious mid-rank convention (`(below + equal/2) / n`) is the standard
 * one, but this pool has a large tie block at exactly zero — every game
 * sharing no distinctive tag at all with the profile — and mid-rank would
 * hand that entire block a similarity of half its own size (0.08, say)
 * instead of 0. A game with literally nothing in common with James's taste
 * must score S = 0, not "better than nothing". Strictly-below does that, and
 * stays monotone everywhere else.
 *
 * The cost, stated: the single best-matching game scores (n-1)/n rather than
 * exactly 1.0. Over 18k rows that is 0.99995, which is not worth a special
 * case that would break the tie rule.
 *
 * O(n log n) — one sort, then a binary search per value.
 * @param {number[]} values
 * @returns {number[]} parallel array on 0..1.
 */
export function percentileRankNormalise(values) {
  if (!values || values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return values.map((v) => {
    // Index of the first element >= v, i.e. exactly the count strictly below.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  });
}

/**
 * Normalise a pool of raw cosines with the chosen normaliser.
 * @param {number[]} values
 * @param {string} [normaliser] - 'percentile' or 'minmax'.
 * @returns {number[]}
 */
export function normaliseSimilarities(values, normaliser = RANK_NORMALISER_DEFAULT) {
  return normaliser === "minmax" ? minMaxNormalise(values) : percentileRankNormalise(values);
}

// ---------------------------------------------------------------------------
// The blend (SPEC.md §4.1) and the presets (§4.2)
// ---------------------------------------------------------------------------

/**
 * The three lenses. Each is a WHOLE QUESTION, not a slider position:
 *
 *  - `default`    — "what do I play next." Experience value leads, taste
 *                   breaks ties, and `wSale = 0` makes the sale term
 *                   arithmetically exactly 1.0 for every row, so an owned
 *                   game and an unowned game are ranked by the same two
 *                   numbers and nothing about ownership touches the score.
 *                   This is the preset that serves James's reason 1 (SPEC.md
 *                   §1) and it is the default FOR that reason.
 *  - `sale`       — "what do I buy." Same base order, then a 90%-off
 *                   historical low earns up to +52%. OWNED GAMES CANNOT WIN
 *                   THIS LENS and that is stated up front rather than
 *                   discovered at the gate: only 1 of the 552 scored owned
 *                   games carries a discount, so an owned row gets a
 *                   multiplier of 1.0 against an unowned row's 1.52. That is
 *                   correct — "what should I buy" is a question about things
 *                   you do not own — but it means `sale` is never the answer
 *                   to "what do I play tonight", and increment 12 must not
 *                   make it the landing state.
 *  - `similarity` — "more like what I play." Taste leads; experience value
 *                   becomes the floor that keeps shovelware out.
 */
export const RANK_PRESETS = {
  default: { we: 0.7, ws: 0.3, wsale: 0 },
  sale: { we: 0.7, ws: 0.3, wsale: 0.5 },
  similarity: { we: 0.4, ws: 0.6, wsale: 0 },
};

export const RANK_PRESET_DEFAULT = "default";

/** Override bounds for `?we=`/`?ws=`/`?wsale=`, mirroring handleFpm's
 * FPM_QEXP_MIN/MAX guardrail pattern. `wE`/`wS` are shares of a base that
 * SPEC.md defines as summing to 1, so 0..1 is the meaningful range. `wSale`
 * gets headroom well past the preset's 0.5 because gate 4 explicitly names it
 * as the lever to turn up if the sale preset cannot move the top 50 over only
 * 1,727 priced rows. Not asserted by SPEC.md as "the" right bounds — a
 * guardrail against a garbage query value, flagged for the gate. */
export const RANK_WEIGHT_MIN = 0;
export const RANK_WEIGHT_MAX = 1;
export const RANK_WSALE_MIN = 0;
export const RANK_WSALE_MAX = 5;

function clampNumber(raw, fallback, min, max) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve preset + overrides into the three weights actually used.
 *
 * THE ONE-SIDED RULE, stated because it is a judgement call: SPEC.md §4.1
 * defines `wE + wS = 1`, so supplying only ONE of them derives the other as
 * its complement — typing `?ws=0.8` means "taste at 0.8", and silently
 * leaving `wE` at the preset's 0.7 would give a base out of 1.5 that is not
 * comparable to any other run. Supplying BOTH honours both verbatim, on the
 * grounds that someone who typed two numbers meant two numbers; the response
 * echoes the weights back so what ran is never in doubt.
 *
 * THE NORMALISER IS RESOLVED HERE TOO, alongside the weights, because after
 * gate 3 it IS one of the preset's settings — resolving it anywhere else would
 * let a preset and its normaliser drift apart. `?norm=` overrides it; anything
 * unrecognised falls back to the preset's own choice rather than 500ing, the
 * same discipline as every other parameter in this app.
 *
 * @param {URLSearchParams} params
 * @returns {{preset: string, we: number, ws: number, wsale: number, normaliser: string}}
 */
export function resolveRankWeights(params) {
  const requested = params?.get("preset");
  const preset = requested && Object.hasOwn(RANK_PRESETS, requested) ? requested : RANK_PRESET_DEFAULT;
  const base = RANK_PRESETS[preset];

  const rawWe = params?.get("we");
  const rawWs = params?.get("ws");
  const hasWe = rawWe != null && rawWe !== "";
  const hasWs = rawWs != null && rawWs !== "";

  let we = clampNumber(rawWe, base.we, RANK_WEIGHT_MIN, RANK_WEIGHT_MAX);
  let ws = clampNumber(rawWs, base.ws, RANK_WEIGHT_MIN, RANK_WEIGHT_MAX);
  // Rounded to 6dp because the complement is ECHOED BACK in the response and
  // read by a human at the gate: `1 - 0.8` is 0.19999999999999996 in binary
  // floating point, and a tuning knob that reports itself as that is worse
  // than useless for the thing this parameter exists for. Six places is far
  // beyond any weight anyone will type, so nothing real is lost. Only the
  // DERIVED side is rounded — a value James typed is honoured exactly.
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  if (hasWe && !hasWs) ws = round6(1 - we);
  else if (hasWs && !hasWe) we = round6(1 - ws);

  const wsale = clampNumber(params?.get("wsale"), base.wsale, RANK_WSALE_MIN, RANK_WSALE_MAX);

  const requestedNorm = params?.get("norm");
  const normaliser = RANK_NORMALISERS.has(requestedNorm)
    ? requestedNorm
    : RANK_NORMALISER_BY_PRESET[preset] ?? RANK_NORMALISER_DEFAULT;

  return { preset, we, ws, wsale, normaliser };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * The blend — SPEC.md §4.1.
 *
 *     E    = experience_score / 100
 *     S    = normalise(cosine(profile, tagVector))
 *     P    = (cut ?? 0) / 100
 *     base = wE * E + wS * S
 *     rank = base * (1 + wSale * P * (atHistoricalLow ? 1.15 : 1))
 *
 * ADDITIVE FOR E AND S, MULTIPLICATIVE FOR SALE, and the asymmetry is the
 * design rather than an accident. E and S are CO-PILLARS, so a weight has to
 * behave like a weight: multiplying them would let a near-zero similarity
 * annihilate a 98 experience score, which is the opposite of what "co-pillar"
 * means and would put Portal nowhere. Sale is explicitly A BOOST, NEVER A
 * GATE (Rev 3's decision table), and a multiplier is what "boost" means — at
 * `wSale = 0` the sale term is EXACTLY 1.0 for every row, which is what makes
 * the default preset provably sale-blind rather than approximately so.
 *
 * 1.15 is the existing HISTORICAL_LOW_BONUS from src/score.js. No new
 * constants: the historical-low premium this app already uses is the one it
 * keeps using.
 *
 * @param {{experienceScore?: number|null, similarityNorm?: number|null, cut?: number|null, atHistoricalLow?: boolean}} row
 * @param {{we: number, ws: number, wsale: number}} weights
 * @returns {{e: number, s: number, p: number, base: number, saleMultiplier: number, rankScore: number}}
 */
export function blendRankScore(row, weights) {
  const e = clamp01((row?.experienceScore ?? 0) / 100);
  const s = clamp01(row?.similarityNorm ?? 0);
  const p = clamp01((row?.cut ?? 0) / 100);

  const base = weights.we * e + weights.ws * s;
  const saleMultiplier = 1 + weights.wsale * p * (row?.atHistoricalLow ? HISTORICAL_LOW_BONUS : 1);
  return { e, s, p, base, saleMultiplier, rankScore: base * saleMultiplier };
}

// ---------------------------------------------------------------------------
// Leave-one-out (SPEC.md §4.3) — the self-match trap
// ---------------------------------------------------------------------------

/** Contributions below this are treated as gone. Subtracting a float sum from
 * itself leaves ~1e-17 residue, and carrying 200 phantom tags at 1e-17 into a
 * cosine is noise dressed up as signal. */
const PROFILE_EPSILON = 1e-12;

/**
 * Rebuild the SUMMED (pre-IDF, pre-normalisation) profile vector from
 * buildProfile's own `contributions`.
 *
 * WHY THIS IS EXACT rather than an approximation: buildProfile constructs its
 * internal `summed` by adding, for each contributing game, exactly the
 * per-tag values it then reports as that game's `tagWeights`. Summing the
 * reported contributions therefore reproduces `summed` term for term. That
 * matters because it is what lets leave-one-out work WITHOUT touching
 * src/profile.js, which SPEC.md §9 puts in the hard out-of-scope list.
 *
 * @param {Array<{tagWeights: Object<string, number>}>} contributions
 * @returns {Object<string, number>}
 */
export function summedProfileFromContributions(contributions) {
  const summed = {};
  for (const contribution of contributions || []) {
    for (const [tag, value] of Object.entries(contribution?.tagWeights || {})) {
      summed[tag] = (summed[tag] || 0) + value;
    }
  }
  return summed;
}

/**
 * The profile as it would have been if ONE owned game had never contributed:
 * subtract that game's tag weights from the summed vector, re-apply IDF, re-
 * normalise.
 *
 * WHY THIS IS NEEDED. An owned game's tags helped build the profile, so
 * scoring it against that profile is circular — under the `similarity` preset
 * the top would fill with games James has already sunk 200 hours into, which
 * is the exact opposite of "more like what I play, that I have not played".
 *
 * WHY IT DOES NOT WEAKEN THE LIBRARY'S ROLE, which is the thing most easily
 * broken here by accident and is a defect condition, not a nicety (SPEC.md
 * §1, §4.3): only the CANDIDATE'S OWN contribution comes out. Every other
 * owned game still contributes in full — to this candidate's score and to
 * every other candidate's. There is no rebuild, no re-read, no stored state
 * touched; it is an O(tags) subtraction per owned candidate. src/profile.js
 * is not modified by this increment at all.
 *
 * @param {Object<string, number>} summed - from summedProfileFromContributions.
 * @param {Object<string, number>} tagWeights - the one game's contribution.
 * @param {Object<string, number>} idfMap
 * @returns {Object<string, number>} an IDF-weighted, L2-normalised profile.
 */
export function profileWithoutGame(summed, tagWeights, idfMap) {
  const reduced = {};
  for (const [tag, value] of Object.entries(summed || {})) {
    // Math.max guards the float residue from BOTH sides: a tiny negative is
    // physically meaningless (a tag cannot contribute less than nothing) and
    // would flip that tag's sign in the cosine.
    const remaining = Math.max(0, value - (tagWeights?.[tag] || 0));
    if (remaining > PROFILE_EPSILON) reduced[tag] = remaining;
  }
  // applyIdf does the IDF weighting AND the L2 normalisation, exactly as
  // buildProfile does on the full vector — same function, same order, so the
  // result is comparable with the full profile term for term.
  return applyIdf(reduced, idfMap || {});
}

// ---------------------------------------------------------------------------
// Low-confidence suppression (SPEC.md §7)
// ---------------------------------------------------------------------------

/** Below this review count a `low`-confidence judgement is a guess with
 * nothing to check it against. Ruling 2's measured band: the low-confidence
 * rate is 1% among the 923 games with 20,000+ reviews and 71% among the 5,904
 * under 200 — the model knows what people own and declines to bluff on the
 * rest, so review volume is the honest proxy for "is this score checkable".
 *
 * 200, NOT 1,000 — RULED BY JAMES 2026-09-03 (SPEC.md §12b.1), and the
 * measurement that moved it belongs next to the number.
 *
 * §7 asserted this would be "close to a no-op" under the `default` preset. It
 * was not: at the 1,000 bar it removed 6,812 rows, 37% of the scored
 * catalogue, and what it removed was not noise — Desvelado (experience 91),
 * Re:Fresh (88), The Happyhills Homicide 2 (88) and Mr. Rainer's Solve-It
 * Service (86) were all hidden purely for being obscure. A filter whose stated
 * job is "stop a bluffed score reaching a stranger's front page" was instead
 * deleting a third of the catalogue, including its best small games.
 *
 * At 200 it removes 4,209. James: "let's pull everything over 200 reviews, we
 * can always suppress later." The asymmetry in that sentence is the whole
 * reasoning: a bad row that surfaces is visible and cheap to fix, a good row
 * that never surfaces is invisible and is not. */
export const LOW_CONFIDENCE_REVIEW_FLOOR = 200;

/**
 * Would this row be suppressed as a low-confidence guess?
 *
 *     suppressed = experience_confidence = 'low'
 *                  AND (positive + negative) < LOW_CONFIDENCE_REVIEW_FLOOR
 *                  AND source_owned = 0
 *
 * The floor is the constant declared four lines above, not a literal repeated
 * here – §12b.1 moved it from 1,000 to 200 and this docstring is the one place
 * that could drift away from it again.
 *
 * WHY SUPPRESS AT ALL. Under the `default` preset this is close to a no-op —
 * low-confidence rows are overwhelmingly obscure and score low anyway. It
 * becomes genuinely load-bearing under `similarity`, where `wS` rises to 0.6
 * and an obscure game with a perfect tag match and a bluffed score is exactly
 * the row that surfaces. Increment 12 puts this in front of strangers, and a
 * bluffed score on the front page is the one failure this product cannot
 * absorb.
 *
 * WHY OWNED GAMES ARE EXEMPT, AND WHY THE EXEMPTION IS NOT BEHIND THE
 * SETTINGS KEY. Suppression exists for exactly one purpose: to stop a bluffed
 * score reaching a stranger's front page as a PURCHASE recommendation. An
 * owned game is never that case — James already bought it, so the only
 * question left is whether to play it, and a shaky one-line score is not a
 * reason to hide a game sitting in his own library from a list whose entire
 * job is "what do I play next". Measured against live D1: 552 owned games are
 * scored and 11 of them would be suppressed without this clause, including
 * Sol Cesto (experience 66, 879 reviews) and Abalon: Roguelike Tactics CCG
 * (63). Those are real play candidates. Hiding them contradicts James's
 * ruling of 2026-09-02 directly, which is why `source_owned` is checked HERE,
 * inside the predicate, and not at the call site where a future caller could
 * forget it — and why it holds whether `suppressLowConfidence` is on or off.
 *
 * @param {{experience_confidence?: string|null, positive?: number|null, negative?: number|null, source_owned?: number|null}} row
 * @returns {boolean}
 */
export function isLowConfidenceSuppressed(row) {
  if (row?.source_owned === 1) return false; // never, under any setting
  if (row?.experience_confidence !== "low") return false;
  const reviews = (row?.positive || 0) + (row?.negative || 0);
  return reviews < LOW_CONFIDENCE_REVIEW_FLOOR;
}

/** The settings key that turns suppression off, read through the existing
 * increment-8 settings lane. Default true. GET /api/settings returns only
 * what is STORED, so an untouched store yields an unchanged response and the
 * new key is no zero-diff breach (SPEC.md §10) — it appears only once written. */
export const SUPPRESS_LOW_CONFIDENCE_KEY = "suppressLowConfidence";
