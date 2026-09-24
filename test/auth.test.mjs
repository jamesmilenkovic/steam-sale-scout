// QA, increment 15 – SPEC.md §13.4: the auth module, the three /auth routes and
// the gate's refusals.
//
// WHY THIS FILE EXISTS. The test-coverage lane measured src/auth.js at 86.65%
// line but **43.90% branch and 61.90% function**, with `unauthorized()` at zero
// executions and these entirely uncovered: `isValidAssertionBody` (the
// authentication-bypass check), `steamIdFromClaimedId` (the host-spoof check),
// `parseKeyValueForm`, `mintNonce`, all four cookie builders, and
// `verifySessionToken`'s fail-closed catch. src/worker.js's whole
// login/callback/logout block – about 153 lines – had no test at all. The
// increment's proof for every one of those was a manual `curl`.
//
// THE MOST IMPORTANT TEST IN THIS FILE is "check_authentication answering
// HTTP 200 with is_valid:false is REFUSED". Ticket #2 measured live that Steam
// answers **200** for a forged assertion, so a callback that checks `res.ok` is
// not a weakness, it is a complete authentication bypass – anyone signs in as
// anyone. It is asserted against a realistic captured body shape, not a bare
// string, because `is_valid:false` sits one line under `ns:` and a naive
// `body.includes("true")` is also a bypass.
//
// NO TEST HERE CALLS steamcommunity.com (SPEC.md §13.6). The identity provider
// is stubbed at `globalThis.fetch`, and `makeOfflineFetchGuard` is the resting
// value so a forgotten stub fails loudly instead of dialling out.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js"; // UNWRAPPED – the gate must actually run.
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";
import {
  SESSION_COOKIE,
  OIDC_STATE_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SESSION_REISSUE_AFTER_SECONDS,
  OIDC_STATE_MAX_AGE_SECONDS,
  mintSessionToken,
  verifySessionToken,
  mintNonce,
  readCookie,
  sessionCookie,
  oidcStateCookie,
  clearSessionCookie,
  clearOidcStateCookie,
  parseKeyValueForm,
  isValidAssertionBody,
  steamIdFromClaimedId,
  isAllowedSteamId,
  isOwnerSteamId,
} from "../src/auth.js";

const SECRET = "test-session-secret-not-a-real-one";
const OTHER_SECRET = "a-different-secret-entirely";

/** A SteamID64 that LOSES ITS LAST DIGIT AS A JAVASCRIPT NUMBER:
 * `Number("76561198012345679")` is `76561198012345680`. Every round trip below
 * asserts byte-identity against this, so a `Number()` or a `parseInt` anywhere
 * on the path shows up as a failed comparison rather than as a quiet collision
 * between two users. */
const STEAM_ID = "76561198012345679";
const OTHER_STEAM_ID = "76561198098765431";
const CLAIMED_ID = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const ORIGIN = "https://scout.example";

// A captured-shape check_authentication body. Ticket #2 §2.2 probed this live:
// a fabricated signature, no signature at all, and a GET all came back HTTP 200
// with a body of exactly this shape.
const BODY_VALID = "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n";
const BODY_INVALID = "ns:http://specs.openid.net/auth/2.0\nis_valid:false\n";

function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), flush: () => Promise.all(pending) };
}

function makeEnv(overrides = {}) {
  return {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    SESSION_SECRET: SECRET,
    ALLOWED_STEAM_IDS: STEAM_ID,
    OWNER_STEAM_ID: STEAM_ID,
    PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  };
}

function cookieHeader(token) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

// base64url, local to the test so a token can be forged byte by byte rather
// than only minted through the function under test.
const enc = new TextEncoder();
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(text) {
  return b64url(enc.encode(text));
}
/** A token whose payload half is arbitrary text, signed for real. This is how
 * the "signature valid, payload nonsense" paths get reached at all. */
async function forgeToken(secret, payloadText) {
  const payload = b64urlStr(payloadText);
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

test.beforeEach(() => {
  globalThis.fetch = makeOfflineFetchGuard("auth");
});

// ===========================================================================
// 1. The token (SPEC.md §6.1)
// ===========================================================================

test("a freshly minted token verifies, and reports the subject it was minted for", async () => {
  const token = await mintSessionToken(SECRET, STEAM_ID);
  const verified = await verifySessionToken(SECRET, token);
  assert.ok(verified);
  assert.equal(verified.steamId, STEAM_ID);
  assert.equal(verified.needsReissue, false);
});

test("`sub` SURVIVES AS A STRING through a full round trip, BYTE-IDENTICAL", async () => {
  // Number("76561198012345679") === 76561198012345680. If anything on this path
  // does arithmetic on the id, this comparison is what catches it – and a
  // consistent corruption is worse than a random one, because two users can
  // collide onto one key.
  assert.notEqual(String(Number(STEAM_ID)), STEAM_ID, "the fixture must be a precision-losing id");

  const token = await mintSessionToken(SECRET, STEAM_ID);
  const verified = await verifySessionToken(SECRET, token);
  assert.equal(typeof verified.steamId, "string");
  assert.equal(verified.steamId, STEAM_ID);
  // And the id is not numeric anywhere in the wire format either.
  const payloadB64 = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
  const decoded = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(payloadB64), (c) => c.charCodeAt(0))),
  );
  assert.equal(typeof decoded.sub, "string");
  assert.equal(decoded.sub, STEAM_ID);
});

test("A TAMPERED PAYLOAD IS REJECTED – swapping the subject for someone else's id", async () => {
  const token = await mintSessionToken(SECRET, STEAM_ID);
  const sig = token.split(".")[1];
  const forgedPayload = b64urlStr(JSON.stringify({ sub: OTHER_STEAM_ID, iat: Date.now() }));
  assert.equal(await verifySessionToken(SECRET, `${forgedPayload}.${sig}`), null);
});

