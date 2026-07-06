// Steam Sale Scout — candidate ranking (Increment 3).
//
// Pure, dependency-free ESM (aside from profile.js's tag-vector builder) so
// it can be imported both by src/worker.js and by `node --test`.

import { buildTagVector } from "./profile.js";

/** Review-quality clamp bounds. */
export const QUALITY_MIN = 0.5;
export const QUALITY_MAX = 1;

/** Quality assumed for a game with too few reviews to trust the ratio. */
export const NEUTRAL_QUALITY = 0.75;

/** Below this many total (positive+negative) reviews, use NEUTRAL_QUALITY
 * instead of the raw ratio. */
export const NEUTRAL_REVIEW_THRESHOLD = 50;

/** Multiplier applied to rankScore when a deal is at its historical low. */
export const HISTORICAL_LOW_BONUS = 1.15;

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
 * Review-quality score, clamped to [0.5, 1], falling back to a neutral 0.75
 * when there are too few total reviews to trust the ratio.
 * @param {number|undefined} positive
 * @param {number|undefined} negative
 * @returns {number}
 */
export function quality(positive, negative) {
  const total = (positive || 0) + (negative || 0);
  if (total < NEUTRAL_REVIEW_THRESHOLD) return NEUTRAL_QUALITY;
  const ratio = positive / total;
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, ratio));
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
 * `excludedCount`. During a cold-start cache build this means the excluded
 * count temporarily includes "not yet fetched" candidates alongside
 * permanently-tagless ones — it self-corrects as the queue completes
 * (tracked separately by /api/recs's fetched/total).
 *
 * @param {Object<string, number>} profile - L2-normalised taste profile.
 * @param {Array<{appid: number|null, tags?: Object<string,number>, reviews?: {positive?: number, negative?: number}, atHistoricalLow?: boolean}>} candidates
 * @returns {{recs: Array<object>, excludedCount: number}}
 */
export function scoreCandidates(profile, candidates) {
  let excludedCount = 0;
  const scored = [];

  for (const candidate of candidates) {
    const tagVector = candidate.appid != null ? buildTagVector(candidate.tags) : {};
    if (candidate.appid == null || Object.keys(tagVector).length === 0) {
      excludedCount++;
      continue;
    }

    const similarity = cosineSimilarity(profile, tagVector);
    const reviews = candidate.reviews || {};
    const qualityValue = quality(reviews.positive, reviews.negative);
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
  return { recs: scored, excludedCount };
}
