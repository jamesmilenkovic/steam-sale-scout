// QA TC-5, second half – proof that the gate (f) guard actually bites.
//
// The five lane tests added in worker-fpm / worker-recs / worker-hof /
// worker-deals / worker-wishlist assert that no experience column leaks into
// a response. Those tests pass today. They would ALSO pass today if
// assertNoExperienceLeak were an empty function, and there is no way to prove
// otherwise by mutating src/ while a six-hour fill is running against it.
//
// So the guard is proved here instead, against synthetic bodies shaped like
// the real ones: a leak in each of the eight increment-10 columns, in both the
// D1 snake_case spelling and the camelCase a response builder would use, must
// fail — and a realistic clean body must not, because a guard that fires on
// `mainHours` or `funPerHour` would be worse than no guard at all.

import test from "node:test";
import assert from "node:assert/strict";
import { assertNoExperienceLeak } from "./helpers/laneShape.mjs";

/** A lane body with the shape of /api/fpm's, minus anything from inc 10. */
function cleanBody(extraEntryFields = {}) {
  return {
    available: true,
    ready: true,
    total: 1,
    matched: 1,
    fpm: [
      {
        appid: 200,
        title: "Portal 2",
        mainHours: 6.5,
        funPerHour: 14.2,
        fpm: 0.35,
        quality: 0.95,
        matchMethod: "name",
        owned: false,
        price: null,
        priceCheckedAt: 1700000000,
        historicalLow: null,
        atHistoricalLow: false,
        tagNames: ["Puzzle"],
        batteryFriendly: true,
        deck: { deck: 3, os: 3, frame: 0 },
        why: "Short and superb",
        ...extraEntryFields,
      },
    ],
  };
}

/** Runs the guard and returns the assertion message, or null if it passed. */
function leakMessage(body) {
  try {
    assertNoExperienceLeak(body, assert);
    return null;
  } catch (err) {
    return err.message;
  }
}

test("gate (f) guard: a realistic clean lane body passes — mainHours/funPerHour/priceCheckedAt are not false positives", () => {
  assert.equal(leakMessage(cleanBody()), null);
});

test("gate (f) guard: every one of SPEC.md §2's eight columns and SPEC-10.5.md §3's two is caught, in the D1 spelling", () => {
  const columns = [
    "experience_score",
    "has_ending",
    "hours_to_value",
    "hours_to_good",
    "experience_reason",
    "experience_confidence",
    "experience_checked_at",
    "experience_model",
    // Increment 10.5. `game_score` is the one that needed a new pattern:
    // nothing in the original three matches it, so without this the new
    // column was the single blind spot in the whole gate (f) guard.
    "game_score",
    "experience_rubric",
  ];
  for (const column of columns) {
    const message = leakMessage(cleanBody({ [column]: 70 }));
    assert.ok(message, `${column} leaked through the guard undetected`);
    assert.match(message, new RegExp(column));
    assert.match(message, /gate \(f\)/);
    assert.match(message, /body\.fpm\[0\]/, "and the message names where it leaked");
  }
});

test("gate (f) guard: the camelCase spellings a response builder would use are caught too", () => {
  for (const key of ["experienceScore", "hasEnding", "hoursToValue", "hoursToGood", "experienceReason", "experienceConfidence", "experienceCheckedAt", "experienceModel", "gameScore", "experienceRubric"]) {
    assert.ok(leakMessage(cleanBody({ [key]: 1 })), `${key} leaked through the guard undetected`);
  }
});

test("gate (f) guard: a leak nested below the entry, or at the top level, is caught wherever it sits", () => {
  const nested = cleanBody({ experience: { score: 70, reason: "x" } });
  assert.match(leakMessage(nested), /body\.fpm\[0\]\.experience/);

  const topLevel = { ...cleanBody(), experienceScored: 18221 };
  assert.match(leakMessage(topLevel), /body\.experienceScored/);

  // Deeply buried, under a key that is itself innocent.
  const buried = cleanBody();
  buried.fpm[0].deck = { deck: 3, os: 3, frame: 0, hours_to_value: 8 };
  assert.match(leakMessage(buried), /body\.fpm\[0\]\.deck\.hours_to_value/);
});

test("gate (f) guard: null, arrays of primitives and empty lanes do not throw or hang the walk", () => {
  assert.equal(leakMessage({ available: false, notice: "unavailable", fpm: [] }), null);
  assert.equal(leakMessage({ deals: [null, 1, "x", true] }), null);
  assert.equal(leakMessage({ wishlist: [{ tagNames: [] }], count: 0 }), null);
});
