// Steam Sale Scout – the session token, the two cookies and the allow-list
// (Increment 15, SPEC.md §6 and §9).
//
// THIS FILE INVERTS THIS PROJECT'S HOUSE STYLE ON PURPOSE. src/catalogCache.js:30
// says "FAIL-SOFT IS ABSOLUTE", and every handler in src/worker.js argues the
// same thing: when something goes wrong, answer 200 with less data rather than
// fail. That is right for a cache and catastrophic for auth. **Every function
// here fails CLOSED**: a malformed token, a missing secret, a thrown crypto
// call and an unreadable allow-list all produce "no, you are not signed in",
// never "probably fine". A future reader who "fixes" a catch here to match the
// rest of the codebase has opened the front door. SPEC.md §7.1.
//
// THE TOKEN IS STATELESS. There is no session store, in D1, in KV or anywhere
// else (ticket #7). KV loses on 1,000 writes/day and on eventual consistency
// bouncing the read straight after the login write; D1 loses on paying a row
// read per request to re-learn what the cookie already proves. The honest cost,
// recorded here so no review re-discovers it as a defect: a sliding stateless
// token can be renewed indefinitely by whoever holds it, so **rotating
// SESSION_SECRET is the documented panic button**, and it is the only lever
// that covers James – pulling himself off the allow-list would lock him out too.
//
// A STEAMID64 IS A STRING, ALWAYS. It is ~7.6e16 and blows past
// Number.MAX_SAFE_INTEGER by an order of magnitude, so `Number()` corrupts the
// last two or three digits, and corrupts them CONSISTENTLY – two different
// users can collide onto one key. Nothing in this file may do arithmetic on one.

const encoder = new TextEncoder();

/** 180 days, the session cookie's life and the token's maximum age. */
export const SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** Halfway. Past this, verification asks the caller to re-issue the cookie, so
 * an active user's session slides forward and never expires under them.
 * SPEC.md §6.1: "no absolute cap", and `iat` ships in the payload so adding
 * one later stays a one-line change. */
export const SESSION_REISSUE_AFTER_SECONDS = 90 * 24 * 60 * 60;
/** 10 minutes is a login round trip through Steam with room to spare. */
export const OIDC_STATE_MAX_AGE_SECONDS = 10 * 60;

export const SESSION_COOKIE = "__Host-sss_session";
export const OIDC_STATE_COOKIE = "__Host-sss_oidc_state";

// The `__Host-` prefix is a browser-enforced contract: the cookie MUST carry
// Secure and Path=/ and MUST NOT carry Domain, or the browser refuses to store
// it at all. That is exactly the shape we want (no subdomain can set it, no
// subdomain can read it), which is why the prefix is in the name.
//
// SameSite=Lax IS MANDATORY AND Strict IS FORBIDDEN (ticket #2 §2.5). The Steam
// callback arrives as a cross-site top-level navigation from steamcommunity.com;
// Strict withholds the cookie on exactly that navigation, so the state nonce is
// simply absent when the callback goes to compare it and EVERY login fails, in a
// way that looks like a Steam problem.
const COOKIE_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Lax";

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

function base64urlFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromBase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlFromString(value) {
  return base64urlFromBytes(encoder.encode(value));
}

