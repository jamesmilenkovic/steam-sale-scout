// Tests for src/worker.js — the /api/recs route (Increment 3), with a
// MOCKED ITAD/SteamSpy upstream, mocked Steam library cache, and a mocked
// KV namespace standing in for TAG_CACHE.
//
// Mirrors worker.test.mjs/worker-deals.test.mjs's style: drive everything
// through the top-level `worker.default.fetch(request, env, ctx)`, stub
// `globalThis.fetch` and `globalThis.caches.default`, restore afterward.
//
// NEVER makes a real network call. The 1 req/sec SteamSpy pacing is shrunk
// to 0ms for these tests via the `__setSpyMinIntervalMsForTests` seam
// exported from src/spyQueue.js — real pacing math is covered separately
// (and fast) via the pure `computeSpyWaitMs` export. The queue logic lives
// in its own module rather than worker.js because worker.js is wrangler's
// `main` entry file, and workerd treats every named export of the main
// module as a potential handler — plain constants/functions exported
// straight from worker.js crash `wrangler dev` at boot (confirmed live; see
// src/spyQueue.js's header comment).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import {
  TAG_CACHE_TTL_SECONDS,
  TAG_CACHE_FAIL_TTL_SECONDS,
  classifySpyResponse,
  computeSpyWaitMs,
  enqueueSpyFetch,
  __setSpyMinIntervalMsForTests,
  __resetSpyQueueForTests,
} from "../src/spyQueue.js";

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

function restoreGlobals() {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) {
    delete globalThis.caches;
  } else {
    globalThis.caches = originalCaches;
  }
}

function makeMockCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      return store.get(request.url);
    },
    async put(request, response) {
      store.set(request.url, response);
    },
  };
}

/** Minimal in-memory stand-in for a Workers KV namespace binding. Records the
 * `expirationTtl` each put() was called with, so tests can assert the
 * 30d/24h TTL split without a real KV clock. */
function makeMockKv() {
  const store = new Map();
  const ttlByKey = new Map();
  return {
    store,
    ttlByKey,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      store.set(key, value);
      ttlByKey.set(key, opts?.expirationTtl);
    },
  };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    async flush() {
      // Draining repeatedly: a waitUntil'd promise can itself push more
      // waitUntil work (the queue pump kicks itself via ctx.waitUntil), so
      // one Promise.all pass isn't always enough to fully drain.
      let rounds = 0;
      while (pending.length > 0 && rounds < 20) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
        rounds++;
      }
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeEnv(overrides = {}) {
  return {
    STEAM_API_KEY: "test-steam-key",
    STEAM_ID: "76561198000000000",
    ITAD_API_KEY: "test-itad-key",
    TAG_CACHE: makeMockKv(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

function primeLibrary(cache, env, games) {
  const key = `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}`;
  cache.store.set(key, jsonResponse({ games }));
}

function primeDeals(cache, minCut, deals) {
  const key = `https://steam-sale-scout.cache/api/deals?minCut=${minCut}`;
  cache.store.set(key, jsonResponse({ deals, minCut }));
}

function ownedGame(overrides = {}) {
  return {
    appid: 1,
    name: "Owned Game",
    playtime_forever: 600,
    playtime_2weeks: 0,
    rtime_last_played: Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60,
    ...overrides,
  };
}

function deal(overrides = {}) {
  return {
    itadId: "itad-x",
    appid: 100,
    title: "Some Deal",
    price: 9.99,
    priceCents: 999,
    regular: 19.99,
    cut: 70,
    expiry: null,
    flag: null,
    atHistoricalLow: false,
    historicalLow: null,
    tags: [],
    ...overrides,
  };
}

test.beforeEach(() => {
  __setSpyMinIntervalMsForTests(0);
  __resetSpyQueueForTests();
});

test.afterEach(() => {
  restoreGlobals();
  __setSpyMinIntervalMsForTests(1000);
});

// ---------------------------------------------------------------------------
// Refuse-on-degraded-library.
// ---------------------------------------------------------------------------

test("missing STEAM_API_KEY/STEAM_ID -> /api/recs refuses with a clear error, without touching fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("should not be called", { status: 200 });
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ STEAM_API_KEY: undefined, STEAM_ID: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/recs"), env, ctx);

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /Steam library|STEAM_API_KEY/i);
  assert.equal(fetchCalls, 0);
});

test("Steam library fetch failure (degraded mode) -> /api/recs refuses rather than risk recommending owned games", async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname.includes("steampowered")) {
      return new Response("forbidden", { status: 403 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  globalThis.caches = { default: makeMockCache() }; // no primed library cache -> forces a live fetch

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/recs"), env, ctx);

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /Steam library|refus/i);
});

test("missing ITAD_API_KEY -> /api/recs refuses with a clear error", async () => {
  globalThis.fetch = async () => new Response("should not be called", { status: 200 });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ ITAD_API_KEY: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/recs"), env, ctx);

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /ITAD_API_KEY/);
});

