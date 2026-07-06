// Steam Sale Scout — SteamSpy tag cache (KV) + strict-1req/sec background
// fetch queue (Increment 3).
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

/** A failed/empty (no-tags) lookup is retried sooner — 24h — in case it was
 * transient, without hammering SteamSpy on every /api/recs poll meanwhile. */
export const TAG_CACHE_FAIL_TTL_SECONDS = 24 * 60 * 60;

/** KV key for one appid's cached SteamSpy trio. */
function spyCacheKey(appid) {
  return `spytag:${appid}`;
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
 * Classify a raw SteamSpy `appdetails` response into the trimmed trio the
 * engine needs, or `null` if it carries no usable tags. SteamSpy returns an
 * empty array (not object) for `tags` on apps it has nothing for — DLC,
 * bundles, and unknown appids commonly land here; they simply never get
 * scored.
 * @param {object} raw
 * @returns {{tags: Object<string,number>, median: number, reviews: {positive: number, negative: number}}|null}
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
 * across the whole queue via the module-scoped `spyLastFetchAt`. Network
 * failures are treated the same as an empty/no-tags response (cached `null`,
 * 24h) rather than left unfetched, so one flaky appid can't get re-hit on
 * every single poll during a cold-start crawl.
 */
async function fetchAndCacheSpy(env, appid) {
  const wait = computeSpyWaitMs(spyLastFetchAt, Date.now(), spyMinIntervalMs);
  if (wait > 0) await sleep(wait);
  spyLastFetchAt = Date.now();

  let classified = null;
  try {
    const url = new URL(STEAMSPY_API_URL);
    url.searchParams.set("request", "appdetails");
    url.searchParams.set("appid", String(appid));
    const res = await fetch(url.toString());
    if (res.ok) {
      classified = classifySpyResponse(await res.json());
    }
  } catch {
    classified = null;
  }

  await setCachedSpy(env, appid, classified, classified ? TAG_CACHE_TTL_SECONDS : TAG_CACHE_FAIL_TTL_SECONDS);
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