test("A TAMPERED SIGNATURE IS REJECTED – one flipped character", async () => {
  const token = await mintSessionToken(SECRET, STEAM_ID);
  const [payload, sig] = token.split(".");
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  assert.equal(await verifySessionToken(SECRET, `${payload}.${flipped}`), null);
  // And a truncated signature, which is the length-mismatch branch.
  assert.equal(await verifySessionToken(SECRET, `${payload}.${sig.slice(0, 10)}`), null);
});

test("A TOKEN SIGNED WITH A DIFFERENT SECRET IS REJECTED – the panic button works", async () => {
  // Rotating SESSION_SECRET is the ONLY real revocation this design has
  // (src/auth.js's header). If an old token still verified after a rotation,
  // the panic button would be decorative.
  const token = await mintSessionToken(OTHER_SECRET, STEAM_ID);
  assert.equal(await verifySessionToken(SECRET, token), null);
  assert.ok(await verifySessionToken(OTHER_SECRET, token), "and it still verifies under its own secret");
});

test("verification fails closed on every malformed shape, and never throws", async () => {
  const now = Date.now();
  const cases = [
    ["", "empty"],
    ["no-dot-at-all", "no separator"],
    [".sig", "empty payload half"],
    ["payload.", "empty signature half"],
    ["a.b.c", "two separators"],
    ["!!!.###", "outside the base64url alphabet"],
    [null, "null"],
    [undefined, "undefined"],
    [12345, "a number"],
    [{}, "an object"],
  ];
  for (const [token, label] of cases) {
    assert.equal(await verifySessionToken(SECRET, token, now), null, `${label} must verify as null`);
  }
  // A missing or empty secret is a refusal, not a throw.
  const good = await mintSessionToken(SECRET, STEAM_ID);
  assert.equal(await verifySessionToken(undefined, good), null);
  assert.equal(await verifySessionToken("", good), null);
});

test("THE FAIL-CLOSED CATCH: a correctly signed token whose payload is not JSON verifies as null", async () => {
  // Reaches `verifySessionToken`'s catch, which the coverage run showed was
  // never executed. The signature is genuine, so the only thing standing
  // between this and a session is the catch.
  assert.equal(await verifySessionToken(SECRET, await forgeToken(SECRET, "not json at all")), null);
  assert.equal(await verifySessionToken(SECRET, await forgeToken(SECRET, "[1,2,3]")), null);
  assert.equal(await verifySessionToken(SECRET, await forgeToken(SECRET, "null")), null);
});

test("a correctly signed token with a NUMERIC `sub` is rejected, not coerced", async () => {
  // The defect SPEC.md §6.1 names by name. A numeric sub is a corrupted id.
  const token = await forgeToken(SECRET, JSON.stringify({ sub: 76561198012345679, iat: Date.now() }));
  assert.equal(await verifySessionToken(SECRET, token), null);
});

test("a correctly signed token with a missing or non-numeric `iat` is rejected", async () => {
  const now = Date.now();
  const bad = async (payload) => verifySessionToken(SECRET, await forgeToken(SECRET, JSON.stringify(payload)), now);
  assert.equal(await bad({ sub: STEAM_ID }), null);
  assert.equal(await bad({ sub: STEAM_ID, iat: "now" }), null);
  assert.equal(await bad({ sub: STEAM_ID, iat: Number.NaN }), null);
  assert.equal(await bad({ sub: "", iat: now }), null);
});

// --- the sliding window, with injected time rather than faked timers --------

test("THE SLIDING RE-ISSUE DOES NOT FIRE BEFORE 90 DAYS", async () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const day = 86_400_000;
  for (const ageDays of [0, 1, 45, 89, 89.9]) {
    const token = await mintSessionToken(SECRET, STEAM_ID, now - ageDays * day);
    const verified = await verifySessionToken(SECRET, token, now);
    assert.ok(verified, `${ageDays} days old must still verify`);
    assert.equal(verified.needsReissue, false, `${ageDays} days old must NOT ask for a re-issue`);
  }
  // Exactly on the boundary is still `false` – the check is `>`, not `>=`.
  const exact = await mintSessionToken(SECRET, STEAM_ID, now - SESSION_REISSUE_AFTER_SECONDS * 1000);
  assert.equal((await verifySessionToken(SECRET, exact, now)).needsReissue, false);
});

test("THE SLIDING RE-ISSUE FIRES PAST 90 DAYS, and the session still verifies", async () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const day = 86_400_000;
  for (const ageDays of [90.5, 120, 179, 179.9]) {
    const token = await mintSessionToken(SECRET, STEAM_ID, now - ageDays * day);
    const verified = await verifySessionToken(SECRET, token, now);
    assert.ok(verified, `${ageDays} days old must still verify – 180 days, sliding`);
    assert.equal(verified.needsReissue, true, `${ageDays} days old must ask for a re-issue`);
    assert.equal(verified.steamId, STEAM_ID);
  }
});

test("past 180 days the token is dead, and a token from the FUTURE is dead too", async () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const justOver = await mintSessionToken(SECRET, STEAM_ID, now - (SESSION_MAX_AGE_SECONDS * 1000 + 1000));
  assert.equal(await verifySessionToken(SECRET, justOver, now), null);
  // Exactly 180 days is still alive – the check is `>`, not `>=`.
  const exact = await mintSessionToken(SECRET, STEAM_ID, now - SESSION_MAX_AGE_SECONDS * 1000);
  assert.ok(await verifySessionToken(SECRET, exact, now));
  // A negative age means someone made the payload up.
  const future = await mintSessionToken(SECRET, STEAM_ID, now + 60_000);
  assert.equal(await verifySessionToken(SECRET, future, now), null);
});