function stringFromBase64url(value) {
  return new TextDecoder().decode(bytesFromBase64url(value));
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(secret, message) {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(signature);
}

/**
 * Constant-time byte comparison.
 *
 * WHY THIS IS NOT JUST `crypto.subtle.timingSafeEqual`, which SPEC.md §6.1
 * names. That method is a **Cloudflare Workers runtime extension**: it exists
 * in workerd (production, `wrangler dev`) and it does NOT exist in plain Node,
 * which is where `npm test` runs – `node --test` imports src/worker.js
 * directly, with no workerd, and `nodejs_compat` is off in wrangler.toml so
 * node:crypto is not a route either. Measured 2026-09-15 on this machine:
 * `typeof crypto.subtle.timingSafeEqual` is `undefined` under node v26.
 *
 * So: use the real one wherever it exists, and fall back to an XOR accumulator
 * over the raw bytes where it does not. What the spec actually forbids is `===`
 * on the base64 strings, and neither branch here does that.
 *
 * The length check is deliberate and safe: an HMAC-SHA256 signature is always
 * 32 bytes, so a length mismatch only says "this candidate is the wrong size",
 * which is public information and leaks nothing about the secret.
 */
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Mint a session token for one SteamID64.
 *
 * `base64url(JSON.stringify({sub, iat})) + "." + base64url(HMAC_SHA256(secret, part1))`
 *
 * @param {string} secret env.SESSION_SECRET
 * @param {string} steamId a SteamID64, as a STRING, and it stays one
 * @param {number} [issuedAt] epoch ms, injectable so the sliding-window tests
 *   do not have to travel in time
 * @returns {Promise<string>}
 */
export async function mintSessionToken(secret, steamId, issuedAt = Date.now()) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("SESSION_SECRET is not configured");
  }
  if (typeof steamId !== "string" || steamId.length === 0) {
    throw new Error("a session subject must be a non-empty string");
  }
  const payload = base64urlFromString(JSON.stringify({ sub: steamId, iat: issuedAt }));
  const signature = await sign(secret, payload);
  return `${payload}.${base64urlFromBytes(signature)}`;
}

/**
 * Verify a session token and say who it is for.
 *
 * THE SIGNATURE IS CHECKED BEFORE THE PAYLOAD IS PARSED. An attacker controls
 * every byte of the payload half, so JSON.parse must not see it until the HMAC
 * has proved we wrote it (SPEC.md §6.1).
 *
 * @returns {Promise<{steamId: string, issuedAt: number, needsReissue: boolean}|null>}
 *   null for every failure, of every kind. There is no third answer.
 */
export async function verifySessionToken(secret, token, now = Date.now()) {
  try {
    if (typeof secret !== "string" || secret.length === 0) return null;
    if (typeof token !== "string" || token.length === 0) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
    const payloadPart = token.slice(0, dot);
    const signaturePart = token.slice(dot + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(payloadPart)) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) return null;

    const expected = await sign(secret, payloadPart);
    if (!timingSafeEqualBytes(bytesFromBase64url(signaturePart), expected)) return null;

    // Only now is the payload ours to read.
    const payload = JSON.parse(stringFromBase64url(payloadPart));
    if (!payload || typeof payload !== "object") return null;
    const { sub, iat } = payload;
    if (typeof sub !== "string" || sub.length === 0) return null;
    if (typeof iat !== "number" || !Number.isFinite(iat)) return null;

    // The cookie's own Max-Age is 180 days, but a browser is not the only
    // thing that can present a token, so the age is enforced here too.
    const ageSeconds = (now - iat) / 1000;
    if (ageSeconds < 0 || ageSeconds > SESSION_MAX_AGE_SECONDS) return null;

    return {
      steamId: sub,
      issuedAt: iat,
      needsReissue: ageSeconds > SESSION_REISSUE_AFTER_SECONDS,
    };
  } catch {
    // FAIL CLOSED. A thrown atob, a thrown JSON.parse, an unavailable crypto:
    // all of them mean "not signed in", never "probably fine". See this file's
    // header.
    return null;
  }
}

/** A fresh 256-bit random value, base64url, for the OpenID `state` nonce. */
export function mintNonce() {
  return base64urlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
}

// ---------------------------------------------------------------------------
// The cookies
// ---------------------------------------------------------------------------

/** One cookie's value out of a request's Cookie header, or null. */
export function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** The 180-day session cookie carrying the token. */
export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${COOKIE_ATTRS}`;
}

/** The 10-minute OpenID state nonce, minted at /auth/login and compared at the
 * callback. NOT OPTIONAL: without it an attacker can feed James their own
 * callback URL and silently sign him into the ATTACKER's account, so every
 * mark he makes afterwards lands on their data (ticket #2 §2.5, login CSRF). */
export function oidcStateCookie(nonce) {
  return `${OIDC_STATE_COOKIE}=${nonce}; Max-Age=${OIDC_STATE_MAX_AGE_SECONDS}; ${COOKIE_ATTRS}`;
}

// A cookie is only cleared if the attributes match the ones that set it, so
// both clears below are the setters with an empty value and Max-Age=0, and the
// shared COOKIE_ATTRS constant is what keeps them honest.
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; ${COOKIE_ATTRS}`;
}