// ---------------------------------------------------------------------------
// Progressive response shape + partial-cache ranking.
// ---------------------------------------------------------------------------

test("cold start (no tags cached yet): responds immediately with ready:false, fetched:0, recs from nothing yet, and kicks the background queue", async () => {
  let steamSpyCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api.php") {
      steamSpyCalls++;
      return jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);
  primeDeals(cache, 60, [deal({ appid: 100 })]);

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/recs"), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ready, false);
  assert.equal(body.fetched, 0);
  assert.equal(body.total, 2); // 1 owned appid + 1 deal appid
  assert.equal(body.recs.length, 0); // nothing cached yet -> nothing scoreable

  // The background queue was kicked (via ctx.waitUntil) even though the
  // response above already came back.
  await ctx.flush();
  assert.equal(steamSpyCalls, 2);
});

test("warm run (everything already cached): ready:true, fetched===total, recs populated with a why-line, no SteamSpy calls", async () => {
  let steamSpyCalls = 0;
  globalThis.fetch = async () => {
    steamSpyCalls++;
    throw new Error("should not call SteamSpy on a fully warm cache");
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  const ownedAppid = 1;
  const candidateAppid = 100;
  primeLibrary(cache, env, [
    ownedGame({ appid: ownedAppid, name: "Slay the Spire", playtime_forever: 10800 }), // 180h
  ]);
  primeDeals(cache, 60, [deal({ appid: candidateAppid, title: "Balatro-like Deal" })]);

  env.TAG_CACHE.store.set(
    `spytag:${ownedAppid}`,
    JSON.stringify({ tags: { Roguelike: 100, Deckbuilder: 50 }, median: 600, reviews: { positive: 90, negative: 10 } }),
  );
  env.TAG_CACHE.store.set(
    `spytag:${candidateAppid}`,
    JSON.stringify({ tags: { Roguelike: 80, Deckbuilder: 40 }, median: 600, reviews: { positive: 95, negative: 5 } }),
  );

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/recs"), env, ctx);
  const body = await res.json();

  assert.equal(body.ready, true);
  assert.equal(body.fetched, 2);
  assert.equal(body.total, 2);
  assert.equal(body.recs.length, 1);
  assert.equal(body.recs[0].appid, candidateAppid);
  assert.ok(body.recs[0].similarity > 0);
  assert.match(body.recs[0].why, /Slay the Spire \(180h\)/);
  assert.equal(steamSpyCalls, 0);
});

test("partial cache (~40% of tags cached): recs computed from what's cached, response doesn't crash, excludedCount reflects the rest", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1, name: "Owned", playtime_forever: 600 })]);

  // 5 candidate deals; only 2 (40%) have cached tag data.
  const deals = Array.from({ length: 5 }, (_, i) => deal({ itadId: `itad-${i}`, appid: 200 + i, title: `Deal ${i}` }));
  primeDeals(cache, 60, deals);

  env.TAG_CACHE.store.set(
    `spytag:1`,
    JSON.stringify({ tags: { Roguelike: 10 }, median: 300, reviews: { positive: 80, negative: 20 } }),
  );
  env.TAG_CACHE.store.set(
    `spytag:200`,
    JSON.stringify({ tags: { Roguelike: 10 }, median: 300, reviews: { positive: 80, negative: 20 } }),
  );
  env.TAG_CACHE.store.set(`spytag:201`, JSON.stringify(null)); // fetched, no usable tags

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/recs"), env, ctx);
  assert.equal(res.status, 200); // must not crash
  const body = await res.json();

  assert.equal(body.ready, false);
  assert.equal(body.total, 6); // 1 owned + 5 candidates
  assert.equal(body.fetched, 3); // appid 1, 200, 201 cached; 202/203/204 not yet
  assert.equal(body.recs.length, 1); // only appid 200 is scoreable
  assert.equal(body.recs[0].appid, 200);
  // appid 201 (no tags) + 202/203/204 (not yet fetched) all fall out as excluded.
  assert.equal(body.excludedCount, 4);

  await ctx.flush(); // drain the background queue this test kicked off
});

