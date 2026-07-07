// Tests for src/score.js — the pure candidate-ranking engine (Increment 4:
// Wilson-bound quality, hard quality floors, IDF-weighted similarity).

import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_REVIEWS,
  MIN_QUALITY,
  MIN_OWNERS,
  HISTORICAL_LOW_BONUS,
  cosineSimilarity,
  wilsonLowerBound,
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
// wilsonLowerBound — the 95% Wilson lower bound, replacing the inc-3
// clamp + neutral default entirely.
// ---------------------------------------------------------------------------

test("wilsonLowerBound: 0 reviews -> 0", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test("wilsonLowerBound: spec anchor — 92%-positive with 12 reviews (pos=11, neg=1) ~= 0.64", () => {
  const bound = wilsonLowerBound(11, 1);
  assert.ok(Math.abs(bound - 0.64) < 0.02, `expected ~0.64, got ${bound}`);
});

test("wilsonLowerBound: spec anchor — 92%-positive with 4000 reviews (pos=3680, neg=320) ~= 0.91", () => {
  const bound = wilsonLowerBound(3680, 320);
  assert.ok(Math.abs(bound - 0.91) < 0.01, `expected ~0.91, got ${bound}`);
});

test("wilsonLowerBound: more reviews at the same ratio pushes the bound closer to the raw ratio", () => {
  const thin = wilsonLowerBound(11, 1); // 12 reviews, 91.7%
  const deep = wilsonLowerBound(3680, 320); // 4000 reviews, 92%
  assert.ok(deep > thin);
});

test("wilsonLowerBound: extreme n (very large, 100% positive) approaches 1 but never reaches it", () => {
  const bound = wilsonLowerBound(1_000_000, 0);
  assert.ok(bound < 1);
  assert.ok(bound > 0.999);
});

test("wilsonLowerBound: a single positive review scores low — thin-review shovelware can't free-ride", () => {
  const bound = wilsonLowerBound(1, 0);
  assert.ok(bound < 0.5, `expected a heavily-discounted bound, got ${bound}`);
});

test("wilsonLowerBound: negative-only reviews score 0-ish regardless of volume", () => {
  assert.ok(wilsonLowerBound(0, 100) < 0.05);
});

test("quality: is exactly wilsonLowerBound(positive, negative)", () => {
  assert.equal(quality(80, 20), wilsonLowerBound(80, 20));
});

test("quality: missing positive/negative defaults to 0/0 -> 0, not a neutral default", () => {
  assert.equal(quality(undefined, undefined), 0);
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
// scoreCandidates — exclusion + counting, ranking, partial-cache safety,
// and (Increment 4) the hard quality floors.
// ---------------------------------------------------------------------------

// Reviews/owners comfortably clear all three floors (MIN_REVIEWS=50,
// MIN_QUALITY=0.70, MIN_OWNERS=5000) by default so tests about tags/ranking
// aren't incidentally tripped up by the floors; floor tests below override
// these explicitly.
function candidate(overrides = {}) {
  return {
    appid: 100,
    title: "Some Game",
    tags: { Roguelike: 10 },
    reviews: { positive: 400, negative: 100 }, // 500 total, wilson ~0.76
    owners: 50000,
    atHistoricalLow: false,
    ...overrides,
  };
}

test("scoreCandidates: a candidate with appid=null is excluded and counted (before quality floors)", () => {
  const profile = { Roguelike: 1 };
  const { recs, excludedCount, qualityExcludedCount } = scoreCandidates(profile, [candidate({ appid: null })]);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 1);
  assert.equal(qualityExcludedCount, 0);
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
  assert.equal(recs[0].quality, wilsonLowerBound(400, 100));
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
  // Both clear every quality floor (n=2000, well above MIN_REVIEWS; wilson
  // bound well above MIN_QUALITY for both) — the ranking gap comes from
  // similarity (1 tag vs 2 matching tags) and quality (76% vs 95%), not
  // from one of them being floored out.
  const low = candidate({ appid: 1, tags: { Roguelike: 1 }, reviews: { positive: 1520, negative: 480 } }); // wilson ~0.74
  const high = candidate({ appid: 2, tags: { Roguelike: 10, Strategy: 10 }, reviews: { positive: 1900, negative: 100 } }); // wilson ~0.94
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

test("scoreCandidates: an empty candidate list returns an empty recs array and 0 excluded/floored", () => {
  const { recs, excludedCount, qualityExcludedCount } = scoreCandidates({ Roguelike: 1 }, []);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 0);
  assert.equal(qualityExcludedCount, 0);
});

// ---------------------------------------------------------------------------
// Hard quality floors (Increment 4) — MIN_REVIEWS, MIN_QUALITY, MIN_OWNERS.
// Floored candidates are excluded from recs and counted separately from
// tagless/null-appid exclusions.
// ---------------------------------------------------------------------------

test("MIN_REVIEWS/MIN_QUALITY/MIN_OWNERS default config", () => {
  assert.equal(MIN_REVIEWS, 50);
  assert.equal(MIN_QUALITY, 0.7);
  assert.equal(MIN_OWNERS, 5000);
});

test("scoreCandidates: below MIN_REVIEWS total reviews is floored (qualityExcludedCount), not scored", () => {
  const profile = { Roguelike: 1 };
  const c = candidate({ reviews: { positive: 40, negative: 5 } }); // 45 total < 50
  const { recs, excludedCount, qualityExcludedCount } = scoreCandidates(profile, [c]);
  assert.deepEqual(recs, []);
  assert.equal(excludedCount, 0);
  assert.equal(qualityExcludedCount, 1);
});

test("scoreCandidates: below MIN_QUALITY Wilson score is floored even with plenty of reviews", () => {
  const profile = { Roguelike: 1 };
  const c = candidate({ reviews: { positive: 60, negative: 40 } }); // 100 total, 60% positive -> wilson well under 0.70
  assert.ok(wilsonLowerBound(60, 40) < MIN_QUALITY);
  const { recs, qualityExcludedCount } = scoreCandidates(profile, [c]);
  assert.deepEqual(recs, []);
  assert.equal(qualityExcludedCount, 1);
});

test("scoreCandidates: below MIN_OWNERS is floored even with great reviews", () => {
  const profile = { Roguelike: 1 };
  const c = candidate({ owners: 1000 });
  const { recs, qualityExcludedCount } = scoreCandidates(profile, [c]);
  assert.deepEqual(recs, []);
  assert.equal(qualityExcludedCount, 1);
});

test("scoreCandidates: missing owners (undefined) is treated as 0 -> fails MIN_OWNERS", () => {
  const profile = { Roguelike: 1 };
  const c = candidate({ owners: undefined });
  const { recs, qualityExcludedCount } = scoreCandidates(profile, [c]);
  assert.deepEqual(recs, []);
  assert.equal(qualityExcludedCount, 1);
});

test("scoreCandidates: a candidate clearing every floor is scored normally", () => {
  const profile = { Roguelike: 1 };
  const c = candidate({ reviews: { positive: 400, negative: 100 }, owners: 50000 });
  const { recs, qualityExcludedCount } = scoreCandidates(profile, [c]);
  assert.equal(recs.length, 1);
  assert.equal(qualityExcludedCount, 0);
});

test("scoreCandidates: qualityExcludedCount stays distinct from excludedCount across a mixed pool", () => {
  const profile = { Roguelike: 1 };
  const candidates = [
    candidate({ appid: null }), // excludedCount: null appid
    candidate({ appid: 2, tags: {} }), // excludedCount: tagless
    candidate({ appid: 3, owners: 100 }), // qualityExcludedCount: below MIN_OWNERS
    candidate({ appid: 4 }), // scored
  ];
  const { recs, excludedCount, qualityExcludedCount } = scoreCandidates(profile, candidates);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].appid, 4);
  assert.equal(excludedCount, 2);
  assert.equal(qualityExcludedCount, 1);
});

// ---------------------------------------------------------------------------
// IDF weighting (Increment 4) — applied to both profile and candidate
// vectors before cosine similarity when an idfMap is passed.
// ---------------------------------------------------------------------------

test("scoreCandidates: without an idfMap, similarity is computed on the raw (unweighted) tag vector — pre-inc-4 behaviour preserved", () => {
  const profile = { Roguelike: 1 };
  const c = candidate({ tags: { Roguelike: 10 } });
  const { recs } = scoreCandidates(profile, [c]);
  assert.ok(Math.abs(recs[0].similarity - 1) < 1e-9);
});

test("scoreCandidates: an idfMap zeroing out a candidate's only tag collapses similarity to 0", () => {
  const profile = { Roguelike: 1 };
  const c = candidate({ tags: { Roguelike: 10 } });
  const idfMap = { Roguelike: 0 }; // maximally generic — present in every doc
  const { recs } = scoreCandidates(profile, [c], idfMap);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].similarity, 0);
});

test("scoreCandidates: an idfMap that favours the profile's distinctive tag over its generic one raises similarity vs unweighted", () => {
  // Candidate's raw vote-share leans Generic (0.9/0.1), but the profile
  // leans Distinctive (0.1/0.9) — idf should reweight the candidate toward
  // Distinctive and pull similarity up, not down.
  const profile = { Generic: 0.1, Distinctive: 0.9 };
  const c = candidate({ tags: { Generic: 90, Distinctive: 10 } });
  const idfMap = { Generic: 0.01, Distinctive: 2 };

  const withoutIdf = scoreCandidates(profile, [c]).recs[0].similarity;
  const withIdf = scoreCandidates(profile, [c], idfMap).recs[0].similarity;
  assert.ok(withIdf > withoutIdf, `expected idf-weighted similarity (${withIdf}) > raw (${withoutIdf})`);
});
