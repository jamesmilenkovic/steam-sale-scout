// Tests for src/score.js — the pure candidate-ranking engine (Increment 3).

import test from "node:test";
import assert from "node:assert/strict";
import {
  QUALITY_MIN,
  QUALITY_MAX,
  NEUTRAL_QUALITY,
  NEUTRAL_REVIEW_THRESHOLD,
  HISTORICAL_LOW_BONUS,
  cosineSimilarity,
  quality,
  rankScore,
  scoreCandidates,
} from "../src/score.js";

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

test("cosineSimilarity: identical vectors -> similarity 1", () => {
  const v = { a: 0.6, b: 0.8 };
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
});

test("cosineSimilarity: orthogonal (no overlapping tags) -> similarity 0", () => {
  assert.equal(cosineSimilarity({ a: 1 }, { b: 1 }), 0);
});

test("cosineSimilarity: partial overlap gives a value strictly between 0 and 1", () => {
  const sim = cosineSimilarity({ a: 1, b: 1 }, { a: 1, c: 1 });
  assert.ok(sim > 0 && sim < 1);
});

test("cosineSimilarity: a zero-magnitude vector returns 0, not NaN", () => {
  assert.equal(cosineSimilarity({}, { a: 1 }), 0);
  assert.equal(cosineSimilarity({ a: 1 }, {}), 0);
  assert.equal(cosineSimilarity({}, {}), 0);
});

// ---------------------------------------------------------------------------
// quality — clamp [0.5, 1], neutral 0.75 under 50 total reviews.
// ---------------------------------------------------------------------------

test("quality: below NEUTRAL_REVIEW_THRESHOLD (50) total reviews -> NEUTRAL_QUALITY regardless of ratio", () => {
  assert.equal(NEUTRAL_REVIEW_THRESHOLD, 50);
  assert.equal(NEUTRAL_QUALITY, 0.75);
  assert.equal(quality(1, 0), NEUTRAL_QUALITY); // 1 total review, 100% positive
  assert.equal(quality(0, 49), NEUTRAL_QUALITY); // 49 total, 0% positive
});

test("quality: exactly at the 50-review threshold uses the real ratio, not neutral", () => {
  assert.equal(quality(50, 0), QUALITY_MAX); // 50 total, 100% positive -> clamps to 1
});

test("quality: a bad ratio (>=50 reviews) clamps up to QUALITY_MIN (0.5)", () => {
  assert.equal(QUALITY_MIN, 0.5);
  assert.equal(quality(5, 95), QUALITY_MIN); // 5% positive, clamped
});

test("quality: a great ratio (>=50 reviews) clamps down to QUALITY_MAX (1)", () => {
  assert.equal(QUALITY_MAX, 1);
  assert.equal(quality(100, 0), QUALITY_MAX);
});

test("quality: a mid ratio with enough reviews passes through unclamped", () => {
  assert.equal(quality(70, 30), 0.7);
});

test("quality: missing positive/negative defaults to 0/0 -> neutral (total 0 < 50)", () => {
  assert.equal(quality(undefined, undefined), NEUTRAL_QUALITY);
});

// ---------------------------------------------------------------------------
// rankScore — similarity x quality x historical-low bonus.
// ---------------------------------------------------------------------------

test("rankScore: multiplies similarity x quality with no bonus when not at historical low", () => {
  assert.equal(rankScore(0.5, 0.8, false), 0.4);
});

test("rankScore: applies HISTORICAL_LOW_BONUS (1.15) when at historical low", () => {
  assert.equal(HISTORICAL_LOW_BONUS, 1.15);
  const expected = 0.5 * 0.8 * 1.15;
  assert.ok(Math.abs(rankScore(0.5, 0.8, true) - expected) < 1e-9);
});

// ---------------------------------------------------------------------------
// scoreCandidates — exclusion + counting, ranking, partial-cache safety.
// ---------------------------------------------------------------------------

