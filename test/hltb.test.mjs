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
  parseHltbSearch,
  hltbLengthSeconds,
  normalizeTitle,
  titleSimilarity,
  matchHltbEntry,
  fpmScore,
  funPerHourDisplay,
  qualifiesForFpm,
  sortFpmLane,
  fpmWhyLine,
  getCachedHltb,
} from "../src/hltb.js";

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
// Lane math — fpmScore / funPerHourDisplay / qualifiesForFpm / sortFpmLane /
// fpmWhyLine.
// ---------------------------------------------------------------------------

test("fpmScore: quality / mainHours", () => {
  assert.equal(fpmScore(0.9, 6), 0.15);
  assert.equal(fpmScore(0.5, 2), 0.25);
});

test("fpmScore: mainHours missing/zero/negative returns 0 rather than Infinity/NaN", () => {
  assert.equal(fpmScore(0.9, 0), 0);
  assert.equal(fpmScore(0.9, undefined), 0);
  assert.equal(fpmScore(0.9, -1), 0);
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

test("fpmWhyLine: matches the spec worked example exactly", () => {
  assert.equal(fpmWhyLine(94, 6.5, 14.5), "94% quality ÷ 6.5h main story — 14.5 fun/hr");
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
