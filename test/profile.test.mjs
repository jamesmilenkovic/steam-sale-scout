// Tests for src/profile.js — the pure taste-profile builder (Increment 3).
//
// Pure module, no fetch/cache stubbing needed. Fixtures shaped from real
// SteamSpy `appdetails` responses (tags: {tagname: votes}, median_forever
// in minutes, positive/negative review counts).

import test from "node:test";
import assert from "node:assert/strict";
import {
  STOPLIST,
  TOP_TAGS_PER_GAME,
  TOP_OWNED_GAMES,
  MIN_PLAYTIME_MINUTES,
  PLAYTIME_NORM_MIN,
  PLAYTIME_NORM_MAX,
  selectTopOwnedGames,
  playtimeNorm,
  gameWeight,
  buildTagVector,
  l2Normalize,
  buildProfile,
} from "../src/profile.js";

const NOW = new Date("2026-07-06T00:00:00Z").getTime();

function game(overrides = {}) {
  return {
    appid: 1,
    name: "Test Game",
    playtime_forever: 600, // 10h
    playtime_2weeks: 0,
    rtime_last_played: Math.floor(NOW / 1000) - 60 * 24 * 60 * 60, // ~2 months ago
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// playtimeNorm — median-ratio clamp + missing/0-median fallback.
// ---------------------------------------------------------------------------

test("playtimeNorm: ratio of playtime to median, unclamped in range", () => {
  const g = game({ playtime_forever: 600 }); // 10h = 600min
  assert.equal(playtimeNorm(g, 300), 2); // 600/300 = 2
});

test("playtimeNorm: clamps the ratio up to PLAYTIME_NORM_MIN (0.1) when far below median", () => {
  const g = game({ playtime_forever: 1 });
  assert.equal(playtimeNorm(g, 1000), PLAYTIME_NORM_MIN);
});

test("playtimeNorm: clamps the ratio down to PLAYTIME_NORM_MAX (4) when far above median", () => {
  const g = game({ playtime_forever: 100000 });
  assert.equal(playtimeNorm(g, 100), PLAYTIME_NORM_MAX);
});

test("playtimeNorm: median exactly at the clamp edges passes through unchanged", () => {
  const gMin = game({ playtime_forever: 10 });
  assert.equal(playtimeNorm(gMin, 100), PLAYTIME_NORM_MIN); // 10/100 = 0.1
  const gMax = game({ playtime_forever: 400 });
  assert.equal(playtimeNorm(gMax, 100), PLAYTIME_NORM_MAX); // 400/100 = 4
});

test("playtimeNorm: falls back to inc-1's log2(1+hours) when median is missing", () => {
  const g = game({ playtime_forever: 600 }); // 10h
  assert.equal(playtimeNorm(g, undefined), Math.log2(11));
  assert.equal(playtimeNorm(g, null), Math.log2(11));
});

test("playtimeNorm: falls back to log2(1+hours) when median is 0", () => {
  const g = game({ playtime_forever: 600 });
  assert.equal(playtimeNorm(g, 0), Math.log2(11));
});

test("playtimeNorm: zero playtime with a fallback median gives log2(1) = 0", () => {
  const g = game({ playtime_forever: 0 });
  assert.equal(playtimeNorm(g, 0), 0);
});

// ---------------------------------------------------------------------------
// gameWeight — playtimeNorm x recencyMultiplier.
// ---------------------------------------------------------------------------

test("gameWeight: multiplies playtimeNorm by the weight.js recency multiplier", () => {
  const g = game({ playtime_forever: 600, playtime_2weeks: 5 }); // recency x3 (played in last 2 weeks)
  assert.equal(gameWeight(g, 300, 12, NOW), 2 * 3); // playtimeNorm(600,300)=2
});

// ---------------------------------------------------------------------------
// selectTopOwnedGames — inc-1 weight() ranking, capped at TOP_OWNED_GAMES.
// ---------------------------------------------------------------------------

test("selectTopOwnedGames: keeps only the top N by inc-1 weight, sorted descending", () => {
  const games = [
    game({ appid: 1, playtime_forever: 100 }),
    game({ appid: 2, playtime_forever: 10000 }),
    game({ appid: 3, playtime_forever: 1000 }),
  ];
  const top2 = selectTopOwnedGames(games, 12, NOW, 2);
  assert.deepEqual(top2.map((g) => g.appid), [2, 3]);
});

test("selectTopOwnedGames: default cap is TOP_OWNED_GAMES (200)", () => {
  assert.equal(TOP_OWNED_GAMES, 200);
  const games = Array.from({ length: 250 }, (_, i) => game({ appid: i, playtime_forever: i }));
  const top = selectTopOwnedGames(games, 12, NOW);
  assert.equal(top.length, 200);
});

test("selectTopOwnedGames: empty/undefined games list yields an empty array", () => {
  assert.deepEqual(selectTopOwnedGames([], 12, NOW), []);
  assert.deepEqual(selectTopOwnedGames(undefined, 12, NOW), []);
});

// ---------------------------------------------------------------------------
// buildTagVector — stoplist removal, top-15-by-votes, normalise to sum 1.
// ---------------------------------------------------------------------------

test("buildTagVector: normalises votes to sum to 1", () => {
  const vector = buildTagVector({ Roguelike: 300, Strategy: 100 });
  assert.equal(vector.Roguelike, 0.75);
  assert.equal(vector.Strategy, 0.25);
  const total = Object.values(vector).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("buildTagVector: strips every default stoplist tag", () => {
  const tags = { Singleplayer: 1000, Roguelike: 100 };
  const vector = buildTagVector(tags);
  assert.equal("Singleplayer" in vector, false);
  assert.equal(vector.Roguelike, 1);
});

test("buildTagVector: keeps only the top 15 tags by votes (after stoplist removal)", () => {
  assert.equal(TOP_TAGS_PER_GAME, 15);
  const tags = {};
  for (let i = 0; i < 20; i++) tags[`Tag${i}`] = 20 - i; // Tag0 highest votes
  const vector = buildTagVector(tags);
  assert.equal(Object.keys(vector).length, 15);
  assert.ok("Tag0" in vector);
  assert.ok(!("Tag15" in vector)); // 16th-highest, dropped
});

test("buildTagVector: a custom stoplist is respected (configurability)", () => {
  const vector = buildTagVector({ Foo: 10, Bar: 5 }, ["Foo"]);
  assert.equal("Foo" in vector, false);
  assert.equal(vector.Bar, 1);
});

test("buildTagVector: missing/empty/array tags all yield an empty vector, not a throw", () => {
  assert.deepEqual(buildTagVector(undefined), {});
  assert.deepEqual(buildTagVector(null), {});
  assert.deepEqual(buildTagVector({}), {});
  assert.deepEqual(buildTagVector([]), {});
});

test("buildTagVector: a game whose only tags are all stoplisted yields an empty vector", () => {
  assert.deepEqual(buildTagVector({ Singleplayer: 500, "Early Access": 200 }), {});
});

// ---------------------------------------------------------------------------
// l2Normalize
// ---------------------------------------------------------------------------

test("l2Normalize: unit-normalises a vector (magnitude 1)", () => {
  const normalized = l2Normalize({ a: 3, b: 4 }); // 3-4-5 triangle
  assert.ok(Math.abs(normalized.a - 0.6) < 1e-9);
  assert.ok(Math.abs(normalized.b - 0.8) < 1e-9);
  const magnitude = Math.sqrt(normalized.a ** 2 + normalized.b ** 2);
  assert.ok(Math.abs(magnitude - 1) < 1e-9);
});

test("l2Normalize: a zero vector returns {} rather than dividing by zero", () => {
  assert.deepEqual(l2Normalize({}), {});
  assert.deepEqual(l2Normalize({ a: 0 }), {});
});

// ---------------------------------------------------------------------------
// buildProfile — the full pipeline: selection, <30min skip, missing/no-tags
// skip, weighted sum, L2 normalisation, and the why.js contributions payload.
// ---------------------------------------------------------------------------

test("buildProfile: skips games played less than MIN_PLAYTIME_MINUTES (30)", () => {
  assert.equal(MIN_PLAYTIME_MINUTES, 30);
  const games = [game({ appid: 1, playtime_forever: 29 }), game({ appid: 2, playtime_forever: 30 })];
  const spy = new Map([
    [1, { tags: { Roguelike: 10 }, median: 100, reviews: {} }],
    [2, { tags: { Strategy: 10 }, median: 100, reviews: {} }],
  ]);
  const { contributions } = buildProfile(games, spy, 12, NOW);
  assert.deepEqual(contributions.map((c) => c.appid), [2]);
});

test("buildProfile: skips a game with no cached SteamSpy entry (not yet fetched)", () => {
  const games = [game({ appid: 1, playtime_forever: 600 })];
  const spy = new Map(); // appid 1 not present -> undefined
  const { profile, contributions } = buildProfile(games, spy, 12, NOW);
  assert.deepEqual(profile, {});
  assert.deepEqual(contributions, []);
});

test("buildProfile: skips a game cached as null (fetched, no usable tags)", () => {
  const games = [game({ appid: 1, playtime_forever: 600 })];
  const spy = new Map([[1, null]]);
  const { profile, contributions } = buildProfile(games, spy, 12, NOW);
  assert.deepEqual(profile, {});
  assert.deepEqual(contributions, []);
});

test("buildProfile: skips a game whose tags are all stoplisted (empty resulting vector)", () => {
  const games = [game({ appid: 1, playtime_forever: 600 })];
  const spy = new Map([[1, { tags: { Singleplayer: 500 }, median: 100, reviews: {} }]]);
  const { contributions } = buildProfile(games, spy, 12, NOW);
  assert.deepEqual(contributions, []);
});

test("buildProfile: sums weighted per-game tag vectors and L2-normalises the result", () => {
  const games = [
    game({ appid: 1, name: "Game A", playtime_forever: 600, playtime_2weeks: 5 }), // recency x3
    game({ appid: 2, name: "Game B", playtime_forever: 600, playtime_2weeks: 5 }),
  ];
  const spy = new Map([
    [1, { tags: { Roguelike: 100 }, median: 300, reviews: {} }], // playtimeNorm=2, weight=6
    [2, { tags: { Strategy: 100 }, median: 300, reviews: {} }], // playtimeNorm=2, weight=6
  ]);
  const { profile } = buildProfile(games, spy, 12, NOW);
  // Equal weights on orthogonal tags -> equal-magnitude unit vector components.
  assert.ok(Math.abs(profile.Roguelike - profile.Strategy) < 1e-9);
  const magnitude = Math.sqrt(profile.Roguelike ** 2 + profile.Strategy ** 2);
  assert.ok(Math.abs(magnitude - 1) < 1e-9);
});

test("buildProfile: returns per-game contributions with appid/name/hours/tagWeights for why.js", () => {
  const games = [game({ appid: 42, name: "Balatro", playtime_forever: 2520 })]; // 42h
  const spy = new Map([[42, { tags: { Roguelike: 10 }, median: 100, reviews: {} }]]);
  const { contributions } = buildProfile(games, spy, 12, NOW);
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].appid, 42);
  assert.equal(contributions[0].name, "Balatro");
  assert.equal(contributions[0].hours, 42);
  assert.ok(contributions[0].tagWeights.Roguelike > 0);
});

test("buildProfile: games beyond the top-200-by-inc-1-weight cutoff never contribute", () => {
  // 201 games all with usable tags/median; the 201st-ranked (lowest weight)
  // must not appear in contributions.
  const games = Array.from({ length: 201 }, (_, i) =>
    game({ appid: i, playtime_forever: 500 - i }), // appid 200 has the lowest playtime -> ranked last
  );
  const spy = new Map(games.map((g) => [g.appid, { tags: { Roguelike: 10 }, median: 50, reviews: {} }]));
  const { contributions } = buildProfile(games, spy, 12, NOW);
  assert.equal(contributions.length, 200);
  assert.ok(!contributions.some((c) => c.appid === 200));
});
