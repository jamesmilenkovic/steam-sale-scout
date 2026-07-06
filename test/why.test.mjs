// Tests for src/why.js — the pure "why" explanation-line builder (Increment 3).

import test from "node:test";
import assert from "node:assert/strict";
import {
  WHY_TOP_TAGS,
  WHY_TOP_GAMES,
  selectTopTags,
  selectTopGames,
  formatWhyLine,
  buildWhy,
} from "../src/why.js";

function contribution(overrides = {}) {
  return { appid: 1, name: "Game", hours: 10, tagWeights: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// selectTopTags — top-3-by-contribution, only tags present in both.
// ---------------------------------------------------------------------------

test("selectTopTags: picks the top N tags by profile-weight x candidate-share, descending", () => {
  const profile = { A: 0.5, B: 0.3, C: 0.1, D: 0.9 };
  const candidateVector = { A: 0.5, B: 0.5, C: 0.5, D: 0.01 }; // D has tiny candidate-share despite high profile weight
  const top = selectTopTags(profile, candidateVector, 3);
  // contributions: A=0.25, B=0.15, C=0.05, D=0.009
  assert.deepEqual(top, ["A", "B", "C"]);
});

test("selectTopTags: default topN is WHY_TOP_TAGS (3)", () => {
  assert.equal(WHY_TOP_TAGS, 3);
  const profile = { A: 1, B: 1, C: 1, D: 1 };
  const candidateVector = { A: 4, B: 3, C: 2, D: 1 };
  assert.equal(selectTopTags(profile, candidateVector).length, 3);
});

test("selectTopTags: ignores candidate tags absent from the profile (no overlap)", () => {
  const profile = { A: 1 };
  const candidateVector = { A: 1, Z: 100 };
  assert.deepEqual(selectTopTags(profile, candidateVector), ["A"]);
});

test("selectTopTags: no overlapping tags at all -> empty array", () => {
  assert.deepEqual(selectTopTags({ A: 1 }, { Z: 1 }), []);
});

// ---------------------------------------------------------------------------
// selectTopGames — top-2-by-summed-contribution-to-the-given-tags.
// ---------------------------------------------------------------------------

test("selectTopGames: ranks owned games by summed tagWeights over the given tags", () => {
  const contributions = [
    contribution({ appid: 1, name: "Slay the Spire", hours: 180, tagWeights: { Roguelike: 5, Strategy: 1 } }),
    contribution({ appid: 2, name: "Balatro", hours: 42, tagWeights: { Roguelike: 3 } }),
    contribution({ appid: 3, name: "Irrelevant Game", hours: 5, tagWeights: { Puzzle: 10 } }),
  ];
  const top = selectTopGames(contributions, ["Roguelike", "Strategy"], 2);
  assert.deepEqual(top.map((g) => g.name), ["Slay the Spire", "Balatro"]);
});

test("selectTopGames: default topN is WHY_TOP_GAMES (2)", () => {
  assert.equal(WHY_TOP_GAMES, 2);
  const contributions = [
    contribution({ appid: 1, tagWeights: { A: 3 } }),
    contribution({ appid: 2, tagWeights: { A: 2 } }),
    contribution({ appid: 3, tagWeights: { A: 1 } }),
  ];
  assert.equal(selectTopGames(contributions, ["A"]).length, 2);
});

test("selectTopGames: excludes games with zero contribution to the given tags", () => {
  const contributions = [
    contribution({ appid: 1, name: "Contributes", tagWeights: { A: 1 } }),
    contribution({ appid: 2, name: "Doesn't", tagWeights: { B: 1 } }),
  ];
  const top = selectTopGames(contributions, ["A"], 2);
  assert.deepEqual(top.map((g) => g.name), ["Contributes"]);
});

test("selectTopGames: no contributions at all -> empty array", () => {
  assert.deepEqual(selectTopGames([], ["A"]), []);
});

// ---------------------------------------------------------------------------
// formatWhyLine
// ---------------------------------------------------------------------------

test("formatWhyLine: matches the spec's example format", () => {
  const line = formatWhyLine(
    ["Roguelike Deckbuilder", "Turn-Based", "Strategy"],
    [
      { name: "Slay the Spire", hours: 180 },
      { name: "Balatro", hours: 42 },
    ],
  );
  assert.equal(
    line,
    "Roguelike Deckbuilder, Turn-Based, Strategy — because Slay the Spire (180h) and Balatro (42h)",
  );
});

test("formatWhyLine: rounds fractional hours", () => {
  const line = formatWhyLine(["Tag"], [{ name: "Game", hours: 41.6 }]);
  assert.equal(line, "Tag — because Game (42h)");
});

test("formatWhyLine: a single contributing game omits the ' and '", () => {
  const line = formatWhyLine(["Tag"], [{ name: "Solo Game", hours: 10 }]);
  assert.equal(line, "Tag — because Solo Game (10h)");
});

test("formatWhyLine: no tags -> null", () => {
  assert.equal(formatWhyLine([], [{ name: "Game", hours: 1 }]), null);
});

test("formatWhyLine: no contributing games -> null", () => {
  assert.equal(formatWhyLine(["Tag"], []), null);
});

// ---------------------------------------------------------------------------
// buildWhy — the composed pipeline.
// ---------------------------------------------------------------------------

test("buildWhy: composes selectTopTags + selectTopGames + formatWhyLine end to end", () => {
  const profile = { Roguelike: 0.8, Strategy: 0.6 };
  const candidateVector = { Roguelike: 0.7, Strategy: 0.7 };
  const contributions = [
    contribution({ name: "Slay the Spire", hours: 180, tagWeights: { Roguelike: 5, Strategy: 4 } }),
    contribution({ name: "Balatro", hours: 42, tagWeights: { Roguelike: 3 } }),
  ];
  const why = buildWhy(profile, candidateVector, contributions);
  assert.match(why, /Roguelike/);
  assert.match(why, /Strategy/);
  assert.match(why, /Slay the Spire \(180h\)/);
});

test("buildWhy: returns null gracefully when there's no overlap (doesn't crash)", () => {
  const why = buildWhy({ A: 1 }, { Z: 1 }, [contribution({ tagWeights: { A: 1 } })]);
  assert.equal(why, null);
});
