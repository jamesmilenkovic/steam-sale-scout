// Tests for src/battery.js — the tag-based battery-friendliness heuristic
// (Increment 5). No official battery data exists; this is a heuristic over
// SteamSpy tags, tested against the exact LOW_POWER/HIGH_POWER lists and the
// "top N by votes" definition of "top tags" (see file header ASSUMPTION).

import test from "node:test";
import assert from "node:assert/strict";
import { LOW_POWER, HIGH_POWER, BATTERY_TOP_TAGS, topTagNames, batteryFriendly } from "../src/battery.js";

test("LOW_POWER / HIGH_POWER lists match the spec exactly", () => {
  assert.deepEqual(LOW_POWER, [
    "2D",
    "Pixel Graphics",
    "Turn-Based Strategy",
    "Turn-Based Tactics",
    "Card Game",
    "Card Battler",
    "Visual Novel",
    "Puzzle",
    "Point & Click",
    "Roguelike Deckbuilder",
    "Board Game",
  ]);
  assert.deepEqual(HIGH_POWER, ["Open World", "Realistic", "Photorealistic", "Racing", "VR", "MMORPG"]);
});

// ---------------------------------------------------------------------------
// topTagNames
// ---------------------------------------------------------------------------

test("topTagNames: ranks by vote count descending, capped at topN", () => {
  const tags = { A: 5, B: 50, C: 20 };
  assert.deepEqual(topTagNames(tags, 2), ["B", "C"]);
});

test("topTagNames: drops non-positive-vote entries", () => {
  assert.deepEqual(topTagNames({ A: 0, B: 10, C: -5 }), ["B"]);
});

test("topTagNames: missing/malformed tags returns [] rather than throwing", () => {
  assert.deepEqual(topTagNames(undefined), []);
  assert.deepEqual(topTagNames(null), []);
  assert.deepEqual(topTagNames([]), []);
  assert.deepEqual(topTagNames("nope"), []);
});

// ---------------------------------------------------------------------------
// batteryFriendly
// ---------------------------------------------------------------------------

test("batteryFriendly: true when top tags hit LOW_POWER and miss HIGH_POWER", () => {
  assert.equal(batteryFriendly({ Puzzle: 100, Indie: 20 }), true);
  assert.equal(batteryFriendly({ "Card Game": 50, "Turn-Based Strategy": 40 }), true);
});

test("batteryFriendly: false when a top tag hits HIGH_POWER even alongside a LOW_POWER hit", () => {
  assert.equal(batteryFriendly({ Puzzle: 100, "Open World": 90 }), false);
  assert.equal(batteryFriendly({ Racing: 100 }), false);
});

test("batteryFriendly: false when no top tag hits LOW_POWER at all", () => {
  assert.equal(batteryFriendly({ Action: 100, Indie: 50 }), false);
});

test("batteryFriendly: edge case — no tags at all is false, not a throw", () => {
  assert.equal(batteryFriendly(undefined), false);
  assert.equal(batteryFriendly(null), false);
  assert.equal(batteryFriendly({}), false);
});

test("batteryFriendly: a HIGH_POWER tag outside the top-N window doesn't disqualify (respects topN cut)", () => {
  const tags = { Puzzle: 100, A: 10, B: 9, C: 8, D: 7, E: 6, F: 5, G: 4, H: 3, I: 2, "Open World": 1 };
  // "Open World" ranks 11th by votes — outside the default top-10 window.
  assert.equal(Object.keys(tags).length, 11);
  assert.equal(batteryFriendly(tags, BATTERY_TOP_TAGS), true);
  // With a wider window it would flip to false — proves the cut is real.
  assert.equal(batteryFriendly(tags, 11), false);
});