// ---------------------------------------------------------------------------
// ?refresh=1 semantics: refreshes library + deals, NOT the tag KV.
// ---------------------------------------------------------------------------

test("?refresh=1 bypasses the library/deals cache but does not touch already-cached SteamSpy tags", async () => {
  let steamApiCalls = 0;
  let itadCalls = 0;
  let steamSpyCalls = 0;

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname.includes("steampowered") && u.pathname.includes("GetOwnedGames")) {
      steamApiCalls++;
      return jsonResponse({
        response: {
          games: [
            {
              appid: 1,
              name: "Owned",
              playtime_forever: 600,
              playtime_2weeks: 0,
              rtime_last_played: Math.floor(Date.now() / 1000) - 100000,
            },
          ],
        },
      });
    }
    if (u.pathname === "/deals/v2") {
      itadCalls++;
      return jsonResponse({ list: [], hasMore: false });
    }
    if (u.pathname === "/api.php") {
      steamSpyCalls++;
      return jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  // Prime stale library/deals caches — refresh=1 must bypass both.
  primeLibrary(cache, env, [ownedGame({ appid: 999, playtime_forever: 1 })]);
  primeDeals(cache, 60, [deal({ appid: 500 })]);
  env.TAG_CACHE.store.set(
    `spytag:1`,
    JSON.stringify({ tags: { Roguelike: 10 }, median: 300, reviews: { positive: 80, negative: 20 } }),
  );

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/recs?refresh=1"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  assert.equal(steamApiCalls, 1); // library refreshed
  assert.equal(itadCalls, 1); // deals refreshed
  // The already-cached tag for appid 1 must not have been re-fetched.
  assert.equal(steamSpyCalls, 0); // ?refresh=1 does not bust the 30-day tag KV
  const body = await res.json();
  assert.equal(body.total, 1); // only appid 1 (fresh owned game); stale deal/owned appids gone
});

// ---------------------------------------------------------------------------
// SteamSpy classification + null-caching of empty/failed responses.
// ---------------------------------------------------------------------------

test("classifySpyResponse: a normal response with tags is trimmed to {tags, median, reviews}", () => {
  const raw = { tags: { Roguelike: 100 }, median_forever: 600, positive: 90, negative: 10, name: "Ignored Field" };
  assert.deepEqual(classifySpyResponse(raw), {
    tags: { Roguelike: 100 },
    median: 600,
    reviews: { positive: 90, negative: 10 },
  });
});

test("classifySpyResponse: SteamSpy's empty-array tags (DLC/bundle/unknown) classifies to null", () => {
  assert.equal(classifySpyResponse({ tags: [], median_forever: 0, positive: 0, negative: 0 }), null);
});

test("classifySpyResponse: missing tags field entirely classifies to null", () => {
  assert.equal(classifySpyResponse({ median_forever: 0 }), null);
});

test("classifySpyResponse: a falsy/non-object body classifies to null without throwing", () => {
  assert.equal(classifySpyResponse(null), null);
  assert.equal(classifySpyResponse(undefined), null);
});

test("background fetch caches a failed/empty SteamSpy response as null (24h TTL) and a successful one for 30d", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = new URL(url);
    const appid = u.searchParams.get("appid");
    if (appid === "1") return jsonResponse({ tags: [], median_forever: 0, positive: 0, negative: 0 }); // no tags
    return jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 }), ownedGame({ appid: 2 })]);
  primeDeals(cache, 60, []);

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/recs"), env, ctx);
  await ctx.flush();

  assert.equal(calls, 2);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:1")), null);
  assert.ok(JSON.parse(env.TAG_CACHE.store.get("spytag:2")).tags.Roguelike === 10);

  // 24h for the failed/no-tags appid, 30d for the successful one.
  assert.equal(TAG_CACHE_FAIL_TTL_SECONDS, 24 * 60 * 60);
  assert.equal(TAG_CACHE_TTL_SECONDS, 30 * 24 * 60 * 60);
  assert.equal(env.TAG_CACHE.ttlByKey.get("spytag:1"), TAG_CACHE_FAIL_TTL_SECONDS);
  assert.equal(env.TAG_CACHE.ttlByKey.get("spytag:2"), TAG_CACHE_TTL_SECONDS);
});

// ---------------------------------------------------------------------------
// 1 req/sec pacing intent — pure math covered directly (fast, no real sleep).
// ---------------------------------------------------------------------------

test("computeSpyWaitMs: no wait needed if this is the first call ever (lastFetchAt falsy)", () => {
  assert.equal(computeSpyWaitMs(0, Date.now(), 1000), 0);
});