test("minting refuses a non-string subject and an absent secret, rather than inventing one", async () => {
  await assert.rejects(() => mintSessionToken("", STEAM_ID), /SESSION_SECRET/);
  await assert.rejects(() => mintSessionToken(undefined, STEAM_ID), /SESSION_SECRET/);
  await assert.rejects(() => mintSessionToken(SECRET, 76561198012345679), /non-empty string/);
  await assert.rejects(() => mintSessionToken(SECRET, ""), /non-empty string/);
});

test("mintNonce returns a fresh high-entropy base64url value every time", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const nonce = mintNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]+$/, "a nonce must be URL-safe – it rides in a query string");
    assert.ok(nonce.length >= 40, "256 bits of base64url is 43 characters");
    seen.add(nonce);
  }
  assert.equal(seen.size, 200, "every nonce must be distinct");
});

// ===========================================================================
// 2. The cookies (SPEC.md §6.2)
// ===========================================================================

test("both cookies carry __Host-, Secure, HttpOnly, Path=/, SameSite=Lax and NO Domain", async () => {
  const token = await mintSessionToken(SECRET, STEAM_ID);
  for (const [label, header] of [["session", sessionCookie(token)], ["state", oidcStateCookie("abc")]]) {
    assert.match(header, /^__Host-/, `${label}: the __Host- prefix is in the name`);
    assert.match(header, /; Secure/, `${label}: Secure`);
    assert.match(header, /; HttpOnly/, `${label}: HttpOnly`);
    assert.match(header, /Path=\/(;|$)/, `${label}: Path=/`);
    // SameSite=Lax IS MANDATORY AND Strict IS FORBIDDEN: the Steam callback is
    // a cross-site top-level navigation and Strict drops the cookie on exactly
    // that, so every login would fail (ticket #2 §2.5).
    assert.match(header, /; SameSite=Lax/, `${label}: SameSite=Lax`);
    assert.doesNotMatch(header, /SameSite=Strict/, `${label}: Strict is forbidden`);
    assert.doesNotMatch(header, /Domain=/i, `${label}: __Host- forbids Domain`);
  }
  assert.match(sessionCookie(token), new RegExp(`Max-Age=${SESSION_MAX_AGE_SECONDS}(;|$)`));
  assert.match(oidcStateCookie("abc"), new RegExp(`Max-Age=${OIDC_STATE_MAX_AGE_SECONDS}(;|$)`));
  assert.equal(SESSION_MAX_AGE_SECONDS, 180 * 24 * 60 * 60);
  assert.equal(OIDC_STATE_MAX_AGE_SECONDS, 10 * 60);
});

test("each CLEAR carries attributes IDENTICAL to its SETTER – a browser drops a cookie only when they match", async () => {
  const attrs = (header) =>
    header
      .split(";")
      .slice(1)
      .map((s) => s.trim())
      .filter((s) => !/^Max-Age=/.test(s))
      .sort();
  const token = await mintSessionToken(SECRET, STEAM_ID);
  assert.deepEqual(attrs(clearSessionCookie()), attrs(sessionCookie(token)));
  assert.deepEqual(attrs(clearOidcStateCookie()), attrs(oidcStateCookie("abc")));
  assert.match(clearSessionCookie(), /^__Host-sss_session=; Max-Age=0;/);
  assert.match(clearOidcStateCookie(), /^__Host-sss_oidc_state=; Max-Age=0;/);
});

test("readCookie picks the right cookie out of a crowded header and is not fooled by prefixes", () => {
  const req = (header) => new Request("https://x/", { headers: header ? { cookie: header } : {} });
  assert.equal(readCookie(req(`a=1; ${SESSION_COOKIE}=tok; b=2`), SESSION_COOKIE), "tok");
  assert.equal(readCookie(req(`${SESSION_COOKIE}=tok`), SESSION_COOKIE), "tok");
  assert.equal(readCookie(req("sss_session=tok"), SESSION_COOKIE), null, "the unprefixed name is a DIFFERENT cookie");
  assert.equal(readCookie(req(`${SESSION_COOKIE}_extra=tok`), SESSION_COOKIE), null);
  assert.equal(readCookie(req(null), SESSION_COOKIE), null);
  assert.equal(readCookie(req("malformed"), SESSION_COOKIE), null);
  assert.equal(readCookie(req(`${OIDC_STATE_COOKIE}=n; ${SESSION_COOKIE}=t`), OIDC_STATE_COOKIE), "n");
});

// ===========================================================================
// 3. check_authentication – THE AUTHENTICATION-BYPASS CHECK (SPEC.md §8.2.3)
// ===========================================================================

test("parseKeyValueForm reads Steam's LF-terminated key:value body, colons in values and all", () => {
  const map = parseKeyValueForm(BODY_VALID);
  assert.equal(map.get("ns"), "http://specs.openid.net/auth/2.0", "the value keeps its own colons");
  assert.equal(map.get("is_valid"), "true");
  assert.equal(parseKeyValueForm("a:1\r\nb:2\r\n").get("b"), "2", "CRLF is tolerated");
  assert.equal(parseKeyValueForm("").size, 0);
  assert.equal(parseKeyValueForm(undefined).size, 0);
  assert.equal(parseKeyValueForm("no-colon-here").size, 0);
});

test("*** THE BYPASS TEST *** a realistic HTTP-200 `is_valid:false` body is NOT a valid assertion", () => {
  // Ticket #2 §2.2, measured live: a forged assertion comes back HTTP **200**
  // with this exact body shape. A handler that checks `res.ok` here logs
  // anybody in as anybody. This is the single most important assertion in the
  // file.
  assert.equal(isValidAssertionBody(BODY_INVALID), false);
  assert.equal(isValidAssertionBody(BODY_VALID), true);
});

