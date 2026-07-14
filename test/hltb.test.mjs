// Tests for src/hltb.js — the pure HowLongToBeat adapter logic (Increment 7).
//
// Fixtures for parseHltbSearch are shaped from the REAL live-probe capture
// (Portal 2 / Hades / Stardew Valley / Baldur's Gate 3 / Vampire Survivors —
// see the orchestrator's probe-findings handoff): nested `{count, data:[...]}`
// as-is, comp_main/comp_plus/comp_100 in SECONDS. A flattened mock would be a
// bug per the increment-6 historical-low lesson.
//
// Network/queue functions (hltbInit/hltbSearch/enqueueHltbFetch) are covered
// via the worker-level tests in test/worker-fpm.test.mjs, which exercise them
// through a mocked globalThis.fetch — no real network call is ever made from
// either test file.

import test from "node:test";
import assert from "node:assert/strict";
import {
  FPM_MATCH_THRESHOLD,
  FPM_MIN_LENGTH_HOURS,
  FPM_LENGTH_FIELD,
  FPM_MIN_REVIEWS,
  FPM_MIN_QUALITY,
  FPM_MIN_OWNERS,
  FPM_FORMULA,
  FPM_QUALITY_EXP,
  FPM_BREADTH_WEIGHT,
  parseHltbSearch,
  hltbLengthSeconds,
  normalizeTitle,
  titleSimilarity,
  matchHltbEntry,
  qualifiesForFpmFloor,
  fpmScore,
  funPerHourDisplay,
  qualifiesForFpm,
  sortFpmLane,
  fpmWhyLine,
  getCachedHltb,
} from "../src/hltb.js";
import { wilsonLowerBound } from "../src/score.js";

// ---------------------------------------------------------------------------
// parseHltbSearch — THE repair surface.
// ---------------------------------------------------------------------------

/** One real-shape /api/bleed response, trimmed to the fields parseHltbSearch
 * reads, mirroring the live-captured Portal 2 search (game_id 7231,
 * comp_main 30743s = 8.54h) plus its DLC sibling (comp_main 0 — a real
 * "no usable length" entry from the same capture). */
const portal2Response = {
  color: "blue",
  title: "",
  category: "games",
  count: 6,
  pageCurrent: 1,
  pageTotal: 1,
  pageSize: 20,
  data: [
    {
      game_id: 7231,
      game_name: "Portal 2",
      game_name_date: 0,
      game_alias: "",
      game_type: "game",
      game_image: "Portal2cover.jpg",
      comp_main: 30743,
      comp_plus: 49416,
      comp_100: 81139,
      comp_all: 38127,
      review_score: 90,
      count_review: 8011,
      profile_platform: "Linux, Mac, Nintendo Switch, PC, PlayStation 3, Xbox 360",
      profile_popular: 1869,
      release_world: 2011,
    },
    {
      game_id: 27601,
      game_name: "Portal 2: Sixense Perceptual Pack",
      game_name_date: 0,
      game_alias: "",
      game_type: "game",
      comp_main: 0,
      comp_plus: 0,
      comp_100: 0,
      review_score: 60,
      count_review: 1,
    },
  ],
};

const baldursGate3Response = {
  color: "blue",
  count: 1,
  data: [
    {
      game_id: 68033,
      game_name: "Baldur's Gate 3",
      game_alias: "Baldur's Gate III",
      game_type: "game",
      comp_main: 262612,
      comp_plus: 419669,
      comp_100: 650174,
      review_score: 93,
      count_review: 4065,
    },
  ],
};

test("parseHltbSearch: real-shape response parses into normalized entries, no profile_steam field needed", () => {
  const entries = parseHltbSearch(portal2Response);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    hltbId: 7231,
    name: "Portal 2",
    alias: "",
    compMain: 30743,
    compPlus: 49416,
    comp100: 81139,
  });
  assert.equal(entries[1].compMain, 0); // real "no usable length" entry
});

