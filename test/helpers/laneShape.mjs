// QA TC-5 (round-2 review) – shared assertion for SPEC.md gate (f).
//
// Gate (f) is the zero-diff claim: "/api/fpm, Recs, Best-of, Deals, Wishlist
// responses byte-identical vs base (nothing consumes the new columns yet)".
// Before this helper, not one test in worker-fpm / worker-recs / worker-hof /
// worker-deals / worker-wishlist asserted a key SET on a response entry, only
// individual fields – so an `experience_score` (or a camelCased
// `experienceScore`) added to a lane's SELECT and passed straight through the
// response builder would have failed nothing at all. The claim was inferred
// from reading the diff, not asserted.
//
// Two things are checked, per lane:
//   1. an exhaustive `Object.keys(entry).sort()` deepEqual, which catches ANY
//      new field, whatever it is called; and
//   2. this walk, which names the increment-10 columns explicitly so the
//      failure message says what leaked rather than just diffing two arrays.

/** The eight columns SPEC.md §2 adds to `fpm_catalog`, plus the two
 * SPEC-10.5.md §3 adds, in both the snake_case D1 spelling and the camelCase
 * spelling a response builder would use. */
const EXPERIENCE_KEY_PATTERNS = [
  /^experience/i, // experience_score/_reason/_confidence/_checked_at/_model/_rubric, experienceScore, ...
  /^has_?ending$/i, // has_ending / hasEnding
  /^hours_?to/i, // hours_to_value / hours_to_good / hoursToValue / hoursToGood
  /^game_?score$/i, // game_score / gameScore - increment 10.5, and NOT covered
  // by /^experience/ the way experience_rubric happens to be.
];

/**
 * Walk a parsed lane response and fail if any key anywhere in it belongs to
 * increment 10's new columns.
 *
 * @param {unknown} value the parsed JSON body
 * @param {import("node:assert")} assert the caller's assert, so the failure
 *   is attributed to the calling test file
 * @param {string} path breadcrumb used in the failure message
 */
export function assertNoExperienceLeak(value, assert, path = "body") {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoExperienceLeak(v, assert, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    for (const pattern of EXPERIENCE_KEY_PATTERNS) {
      assert.ok(
        !pattern.test(key),
        `SPEC.md gate (f): the experience columns' ${key} leaked into a lane response at ${path}.${key} — ` +
          "nothing is meant to consume the experience columns until increment 11",
      );
    }
    assertNoExperienceLeak(v, assert, `${path}.${key}`);
  }
}