function candidate(overrides = {}) {
  return {
    appid: 100,
    title: "Some Game",
    tags: { Roguelike: 10 },
    reviews: { positive: 80, negative: 20 },
    atHistoricalLow: false,
    ...overrides,
  };
}

test("scoreCandidates: a candidate with appid=null is excluded and counted", () => {
  const profile = { Roguelike: 1 };
  const { recs, excludedCount } = scoreCandidates(profile, [candidate({ appid: null })]);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 1);
});

test("scoreCandidates: a candidate with no tags (empty object) is excluded and counted", () => {
  const profile = { Roguelike: 1 };
  const { recs, excludedCount } = scoreCandidates(profile, [candidate({ tags: {} })]);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 1);
});

test("scoreCandidates: a candidate whose tags are missing entirely (undefined) is excluded and counted", () => {
  const profile = { Roguelike: 1 };
  const { recs, excludedCount } = scoreCandidates(profile, [candidate({ tags: undefined })]);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 1);
});

test("scoreCandidates: a candidate whose tags are ALL stoplisted is excluded and counted (empty vector after buildTagVector)", () => {
  const profile = { Roguelike: 1 };
  const { recs, excludedCount } = scoreCandidates(profile, [candidate({ tags: { Singleplayer: 500 } })]);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 1);
});

test("scoreCandidates: a scoreable candidate gets similarity/quality/rankScore attached", () => {
  const profile = { Roguelike: 1 };
  const { recs, excludedCount } = scoreCandidates(profile, [candidate()]);
  assert.equal(excludedCount, 0);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].similarity > 0);
  assert.equal(recs[0].quality, 0.8); // 80/100
  assert.ok(recs[0].rankScore > 0);
});

test("scoreCandidates: preserves all original candidate fields alongside the new scoring fields", () => {
  const profile = { Roguelike: 1 };
  const { recs } = scoreCandidates(profile, [candidate({ title: "Balatro", cut: 60, price: 12.5 })]);
  assert.equal(recs[0].title, "Balatro");
  assert.equal(recs[0].cut, 60);
  assert.equal(recs[0].price, 12.5);
});

test("scoreCandidates: sorts descending by rankScore", () => {
  const profile = { Roguelike: 1, Strategy: 1 };
  const low = candidate({ appid: 1, tags: { Roguelike: 1 }, reviews: { positive: 60, negative: 40 } }); // similarity lower, quality lower
  const high = candidate({ appid: 2, tags: { Roguelike: 10, Strategy: 10 }, reviews: { positive: 95, negative: 5 } });
  const { recs } = scoreCandidates(profile, [low, high]);
  assert.equal(recs[0].appid, 2);
  assert.equal(recs[1].appid, 1);
});

test("scoreCandidates: HISTORICAL_LOW_BONUS can flip the ranking order", () => {
  const profile = { Roguelike: 1 };
  // Identical similarity/quality, but B is at historical low -> B should rank first.
  const a = candidate({ appid: 1, atHistoricalLow: false });
  const b = candidate({ appid: 2, atHistoricalLow: true });
  const { recs } = scoreCandidates(profile, [a, b]);
  assert.equal(recs[0].appid, 2);
});

test("scoreCandidates: mixed pool (some pending/tagless, some scoreable) doesn't crash — partial-cache safety", () => {
  const profile = { Roguelike: 1 };
  const candidates = [
    candidate({ appid: 1, tags: { Roguelike: 10 } }), // scoreable
    candidate({ appid: 2, tags: {} }), // not yet fetched / no tags
    candidate({ appid: null }), // unresolvable appid
    candidate({ appid: 3, tags: { Roguelike: 5 } }), // scoreable
  ];
  const { recs, excludedCount } = scoreCandidates(profile, candidates);
  assert.equal(recs.length, 2);
  assert.equal(excludedCount, 2);
  assert.deepEqual(recs.map((r) => r.appid).sort(), [1, 3]);
});

test("scoreCandidates: an empty candidate list returns an empty recs array and 0 excluded", () => {
  const { recs, excludedCount } = scoreCandidates({ Roguelike: 1 }, []);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 0);
});