test("parseHltbSearch: keeps game_alias when present (Baldur's Gate 3 / Baldur's Gate III)", () => {
  const entries = parseHltbSearch(baldursGate3Response);
  assert.equal(entries[0].alias, "Baldur's Gate III");
});

test("parseHltbSearch: missing `data` throws (drift/lane-hides trigger)", () => {
  assert.throws(() => parseHltbSearch({ count: 0 }), /Unexpected HLTB search response shape/);
});

test("parseHltbSearch: `data` present but not an array throws", () => {
  assert.throws(() => parseHltbSearch({ data: {} }), /Unexpected HLTB search response shape/);
});

test("parseHltbSearch: an entry missing game_id or game_name throws", () => {
  assert.throws(
    () => parseHltbSearch({ data: [{ game_name: "No id" }] }),
    /Unexpected HLTB entry shape/,
  );
  assert.throws(
    () => parseHltbSearch({ data: [{ game_id: 1 }] }),
    /Unexpected HLTB entry shape/,
  );
});

test("parseHltbSearch: a totally empty result set (count:0, data:[]) parses to an empty array, not a throw", () => {
  assert.deepEqual(parseHltbSearch({ count: 0, data: [] }), []);
});

// ---------------------------------------------------------------------------
// hltbLengthSeconds — generic read of the configured length field.
// ---------------------------------------------------------------------------

test("hltbLengthSeconds: reads comp_main (the default FPM_LENGTH_FIELD) off a parsed entry", () => {
  const [portal2] = parseHltbSearch(portal2Response);
  assert.equal(FPM_LENGTH_FIELD, "comp_main");
  assert.equal(hltbLengthSeconds(portal2), 30743);
  assert.equal(hltbLengthSeconds(portal2, "comp_plus"), 49416);
  assert.equal(hltbLengthSeconds(portal2, "comp_100"), 81139);
});

test("hltbLengthSeconds: missing/unknown record returns 0", () => {
  assert.equal(hltbLengthSeconds(null), 0);
  assert.equal(hltbLengthSeconds({}), 0);
});

// ---------------------------------------------------------------------------
// normalizeTitle / titleSimilarity / matchHltbEntry — matching matrix.
// ---------------------------------------------------------------------------

test("normalizeTitle: lowercases, strips punctuation/®™, collapses whitespace", () => {
  assert.equal(normalizeTitle("Baldur's Gate 3"), "baldurs gate 3");
  assert.equal(normalizeTitle("DOOM®"), "doom");
  assert.equal(normalizeTitle("  Portal   2  "), "portal 2");
});

test("normalizeTitle: drops minimal edition/goty noise", () => {
  assert.equal(normalizeTitle("Some Game GOTY Edition"), "some game");
});

test("titleSimilarity: identical (post-normalize) titles score 1", () => {
  assert.equal(titleSimilarity("Portal 2", "Portal 2"), 1);
  assert.equal(titleSimilarity("DOOM®", "doom"), 1);
});

test("titleSimilarity: a close fuzzy match (single-character typo) scores >= FPM_MATCH_THRESHOLD", () => {
  const score = titleSimilarity("Stardew Valey", "Stardew Valley");
  assert.ok(score >= FPM_MATCH_THRESHOLD, `expected >= ${FPM_MATCH_THRESHOLD}, got ${score}`);
});

test("titleSimilarity: unrelated titles score well below threshold", () => {
  const score = titleSimilarity("Counter-Strike 2", "Portal 2");
  assert.ok(score < FPM_MATCH_THRESHOLD, `expected < ${FPM_MATCH_THRESHOLD}, got ${score}`);
});

test("titleSimilarity: either title empty/non-string returns 0, never throws", () => {
  assert.equal(titleSimilarity("", "Portal 2"), 0);
  assert.equal(titleSimilarity(undefined, "Portal 2"), 0);
});

test("matchHltbEntry: exact-ish name hit returns the entry with matchMethod 'name'", () => {
  const entries = parseHltbSearch(portal2Response);
  const match = matchHltbEntry("Portal 2", entries);
  assert.ok(match);
  assert.equal(match.hltbId, 7231);
  assert.equal(match.matchMethod, "name");
  assert.equal(match.matchScore, 1);
});

