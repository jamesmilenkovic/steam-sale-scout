// Steam Sale Scout — SteamSpy tag cache (KV) + strict-1req/sec background
// fetch queue (Increment 3; owners field + v2 cache key + error/empty TTL
// split added in Increment 4).
//
// Lives in its own module (separate from src/worker.js) for a load-bearing
// reason, not just tidiness: src/worker.js is wrangler's `main` entry
// module, and the Workers runtime (workerd) treats EVERY named export of
// the main module as a potential additional handler/entrypoint. Exporting
// plain constants/functions from worker.js itself (which this file's
// pure/test-only helpers need to be, to be unit-testable) crashes `wrangler
// dev` at boot with "Incorrect type for map entry '<name>': the provided
// value is not of type 'function or ExportedHandler'." Keeping this logic
// here, with worker.js only importing the couple of functions it calls,
// avoids that entirely.

const STEAMSPY_API_URL = "https://steamspy.com/api.php";

/** Tag/median data is near-static — cache a successful lookup for 30 days. */
export const TAG_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A genuinely empty/no-tags response (a 2xx with no usable tags — DLC,
 * bundle, unknown appid) is retried sooner — 24h — in case it was
 * transient, without hammering SteamSpy on every /api/recs poll meanwhile. */
export const TAG_CACHE_FAIL_TTL_SECONDS = 24 * 60 * 60;

/** A network error or non-2xx response gets only 1h — much shorter than the
 * 24h empty-response TTL, so a SteamSpy blip can't strand an otherwise-good
 * game out of recs for a whole day (Increment 4, inc-3 flag 4). */
export const TAG_CACHE_ERROR_TTL_SECONDS = 60 * 60;

/** KV key for one appid's cached SteamSpy trio. Prefixed `v2:` (Increment 4
 * added `owners` to the cached trio) so old `spytag:`-keyed entries are
 * simply missed and lazily refetched rather than misread. */
function spyCacheKey(appid) {
  return `v2:spytag:${appid}`;
}

/**
 * Read one appid's cached SteamSpy entry from the TAG_CACHE KV namespace.
 * Distinguishes "never fetched" from "fetched, no usable tags" (cached as
 * the literal value `null`) by checking KV's raw get(): a real KV miss
 * returns `null`, while a cached failure is stored as the JSON text "null"
 * and parses back to a JS `null` — so `raw == null` only happens on an
 * actual cache miss.
 * @returns {Promise<{cached: boolean, data: object|null|undefined}>}
 */
export async function getCachedSpy(env, appid) {
  const raw = await env.TAG_CACHE.get(spyCacheKey(appid));
  if (raw == null) return { cached: false, data: undefined };
  return { cached: true, data: JSON.parse(raw) };
}

async function setCachedSpy(env, appid, data, ttlSeconds) {
  await env.TAG_CACHE.put(spyCacheKey(appid), JSON.stringify(data), {
    expirationTtl: ttlSeconds,
  });
}

/**
 * Parse SteamSpy's `owners` range string (e.g. `"10,000 .. 20,000"` or
 * `"10,000 - 20,000"`) into a single midpoint number. Returns 0 if `owners`
 * is missing or doesn't match the expected shape, rather than throwing —
 * used as a hard quality-floor input (src/score.js's MIN_OWNERS), so an
 * unparseable value should fail that floor, not crash the request.
 * @param {string|undefined|null} owners
 * @returns {number}
 */
export function parseOwnersMidpoint(owners) {
  if (typeof owners !== "string") return 0;
  const match = owners.replace(/,/g, "").match(/(\d+)\s*(?:\.\.|-)\s*(\d+)/);
  if (!match) return 0;
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 0;
  return (low + high) / 2;
}

/**
 * Classify a raw SteamSpy `appdetails` response into the trimmed trio the
 * engine needs, or `null` if it carries no usable tags. SteamSpy returns an
 * empty array (not object) for `tags` on apps it has nothing for — DLC,
 * bundles, and unknown appids commonly land here; they simply never get
 * scored.
 * @param {object} raw
 * @returns {{tags: Object<string,number>, median: number, reviews: {positive: number, negative: number}, owners: number}|null}
 */