test("and it is not a substring test either – `is_valid` must be the KEY and `true` the whole VALUE", () => {
  // `body.includes("true")` is the other way to write the same bypass, and it
  // is one Steam-side field addition away from being live.
  assert.equal(isValidAssertionBody("ns:http://specs.openid.net/auth/2.0\nis_valid:false\nerror:true\n"), false);
  assert.equal(isValidAssertionBody("is_valid:truex\n"), false);
  assert.equal(isValidAssertionBody("is_valid:TRUE\n"), false);
  assert.equal(isValidAssertionBody("is_valid: true\n"), false, "a leading space is not `true`");
  assert.equal(isValidAssertionBody("not_is_valid:true\n"), false);
  assert.equal(isValidAssertionBody(""), false);
  assert.equal(isValidAssertionBody(undefined), false);
  assert.equal(isValidAssertionBody("<html><body>is_valid:true</body></html>"), false);
});

// ===========================================================================
// 4. steamIdFromClaimedId – the host-spoof check (SPEC.md §8.2.4)
// ===========================================================================

test("THE HOST-SPOOF CHECK: a lookalike host is refused, however convincing", () => {
  assert.equal(steamIdFromClaimedId(`https://steamcommunity.com.evil.example/openid/id/${STEAM_ID}`), null);
  assert.equal(steamIdFromClaimedId(`https://evil.example/steamcommunity.com/openid/id/${STEAM_ID}`), null);
  assert.equal(steamIdFromClaimedId(`https://steamcommunity.com.evil.example:443/openid/id/${STEAM_ID}`), null);
  assert.equal(steamIdFromClaimedId(`https://notsteamcommunity.com/openid/id/${STEAM_ID}`), null);
  assert.equal(steamIdFromClaimedId(`https://www.steamcommunity.com/openid/id/${STEAM_ID}`), null, "a subdomain is not the host");
  assert.equal(steamIdFromClaimedId(`https://steamcommunity.com@evil.example/openid/id/${STEAM_ID}`), null, "userinfo is not the host");
  assert.equal(steamIdFromClaimedId(`javascript:steamcommunity.com/openid/id/${STEAM_ID}`), null);
  assert.equal(steamIdFromClaimedId(`ftp://steamcommunity.com/openid/id/${STEAM_ID}`), null);
});

test("steamIdFromClaimedId takes the real thing, over http and https, and returns a STRING", () => {
  assert.equal(steamIdFromClaimedId(CLAIMED_ID), STEAM_ID);
  assert.equal(typeof steamIdFromClaimedId(CLAIMED_ID), "string");
  // Valve documents the http form and it 302s to https live, so both are taken.
  assert.equal(steamIdFromClaimedId(`http://steamcommunity.com/openid/id/${STEAM_ID}`), STEAM_ID);
});

test("steamIdFromClaimedId refuses anything that is not exactly 17 digits at exactly that path", () => {
  assert.equal(steamIdFromClaimedId("https://steamcommunity.com/openid/id/123"), null);
  assert.equal(steamIdFromClaimedId(`https://steamcommunity.com/openid/id/${STEAM_ID}9`), null);
  assert.equal(steamIdFromClaimedId(`https://steamcommunity.com/openid/id/${STEAM_ID}/`), null);
  assert.equal(steamIdFromClaimedId(`https://steamcommunity.com/profiles/${STEAM_ID}`), null);
  assert.equal(steamIdFromClaimedId("https://steamcommunity.com/openid/id/765611980123456x"), null);
  assert.equal(steamIdFromClaimedId("not a url"), null);
  assert.equal(steamIdFromClaimedId(null), null);
  assert.equal(steamIdFromClaimedId(undefined), null);
  assert.equal(steamIdFromClaimedId(76561198012345679), null);
});

// ===========================================================================
// 5. The allow-list (SPEC.md §9)
// ===========================================================================

test("the allow-list matches on the exact id, tolerates spacing, and is not a substring test", () => {
  const env = { ALLOWED_STEAM_IDS: ` ${OTHER_STEAM_ID} , ${STEAM_ID} ` };
  assert.equal(isAllowedSteamId(env, STEAM_ID), true);
  assert.equal(isAllowedSteamId(env, OTHER_STEAM_ID), true);
  assert.equal(isAllowedSteamId(env, "76561198012345670"), false);
  assert.equal(isAllowedSteamId(env, STEAM_ID.slice(0, 16)), false, "a prefix is not a match");
  assert.equal(isAllowedSteamId(env, `${STEAM_ID}0`), false);
  assert.equal(isAllowedSteamId({}, STEAM_ID), false, "an absent list allows nobody");
  assert.equal(isAllowedSteamId({ ALLOWED_STEAM_IDS: "" }, STEAM_ID), false);
  assert.equal(isAllowedSteamId(null, STEAM_ID), false);
  assert.equal(isAllowedSteamId(env, ""), false);
  assert.equal(isAllowedSteamId(env, 76561198012345679), false, "a number is never allowed");
});

test("THE OWNER IS IMPLICITLY ALLOWED even with an empty list – the paste-typo guard", () => {
  const env = { ALLOWED_STEAM_IDS: "", OWNER_STEAM_ID: STEAM_ID };
  assert.equal(isAllowedSteamId(env, STEAM_ID), true);
  assert.equal(isAllowedSteamId(env, OTHER_STEAM_ID), false);
  assert.equal(isOwnerSteamId(env, STEAM_ID), true);
  assert.equal(isOwnerSteamId(env, OTHER_STEAM_ID), false);
  assert.equal(isOwnerSteamId({}, STEAM_ID), false);
  assert.equal(isOwnerSteamId({ OWNER_STEAM_ID: STEAM_ID }, ""), false);
});