test("matchHltbEntry: matches against game_alias too, taking the max of name/alias score", () => {
  const entries = parseHltbSearch(baldursGate3Response);
  // "Baldur's Gate III" (roman numeral) is closer to the alias than the name.
  const match = matchHltbEntry("Baldur's Gate III", entries);
  assert.ok(match);
  assert.equal(match.hltbId, 68033);
});

test("matchHltbEntry: a fuzzy (typo) hit at/above threshold still matches", () => {
  const entries = [{ hltbId: 1, name: "Stardew Valley", alias: "", compMain: 192163 }];
  const match = matchHltbEntry("Stardew Valey", entries);
  assert.ok(match);
  assert.equal(match.hltbId, 1);
});

test("matchHltbEntry: below-threshold best guess returns null, never a wrong-game match", () => {
  const entries = parseHltbSearch(portal2Response); // only Portal 2 entries
  const match = matchHltbEntry("Counter-Strike 2", entries);
  assert.equal(match, null);
});

test("matchHltbEntry: empty entries array returns null", () => {
  assert.equal(matchHltbEntry("Anything", []), null);
});

// ---------------------------------------------------------------------------
// Qualification — qualifiesForFpmFloor (Increment 7.5). This lane's OWN
// floor, deliberately NOT hallOfFame.js's qualifiesForHof (10k reviews/95%
// ratio) — the floor matrix below proves a candidate that clears THIS floor
// but fails the stricter Hall-of-Fame one now qualifies for FPM, while
// hallOfFame.js's own qualifiesForHof (tested in test/hallOfFame.test.mjs)
// stays completely untouched.
// ---------------------------------------------------------------------------

test("FPM_MIN_REVIEWS/FPM_MIN_QUALITY/FPM_MIN_OWNERS default config", () => {
  assert.equal(FPM_MIN_REVIEWS, 50);
  assert.equal(FPM_MIN_QUALITY, 0.7);
  assert.equal(FPM_MIN_OWNERS, 5000);
});

test("qualifiesForFpmFloor: a candidate clearing 50/0.7/5000 but failing Hall-of-Fame's 10k/95% now qualifies", () => {
  // 400 total reviews (>=50), 80% positive, wilson well above 0.7; 50000
  // owners (>=5000) — clears every FPM floor, but 400 total reviews is far
  // below HOF_MIN_REVIEWS (10000), so this candidate would NOT qualify for
  // Best-of.
  const candidate = { reviews: { positive: 320, negative: 80 }, owners: 50000 };
  assert.ok(wilsonLowerBound(320, 80) >= FPM_MIN_QUALITY);
  assert.equal(qualifiesForFpmFloor(candidate), true);
});

test("qualifiesForFpmFloor: sub-floor junk fails on reviews alone even with perfect ratio/owners", () => {
  const candidate = { reviews: { positive: 30, negative: 0 } /* 30 < 50 */, owners: 50000 };
  assert.equal(qualifiesForFpmFloor(candidate), false);
});

test("qualifiesForFpmFloor: sub-floor junk fails on Wilson quality alone even with plenty of reviews/owners", () => {
  const candidate = { reviews: { positive: 60, negative: 40 } /* 100 total, 60% -> wilson well under 0.7 */, owners: 50000 };
  assert.ok(wilsonLowerBound(60, 40) < FPM_MIN_QUALITY);
  assert.equal(qualifiesForFpmFloor(candidate), false);
});

test("qualifiesForFpmFloor: sub-floor junk fails on owners alone even with reviews/quality clearing", () => {
  const candidate = { reviews: { positive: 400, negative: 20 }, owners: 4999 /* < 5000 */ };
  assert.ok(wilsonLowerBound(400, 20) >= FPM_MIN_QUALITY);
  assert.equal(qualifiesForFpmFloor(candidate), false);
});

