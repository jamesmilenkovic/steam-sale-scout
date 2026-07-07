// Steam Sale Scout — "Best of Steam" hall-of-fame lane (Increment 5).
//
// Pure, dependency-free ESM (aside from score.js's Wilson-quality helper) so
// it can be imported both by src/worker.js and by `node --test`, mirroring
// src/score.js's seam.
//
// Taste-agnostic by design: candidates qualify purely on review volume/ratio
// (config thresholds below), never on similarity to James's taste profile.
// Similarity is computed elsewhere (src/score.js's cosineSimilarity) and
// attached by the caller as a secondary display field only — this module
// never sorts on it. No new data: reviews/owners are already fetched as
// part of the existing SteamSpy v2 trio (see src/spyQueue.js); candidates
// are drawn from the same deals pool as Recs, which already excludes owned
// games.

import { quality } from "./score.js";

/** Minimum total reviews (positive + negative) to qualify — filters out
 * anything too thin to trust, however high its ratio. */
export const HOF_MIN_REVIEWS = 10000;

/** Minimum positive-review ratio to qualify — roughly Steam's own
 * "Overwhelmingly Positive" tier. */
export const HOF_MIN_RATIO = 0.95;

/** Sort-score exponents: score = discountDepth^HOF_DISCOUNT_WEIGHT x
 * qualityValue^HOF_QUALITY_WEIGHT. Both default to 1 (a plain product) —
 * config knobs to retune the balance later without touching the formula. */
export const HOF_DISCOUNT_WEIGHT = 1;
export const HOF_QUALITY_WEIGHT = 1;

/**
 * Whether a candidate's reviews clear the Hall-of-Fame bar: at least
 * HOF_MIN_REVIEWS total reviews AND at least HOF_MIN_RATIO of them positive.
 * @param {{reviews?: {positive?: number, negative?: number}}} candidate
 * @returns {boolean}
 */
export function qualifiesForHof(candidate) {
  const reviews = candidate?.reviews || {};
  const positive = reviews.positive || 0;
  const negative = reviews.negative || 0;
  const total = positive + negative;
  if (total < HOF_MIN_REVIEWS) return false;
  return positive / total >= HOF_MIN_RATIO;
}

/**
 * Hall-of-Fame sort score: discount depth (0-1) x Wilson quality (0-1),
 * each optionally weighted by an exponent (see HOF_DISCOUNT_WEIGHT/
 * HOF_QUALITY_WEIGHT above).
 * @param {number} cut - discount percentage (0-100).
 * @param {number} qualityValue - Wilson lower bound (0-1), from score.js's quality().
 * @returns {number}
 */
export function hofScore(cut, qualityValue) {
  const discountDepth = Math.max(0, cut || 0) / 100;
  return Math.pow(discountDepth, HOF_DISCOUNT_WEIGHT) * Math.pow(qualityValue, HOF_QUALITY_WEIGHT);
}

/**
 * Filter candidates to those qualifying for Hall of Fame, score, and sort
 * by hofScore descending. Each returned candidate keeps its original fields
 * plus `quality` (Wilson lower bound) and `hofScore`.
 * @param {Array<{cut?: number, reviews?: {positive?: number, negative?: number}}>} candidates
 * @returns {Array<object>}
 */
export function buildHallOfFame(candidates) {
  const qualifying = (candidates || []).filter(qualifiesForHof);

  const scored = qualifying.map((candidate) => {
    const qualityValue = quality(candidate.reviews?.positive, candidate.reviews?.negative);
    return {
      ...candidate,
      quality: qualityValue,
      hofScore: hofScore(candidate.cut, qualityValue),
    };
  });

  scored.sort((a, b) => b.hofScore - a.hofScore);
  return scored;
}
