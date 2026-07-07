// Tests for src/hallOfFame.js — the "Best of Steam" qualification + ranking
// logic (Increment 5). Reuses src/score.js's Wilson quality() — no new
// review-quality math here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  HOF_MIN_REVIEWS,
  HOF_MIN_RATIO,
  qualifiesForHof,
  hofScore,
  buildHallOfFame,
} from "../src/hallOfFame.js";

test("config thresholds match the spec exactly", () => {
  assert.equal(HOF_MIN_REVIEWS, 10000);
  assert.equal(HOF_MIN_RATIO, 0.95);
});

// ---------------------------------------------------------------------------
// qualifiesForHof
// ---------------------------------------------------------------------------

test("qualifiesForHof: true at exactly the review-count and ratio floors", () => {
  // 9500/10000 = 0.95 exactly.
  assert.equal(qualifiesForHof({ reviews: { positive: 9500, negative: 500 } }), true);
});

test("qualifiesForHof: false just below the review-count floor even with a perfect ratio", () => {
  assert.equal(qualifiesForHof({ reviews: { positive: 9999, negative: 0 } }), false);
});

test("qualifiesForHof: false just below the ratio floor even with huge volume", () => {
  // 94.9% positive, 100000 reviews.
  assert.equal(qualifiesForHof({ reviews: { positive: 94900, negative: 5100 } }), false);
});

test("qualifiesForHof: missing/empty reviews is false, not a throw", () => {
  assert.equal(qualifiesForHof({}), false);
  assert.equal(qualifiesForHof({ reviews: {} }), false);
  assert.equal(qualifiesForHof({ reviews: undefined }), false);
});

// ---------------------------------------------------------------------------
// hofScore
// ---------------------------------------------------------------------------

test("hofScore: discount depth x quality, both on a 0-1 scale", () => {
  assert.ok(Math.abs(hofScore(50, 0.9) - 0.45) < 1e-9);
  assert.equal(hofScore(0, 0.9), 0);
  assert.equal(hofScore(100, 0), 0);
});

test("hofScore: a deeper discount at equal quality scores higher", () => {
  assert.ok(hofScore(80, 0.9) > hofScore(40, 0.9));
});

test("hofScore: higher quality at equal discount scores higher", () => {
  assert.ok(hofScore(50, 0.98) > hofScore(50, 0.9));
});

// ---------------------------------------------------------------------------
// buildHallOfFame — qualification + ordering together
// ---------------------------------------------------------------------------

test("buildHallOfFame: excludes non-qualifying candidates entirely", () => {
  const candidates = [
    { appid: 1, cut: 90, reviews: { positive: 100, negative: 0 } }, // too few reviews
    { appid: 2, cut: 90, reviews: { positive: 9500, negative: 500 } }, // qualifies
  ];
  const hof = buildHallOfFame(candidates);
  assert.equal(hof.length, 1);
  assert.equal(hof[0].appid, 2);
});

test("buildHallOfFame: orders by hofScore descending (discount depth x Wilson quality), not by raw review count", () => {
  const shallowDiscountHighVolume = {
    appid: 1,
    cut: 40,
    reviews: { positive: 950000, negative: 50000 }, // huge volume, 95%
  };
  const deepDiscountSameRatio = {
    appid: 2,
    cut: 90,
    reviews: { positive: 9500, negative: 500 }, // far fewer reviews, same 95% ratio
  };
  const hof = buildHallOfFame([shallowDiscountHighVolume, deepDiscountSameRatio]);
  assert.equal(hof.length, 2);
  // Wilson quality converges as volume grows, but a much deeper discount
  // still wins on hofScore's discount-depth factor.
  assert.equal(hof[0].appid, 2);
  assert.equal(hof[1].appid, 1);
});

test("buildHallOfFame: attaches quality and hofScore to each returned candidate", () => {
  const hof = buildHallOfFame([{ appid: 1, cut: 75, reviews: { positive: 9500, negative: 500 } }]);
  assert.equal(hof.length, 1);
  assert.ok(hof[0].quality > 0 && hof[0].quality <= 1);
  assert.ok(hof[0].hofScore > 0);
});

test("buildHallOfFame: empty/missing candidates array returns []", () => {
  assert.deepEqual(buildHallOfFame([]), []);
  assert.deepEqual(buildHallOfFame(undefined), []);
});