test("qualifiesForFpmFloor: missing/empty reviews or owners is false, not a throw", () => {
  assert.equal(qualifiesForFpmFloor({}), false);
  assert.equal(qualifiesForFpmFloor({ reviews: {} }), false);
  assert.equal(qualifiesForFpmFloor({ reviews: undefined, owners: undefined }), false);
});

// ---------------------------------------------------------------------------
// Lane math — fpmScore / funPerHourDisplay / qualifiesForFpm / sortFpmLane /
// fpmWhyLine.
// ---------------------------------------------------------------------------

test("FPM_FORMULA/FPM_QUALITY_EXP/FPM_BREADTH_WEIGHT default config", () => {
  assert.equal(FPM_FORMULA, "sqrt");
  assert.equal(FPM_QUALITY_EXP, 2);
  assert.equal(FPM_BREADTH_WEIGHT, 0);
});

test("fpmScore: 'linear' formula is quality^qexp / hours", () => {
  assert.equal(fpmScore(0.9, 6, { formula: "linear", qualityExp: 1 }), 0.15);
  assert.equal(fpmScore(0.5, 2, { formula: "linear", qualityExp: 1 }), 0.25);
  assert.ok(Math.abs(fpmScore(0.9, 6, { formula: "linear", qualityExp: 2 }) - 0.9 ** 2 / 6) < 1e-12);
});

test("fpmScore: 'sqrt' formula is quality^qexp / sqrt(hours)", () => {
  const expected = 0.9 ** 2 / Math.sqrt(6);
  assert.ok(Math.abs(fpmScore(0.9, 6, { formula: "sqrt", qualityExp: 2 }) - expected) < 1e-12);
});

test("fpmScore: 'log' formula is quality^qexp / log2(hours + 1)", () => {
  const expected = 0.9 ** 2 / Math.log2(7);
  assert.ok(Math.abs(fpmScore(0.9, 6, { formula: "log", qualityExp: 2 }) - expected) < 1e-12);
});

test("fpmScore: default options (no override) use the FPM_FORMULA/FPM_QUALITY_EXP/FPM_BREADTH_WEIGHT config constants", () => {
  const expected = 0.9 ** FPM_QUALITY_EXP / Math.sqrt(6); // FPM_FORMULA is 'sqrt'
  assert.ok(Math.abs(fpmScore(0.9, 6) - expected) < 1e-12);
});

test("fpmScore: breadthWeight=0 (the default) is EXACTLY x1 — no floating-point drift regardless of reviewCount", () => {
  const noBreadthArg = fpmScore(0.9, 6, { formula: "linear", qualityExp: 1 });
  // Math.pow(x, 0) === 1 exactly for any finite x, including reviewCount:0,
  // a huge count, or omitting reviewCount entirely — assert bitwise/exact
  // equality, not just "close", per the spec's w=0 identity requirement.
  assert.equal(fpmScore(0.9, 6, { formula: "linear", qualityExp: 1, reviewCount: 0, breadthWeight: 0 }), noBreadthArg);
  assert.equal(fpmScore(0.9, 6, { formula: "linear", qualityExp: 1, reviewCount: 500000, breadthWeight: 0 }), noBreadthArg);
  assert.equal(fpmScore(0.9, 6, { formula: "linear", qualityExp: 1, breadthWeight: 0 }), noBreadthArg);
});

test("fpmScore: breadthWeight > 0 scales the score up by log10(max(reviewCount,10))^w", () => {
  const base = fpmScore(0.9, 6, { formula: "linear", qualityExp: 1 });
  const withBreadth = fpmScore(0.9, 6, { formula: "linear", qualityExp: 1, reviewCount: 100000, breadthWeight: 1 });
  const expectedBreadthTerm = Math.log10(100000); // = 5
  assert.ok(Math.abs(withBreadth - base * expectedBreadthTerm) < 1e-12);
});