export function classifySpyResponse(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tags = raw.tags;
  if (!tags || typeof tags !== "object" || Array.isArray(tags) || Object.keys(tags).length === 0) {
    return null;
  }
  return {
    tags,
    median: raw.median_forever ?? 0,
    reviews: {
      positive: raw.positive ?? 0,
      negative: raw.negative ?? 0,
    },
    owners: parseOwnersMidpoint(raw.owners),
  };
}

let spyLastFetchAt = 0;
let spyMinIntervalMs = 1000;
const spyQueue = [];
const spyQueued = new Set();
let spyQueueRunning = false;

/** TEST-ONLY seam: shrink the 1 req/sec pacing so queue tests don't burn
 * real wall-clock seconds. Never called from production code. */
export function __setSpyMinIntervalMsForTests(ms) {
  spyMinIntervalMs = ms;
}

/** TEST-ONLY seam: clear the module-scoped queue bookkeeping between tests.
 * The queue is deliberately module-scoped in production (one shared 1
 * req/sec pace across every request the Worker instance handles) but that
 * means state leaks between tests in the same file unless reset. Never
 * called from production code. */
export function __resetSpyQueueForTests() {
  spyQueue.length = 0;
  spyQueued.clear();
  spyQueueRunning = false;
  spyLastFetchAt = 0;
}

/** Pure: how many ms must still elapse before the next SteamSpy call is
 * allowed, given when the last one fired. */
export function computeSpyWaitMs(lastFetchAt, now, minIntervalMs) {
  if (!lastFetchAt) return 0;
  const elapsed = now - lastFetchAt;
  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch + classify + cache one appid from SteamSpy, pacing to ≤1 req/sec
 * across the whole queue via the module-scoped `spyLastFetchAt`. A thrown
 * network error or non-2xx response is cached `null` for only 1h
 * (TAG_CACHE_ERROR_TTL_SECONDS) — likely transient, so it's retried soon
 * without hammering SteamSpy on every /api/recs poll meanwhile. A genuine
 * 2xx-but-no-usable-tags response is cached `null` for the longer 24h
 * (TAG_CACHE_FAIL_TTL_SECONDS) — SteamSpy answered, it just has nothing for
 * this appid, so there's less reason to expect a retry to help soon.
 */
async function fetchAndCacheSpy(env, appid) {
  const wait = computeSpyWaitMs(spyLastFetchAt, Date.now(), spyMinIntervalMs);
  if (wait > 0) await sleep(wait);
  spyLastFetchAt = Date.now();

  let classified = null;
  let errored = false;
  try {
    const url = new URL(STEAMSPY_API_URL);
    url.searchParams.set("request", "appdetails");
    url.searchParams.set("appid", String(appid));
    const res = await fetch(url.toString());
    if (res.ok) {
      classified = classifySpyResponse(await res.json());
    } else {
      errored = true;
    }
  } catch {
    classified = null;
    errored = true;
  }

  const ttl = classified
    ? TAG_CACHE_TTL_SECONDS
    : errored
      ? TAG_CACHE_ERROR_TTL_SECONDS
      : TAG_CACHE_FAIL_TTL_SECONDS;
  await setCachedSpy(env, appid, classified, ttl);
}

async function pumpSpyQueue(env) {
  if (spyQueueRunning) return;
  spyQueueRunning = true;
  try {
    while (spyQueue.length > 0) {
      const appid = spyQueue.shift();
      spyQueued.delete(appid);
      await fetchAndCacheSpy(env, appid);
    }
  } finally {
    spyQueueRunning = false;
  }
}

/**
 * Kick or continue the background SteamSpy fetch queue for the given
 * appids, deduping against whatever's already queued/in-flight. Never
 * awaited by the caller — /api/recs must return before this finishes; if a
 * pump is already running, the new appids just get picked up by its loop
 * (no second pump is started, preserving the single global 1 req/sec pace).
 */
export function enqueueSpyFetch(env, ctx, appids) {
  let added = false;
  for (const appid of appids) {
    if (spyQueued.has(appid)) continue;
    spyQueued.add(appid);
    spyQueue.push(appid);
    added = true;
  }
  if (added) ctx.waitUntil(pumpSpyQueue(env));
}
