// Tests for src/worker.js — the /api/fpm route (Increment 7): "Fun per
// minute", Wilson quality ÷ HowLongToBeat main-story hours over the SAME
// rank-sorted Best-of pool as /api/best-of. Mirrors test/worker-hof.test.mjs's
// mocking style (mocked ITAD/SteamSpy/GetItems/HLTB upstream, mocked Steam
// library cache, mocked KV) plus test/worker-wishlist.test.mjs's fail-soft
// conventions (this lane never surfaces a non-200 — a HowLongToBeat problem
// hides the lane behind {available:false} instead).
//
// NEVER makes a real network call. Spy-queue AND HLTB-queue pacing shrunk to
// 0ms via their respective test seams.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { __setSpyMinIntervalMsForTests, __resetSpyQueueForTests } from "../src/spyQueue.js";
import {
  __setHltbMinIntervalMsForTests,
  __resetHltbQueueForTests,
  FPM_POOL_CAP,
  FPM_MIN_LENGTH_HOURS,
} from "../src/hltb.js";
import { quality } from "../src/score.js";

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

function primeBestOfPool(cache, deals) {
  const key = "https://steam-sale-scout.cache/api/best-of/pool";
  cache.store.set(key, jsonResponse({ deals }));
}

function v2Key(appid) {
  return `v2:spytag:${appid}`;
}

function deckKey(appid) {
  return `deck:${appid}`;
}

function hltbKey(appid) {
  return `hltb:${appid}`;
}

function goodSpyEntry(overrides = {}) {
  return {
    tags: { Roguelike: 10 },
    median: 300,
    reviews: { positive: 95000, negative: 5000 }, // clears HOF_MIN_REVIEWS/HOF_MIN_RATIO by default
    owners: 750000,
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
    appid: 200,
    title: "Portal 2",
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

/** One raw /api/bleed search-result entry, mirroring the real live-probe
 * capture's field names (comp_main etc. in seconds). */
function rawHltbEntry(overrides = {}) {
  return {
    game_id: 7231,
    game_name: "Portal 2",
    game_alias: "",
    game_type: "game",
    comp_main: 30743, // ~8.54h
    comp_plus: 49416,
    comp_100: 81139,
    review_score: 90,
    count_review: 8011,
    ...overrides,
  };
}

/**
 * Router-style mock `fetch` for the HowLongToBeat handshake+search only.
 * `searchResultsByQuery` maps the exact space-joined query string (title
 * split on spaces, rejoined — see src/hltb.js's buildSearchBody) to an array
 * of raw entries. `forbiddenOnceQueries` simulates a stale token: the first
 * search for that query 403s, then (after a re-init) succeeds.
 */
function makeHltbFetch({
  initOk = true,
  initStatus = 200,
  searchResultsByQuery = {},
  forbiddenOnceQueries = new Set(),
  onCall,
} = {}) {
  const seen403 = new Set();
  let initCalls = 0;
  return async (url, options = {}) => {
    const u = new URL(url);
    onCall?.(u, options);

    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed/init") {
      initCalls++;
      if (!initOk) return new Response("error", { status: initStatus });
      return jsonResponse({ token: `tok-${initCalls}`, hpKey: "hpk", hpVal: "hpv" });
    }

    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      assert.equal(body.hpk, "hpv", "search body must echo body[hpKey]=hpVal");
      assert.equal(options.headers["x-auth-token"], `tok-${initCalls}`);
      const query = body.searchTerms.join(" ");
      if (forbiddenOnceQueries.has(query) && !seen403.has(query)) {
        seen403.add(query);
        return new Response("forbidden", { status: 403 });
      }
      const entries = searchResultsByQuery[query] ?? [];
      return jsonResponse({ count: entries.length, data: entries });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
}

test.beforeEach(() => {
  __setSpyMinIntervalMsForTests(0);
  __resetSpyQueueForTests();
  __setHltbMinIntervalMsForTests(0);
  __resetHltbQueueForTests();
});

test.afterEach(() => {
  restoreGlobals();
  __setSpyMinIntervalMsForTests(1000);
  __setHltbMinIntervalMsForTests(1000);
});

// ---------------------------------------------------------------------------
// Fail-soft, source level.
// ---------------------------------------------------------------------------

test("missing STEAM_API_KEY/STEAM_ID -> 200 {available:false}, without touching fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("should not be called", { status: 200 });
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ STEAM_API_KEY: undefined, STEAM_ID: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.notice, "Fun-per-minute unavailable");
  assert.equal(fetchCalls, 0);
});

test("missing ITAD_API_KEY -> 200 {available:false}", async () => {
  globalThis.fetch = async () => new Response("should not be called", { status: 200 });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ ITAD_API_KEY: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
});