test("fpmScore: breadthWeight > 0 with reviewCount below 10 clamps to log10(10)=1, never negative/undefined", () => {
  const base = fpmScore(0.9, 6, { formula: "linear", qualityExp: 1 });
  const withBreadth = fpmScore(0.9, 6, { formula: "linear", qualityExp: 1, reviewCount: 3, breadthWeight: 1 });
  assert.ok(Math.abs(withBreadth - base * 1) < 1e-12); // log10(max(3,10)) = log10(10) = 1
});

test("fpmScore: mainHours missing/zero/negative returns 0 rather than Infinity/NaN", () => {
  assert.equal(fpmScore(0.9, 0), 0);
  assert.equal(fpmScore(0.9, undefined), 0);
  assert.equal(fpmScore(0.9, -1), 0);
});

test("fpmScore: an unrecognized formula string falls back to 'sqrt' behaviour rather than throwing", () => {
  const sqrtScore = fpmScore(0.9, 6, { formula: "sqrt", qualityExp: 2 });
  const bogusScore = fpmScore(0.9, 6, { formula: "not-a-real-formula", qualityExp: 2 });
  assert.equal(bogusScore, sqrtScore);
});

test("funPerHourDisplay: matches the spec worked example (94% quality, 6.5h -> 14.5 fun/hr)", () => {
  assert.equal(funPerHourDisplay(0.94, 6.5), 14.5);
});

test("funPerHourDisplay: rounds to one decimal place", () => {
  assert.equal(funPerHourDisplay(0.905, 3), 30.2); // 0.905*100/3 = 30.1666...
});

test("funPerHourDisplay: mainHours missing/zero returns 0", () => {
  assert.equal(funPerHourDisplay(0.9, 0), 0);
});

test("qualifiesForFpm: matched, compMain > 0, mainHours >= FPM_MIN_LENGTH_HOURS -> true", () => {
  assert.equal(FPM_MIN_LENGTH_HOURS, 1);
  assert.equal(qualifiesForFpm({ compMain: 3600, mainHours: 1 }), true);
  assert.equal(qualifiesForFpm({ compMain: 30743, mainHours: 30743 / 3600 }), true);
});

test("qualifiesForFpm: sub-floor main-story hours excludes (degenerate short entry)", () => {
  assert.equal(qualifiesForFpm({ compMain: 1800, mainHours: 0.5 }), false);
});

test("qualifiesForFpm: missing length (compMain 0/undefined) excludes", () => {
  assert.equal(qualifiesForFpm({ compMain: 0, mainHours: 0 }), false);
  assert.equal(qualifiesForFpm({}), false);
});

test("sortFpmLane: fpm descending, atHistoricalLow as tiebreak", () => {
  const items = [
    { title: "Mid fpm, not low", fpm: 0.2, atHistoricalLow: false },
    { title: "Highest fpm", fpm: 0.5, atHistoricalLow: false },
    { title: "Tied fpm, not low", fpm: 0.3, atHistoricalLow: false },
    { title: "Tied fpm, at low (tiebreak winner)", fpm: 0.3, atHistoricalLow: true },
  ];
  const sorted = sortFpmLane(items);
  assert.deepEqual(
    sorted.map((i) => i.title),
    [
      "Highest fpm",
      "Tied fpm, at low (tiebreak winner)",
      "Tied fpm, not low",
      "Mid fpm, not low",
    ],
  );
});

test("sortFpmLane does not mutate the input array", () => {
  const items = [
    { fpm: 0.1, atHistoricalLow: false },
    { fpm: 0.9, atHistoricalLow: false },
  ];
  const copy = [...items];
  sortFpmLane(items);
  assert.deepEqual(items, copy);
});

test("fpmWhyLine: matches the spec worked example exactly (default formula 'linear', no suffix)", () => {
  assert.equal(fpmWhyLine(94, 6.5, 14.5), "94% quality ÷ 6.5h main story — 14.5 fun/hr");
});

test("fpmWhyLine: formula 'linear' explicitly is behavior-identical to Increment 7's why-line (no suffix)", () => {
  assert.equal(fpmWhyLine(94, 6.5, 14.5, "linear"), "94% quality ÷ 6.5h main story — 14.5 fun/hr");
});

