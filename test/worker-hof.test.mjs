// Tests for src/worker.js — the /api/best-of route (Increment 5): "Best of
// Steam", taste-agnostic Hall of Fame ranking over the same deals pool as
// /api/recs. Mirrors test/worker-recs.test.mjs's mocking style (MOCKED
// ITAD/SteamSpy/GetItems upstream, mocked Steam library cache, mocked KV).
//
// NEVER makes a real network call. Spy-queue pacing shrunk to 0ms via the
// same seams worker-recs.test.mjs uses.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { __setSpyMinIntervalMsForTests, __resetSpyQueueForTests } from "../src/spyQueue.js";

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

function v2Key(appid) {
  return `v2:spytag:${appid}`;
}

function deckKey(appid) {
  return `deck:${appid}`;
}

function goodSpyEntry(overrides = {}) {
  return {
    tags: { Roguelike: 10 },
    median: 300,
    reviews: { positive: 90, negative: 10 },
    owners: 75000,
    ...overrides,
  };
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
// Refuse-on-degraded-library (mirrors /api/recs).
// ---------------------------------------------------------------------------

test("missing STEAM_API_KEY/STEAM_ID -> /api/best-of refuses with a clear error, without touching fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("should not be called", { status: 200 });
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ STEAM_API_KEY: undefined, STEAM_ID: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /Steam library|STEAM_API_KEY/i);
  assert.equal(fetchCalls, 0);
});

test("missing ITAD_API_KEY -> /api/best-of refuses with a clear error", async () => {
  globalThis.fetch = async () => new Response("should not be called", { status: 200 });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ ITAD_API_KEY: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /ITAD_API_KEY/);
});

// ---------------------------------------------------------------------------
// Qualification + ordering, sharing the candidate pool with /api/recs.
// ---------------------------------------------------------------------------

test("only candidates clearing HOF_MIN_REVIEWS/HOF_MIN_RATIO appear, ordered by hofScore", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);
  const deals = [
    deal({ itadId: "itad-hof-shallow", appid: 200, cut: 40, title: "All-timer, shallow discount" }),
    deal({ itadId: "itad-hof-deep", appid: 201, cut: 90, title: "All-timer, deep discount" }),
    deal({ itadId: "itad-not-hof", appid: 202, cut: 90, title: "Good but not Hall-of-Fame" }),
  ];
  primeDeals(cache, 60, deals);

  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 } })));
  // Both HoF-qualifying entries clear 10k reviews @ 95%+.
  env.TAG_CACHE.store.set(
    v2Key(200),
    JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 }, reviews: { positive: 95000, negative: 5000 } })),
  );
  env.TAG_CACHE.store.set(
    v2Key(201),
    JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 }, reviews: { positive: 95000, negative: 5000 } })),
  );
  // Good reviews but well under HOF_MIN_REVIEWS (10,000) — same shape /api/recs
  // would happily score, but Hall of Fame is a stricter, separate bar.
  env.TAG_CACHE.store.set(
    v2Key(202),
    JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 }, reviews: { positive: 90, negative: 10 } })),
  );
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 3, os: 3, frame: 0 }));
  env.TAG_CACHE.store.set(deckKey(201), JSON.stringify({ deck: 2, os: 2, frame: 0 }));

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.hof.length, 2);
  // Deeper discount at the same Wilson quality wins (hofScore ordering).
  assert.equal(body.hof[0].appid, 201);
  assert.equal(body.hof[1].appid, 200);
  assert.ok(!body.hof.some((h) => h.appid === 202), "non-qualifying candidate must be excluded");
});

test("similarity is attached as a secondary field but never used to exclude a qualifying candidate", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  // Owned game's tags share nothing with the candidate — similarity ~0.
  primeLibrary(cache, env, [ownedGame({ appid: 1, name: "Owned", playtime_forever: 600 })]);
  primeDeals(cache, 60, [deal({ itadId: "itad-hof", appid: 200, cut: 80 })]);

  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry({ tags: { Simulation: 50 } })));
  env.TAG_CACHE.store.set(
    v2Key(200),
    JSON.stringify(
      goodSpyEntry({ tags: { Roguelike: 10 }, reviews: { positive: 95000, negative: 5000 } }),
    ),
  );
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const body = await res.json();

  assert.equal(body.hof.length, 1);
  assert.equal(typeof body.hof[0].similarity, "number");
  // No overlap between the owned tag set and the candidate's -> ~0, but the
  // candidate still qualifies and appears — similarity never gates HoF.
  assert.equal(body.hof[0].similarity, 0);
});

// ---------------------------------------------------------------------------
// Increment 5 fields: tagNames, batteryFriendly, deck, quality, hofScore;
// raw `tags`/`reviews` stripped from the envelope (mirrors /api/recs).
// ---------------------------------------------------------------------------

test("each hof entry carries tagNames/batteryFriendly/deck/quality/hofScore, with raw tags/reviews stripped", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);
  primeDeals(cache, 60, [deal({ itadId: "itad-hof", appid: 200, cut: 75 })]);

  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(
    v2Key(200),
    JSON.stringify(
      goodSpyEntry({ tags: { Puzzle: 50 }, reviews: { positive: 95000, negative: 5000 }, owners: 500000 }),
    ),
  );
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 3, os: 3, frame: 0 }));

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const body = await res.json();

  assert.equal(body.hof.length, 1);
  const entry = body.hof[0];
  assert.deepEqual(entry.tagNames, ["Puzzle"]);
  assert.equal(typeof entry.batteryFriendly, "boolean");
  assert.deepEqual(entry.deck, { deck: 3, os: 3, frame: 0 });
  assert.ok(entry.quality > 0 && entry.quality <= 1);
  assert.ok(entry.hofScore > 0);
  assert.equal(entry.reviewCount, 100000);
  assert.equal(entry.owners, 500000);
  assert.equal("tags" in entry, false);
  assert.equal("reviews" in entry, false);
});

// ---------------------------------------------------------------------------
// Progressive response shape (pending candidates), mirroring /api/recs.
// ---------------------------------------------------------------------------

test("cold start (no tags cached yet): responds with ready:false and an empty hof, still kicks the background queue", async () => {
  let steamSpyCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api.php") {
      steamSpyCalls++;
      return jsonResponse(goodSpyEntry({ tags: { Roguelike: 10 } }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);
  primeDeals(cache, 60, [deal({ appid: 200 })]);

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ready, false);
  assert.equal(body.hof.length, 0);
  assert.equal(body.pendingCount, 1);

  await ctx.flush();
});