export function clearOidcStateCookie() {
  return `${OIDC_STATE_COOKIE}=; Max-Age=0; ${COOKIE_ATTRS}`;
}

// ---------------------------------------------------------------------------
// OpenID pieces the callback needs (ticket #2 §2.2 and §2.4)
// ---------------------------------------------------------------------------

/**
 * Steam's Key-Value form responses: lines terminated by a single LF, each
 * `key:value`, the value free to contain further colons.
 */
export function parseKeyValueForm(body) {
  const map = new Map();
  if (typeof body !== "string") return map;
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    map.set(trimmed.slice(0, colon), trimmed.slice(colon + 1));
  }
  return map;
}

/**
 * Did Steam say the assertion is genuine?
 *
 * **THE STATUS CODE IS USELESS HERE AND CHECKING IT IS A COMPLETE
 * AUTHENTICATION BYPASS.** Measured live in ticket #2 §2.2: three probes with a
 * fabricated signature, with no signature, and over GET all returned
 * **HTTP 200** with a body of `ns:...\nis_valid:false\n`. The only correct test
 * is this one.
 *
 * And not `body.includes("true")` either: `is_valid:false` sits one line under
 * a `ns:` line, and a substring test over the whole body is one Steam-side
 * field addition away from being wrong.
 */
export function isValidAssertionBody(body) {
  return parseKeyValueForm(body).get("is_valid") === "true";
}

/**
 * The SteamID64 out of `openid.claimed_id`, as a STRING, or null.
 *
 * Valve documents the form `http://steamcommunity.com/openid/id/<steamid>`, and
 * live the http form 302s to https, so both schemes are accepted. The host is
 * compared as a parsed host and not by regex alone, because
 * `https://steamcommunity.com.evil.example/openid/id/7656...` matches a lazy
 * pattern and is not Steam.
 */
export function steamIdFromClaimedId(claimedId) {
  if (typeof claimedId !== "string") return null;
  let url;
  try {
    url = new URL(claimedId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.host !== "steamcommunity.com") return null;
  const match = /^\/openid\/id\/([0-9]{17})$/.exec(url.pathname);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// The allow-list (SPEC.md §9, ticket #8)
// ---------------------------------------------------------------------------

/**
 * Is this SteamID64 invited?
 *
 * One Worker secret, `ALLOWED_STEAM_IDS`, comma-separated. No admin route, no
 * table, no roles. **`[vars]` is forbidden for it: this repository is PUBLIC**,
 * so a committed list would publish James's SteamID64 and every mate's, each of
 * which resolves to a live steamcommunity.com/profiles/ page.
 *
 * THE OWNER IS IMPLICITLY ALLOWED even if absent from the list – a deliberate
 * guard against a paste typo locking James out of his own app.
 */
export function isAllowedSteamId(env, steamId) {
  if (typeof steamId !== "string" || steamId.length === 0) return false;
  if (isOwnerSteamId(env, steamId)) return true;
  const raw = env?.ALLOWED_STEAM_IDS;
  if (typeof raw !== "string") return false;
  return raw.split(",").some((entry) => entry.trim() === steamId);
}

/**
 * Is this SteamID64 the OWNER – whose app this is, as opposed to who happens
 * to be signed in?
 *
 * Two different questions that shared one name until this increment. The
 * session answers "who is asking", per request; this answers "whose app is
 * this", a deploy-time constant. `GET /api/me` reports it as `owner` for
 * increment 16's sync controls, and `isAllowedSteamId` above uses it for the
 * implicit-owner guard.
 *
 * THIS IS THE ONLY `env.OWNER_STEAM_ID` READ IN THIS FILE, deliberately: one
 * read site means one line to check. **The variable was called `STEAM_ID` until
 * SPEC.md §11.6 renamed it here.** The old name shared one word between two
 * jobs - who the current user is, per request, and whose app this is, a
 * deploy-time constant - and nine places in src/worker.js read it as the first
 * when it only ever meant the second.
 */
export function isOwnerSteamId(env, steamId) {
  if (typeof steamId !== "string" || steamId.length === 0) return false;
  return typeof env?.OWNER_STEAM_ID === "string" && env.OWNER_STEAM_ID.trim() === steamId;
}