test("fpmWhyLine: a non-linear formula appends '· <formula> ranking' (Increment 7.5)", () => {
  assert.equal(fpmWhyLine(94, 6.5, 14.5, "sqrt"), "94% quality ÷ 6.5h main story — 14.5 fun/hr · sqrt ranking");
  assert.equal(fpmWhyLine(94, 6.5, 14.5, "log"), "94% quality ÷ 6.5h main story — 14.5 fun/hr · log ranking");
});

// ---------------------------------------------------------------------------
// Ordering fixture (Increment 7.5) — curated real-ish games from SPEC.md,
// proving the formula/qexp levers actually move what James flagged: pure
// quality/hours (linear, k=1) ranks purely by brevity; sqrt+qexp=2 (the new
// default) pulls that gap hard toward rewarding sustained quality.
//
// JUDGMENT CALL (flagged to the PO): with real "quick wins"-tier candidates,
// Wilson quality clusters within ~1 percentage point of each other (that's
// what the floor is FOR) — a ~25x hours range (1.8h to 45.9h) mathematically
// dwarfs a ~1-point quality spread for ANY qualityExp inside the sane [0,10]
// bound (flipping Gorogoa out of #1 here would need qualityExp > ~35). So
// this fixture asserts the honest, achievable version of "no longer purely
// brevity-driven": the score gap between the shortest and longest game
// collapses hard (>20x under linear down to <10x under sqrt+qexp=2), rather
// than a literal reordering of the curated set. If a literal top-spot flip
// is what's wanted, breadth weight (rewarding broadly-loved games) or a much
// higher FPM_QUALITY_EXP is the lever — not qexp=2 alone.
// ---------------------------------------------------------------------------

const CURATED_GAMES = [
  { title: "Gorogoa", quality: 0.973, hours: 1.8 },
  { title: "Portal", quality: 0.98, hours: 3 },
  { title: "Celeste", quality: 0.97, hours: 8 },
  { title: "Hades", quality: 0.98, hours: 23 },
  { title: "Euro Truck Simulator 2", quality: 0.973, hours: 45.9 },
];

function rankCuratedGames(options) {
  return CURATED_GAMES.map((g) => ({ ...g, score: fpmScore(g.quality, g.hours, options) })).sort(
    (a, b) => b.score - a.score,
  );
}

test("ordering fixture: linear (k=1) ranks purely by brevity — Gorogoa first, ETS2 last", () => {
  const ranked = rankCuratedGames({ formula: "linear", qualityExp: 1 });
  assert.deepEqual(
    ranked.map((g) => g.title),
    ["Gorogoa", "Portal", "Celeste", "Hades", "Euro Truck Simulator 2"],
  );
});

test("ordering fixture: sqrt+qexp=2 collapses the brevity-driven gap hard toward sustained quality", () => {
  const linear = rankCuratedGames({ formula: "linear", qualityExp: 1 });
  const sqrt2 = rankCuratedGames({ formula: "sqrt", qualityExp: 2 });

  const byTitle = (ranked, title) => ranked.find((g) => g.title === title).score;
  const ratioLinear = byTitle(linear, "Gorogoa") / byTitle(linear, "Euro Truck Simulator 2");
  const ratioSqrt = byTitle(sqrt2, "Gorogoa") / byTitle(sqrt2, "Euro Truck Simulator 2");

  assert.ok(ratioLinear > 20, `expected a huge brevity-driven blowout under linear, got ${ratioLinear.toFixed(1)}x`);
  assert.ok(ratioSqrt < 10, `expected sqrt+qexp=2 to collapse the gap well under 10x, got ${ratioSqrt.toFixed(1)}x`);
  assert.ok(ratioSqrt < ratioLinear / 2, "sqrt+qexp=2 must shrink the Gorogoa/ETS2 gap by at least half vs linear");
});

