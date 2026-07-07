// Steam Sale Scout — candidate ranking (Increment 4).
//
// Pure, dependency-free ESM (aside from profile.js's tag-vector builder) so
// it can be imported both by src/worker.js and by `node --test`.

import { buildTagVector, applyIdf } from "./profile.js";

/** Multiplier applied to rankScore when a deal is at its historical low. */
export const HISTORICAL_LOW_BONUS = 1.15;

/** Hard quality floors, applied after scoring but before a candidate is
 * allowed into `recs` (Increment 4 — kills shovelware that the Wilson bound
 * alone doesn't zero out, e.g. a game with exactly 51 mixed reviews). */
export const MIN_REVIEWS = 50;
export const MIN_QUALITY = 0.7;
export const MIN_OWNERS = 5000;

/**
 * Cosine similarity between two sparse tag vectors (tag -> weight). Returns
 * 0 (rather than NaN) if either vector has zero magnitude.
 * @param {Object<string, number>} a
 * @param {Object<string, number>} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  for (const key of keys) {
    dot += (a[key] || 0) * (b[key] || 0);
  }

  let magA = 0;
  for (const v of Object.values(a)) magA += v * v;
  let magB = 0;
  for (const v of Object.values(b)) magB += v * v;

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * The lower bound of the 95% Wilson confidence interval on the true
 * positive-review ratio, given `pos` positive and `neg` negative reviews.
 * Unlike a raw ratio, this is naturally punishing when there are few
 * reviews (wide interval -> low bound) and converges toward the ratio as
 * reviews pile up (narrow interval) — so thin-review shovelware can't
 * free-ride on a lucky 100% ratio from three reviews.
 * @param {number} pos
 * @param {number} neg
 * @param {number} z - the confidence z-score (1.96 = 95%).
 * @returns {number}
 */
export function wilsonLowerBound(pos, neg, z = 1.96) {
  const n = pos + neg;
  if (n === 0) return 0;
  const phat = pos / n;
  const z2 = z * z;
  return (phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/**
 * Review-quality score: the Wilson lower bound on the positive-review
 * ratio. No clamping, no neutral default for thin-review games — a game
 * with 0 reviews scores 0.
 * @param {number|undefined} positive
 * @param {number|undefined} negative
 * @returns {number}
 */
export function quality(positive, negative) {
  return wilsonLowerBound(positive || 0, negative || 0);
}

/**
 * Final rank score: similarity x quality x historical-low bonus. Discount
 * depth itself is not a factor here — minCut already gated which deals made
 * it into the candidate pool, so this doesn't double-count it.
 * @param {number} similarity
 * @param {number} qualityValue
 * @param {boolean} atHistoricalLow
 * @returns {number}
 */
export function rankScore(similarity, qualityValue, atHistoricalLow) {
  return similarity * qualityValue * (atHistoricalLow ? HISTORICAL_LOW_BONUS : 1);
}

/**
 * Score and rank candidate deals against a taste profile.
 *
 * Candidates with `appid == null` or with no usable tags (SteamSpy tags
 * missing/empty — whether because they genuinely have none, e.g. a
 * DLC/bundle, or because their tag data simply hasn't been fetched yet by
 * the background queue) are excluded from `recs` and counted in
 * `excludedCount`. Callers that need to tell "not yet fetched" apart from
 * "permanently tagless" (e.g. for a UI footnote) should filter those out
 * before calling scoreCandidates — see src/worker.js's `pendingCount`.
 *
 * Scoreable candidates that clear the tag check but fail any of the hard
 * quality floors (MIN_REVIEWS total reviews, MIN_QUALITY Wilson score,
 * MIN_OWNERS SteamSpy owners-midpoint) are excluded from `recs` and counted
 * separately in `qualityExcludedCount`, so the two exclusion reasons don't
 * get conflated. A candidate with no owners data at all (`owners`
 * undefined) is treated as failing MIN_OWNERS (0) — see src/worker.js,
 * which only calls scoreCandidates with cached (fetched) SteamSpy entries,
 * so a candidate with tags will also have an owners value; missing owners
 * alongside present tags should be rare in practice.
 *
 * @param {Object<string, number>} profile - taste profile (L2-normalised, or IDF-weighted if idfMap given).
 * @param {Array<{appid: number|null, tags?: Object<string,number>, reviews?: {positive?: number, negative?: number}, owners?: number, atHistoricalLow?: boolean}>} candidates
 * @param {Object<string, number>|null} [idfMap] - tag -> idf weight, applied to each candidate's tag vector before cosine similarity. Omit to score unweighted (pre-inc-4 behaviour).
 * @returns {{recs: Array<object>, excludedCount: number, qualityExcludedCount: number}}
 */
export function scoreCandidates(profile, candidates, idfMap = null) {
  let excludedCount = 0;
  let qualityExcludedCount = 0;
  const scored = [];

  for (const candidate of candidates) {
    const rawTagVector = candidate.appid != null ? buildTagVector(candidate.tags) : {};
    if (candidate.appid == null || Object.keys(rawTagVector).length === 0) {
      excludedCount++;
      continue;
    }

    const reviews = candidate.reviews || {};
    const totalReviews = (reviews.positive || 0) + (reviews.negative || 0);
    const qualityValue = quality(reviews.positive, reviews.negative);
    const owners = candidate.owners || 0;
    if (totalReviews < MIN_REVIEWS || qualityValue < MIN_QUALITY || owners < MIN_OWNERS) {
      qualityExcludedCount++;
      continue;
    }

    const tagVector = idfMap ? applyIdf(rawTagVector, idfMap) : rawTagVector;
    const similarity = cosineSimilarity(profile, tagVector);
    const score = rankScore(similarity, qualityValue, Boolean(candidate.atHistoricalLow));

    scored.push({
      ...candidate,
      similarity,
      quality: qualityValue,
      rankScore: score,
      tagVector,
    });
  }

  scored.sort((a, b) => b.rankScore - a.rankScore);
  return { recs: scored, excludedCount, qualityExcludedCount };
}