// ===========================================================================
// 6. The gate's refusals (SPEC.md §7.1)
// ===========================================================================

function gateStatus(env, headers = {}) {
  return worker.fetch(new Request("https://x/api/marks", { headers }), env, makeCtx());
}

test("THE GATE RETURNS 401 – NOT 500 AND NOT 200 – WHEN SESSION_SECRET IS MISSING", async () => {
  // SPEC.md §7.1's named case. A 500 here would be a fail-open in disguise on
  // any deployment that later added a permissive error page, and a 200 would
  // be the front door.
  const token = await mintSessionToken(SECRET, STEAM_ID);
  for (const secret of [undefined, "", null, 12345]) {
    const env = makeEnv({ SESSION_SECRET: secret });
    const res = await gateStatus(env, cookieHeader(token));
    assert.equal(res.status, 401, `SESSION_SECRET=${JSON.stringify(secret)} must give 401`);
    assert.deepEqual(await res.json(), { error: "not signed in" });
  }
});

test("A SIGNED COOKIE FOR A SINCE-REMOVED ID IS REFUSED AT THE GATE – this is the revocation", async () => {
  // Ticket #7 traded the session store away ON THE GROUNDS that the allow-list
  // is the revocation. A login-only check would leave a removed mate working
  // for the full 180 days of their cookie. The cookie below is genuinely
  // signed and entirely valid; the only thing wrong with it is that its owner
  // is no longer invited.
  const token = await mintSessionToken(SECRET, OTHER_STEAM_ID);
  const stillOnList = makeEnv({ ALLOWED_STEAM_IDS: `${STEAM_ID},${OTHER_STEAM_ID}` });
  assert.notEqual((await gateStatus(stillOnList, cookieHeader(token))).status, 401, "sanity: on the list, it gets in");

  const removed = makeEnv({ ALLOWED_STEAM_IDS: STEAM_ID, OWNER_STEAM_ID: STEAM_ID });
  const res = await gateStatus(removed, cookieHeader(token));
  assert.equal(res.status, 401, "taken off the list, the NEXT request fails");
  assert.deepEqual(await res.json(), { error: "not signed in" });
});

test("a tampered payload, a tampered signature and a foreign secret each get 401 AT THE GATE", async () => {
  // BOTH ids are on the list, so the only thing that can produce a 401 below
  // is the broken signature. If the swapped-subject token were refused merely
  // for being off the allow-list, this test would pass without proving the
  // HMAC does anything.
  const env = makeEnv({ ALLOWED_STEAM_IDS: `${STEAM_ID},${OTHER_STEAM_ID}` });
  const good = await mintSessionToken(SECRET, STEAM_ID);
  const [payload, sig] = good.split(".");
  assert.notEqual(
    (await gateStatus(env, cookieHeader(await mintSessionToken(SECRET, OTHER_STEAM_ID)))).status,
    401,
    "sanity: a PROPERLY signed token for the other id gets in under this env",
  );

  // Someone else's subject, carrying this token's signature.
  const tamperedPayload = `${b64urlStr(JSON.stringify({ sub: OTHER_STEAM_ID, iat: Date.now() }))}.${sig}`;
  const tamperedSig = `${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  const foreign = await mintSessionToken(OTHER_SECRET, STEAM_ID);

  for (const [label, token] of [
    ["tampered payload", tamperedPayload],
    ["tampered signature", tamperedSig],
    ["foreign secret", foreign],
  ]) {
    const res = await gateStatus(env, cookieHeader(token));
    assert.equal(res.status, 401, `${label} must be 401`);
  }
  assert.notEqual((await gateStatus(env, cookieHeader(good))).status, 401, "sanity: the untampered cookie gets in");
});

test("an expired cookie is 401, and a re-issuable one gets a fresh Set-Cookie riding on the response", async () => {
  const env = makeEnv();
  const now = Date.now();
  const dead = await mintSessionToken(SECRET, STEAM_ID, now - (SESSION_MAX_AGE_SECONDS * 1000 + 60_000));
  assert.equal((await gateStatus(env, cookieHeader(dead))).status, 401);

  const stale = await mintSessionToken(SECRET, STEAM_ID, now - 100 * 86_400_000);
  const res = await gateStatus(env, cookieHeader(stale));
  assert.notEqual(res.status, 401);
  const setCookies = res.headers.getSetCookie();
  assert.equal(setCookies.length, 1, "a slid session re-issues exactly one cookie");
  assert.match(setCookies[0], new RegExp(`^${SESSION_COOKIE}=`));
  const reissued = setCookies[0].slice(`${SESSION_COOKIE}=`.length).split(";")[0];
  const verified = await verifySessionToken(SECRET, reissued);
  assert.equal(verified.steamId, STEAM_ID, "the slid cookie carries the SAME subject, still a string");
  assert.equal(verified.needsReissue, false, "and it is fresh, so it will not slide again immediately");
});

// ===========================================================================
// 7. GET /api/me – above the gate, and it must be able to answer "no"
// ===========================================================================

test("GET /api/me with NO cookie is 200 {signedIn:false}, NEVER 401", async () => {
  // SPEC.md §7.2. Gating this makes it unable to answer no, and the whole
  // signed-out page depends on the answer.
  const res = await worker.fetch(new Request("https://x/api/me"), makeEnv(), makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { signedIn: false });
});

test("GET /api/me signed in reports the steamId as a STRING, byte-identical, plus the owner flag", async () => {
  const token = await mintSessionToken(SECRET, STEAM_ID);
  const res = await worker.fetch(new Request("https://x/api/me", { headers: cookieHeader(token) }), makeEnv(), makeCtx());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.signedIn, true);
  assert.equal(typeof body.steamId, "string");
  assert.equal(body.steamId, STEAM_ID);
  assert.equal(body.owner, true);
  assert.deepEqual(Object.keys(body).sort(), ["owner", "signedIn", "steamId"]);
});

test("GET /api/me for a non-owner on the list reports owner:false", async () => {
  const token = await mintSessionToken(SECRET, OTHER_STEAM_ID);
  const env = makeEnv({ ALLOWED_STEAM_IDS: `${STEAM_ID},${OTHER_STEAM_ID}`, OWNER_STEAM_ID: STEAM_ID });
  const res = await worker.fetch(new Request("https://x/api/me", { headers: cookieHeader(token) }), env, makeCtx());
  assert.deepEqual(await res.json(), { signedIn: true, steamId: OTHER_STEAM_ID, owner: false });
});

test("GET /api/me with a REVOKED but validly signed cookie answers 200 {signedIn:false}, not 401", async () => {
  const token = await mintSessionToken(SECRET, OTHER_STEAM_ID);
  const env = makeEnv({ ALLOWED_STEAM_IDS: STEAM_ID, OWNER_STEAM_ID: STEAM_ID });
  const res = await worker.fetch(new Request("https://x/api/me", { headers: cookieHeader(token) }), env, makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { signedIn: false });
});

test("POST /api/me is 405 – the method is matched above the gate, so it is not a 401", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await worker.fetch(new Request("https://x/api/me", { method }), makeEnv(), makeCtx());
    assert.equal(res.status, 405, `${method} /api/me`);
    assert.deepEqual(await res.json(), { error: "method not allowed" });
  }
});

// ===========================================================================
// 8. GET /auth/login (SPEC.md §8.1)
// ===========================================================================

test("GET /auth/login 302s to Steam with realm and return_to taken from PUBLIC_ORIGIN, and sets the nonce cookie", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/auth/login`), makeEnv(), makeCtx());
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, STEAM_OPENID_ENDPOINT);
  assert.equal(location.searchParams.get("openid.ns"), "http://specs.openid.net/auth/2.0");
  assert.equal(location.searchParams.get("openid.mode"), "checkid_setup");
  assert.equal(location.searchParams.get("openid.identity"), "http://specs.openid.net/auth/2.0/identifier_select");
  assert.equal(location.searchParams.get("openid.claimed_id"), "http://specs.openid.net/auth/2.0/identifier_select");
  assert.equal(location.searchParams.get("openid.realm"), ORIGIN);

  // The state in return_to is the same nonce as the cookie – that is what makes
  // it signature-covered once Steam signs return_to.
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(OIDC_STATE_COOKIE));
  assert.ok(setCookie, "the nonce cookie is NOT optional (SPEC.md §6.2)");
  const nonce = setCookie.slice(`${OIDC_STATE_COOKIE}=`.length).split(";")[0];
  assert.equal(location.searchParams.get("openid.return_to"), `${ORIGIN}/auth/callback?state=${nonce}`);
});