test("hltbInit() network failure -> 200 {available:false}, library/pool never fetched", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "howlongtobeat.com") throw new Error("network down");
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.notice, "Fun-per-minute unavailable");
});

test("hltbInit() returns a bad shape (missing token) -> 200 {available:false}", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed/init") {
      return jsonResponse({ hpKey: "hpk", hpVal: "hpv" }); // no token
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();
  assert.equal(body.available, false);
});

test("cold cache + killed HLTB handshake hides only the FPM lane — /api/deals keeps serving 200 under the same mocked-HLTB-down fetch", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  // An eligible candidate with no cached HLTB record — toResolve > 0, so
  // handleFpm still has to attempt the (killed) handshake and fail soft.
  primeBestOfPool(cache, [deal({ itadId: "itad-portal2", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry({ reviews: { positive: 96000, negative: 4000 } })));

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "howlongtobeat.com") {
      return new Response("service unavailable", { status: 503 });
    }
    if (u.pathname === "/deals/v2") {
      return jsonResponse({ list: [], hasMore: false });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const fpmRes = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  assert.equal(fpmRes.status, 200);
  const fpmBody = await fpmRes.json();
  assert.equal(fpmBody.available, false);

  const dealsRes = await worker.fetch(new Request("https://x/api/deals?minCut=60"), env, ctx);
  assert.equal(dealsRes.status, 200);
  const dealsBody = await dealsRes.json();
  assert.deepEqual(dealsBody.deals, []);
});

test("fully warm cache: /api/fpm serves cached rows without ever calling hltbInit, even if the handshake would fail", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-portal2", appid: 200, title: "Portal 2", cut: 80 })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(
    v2Key(200),
    JSON.stringify(goodSpyEntry({ tags: { Puzzle: 50 }, reviews: { positive: 96000, negative: 4000 } })),
  );
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 3, os: 3, frame: 0 }));
  // The candidate's HLTB record is already cached — every eligible
  // candidate is resolved, so toResolve is empty and hltbInit must never
  // be reached.
  env.TAG_CACHE.store.set(
    hltbKey(200),
    JSON.stringify({ hltbId: 7231, compMain: 23400, compPlus: 40000, comp100: 50000, matchMethod: "name" }),
  );

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "howlongtobeat.com") {
      throw new Error("hltbInit must not be called on a fully-warm cache");
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res.json();

  assert.equal(body.available, true);
  assert.equal(body.ready, true);
  assert.equal(body.fpm.length, 1);
  assert.equal(body.fpm[0].appid, 200);
});

// ---------------------------------------------------------------------------
// Eligibility: only candidates clearing qualifiesForHof are even considered.
// ---------------------------------------------------------------------------

test("a candidate failing the Hall-of-Fame quality floor is never queried against HLTB at all", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-weak", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  // Thin reviews -> fails HOF_MIN_REVIEWS, never becomes "eligible".
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry({ reviews: { positive: 90, negative: 10 } })));

  let hltbCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed/init") {
      return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    }
    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed") {
      hltbCalls++;
      return jsonResponse({ count: 0, data: [] });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res.json();

  assert.equal(body.available, true);
  assert.equal(body.total, 0);
  assert.equal(body.fpm.length, 0);
  assert.equal(hltbCalls, 0, "a non-qualifying candidate must never reach the HLTB search queue");
});

// ---------------------------------------------------------------------------
// Happy path + lane math + enrichment.
// ---------------------------------------------------------------------------

test("happy path: an eligible, matched candidate carries fpm/funPerHour/mainHours/matchMethod/why/deck/tagNames/batteryFriendly", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-portal2", appid: 200, title: "Portal 2", cut: 80 })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  // 96% positive, well clear of HOF_MIN_RATIO (0.95) so this candidate is
  // actually eligible for the lane.
  env.TAG_CACHE.store.set(
    v2Key(200),
    JSON.stringify(goodSpyEntry({ tags: { Puzzle: 50 }, reviews: { positive: 96000, negative: 4000 } })),
  );
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 3, os: 3, frame: 0 }));

  globalThis.fetch = makeHltbFetch({
    searchResultsByQuery: { "Portal 2": [rawHltbEntry({ comp_main: 23400 })] }, // exactly 6.5h
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();

  // First response may still show the queue pending; poll once more the way
  // the UI does.
  const res2 = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res2.json();

  assert.equal(body.available, true);
  assert.equal(body.ready, true);
  assert.equal(body.unmatchedCount, 0);
  assert.equal(body.fpm.length, 1);

  const entry = body.fpm[0];
  const expectedQuality = quality(96000, 4000);
  assert.equal(entry.appid, 200);
  assert.equal(entry.mainHours, 6.5);
  assert.equal(entry.matchMethod, "name");
  assert.equal(entry.quality, expectedQuality);
  assert.equal(entry.funPerHour, Math.round(((entry.quality * 100) / 6.5) * 10) / 10);
  assert.ok(Math.abs(entry.fpm - entry.quality / 6.5) < 1e-9);
  assert.equal(entry.why, `${Math.round(entry.quality * 100)}% quality ÷ 6.5h main story — ${entry.funPerHour.toFixed(1)} fun/hr`);
  assert.deepEqual(entry.deck, { deck: 3, os: 3, frame: 0 });
  assert.deepEqual(entry.tagNames, ["Puzzle"]);
  assert.equal(typeof entry.batteryFriendly, "boolean");
  assert.equal(entry.cut, 80);
  assert.equal("tags" in entry, false);
  assert.equal("reviews" in entry, false);
});

