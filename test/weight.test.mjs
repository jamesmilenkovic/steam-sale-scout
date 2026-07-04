// Tests for public/weight.js — the pure taste-weight module.
//
// A FIXED reference clock is used throughout (never Date.now()) so results
// are deterministic. All "months ago" timestamps are constructed via the
// same average-month constant the module itself uses
// ((365.25/12)*24*60*60*1000 = 2,629,800,000 ms exactly), and FIXED_NOW is
// chosen as a whole number of seconds so the round-trip
// (rtime -> monthsSince -> band) lands on exact integers for boundary tests
// — no epsilon tolerance needed for the boundary assertions themselves.

import test from "node:test";
import assert from "node:assert/strict";
import { monthsSince, recencyMultiplier, weight } from "../public/weight.js";

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000; // 2,629,800,000
const FIXED_NOW = Date.UTC(2026, 6, 4, 0, 0, 0); // whole seconds

function rtimeMonthsAgo(months, now = FIXED_NOW) {
  return (now - months * MS_PER_MONTH) / 1000;
}

function assertWeightCloseTo(actual, expectedHours, expectedMultiplier) {
  const expected = Math.log2(1 + expectedHours) * expectedMultiplier;
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected weight ~${expected}, got ${actual}`,
  );
}

// ---------------------------------------------------------------------------
// Five recency bands (windowMonths = 12 default)
// ---------------------------------------------------------------------------

test("band: playtime_2weeks > 0 -> x3", () => {
  const game = {
    playtime_forever: 120, // 2 hours
    playtime_2weeks: 45,
    rtime_last_played: rtimeMonthsAgo(0.1),
  };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 3);
  assertWeightCloseTo(weight(game, 12, FIXED_NOW), 2, 3);
});

test("band: within windowMonths/4 (1 month, window 12) -> x2", () => {
  const game = {
    playtime_forever: 600, // 10 hours
    rtime_last_played: rtimeMonthsAgo(1),
  };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 2);
  assertWeightCloseTo(weight(game, 12, FIXED_NOW), 10, 2);
});

test("band: within windowMonths (6 months, window 12) -> x1.5", () => {
  const game = {
    playtime_forever: 300, // 5 hours
    rtime_last_played: rtimeMonthsAgo(6),
  };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 1.5);
  assertWeightCloseTo(weight(game, 12, FIXED_NOW), 5, 1.5);
});

test("band: within 2*windowMonths (18 months, window 12) -> x1", () => {
  const game = {
    playtime_forever: 60, // 1 hour
    rtime_last_played: rtimeMonthsAgo(18),
  };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 1);
  assertWeightCloseTo(weight(game, 12, FIXED_NOW), 1, 1);
});

test("band: older than 2*windowMonths (30 months, window 12) -> x0.5", () => {
  const game = {
    playtime_forever: 600, // 10 hours
    rtime_last_played: rtimeMonthsAgo(30),
  };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 0.5);
  assertWeightCloseTo(weight(game, 12, FIXED_NOW), 10, 0.5);
});

// ---------------------------------------------------------------------------
// Boundary conditions — exact edges, plus one tick on either side to prove
// which tier the boundary itself falls into and that it's consistent.
// ---------------------------------------------------------------------------

test("boundary: exactly windowMonths/4 (3mo, window 12) falls in the x2 band", () => {
  const rtime = rtimeMonthsAgo(3);
  assert.equal(monthsSince(rtime, FIXED_NOW), 3); // exact round-trip
  const game = { playtime_forever: 60, rtime_last_played: rtime };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 2);
});

test("boundary: just past windowMonths/4 (3mo + 1 day) drops to the x1.5 band", () => {
  const rtime = rtimeMonthsAgo(3) - 86400; // one day further in the past
  const game = { playtime_forever: 60, rtime_last_played: rtime };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 1.5);
});

test("boundary: just before windowMonths/4 (3mo - 1 day) stays in the x2 band", () => {
  const rtime = rtimeMonthsAgo(3) + 86400; // one day more recent
  const game = { playtime_forever: 60, rtime_last_played: rtime };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 2);
});

test("boundary: exactly windowMonths (12mo, window 12) falls in the x1.5 band", () => {
  const rtime = rtimeMonthsAgo(12);
  assert.equal(monthsSince(rtime, FIXED_NOW), 12); // exact round-trip
  const game = { playtime_forever: 60, rtime_last_played: rtime };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 1.5);
});

test("boundary: just past windowMonths (12mo + 1 day) drops to the x1 band", () => {
  const rtime = rtimeMonthsAgo(12) - 86400;
  const game = { playtime_forever: 60, rtime_last_played: rtime };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 1);
});

test("boundary: exactly 2*windowMonths (24mo, window 12) falls in the x1 band", () => {
  const rtime = rtimeMonthsAgo(24);
  assert.equal(monthsSince(rtime, FIXED_NOW), 24); // exact round-trip
  const game = { playtime_forever: 60, rtime_last_played: rtime };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 1);
});

test("boundary: just past 2*windowMonths (24mo + 1 day) drops to the x0.5 band", () => {
  const rtime = rtimeMonthsAgo(24) - 86400;
  const game = { playtime_forever: 60, rtime_last_played: rtime };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 0.5);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("edge: playtime_forever = 0 -> weight is 0 regardless of recency", () => {
  const game = {
    playtime_forever: 0,
    playtime_2weeks: 10, // even at the best multiplier
    rtime_last_played: rtimeMonthsAgo(0.1),
  };
  assert.equal(weight(game, 12, FIXED_NOW), 0);
});

test("edge: missing rtime_last_played (undefined), no playtime_2weeks -> x0.5 (never played)", () => {
  const game = { playtime_forever: 120 };
  assert.equal(monthsSince(game.rtime_last_played, FIXED_NOW), Infinity);
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 0.5);
  assertWeightCloseTo(weight(game, 12, FIXED_NOW), 2, 0.5);
});

test("edge: rtime_last_played = 0, no playtime_2weeks -> x0.5 (never played)", () => {
  const game = { playtime_forever: 120, rtime_last_played: 0 };
  assert.equal(monthsSince(0, FIXED_NOW), Infinity);
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 0.5);
});

test("edge: playtime_2weeks present short-circuits to x3 even if rtime_last_played is very old", () => {
  const game = {
    playtime_forever: 600,
    playtime_2weeks: 5,
    rtime_last_played: rtimeMonthsAgo(100), // way outside every other band
  };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 3);
});

test("edge: playtime_2weeks present short-circuits to x3 even with no rtime_last_played at all", () => {
  const game = { playtime_forever: 600, playtime_2weeks: 5 };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 3);
});

test("edge: playtime_2weeks = 0 does NOT short-circuit (falls through to recency bands)", () => {
  const game = {
    playtime_forever: 600,
    playtime_2weeks: 0,
    rtime_last_played: rtimeMonthsAgo(1), // within windowMonths/4
  };
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 2);
});

// ---------------------------------------------------------------------------
// Window-setting variation — the same game's played-4-months-ago lands in a
// different band depending on the windowMonths setting, proving the setting
// reshuffles the ranking rather than being cosmetic.
// ---------------------------------------------------------------------------

test("window variation: a game played 4 months ago bands differently under a 12mo vs 3mo window", () => {
  const rtime = rtimeMonthsAgo(4);
  const game = { playtime_forever: 300, rtime_last_played: rtime };

  // 12-month window: 4 > 12/4=3, but <= 12 -> x1.5
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 1.5);

  // 3-month window: 4 > 3/4=0.75, and 4 > 3, but <= 2*3=6 -> x1
  assert.equal(recencyMultiplier(game, 3, FIXED_NOW), 1);

  // Confirms the two windows disagree on this game's band.
  assert.notEqual(
    recencyMultiplier(game, 12, FIXED_NOW),
    recencyMultiplier(game, 3, FIXED_NOW),
  );
});

test("window variation: a game played 2 months ago is x2 under a 3mo window but x1.5 under a 12mo window", () => {
  const rtime = rtimeMonthsAgo(2);
  const game = { playtime_forever: 300, rtime_last_played: rtime };

  // 3-month window: windowMonths/4 = 0.75; 2 > 0.75, but <= 3 -> x1.5... wait check next line
  assert.equal(recencyMultiplier(game, 3, FIXED_NOW), 1.5);

  // 12-month window: windowMonths/4 = 3; 2 <= 3 -> x2
  assert.equal(recencyMultiplier(game, 12, FIXED_NOW), 2);

  assert.notEqual(
    recencyMultiplier(game, 3, FIXED_NOW),
    recencyMultiplier(game, 12, FIXED_NOW),
  );
});