test("GET /auth/login on a hostname that is not PUBLIC_ORIGIN is refused – the realm is never request-derived", async () => {
  // One Worker is reachable on more than one hostname, so a request-derived
  // realm is partly attacker-influenced (ticket #2 §1.5).
  const res = await worker.fetch(
    new Request("https://evil.example/auth/login", { headers: { host: "evil.example" } }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not available on this hostname/i);
});

test("GET /auth/login with no PUBLIC_ORIGIN refuses in plain text and clears BOTH cookies", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/auth/login`), makeEnv({ PUBLIC_ORIGIN: undefined }), makeCtx());
  assert.equal(res.status, 500);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.deepEqual(
    res.headers.getSetCookie().map((c) => c.split(";")[0]).sort(),
    [`${OIDC_STATE_COOKIE}=`, `${SESSION_COOKIE}=`],
  );
});

test("POST /auth/login is 405", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/auth/login`, { method: "POST" }), makeEnv(), makeCtx());
  assert.equal(res.status, 405);
});

// ===========================================================================
// 9. GET /auth/callback (SPEC.md §8.2)
// ===========================================================================

const NONCE = "test-nonce-abc123";

/** A callback request that is correct in every respect, so each test below can
 * break exactly one thing and attribute the refusal to it. */
function callbackRequest(overrides = {}, { nonceCookie = NONCE, state = NONCE } = {}) {
  const params = {
    state,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id": CLAIMED_ID,
    "openid.identity": CLAIMED_ID,
    "openid.return_to": `${ORIGIN}/auth/callback?state=${state}`,
    "openid.response_nonce": "2026-09-22T09:00:00ZAbCdEf",
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "Zm9yZ2VkLXNpZ25hdHVyZQ==",
    ...overrides,
  };
  const url = new URL(`${ORIGIN}/auth/callback`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, v);
  }
  const headers = nonceCookie === null ? {} : { cookie: `${OIDC_STATE_COOKIE}=${nonceCookie}` };
  return new Request(url, { headers });
}

/** The identity provider, stubbed. NOTHING in this suite dials steamcommunity.com. */
function stubSteam(body, { status = 200, throws = false } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input?.url ?? input), init });
    if (throws) throw new Error("connect ETIMEDOUT");
    return new Response(body, { status, headers: { "content-type": "text/plain" } });
  };
  return calls;
}

function sessionCookieFrom(res) {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
}