test("a resolved match below FPM_MIN_LENGTH_HOURS is excluded silently — not counted in unmatchedCount", async () => {
  assert.equal(FPM_MIN_LENGTH_HOURS, 1);
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-short", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));

  globalThis.fetch = makeHltbFetch({
    // 1800s = 0.5h, under the 1h floor.
    searchResultsByQuery: { "Portal 2": [rawHltbEntry({ comp_main: 1800 })] },
  });

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res.json();

  assert.equal(body.fpm.length, 0);
  assert.equal(body.unmatchedCount, 0, "a sub-floor MATCH is not the same as no length data");
});

test("no HLTB entry clears FPM_MATCH_THRESHOLD -> candidate excluded and counted in unmatchedCount", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-nomatch", appid: 200, title: "Some Obscure Indie Game" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));

  globalThis.fetch = makeHltbFetch({
    // Totally unrelated result set -> similarity well under threshold.
    searchResultsByQuery: {
      "Some Obscure Indie Game": [rawHltbEntry({ game_id: 999, game_name: "Portal 2" })],
    },
  });

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res.json();

  assert.equal(body.fpm.length, 0);
  assert.equal(body.unmatchedCount, 1);
});

test("a search that returns zero results (empty data array) is a clean negative match, not a thrown error", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-empty", appid: 200, title: "Nonexistent Game Title" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));

  globalThis.fetch = makeHltbFetch({ searchResultsByQuery: {} }); // no entry -> [] for every query

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res.json();

  assert.equal(body.available, true);
  assert.equal(body.fpm.length, 0);
  assert.equal(body.unmatchedCount, 1);
});

// ---------------------------------------------------------------------------
// Progressive fill (mirrors /api/best-of's cold-start behaviour).
// ---------------------------------------------------------------------------

test("cold start (no HLTB cache yet): responds ready:false, empty fpm, still kicks the background queue", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-cold", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));

  let hltbSearchCalls = 0;
  globalThis.fetch = makeHltbFetch({
    searchResultsByQuery: { "Portal 2": [rawHltbEntry()] },
    onCall: (u) => {
      if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed") hltbSearchCalls++;
    },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.ready, false);
  assert.equal(body.total, 1);
  assert.equal(body.fetched, 0);
  assert.equal(body.fpm.length, 0);

  await ctx.flush();
  assert.equal(hltbSearchCalls, 1, "the background queue should have resolved the one pending candidate");

  const cachedRaw = env.TAG_CACHE.store.get(hltbKey(200));
  assert.ok(cachedRaw, "a resolved candidate must be cached under its own hltb:<appid> key");
});

test("HLTB cache round-trip: a primed positive result avoids re-hitting the search endpoint", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-cached", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(
    hltbKey(200),
    JSON.stringify({ hltbId: 7231, compMain: 23400, compPlus: 40000, comp100: 50000, matchMethod: "name" }),
  );

  let searchCalls = 0;
  globalThis.fetch = makeHltbFetch({ onCall: (u) => {
    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed") searchCalls++;
  } });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.ready, true);
  assert.equal(body.fpm.length, 1);
  assert.equal(body.fpm[0].mainHours, 6.5);
  assert.equal(searchCalls, 0, "a cache hit must never call HLTB search");
});

test("HLTB negative cache round-trip: a primed null result counts toward unmatchedCount without re-searching", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-neg", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(hltbKey(200), JSON.stringify(null));

  let searchCalls = 0;
  globalThis.fetch = makeHltbFetch({ onCall: (u) => {
    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed") searchCalls++;
  } });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.ready, true);
  assert.equal(body.fpm.length, 0);
  assert.equal(body.unmatchedCount, 1);
  assert.equal(searchCalls, 0);
});