// ---------------------------------------------------------------------------
// Curated-fixture pair fix (Increment 7.6, SPEC.md §4): the Gorogoa/ETS2 pair
// above has IDENTICAL Wilson quality (0.973 each), so no quality exponent can
// ever flip its order by construction — it can only demonstrate the score
// gap collapsing, never a real reordering. This pair (live-verified
// quality-gap shape; the underlying floats round to the displayed 96%/91%)
// DOES flip under sqrt+qexp=2 (the shipped default) while staying
// brevity-ordered under plain linear — proof the quality exponent lever can
// actually reorder real candidates, not just narrow a gap that was never
// going to reorder anything.
// ---------------------------------------------------------------------------

const THRONEFALL = { title: "Thronefall", quality: 0.964, hours: 7.9 };
const LARA_CROFT = { title: "Lara Croft", quality: 0.91, hours: 6.3 };

test("curated pair fix: linear ranks Lara Croft (shorter) over Thronefall — pure brevity, unflipped", () => {
  assert.equal(Math.round(THRONEFALL.quality * 100), 96);
  assert.equal(Math.round(LARA_CROFT.quality * 100), 91);
  const linearThronefall = fpmScore(THRONEFALL.quality, THRONEFALL.hours, { formula: "linear", qualityExp: 1 });
  const linearLara = fpmScore(LARA_CROFT.quality, LARA_CROFT.hours, { formula: "linear", qualityExp: 1 });
  assert.ok(linearLara > linearThronefall, "linear must still favour the shorter game");
});

test("curated pair fix: sqrt+qexp=2 (the shipped default) flips the order — Thronefall overtakes Lara Croft on sustained quality", () => {
  const sqrtThronefall = fpmScore(THRONEFALL.quality, THRONEFALL.hours, { formula: "sqrt", qualityExp: 2 });
  const sqrtLara = fpmScore(LARA_CROFT.quality, LARA_CROFT.hours, { formula: "sqrt", qualityExp: 2 });
  assert.ok(sqrtThronefall > sqrtLara, "sqrt+qexp=2 must flip Thronefall ahead of Lara Croft, not just narrow the gap");
});

// ---------------------------------------------------------------------------
// getCachedHltb — cache-miss vs. cached-negative distinction (own KV key).
// ---------------------------------------------------------------------------

function makeMockKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

test("getCachedHltb: a true KV miss returns {cached:false, data:undefined}", async () => {
  const env = { TAG_CACHE: makeMockKv() };
  const result = await getCachedHltb(env, 12345);
  assert.deepEqual(result, { cached: false, data: undefined });
});

test("getCachedHltb: a cached negative result (JSON \"null\") returns {cached:true, data:null}, distinct from a miss", async () => {
  const env = { TAG_CACHE: makeMockKv() };
  env.TAG_CACHE.store.set("hltb:12345", JSON.stringify(null));
  const result = await getCachedHltb(env, 12345);
  assert.deepEqual(result, { cached: true, data: null });
});

test("getCachedHltb: a cached positive result round-trips", async () => {
  const env = { TAG_CACHE: makeMockKv() };
  const record = { hltbId: 7231, compMain: 30743, compPlus: 49416, comp100: 81139, matchMethod: "name" };
  env.TAG_CACHE.store.set("hltb:7231", JSON.stringify(record));
  const result = await getCachedHltb(env, 7231);
  assert.deepEqual(result, { cached: true, data: record });
});

test("getCachedHltb uses its own `hltb:<appid>` key, distinct from spyQueue's v2:spytag: and deckCompat's deck: keys", async () => {
  const env = { TAG_CACHE: makeMockKv() };
  env.TAG_CACHE.store.set("v2:spytag:7231", JSON.stringify({ tags: { Puzzle: 1 } }));
  env.TAG_CACHE.store.set("deck:7231", JSON.stringify({ deck: 3, os: 3, frame: 0 }));
  const result = await getCachedHltb(env, 7231);
  assert.deepEqual(result, { cached: false, data: undefined });
});