test("*** THE BYPASS TEST, AT THE ROUTE *** check_authentication answering HTTP 200 with is_valid:false is REFUSED", async () => {
  // Steam answers **200** for a forged assertion (ticket #2 §2.2, measured
  // live). If this route checked `res.ok`, this test would mint a session for
  // an assertion Steam explicitly refused to confirm – anyone signs in as
  // anyone. Note the stub's status: 200, deliberately.
  stubSteam(BODY_INVALID, { status: 200 });
  const res = await worker.fetch(callbackRequest(), makeEnv(), makeCtx());

  assert.equal(res.status, 403);
  assert.match(await res.text(), /Steam did not confirm that login/i);
  assert.equal(sessionCookieFrom(res), undefined, "NO SESSION COOKIE MAY BE MINTED");
  // Every failure path clears both cookies (SPEC.md §8.2).
  assert.deepEqual(
    res.headers.getSetCookie().map((c) => c.split(";")[0]).sort(),
    [`${OIDC_STATE_COOKIE}=`, `${SESSION_COOKIE}=`],
  );
});

test("the happy path verifies against Steam by POSTing every openid.* field to the HARDCODED endpoint", async () => {
  const calls = stubSteam(BODY_VALID);
  const res = await worker.fetch(callbackRequest(), makeEnv(), makeCtx());

  assert.equal(calls.length, 1);
  // Verifying with the endpoint named IN the response would be verifying with
  // the attacker's own server. It goes to the constant, always.
  assert.equal(calls[0].url, STEAM_OPENID_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(sent.get("openid.mode"), "check_authentication", "only the mode is replaced");
  assert.equal(sent.get("openid.sig"), "Zm9yZ2VkLXNpZ25hdHVyZQ==", "every other field goes back verbatim");
  assert.equal(sent.get("openid.claimed_id"), CLAIMED_ID);
  assert.equal(sent.get("state"), null, "only openid.* fields are forwarded");

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const cookie = sessionCookieFrom(res);
  assert.ok(cookie, "a confirmed login mints the session cookie");
  const verified = await verifySessionToken(SECRET, cookie.slice(`${SESSION_COOKIE}=`.length).split(";")[0]);
  assert.equal(verified.steamId, STEAM_ID, "and its subject is the claimed id, as a string");
  assert.ok(
    res.headers.getSetCookie().some((c) => c.startsWith(`${OIDC_STATE_COOKIE}=;`)),
    "the nonce is spent: the state cookie is cleared on success too",
  );
});

test("A STATE MISMATCH AT THE CALLBACK IS REJECTED – and so is a missing state, and a missing cookie", async () => {
  // Without this an attacker feeds James their own callback URL and silently
  // signs him into the ATTACKER's account, so every mark he makes afterwards
  // lands on their data (ticket #2 §2.5, login CSRF).
  const cases = [
    ["a state that does not match the cookie", callbackRequest({}, { nonceCookie: "some-other-nonce" })],
    ["no state parameter at all", callbackRequest({ state: undefined, "openid.return_to": `${ORIGIN}/auth/callback` }, { state: undefined })],
    ["no nonce cookie at all", callbackRequest({}, { nonceCookie: null })],
    ["an empty nonce cookie", callbackRequest({}, { nonceCookie: "" })],
  ];
  for (const [label, request] of cases) {
    const calls = stubSteam(BODY_VALID);
    const res = await worker.fetch(request, makeEnv(), makeCtx());
    assert.equal(res.status, 400, label);
    assert.match(await res.text(), /did not match this browser/i, label);
    assert.equal(calls.length, 0, `${label}: the state check comes BEFORE Steam is even contacted`);
    assert.equal(sessionCookieFrom(res), undefined, label);
  }
});

test("AN OPENID.SIGNED LIST THAT OMITS claimed_id IS REJECTED – the account-impersonation hole", async () => {
  // James ruled this in on 2026-09-15. `openid.signed` names which fields
  // Steam's signature actually covers, and check_authentication then answers
  // is_valid:true perfectly honestly for the fields it DOES cover. So an
  // attacker takes a genuine assertion from their own login, drops claimed_id
  // from the signed list, swaps in James's SteamID64, and a callback that
  // skips this check logs them in as James – with Steam's blessing.
  const calls = stubSteam(BODY_VALID);
  const res = await worker.fetch(
    callbackRequest({ "openid.signed": "signed,op_endpoint,identity,return_to,response_nonce,assoc_handle" }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(res.status, 403);
  assert.match(await res.text(), /did not sign the parts/i);
  assert.equal(calls.length, 0, "and it is refused before Steam is asked, because the answer would be a truthful yes");
  assert.equal(sessionCookieFrom(res), undefined);
});

test("every other required field must be named in openid.signed too, and the names are UNPREFIXED", async () => {
  for (const omitted of ["identity", "return_to", "response_nonce", "op_endpoint"]) {
    const signed = ["claimed_id", "identity", "return_to", "response_nonce", "op_endpoint"]
      .filter((n) => n !== omitted)
      .join(",");
    stubSteam(BODY_VALID);
    const res = await worker.fetch(callbackRequest({ "openid.signed": signed }), makeEnv(), makeCtx());
    assert.equal(res.status, 403, `omitting ${omitted} must be refused`);
  }
  // Comparing the prefixed form finds nothing, passes nothing and looks like a
  // working check.
  stubSteam(BODY_VALID);
  const prefixed = await worker.fetch(
    callbackRequest({
      "openid.signed": "openid.claimed_id,openid.identity,openid.return_to,openid.response_nonce,openid.op_endpoint",
    }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(prefixed.status, 403);
});

test("an op_endpoint that is not Steam's is refused", async () => {
  stubSteam(BODY_VALID);
  const res = await worker.fetch(
    callbackRequest({ "openid.op_endpoint": "https://evil.example/openid/login" }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(res.status, 403);
  assert.match(await res.text(), /did not come from Steam/i);
});

test("a return_to issued for a DIFFERENT origin is refused, even with a matching state", async () => {
  stubSteam(BODY_VALID);
  const res = await worker.fetch(
    callbackRequest({ "openid.return_to": `https://evil.example/auth/callback?state=${NONCE}` }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(res.status, 403);
  assert.match(await res.text(), /issued for a different address/i);
});

test("AN ALLOW-LIST MISS IS REFUSED AT THE CALLBACK, with the id shown so James can paste it", async () => {
  // A refused stranger is a distinct third state (SPEC.md §9), served here and
  // never by the SPA, or they loop through Steam forever.
  stubSteam(BODY_VALID);
  const env = makeEnv({ ALLOWED_STEAM_IDS: OTHER_STEAM_ID, OWNER_STEAM_ID: OTHER_STEAM_ID });
  const res = await worker.fetch(callbackRequest(), env, makeCtx());

  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /invite only/i);
  assert.ok(body.includes(STEAM_ID), "the refusal shows the id, because that is how James gets it into the secret");
  assert.equal(sessionCookieFrom(res), undefined, "the allow-list is checked BEFORE the cookie is minted");
});

test("a claimed_id on a lookalike host is refused at the callback, not just in the helper", async () => {
  const evil = `https://steamcommunity.com.evil.example/openid/id/${STEAM_ID}`;
  stubSteam(BODY_VALID);
  const res = await worker.fetch(
    callbackRequest({ "openid.claimed_id": evil, "openid.identity": evil }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(res.status, 403);
  assert.match(await res.text(), /not a Steam account/i);
  assert.equal(sessionCookieFrom(res), undefined);
});

test("Steam being unreachable FAILS CLOSED – a thrown fetch is a refusal, never a pass", async () => {
  stubSteam(null, { throws: true });
  const res = await worker.fetch(callbackRequest(), makeEnv(), makeCtx());
  assert.equal(res.status, 403);
  assert.match(await res.text(), /did not confirm that login/i);
  assert.equal(sessionCookieFrom(res), undefined);
});

test("an empty or unparseable check_authentication body fails closed", async () => {
  for (const body of ["", "<html>503 Service Unavailable</html>", "ns:http://specs.openid.net/auth/2.0\n"]) {
    stubSteam(body);
    const res = await worker.fetch(callbackRequest(), makeEnv(), makeCtx());
    assert.equal(res.status, 403, `body ${JSON.stringify(body.slice(0, 20))} must be refused`);
    assert.equal(sessionCookieFrom(res), undefined);
  }
});

test("openid.mode cancel and error are ordinary outcomes, told plainly, and mint nothing", async () => {
  stubSteam(BODY_VALID);
  const cancelled = await worker.fetch(callbackRequest({ "openid.mode": "cancel" }), makeEnv(), makeCtx());
  assert.equal(cancelled.status, 400);
  assert.match(await cancelled.text(), /cancelled/i);
  assert.equal(sessionCookieFrom(cancelled), undefined);

  stubSteam(BODY_VALID);
  const errored = await worker.fetch(
    callbackRequest({ "openid.mode": "error", "openid.error": "something broke" }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(errored.status, 400);
  const body = await errored.text();
  assert.match(body, /Steam refused the sign-in/i);
  assert.ok(body.includes("something broke"), "Steam's own reason is reflected, not swallowed");
  assert.equal(errored.headers.get("x-content-type-options"), "nosniff", "reflected text is never sniffed");

  stubSteam(BODY_VALID);
  const nonsense = await worker.fetch(callbackRequest({ "openid.mode": "id_reso" }), makeEnv(), makeCtx());
  assert.equal(nonsense.status, 400);
});

test("a callback with no PUBLIC_ORIGIN refuses rather than deriving the origin from the request", async () => {
  stubSteam(BODY_VALID);
  const res = await worker.fetch(callbackRequest(), makeEnv({ PUBLIC_ORIGIN: undefined }), makeCtx());
  assert.equal(res.status, 500);
  assert.equal(sessionCookieFrom(res), undefined);
});

test("a confirmed login with no SESSION_SECRET refuses instead of issuing an unsigned session", async () => {
  stubSteam(BODY_VALID);
  const res = await worker.fetch(callbackRequest(), makeEnv({ SESSION_SECRET: undefined }), makeCtx());
  assert.equal(res.status, 500);
  assert.equal(sessionCookieFrom(res), undefined);
});

test("POST /auth/callback is 405", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/auth/callback`, { method: "POST" }), makeEnv(), makeCtx());
  assert.equal(res.status, 405);
});

// ===========================================================================
// 10. POST /auth/logout (SPEC.md §8.3)
// ===========================================================================

test("POST /auth/logout clears BOTH cookies with attributes IDENTICAL to the setters, and 302s home", async () => {
  const token = await mintSessionToken(SECRET, STEAM_ID);
  const res = await worker.fetch(
    new Request("https://x/auth/logout", { method: "POST", headers: cookieHeader(token) }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  // Byte-identical to the exported clears, which in turn share one attribute
  // constant with the setters. A browser only drops a cookie when they match.
  assert.ok(cookies.includes(clearSessionCookie()));
  assert.ok(cookies.includes(clearOidcStateCookie()));
  for (const c of cookies) {
    assert.match(c, /Max-Age=0/);
    assert.match(c, /Path=\//);
    assert.match(c, /Secure/);
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
  }
});

test("GET /auth/logout is 405 – a GET logout is fireable from any <img> tag", async () => {
  const res = await worker.fetch(new Request("https://x/auth/logout"), makeEnv(), makeCtx());
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: "method not allowed" });
});

test("an unknown /auth/ path is BELOW the gate: a stranger gets 401, not the asset handler", async () => {
  let assetsCalled = false;
  const env = makeEnv({
    ASSETS: {
      fetch: async () => {
        assetsCalled = true;
        return new Response("x");
      },
    },
  });
  const res = await worker.fetch(new Request("https://x/auth/anything-else"), env, makeCtx());
  assert.equal(res.status, 401);
  assert.equal(assetsCalled, false);
});