test("?refresh=1 bypasses the HLTB cache even when a positive result is already cached", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-refresh", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(
    hltbKey(200),
    JSON.stringify({ hltbId: 1, compMain: 3600, compPlus: 3600, comp100: 3600, matchMethod: "name" }),
  );

  // refresh=1 flows through to loadLibraryForRecs AND loadBestOfPool too
  // (the same shared helpers handleHof uses) — their cache bypass means
  // GetOwnedGames and the whole ITAD Best-of sourcing path get re-hit for
  // real, so this mock has to answer all of that as well as the HLTB
  // endpoints.
  let searchCalls = 0;
  const hltbFetch = makeHltbFetch({
    searchResultsByQuery: { "Portal 2": [rawHltbEntry({ comp_main: 7200 })] }, // 2h — differs from the stale 3600s cached above
    onCall: (u) => {
      if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed") searchCalls++;
    },
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetOwnedGames")) {
      return jsonResponse({ response: { games: [ownedGame({ appid: 1 })] } });
    }
    if (u.pathname === "/deals/v2") {
      const offset = Number(u.searchParams.get("offset") || "0");
      if (offset > 0) return jsonResponse({ list: [], hasMore: false });
      return jsonResponse({
        list: [
          {
            id: "itad-refresh",
            title: "Portal 2",
            deal: { price: { amount: 9.99, amountInt: 999 }, regular: { amount: 19.99 }, cut: 70, expiry: null, flag: null },
          },
        ],
        hasMore: false,
      });
    }
    if (u.pathname === "/lookup/shop/61/id/v1") {
      const ids = JSON.parse(options.body);
      const body = {};
      for (const id of ids) body[id] = id === "itad-refresh" ? ["app/200"] : [];
      return jsonResponse(body);
    }
    if (u.pathname === "/games/historylow/v1") {
      return jsonResponse([]);
    }
    return hltbFetch(url, options);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm?refresh=1"), env, ctx);
  const body = await res.json();
  assert.equal(body.ready, false, "refresh must treat the candidate as unresolved again");
  assert.equal(body.fpm.length, 0);

  await ctx.flush();
  assert.ok(searchCalls >= 1, "refresh=1 must bypass the HLTB cache and re-hit search");

  const res2 = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body2 = await res2.json();
  assert.equal(body2.fpm[0].mainHours, 2, "the cache must now hold the freshly-resolved length");
});

// ---------------------------------------------------------------------------
// 403 retry-once behaviour (queue-level, exercised through the route).
// ---------------------------------------------------------------------------

test("a 403 mid-pump triggers exactly one re-init + retry, and still resolves the match", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-403", appid: 200, title: "Portal 2" })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify(goodSpyEntry()));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 0, os: 0, frame: 0 }));

  let initCalls = 0;
  globalThis.fetch = makeHltbFetch({
    searchResultsByQuery: { "Portal 2": [rawHltbEntry({ comp_main: 23400 })] },
    forbiddenOnceQueries: new Set(["Portal 2"]),
    onCall: (u) => {
      if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed/init") initCalls++;
    },
  });

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/fpm"), env, ctx); // handleFpm's own up-front hltbInit(): call #1
  await ctx.flush(); // pump hits 403 on the first search -> re-inits (call #2) -> retries -> resolves

  assert.equal(initCalls, 2, "expected exactly one re-init beyond handleFpm's up-front init, before any second request");

  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx); // its own up-front init: call #3
  const body = await res.json();

  assert.equal(body.fpm.length, 1);
  assert.equal(body.fpm[0].mainHours, 6.5);
});

// ---------------------------------------------------------------------------
// Pool cap: only the top FPM_POOL_CAP (already rank-sorted) pool entries are
// considered.
// ---------------------------------------------------------------------------

test("only the top FPM_POOL_CAP entries of the Best-of pool are considered", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry()));

  const pool = [];
  for (let i = 0; i < FPM_POOL_CAP + 5; i++) {
    const appid = 1000 + i;
    pool.push(deal({ itadId: `itad-${i}`, appid, title: `Pool Game ${i}` }));
    env.TAG_CACHE.store.set(v2Key(appid), JSON.stringify(goodSpyEntry()));
  }
  primeBestOfPool(cache, pool);

  globalThis.fetch = makeHltbFetch({ searchResultsByQuery: {} });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.total, FPM_POOL_CAP, "candidates beyond FPM_POOL_CAP must never become eligible");

  // Drain the (unmatched, so fast) background queue before the test ends —
  // otherwise it keeps running into the next test with a 1000ms/item pace
  // once afterEach restores the real interval, which looks like a hang.
  await ctx.flush();
});
