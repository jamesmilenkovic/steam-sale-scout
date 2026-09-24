// The shared test session (Increment 15, SPEC.md §13.1).
//
// THIS SIGNS FOR REAL. IT DOES NOT STUB THE VERIFIER, AND IT MUST NOT.
// James ruled on 2026-09-15 that tests reaching handlers beneath the gate is
// rejected, because that is the exact shape of the gap increment 14 shipped: a
// suite that proves the handlers work while proving nothing about whether the
// door is shut. Every cookie minted here goes through `mintSessionToken` from
// src/auth.js with a real HMAC over a real secret, and the gate verifies it the
// same way it verifies James's own. If the gate breaks, these tests break.
//
// WHY A WRAPPER AND NOT 124 EDITED CALL SITES. Ten existing test files call
// `worker.fetch(request, env, ctx)` 124 times between them. Editing each one to
// add a cookie header and two env vars is 124 chances to weaken an assertion by
// accident, and SPEC.md §13.2 forbids exactly that: no existing test deleted, no
// existing assertion weakened. So each file swaps its ONE import line for
// `signedWorker(worker)` and every call site stays byte-identical. The gate
// still runs, in full, on all 124.

import { SESSION_COOKIE, mintSessionToken } from "../../src/auth.js";

/** The suite's SESSION_SECRET. Fixed, so a token minted in one test verifies in
 * another, and obviously fake so nobody mistakes it for a real one. */
export const TEST_SESSION_SECRET = "test-session-secret-not-a-real-one";

/**
 * The suite's SteamID64.
 *
 * **CHOSEN BECAUSE IT LOSES PRECISION AS A JAVASCRIPT NUMBER.**
 * `Number("76561198012345679")` is `76561198012345680` – the last digit is
 * gone. Any code anywhere under the gate that does `Number()`, `parseInt` or
 * arithmetic on this id produces a value that does not match it, so the
 * string-safety property SPEC.md §6.1 demands is exercised by every one of the
 * 830 existing tests rather than by one dedicated test that could rot.
 *
 * It is a valid SteamID64 in shape (17 digits, `7656119...`) and belongs to
 * nobody in particular.
 */
export const TEST_STEAM_ID = "76561198012345679";

/** The two env vars the gate needs to let `TEST_STEAM_ID` through: the secret
 * its cookie is signed with, and an allow-list it appears on (SPEC.md §9's
 * revocation check runs on EVERY request, not just at login, so the list has to
 * be present or every gated test 401s). */
export const TEST_SESSION_ENV = Object.freeze({
  SESSION_SECRET: TEST_SESSION_SECRET,
  ALLOWED_STEAM_IDS: TEST_STEAM_ID,
});

/**
 * A freshly signed token, minted per call rather than once per process.
 *
 * **MINTED FRESH ON PURPOSE, AND CACHING IT BREAKS THE SUITE.** Several tests
 * stub `Date.now` to step deterministically (test/worker-marks.test.mjs:165
 * winds it back to 2025 so three writes cannot land in the same millisecond).
 * A token minted under the real clock and verified under a stubbed one has an
 * age of minus a year, `verifySessionToken` fails closed as it should, and the
 * test 401s for a reason that has nothing to do with what it is testing.
 * Minting inside the call means the token's `iat` and the gate's `now` always
 * come from the same clock, stubbed or not. It costs one HMAC per request.
 */
export function testSessionToken() {
  return mintSessionToken(TEST_SESSION_SECRET, TEST_STEAM_ID);
}

/** The value for a request's `Cookie` header: `__Host-sss_session=<token>`. */
export async function testCookieHeader() {
  return `${SESSION_COOKIE}=${await testSessionToken()}`;
}

/** The same request with the session cookie attached. The original is left
 * alone; `new Request(request, { headers })` carries the method, the URL and
 * the body across unchanged. */
export async function signedRequest(request) {
  const headers = new Headers(request.headers);
  headers.set("cookie", await testCookieHeader());
  return new Request(request, { headers });
}

/**
 * The env the test built, with the two session vars added.
 *
 * ADDED IN PLACE, AND ONLY WHEN ABSENT. In place, because several tests hold a
 * reference to the env object across calls and a copy would break that
 * identity. Only when absent, so a test that deliberately sets its own
 * SESSION_SECRET or ALLOWED_STEAM_IDS (to prove a revocation, say) keeps it.
 */
export function withSessionEnv(env) {
  if (!env || typeof env !== "object") return env;
  if (env.SESSION_SECRET === undefined) env.SESSION_SECRET = TEST_SESSION_ENV.SESSION_SECRET;
  if (env.ALLOWED_STEAM_IDS === undefined) env.ALLOWED_STEAM_IDS = TEST_SESSION_ENV.ALLOWED_STEAM_IDS;
  return env;
}

/**
 * The worker, driven as a signed-in user.
 *
 * Drop-in for the default export of src/worker.js: same `fetch(request, env,
 * ctx)` shape, same return value, with a genuinely signed cookie on the request
 * and the matching secret on the env. Nothing is bypassed – the gate reads the
 * cookie, recomputes the HMAC and checks the allow-list on every single call.
 */
export function signedWorker(worker) {
  return {
    async fetch(request, env, ctx) {
      return worker.fetch(await signedRequest(request), withSessionEnv(env), ctx);
    },
  };
}