test("computeSpyWaitMs: no wait needed once the interval has already elapsed", () => {
  const now = 10_000;
  assert.equal(computeSpyWaitMs(now - 1000, now, 1000), 0);
  assert.equal(computeSpyWaitMs(now - 2000, now, 1000), 0);
});

test("computeSpyWaitMs: waits the remainder of the interval otherwise", () => {
  const now = 10_000;
  assert.equal(computeSpyWaitMs(now - 400, now, 1000), 600);
});

// ---------------------------------------------------------------------------
// enqueueSpyFetch/pumpSpyQueue — the actual queue wiring, not just the pure
// computeSpyWaitMs formula. Every other test in this file shrinks the
// interval to 0ms (via beforeEach), which proves the queue doesn't crash but
// can't prove it actually PACES calls or DEDUPES appids — that's what these
// two tests are for, using a small-but-measurable non-zero interval.
// ---------------------------------------------------------------------------

test("enqueueSpyFetch/pumpSpyQueue: serialises multiple queued appids, spaced by the configured interval (not concurrent)", async () => {
  __setSpyMinIntervalMsForTests(40);
  const timestamps = [];
  globalThis.fetch = async (url) => {
    timestamps.push(Date.now());
    return jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2, 3]);
  await ctx.flush();

  assert.equal(timestamps.length, 3);
  // Allow some scheduler slack, but each call must clearly be paced apart —
  // if the queue fired all three concurrently these gaps would be ~0ms.
  assert.ok(timestamps[1] - timestamps[0] >= 30, `gap0->1 was ${timestamps[1] - timestamps[0]}ms, expected >=30ms`);
  assert.ok(timestamps[2] - timestamps[1] >= 30, `gap1->2 was ${timestamps[2] - timestamps[1]}ms, expected >=30ms`);

  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:1")).tags.Roguelike, 10);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:2")).tags.Roguelike, 10);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:3")).tags.Roguelike, 10);
});

test("enqueueSpyFetch: dedupes appids already queued/in-flight — each appid fetched exactly once even if re-enqueued", async () => {
  __setSpyMinIntervalMsForTests(20);
  let calls = 0;
  const seenAppids = new Set();
  globalThis.fetch = async (url) => {
    calls++;
    seenAppids.add(new URL(url).searchParams.get("appid"));
    return jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2]);
  enqueueSpyFetch(env, ctx, [2, 3]); // appid 2 is already queued/in-flight from the first call
  await ctx.flush();

  assert.equal(calls, 3); // 1, 2, 3 — never a duplicate fetch for appid 2
  assert.deepEqual([...seenAppids].sort(), ["1", "2", "3"]);
});

// ---------------------------------------------------------------------------
// Null-caching of a genuinely FAILED SteamSpy call (non-2xx / thrown network
// error), not just a well-formed-but-empty-tags 200. Also proves one bad
// appid doesn't wedge the queue for the ones behind it.
// ---------------------------------------------------------------------------

test("background fetch caches a non-2xx SteamSpy response as null (24h TTL) without crashing the queue for later appids", async () => {
  globalThis.fetch = async (url) => {
    const appid = new URL(url).searchParams.get("appid");
    if (appid === "1") return new Response("server error", { status: 500 });
    return jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2]);
  await ctx.flush();

  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:1")), null);
  assert.equal(env.TAG_CACHE.ttlByKey.get("spytag:1"), TAG_CACHE_FAIL_TTL_SECONDS);
  // appid 2, queued behind the failing appid 1, must still get processed and cached.
  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:2")).tags.Roguelike, 10);
  assert.equal(env.TAG_CACHE.ttlByKey.get("spytag:2"), TAG_CACHE_TTL_SECONDS);
});

test("background fetch caches a thrown network error as null (24h TTL) without crashing the queue for later appids", async () => {
  globalThis.fetch = async (url) => {
    const appid = new URL(url).searchParams.get("appid");
    if (appid === "1") throw new Error("ECONNRESET");
    return jsonResponse({ tags: { Roguelike: 10 }, median_forever: 300, positive: 80, negative: 20 });
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2]);
  await ctx.flush();

  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:1")), null);
  assert.equal(env.TAG_CACHE.ttlByKey.get("spytag:1"), TAG_CACHE_FAIL_TTL_SECONDS);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get("spytag:2")).tags.Roguelike, 10);
  assert.equal(env.TAG_CACHE.ttlByKey.get("spytag:2"), TAG_CACHE_TTL_SECONDS);
});
