// Tests for src/worker.js — the /api/wishlist route (Increment 6), with a
// MOCKED Steam GetWishlist/GetItems upstream and a mocked ITAD upstream.
//
// Mirrors test/worker-deals.test.mjs's style: drive everything through the
// top-level `worker.default.fetch(request, env, ctx)`, stub `globalThis.fetch`
// and `globalThis.caches.default` with minimal in-memory fakes, restore
// afterward. NEVER makes a real network call — all responses below are
// fixtures shaped from the live-verified shapes documented in
// src/wishlist.js and probe-findings.md (GetWishlist, /lookup/id/shop/61/v1,
// /games/prices/v2, /games/historylow/v1, GetItems).
//
// FAIL-SOFT IS THE HEADLINE BEHAVIOUR under test here: unlike /api/deals,
// /api/wishlist must never surface a non-200 or throw — every failure mode
// (missing secrets, GetWishlist down, ITAD down) collapses to the same
// `{available: false}` 200 response.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { __setSpyMinIntervalMsForTests, __resetSpyQueueForTests } from "../src/spyQueue.js";

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

test.beforeEach(() => {
  __setSpyMinIntervalMsForTests(0);
  __resetSpyQueueForTests();
});

test.afterEach(() => {
  restoreGlobals();
  __setSpyMinIntervalMsForTests(1000);
});

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

function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}

function makeMockKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    STEAM_ID: "76561198000000000",
    ITAD_API_KEY: "test-itad-key",
    TAG_CACHE: makeMockKv(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function deckKey(appid) {
  return `deck:${appid}`;
}

function v2Key(appid) {
  return `v2:spytag:${appid}`;
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

/**
 * Router-style mock `fetch` covering every upstream /api/wishlist can hit:
 * Steam's GetWishlist and GetItems (both GET, anonymous), and ITAD's reverse
 * id lookup / prices / historylow (all POST, batched). `lowsById` maps itad
 * id -> the `{amount, amountInt}` price of the recorded low; the response
 * nests that under `low.price` (`{shop, price: {amount, amountInt}, regular,
 * cut, timestamp}`) — the REAL /games/historylow/v1 shape (verified live
 * 2026-07-10; see src/worker.js's resolveHistoricalLows header comment) — so
 * this mock actually exercises the `r.low?.price` unwrap instead of masking
 * a shape bug the way a flat `low` object used to.
 */
function makeWishlistFetch({
  wishlistResponse = { response: { items: [] } },
  wishlistStatus = 200,
  itadIdByAppid = {},
  pricesByItadId = {},
  lowsById = {},
  titlesByAppid = {},
  onCall,
} = {}) {
  return async (url, options = {}) => {
    const u = new URL(url);
    onCall?.(u, options);

    if (u.hostname === "api.steampowered.com" && u.pathname === "/IWishlistService/GetWishlist/v1/") {
      if (wishlistStatus !== 200) {
        return new Response("error", { status: wishlistStatus });
      }
      return jsonResponse(wishlistResponse);
    }

    if (u.hostname === "api.steampowered.com" && u.pathname === "/IStoreBrowseService/GetItems/v1/") {
      const inputJson = JSON.parse(u.searchParams.get("input_json"));
      const storeItems = inputJson.ids
        .filter(({ appid }) => titlesByAppid[appid] !== undefined)
        .map(({ appid }) => ({ appid, name: titlesByAppid[appid] }));
      return jsonResponse({ response: { store_items: storeItems } });
    }

    if (u.pathname === "/lookup/id/shop/61/v1") {
      const body = JSON.parse(options.body);
      const result = {};
      for (const key of body) {
        const appid = Number(key.slice("app/".length));
        result[key] = itadIdByAppid[appid] ?? null;
      }
      return jsonResponse(result);
    }

    if (u.pathname === "/games/prices/v2") {
      const ids = JSON.parse(options.body);
      const arr = [];
      for (const id of ids) {
        const priced = pricesByItadId[id];
        if (!priced) continue; // no live Steam deal -> omitted, per probe-findings.md
        arr.push({
          id,
          deals: [
            {
              shop: { id: 61 },
              price: { amount: priced.price, amountInt: priced.priceCents },
              regular: { amount: priced.regular },
              cut: priced.cut,
              expiry: priced.expiry ?? null,
            },
          ],
        });
      }
      return jsonResponse(arr);
    }

    if (u.pathname === "/games/historylow/v1") {
      const ids = JSON.parse(options.body);
      const arr = ids
        .filter((id) => lowsById[id] !== undefined)
        .map((id) => ({ id, low: { shop: { id: 61 }, price: lowsById[id], regular: null, cut: null, timestamp: null } }));
      return jsonResponse(arr);
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Fail-soft: missing secrets.
// ---------------------------------------------------------------------------

test("missing STEAM_ID returns 200 {available:false} without calling fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("fetch should not be called");
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ STEAM_ID: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(fetchCalls, 0);
});

test("missing ITAD_API_KEY returns 200 {available:false} without calling fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("fetch should not be called");
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ ITAD_API_KEY: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(fetchCalls, 0);
});

// ---------------------------------------------------------------------------
// Fail-soft: upstream failures never throw out of handleWishlist.
// ---------------------------------------------------------------------------

test("GetWishlist fetch rejecting (network error) is fail-soft: 200 {available:false}, no throw", async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/IWishlistService/GetWishlist/v1/") {
      throw new Error("network down");
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
});

test("GetWishlist returning a 500 is fail-soft: 200 {available:false}", async () => {
  globalThis.fetch = makeWishlistFetch({ wishlistStatus: 500 });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
});

test("an ITAD failure during price resolution (reverse-id lookup 500) is fail-soft: 200 {available:false}", async () => {
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.steampowered.com" && u.pathname === "/IWishlistService/GetWishlist/v1/") {
      return jsonResponse({ response: { items: [{ appid: 700, priority: 0, date_added: 1700000000 }] } });
    }
    if (u.pathname === "/lookup/id/shop/61/v1") {
      return new Response("rate limited", { status: 429 });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
});

// ---------------------------------------------------------------------------
// Happy path: qualifying item carries every field the UI needs; a
// non-qualifier (shallow cut, not at historical low) is dropped.
// ---------------------------------------------------------------------------

test("happy path: a qualifying item carries title/price/cut/atHistoricalLow/why/priority/dateAdded/deck/tagNames/batteryFriendly, and a non-qualifier is dropped", async () => {
  const env = makeEnv();
  globalThis.caches = { default: makeMockCache() };

  // Prime deck + SteamSpy tag caches for the qualifying appid (100) so
  // enrichWishlist doesn't need its own GetItems/SteamSpy mock branch.
  env.TAG_CACHE.store.set(deckKey(100), JSON.stringify({ deck: 3, os: 2, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(100), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10, Indie: 5 } })));

  globalThis.fetch = makeWishlistFetch({
    wishlistResponse: {
      response: {
        items: [
          { appid: 100, priority: 3, date_added: 1700000000 }, // qualifies: cut=50 >= 10
          { appid: 200, priority: 1, date_added: 1650000000 }, // does not qualify: cut=5, not at low
        ],
      },
    },
    itadIdByAppid: { 100: "itad-100", 200: "itad-200" },
    pricesByItadId: {
      "itad-100": { price: 9.99, priceCents: 999, regular: 19.99, cut: 50, expiry: null },
      "itad-200": { price: 18.99, priceCents: 1899, regular: 19.99, cut: 5, expiry: null },
    },
    titlesByAppid: { 100: "Qualifying Wishlist Game" },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.wishlist.length, 1);
  assert.equal(body.count, 1);

  const item = body.wishlist[0];
  assert.equal(item.appid, 100);
  assert.equal(item.title, "Qualifying Wishlist Game");
  assert.equal(item.price, 9.99);
  assert.equal(item.regular, 19.99);
  assert.equal(item.cut, 50);
  assert.equal(item.atHistoricalLow, false);
  assert.equal(item.why, "On your wishlist since 14 Nov 2023");
  assert.equal(item.priority, 3);
  assert.equal(item.dateAdded, 1700000000);
  assert.deepEqual(item.deck, { deck: 3, os: 2, frame: 0 });
  assert.deepEqual(item.tagNames.sort(), ["Indie", "Roguelike"]);
  assert.equal(typeof item.batteryFriendly, "boolean");

  // The shallow-cut, not-at-low item (appid 200) never made it into the
  // response at all.
  assert.ok(!body.wishlist.some((w) => w.appid === 200));
});

test("happy path: a shallow cut still qualifies when atHistoricalLow is true", async () => {
  const env = makeEnv();
  globalThis.caches = { default: makeMockCache() };

  env.TAG_CACHE.store.set(deckKey(300), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(300), JSON.stringify(goodSpyEntry()));

  globalThis.fetch = makeWishlistFetch({
    wishlistResponse: {
      response: { items: [{ appid: 300, priority: 0, date_added: 1700000000 }] },
    },
    itadIdByAppid: { 300: "itad-300" },
    pricesByItadId: {
      "itad-300": { price: 19.99, priceCents: 1999, regular: 19.99, cut: 5, expiry: null }, // shallow cut
    },
    lowsById: { "itad-300": { amount: 19.99, amountInt: 1999 } }, // exactly at recorded low
    titlesByAppid: { 300: "Shallow Cut, At Low" },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.wishlist.length, 1);
  assert.equal(body.wishlist[0].atHistoricalLow, true);
  assert.equal(body.wishlist[0].historicalLow, 19.99);
  assert.equal(body.wishlist[0].cut, 5);
});

// ---------------------------------------------------------------------------
// Cache round-trips.
// ---------------------------------------------------------------------------

test("raw wishlist cache hit (24h TTL) avoids re-fetching GetWishlist", async () => {
  const env = makeEnv({ STEAM_ID: "76561198000000002" });
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const rawCacheKey = `https://steam-sale-scout.cache/api/wishlist/raw?steamid=${env.STEAM_ID}`;
  cache.store.set(rawCacheKey, jsonResponse({ items: [{ appid: 400, priority: 0, dateAdded: 1700000000 }] }));

  env.TAG_CACHE.store.set(deckKey(400), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(400), JSON.stringify(goodSpyEntry()));

  let getWishlistCalls = 0;
  globalThis.fetch = makeWishlistFetch({
    itadIdByAppid: { 400: "itad-400" },
    pricesByItadId: { "itad-400": { price: 4.99, priceCents: 499, regular: 9.99, cut: 50, expiry: null } },
    titlesByAppid: { 400: "Raw-cache Game" },
    onCall: (u) => {
      if (u.pathname === "/IWishlistService/GetWishlist/v1/") getWishlistCalls++;
    },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  assert.equal(getWishlistCalls, 0, "GetWishlist should not be called on a raw-cache hit");
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.wishlist[0].title, "Raw-cache Game");
});

test("?refresh=1 bypasses the raw wishlist cache, re-hits GetWishlist, and repopulates the cache", async () => {
  const env = makeEnv({ STEAM_ID: "76561198000000003" });
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const rawCacheKey = `https://steam-sale-scout.cache/api/wishlist/raw?steamid=${env.STEAM_ID}`;
  cache.store.set(rawCacheKey, jsonResponse({ items: [{ appid: 999, priority: 0, dateAdded: 1600000000 }] }));

  env.TAG_CACHE.store.set(deckKey(500), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(500), JSON.stringify(goodSpyEntry()));

  let getWishlistCalls = 0;
  globalThis.fetch = makeWishlistFetch({
    wishlistResponse: { response: { items: [{ appid: 500, priority: 0, date_added: 1712345678 }] } },
    itadIdByAppid: { 500: "itad-500" },
    pricesByItadId: { "itad-500": { price: 3.99, priceCents: 399, regular: 7.99, cut: 50, expiry: null } },
    titlesByAppid: { 500: "Fresh Game" },
    onCall: (u) => {
      if (u.pathname === "/IWishlistService/GetWishlist/v1/") getWishlistCalls++;
    },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist?refresh=1"), env, ctx);
  await ctx.flush();

  assert.equal(getWishlistCalls, 1);
  const body = await res.json();
  assert.equal(body.wishlist[0].title, "Fresh Game");

  const repopulated = cache.store.get(rawCacheKey);
  assert.ok(repopulated, "expected the raw cache to be repopulated after refresh");
  const repopulatedBody = await repopulated.clone().json();
  assert.deepEqual(repopulatedBody.items, [{ appid: 500, priority: 0, dateAdded: 1712345678 }]);
});

test("resolved-price cache hit (6h TTL) returns cached candidates without re-fetching GetWishlist/lookup/prices/historylow", async () => {
  const env = makeEnv({ STEAM_ID: "76561198000000004" });
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const cachedCandidates = [
    {
      itadId: "itad-cached",
      appid: 321,
      title: null,
      price: 5,
      priceCents: 500,
      regular: 10,
      cut: 50,
      expiry: null,
      atHistoricalLow: false,
      historicalLow: null,
      priority: 0,
      dateAdded: 1700000000,
      why: "On your wishlist since 14 Nov 2023",
    },
  ];
  const pricesCacheKey = `https://steam-sale-scout.cache/api/wishlist/resolved?steamid=${env.STEAM_ID}`;
  cache.store.set(pricesCacheKey, jsonResponse({ candidates: cachedCandidates }));

  env.TAG_CACHE.store.set(deckKey(321), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(321), JSON.stringify(goodSpyEntry()));

  const calledPaths = [];
  globalThis.fetch = makeWishlistFetch({
    titlesByAppid: { 321: "Cached Candidate Game" },
    onCall: (u) => calledPaths.push(u.pathname),
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.wishlist.length, 1);
  assert.equal(body.wishlist[0].title, "Cached Candidate Game");

  assert.ok(!calledPaths.includes("/IWishlistService/GetWishlist/v1/"));
  assert.ok(!calledPaths.includes("/lookup/id/shop/61/v1"));
  assert.ok(!calledPaths.includes("/games/prices/v2"));
  assert.ok(!calledPaths.includes("/games/historylow/v1"));
});

// ---------------------------------------------------------------------------
// enrichWishlist fail-soft (reviewer gap #1): price resolution SUCCEEDS (the
// item qualifies for the lane) but the enrichment step itself throws. Proven
// with a genuinely-throwing TAG_CACHE.get — spyQueue.js's getCachedSpy does
// NOT wrap env.TAG_CACHE.get in a try/catch (unlike resolveDeckCompat's own
// GetItems fetch, which is best-effort), so a KV outage here really does
// propagate out of enrichWishlist. This demonstrates handleWishlist's outer
// try/catch around enrichWishlist is load-bearing, not dead code.
// ---------------------------------------------------------------------------

test("enrichWishlist genuinely throws (TAG_CACHE.get rejects) after a successful qualifying price resolution -> fail-soft 200 {available:false}, no throw out of handleWishlist", async () => {
  const env = makeEnv({
    TAG_CACHE: {
      async get() {
        throw new Error("KV outage");
      },
      async put() {},
    },
  });
  globalThis.caches = { default: makeMockCache() };

  globalThis.fetch = makeWishlistFetch({
    wishlistResponse: {
      response: { items: [{ appid: 600, priority: 0, date_added: 1700000000 }] },
    },
    itadIdByAppid: { 600: "itad-600" },
    pricesByItadId: {
      "itad-600": { price: 4.99, priceCents: 499, regular: 9.99, cut: 50, expiry: null },
    },
    titlesByAppid: { 600: "Should Never Render" },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.notice, "Wishlist unavailable");
});

// ---------------------------------------------------------------------------
// Per-appid itad-id and title caches (reviewer gap #2): each has its own
// cache-key/TTL independent of the coarser 24h raw-wishlist and 6h
// resolved-candidates blobs (see wishlistItadIdCacheKey/wishlistTitleCacheKey
// in worker.js). Prove each is actually consulted and hit on a second call,
// and that ?refresh=1 bypasses it too, not just the outer blobs.
// ---------------------------------------------------------------------------

test("second /api/wishlist call reuses the per-appid itad-id cache once the 6h resolved-candidates blob is evicted (itad-id's own TTL is 7d, longer-lived)", async () => {
  const env = makeEnv({ STEAM_ID: "76561198000000010" });
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  env.TAG_CACHE.store.set(deckKey(700), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(700), JSON.stringify(goodSpyEntry()));

  let lookupCalls = 0;
  let wishlistCalls = 0;
  globalThis.fetch = makeWishlistFetch({
    wishlistResponse: { response: { items: [{ appid: 700, priority: 0, date_added: 1700000000 }] } },
    itadIdByAppid: { 700: "itad-700" },
    pricesByItadId: { "itad-700": { price: 4.99, priceCents: 499, regular: 9.99, cut: 50, expiry: null } },
    titlesByAppid: { 700: "Repeat Game" },
    onCall: (u) => {
      if (u.pathname === "/lookup/id/shop/61/v1") lookupCalls++;
      if (u.pathname === "/IWishlistService/GetWishlist/v1/") wishlistCalls++;
    },
  });

  const ctx = makeCtx();
  const res1 = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();
  assert.equal((await res1.json()).available, true);
  assert.equal(lookupCalls, 1, "first call resolves the itad id via lookup");

  // Simulate the 6h resolved-candidates blob expiring while the longer-lived
  // (7d) per-appid itad-id cache entry survives — a realistic scenario, not
  // a contrived one, since WISHLIST_PRICES_CACHE_TTL_SECONDS (6h) is shorter
  // than APPID_CACHE_TTL_SECONDS (7d).
  const pricesCacheKey = `https://steam-sale-scout.cache/api/wishlist/resolved?steamid=${env.STEAM_ID}`;
  cache.store.delete(pricesCacheKey);

  const res2 = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();
  const body2 = await res2.json();
  assert.equal(body2.available, true);
  assert.equal(body2.wishlist[0].title, "Repeat Game");
  assert.equal(lookupCalls, 1, "second call must reuse the per-appid itad-id cache, not re-hit lookup/id/shop/61/v1");
  assert.equal(wishlistCalls, 1, "raw wishlist cache (24h) also still holds — GetWishlist not re-hit either");
});

test("?refresh=1 bypasses the per-appid itad-id cache too (re-hits lookup/id/shop/61/v1 on every call)", async () => {
  const env = makeEnv({ STEAM_ID: "76561198000000011" });
  globalThis.caches = { default: makeMockCache() };

  env.TAG_CACHE.store.set(deckKey(701), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(701), JSON.stringify(goodSpyEntry()));

  let lookupCalls = 0;
  globalThis.fetch = makeWishlistFetch({
    wishlistResponse: { response: { items: [{ appid: 701, priority: 0, date_added: 1700000000 }] } },
    itadIdByAppid: { 701: "itad-701" },
    pricesByItadId: { "itad-701": { price: 4.99, priceCents: 499, regular: 9.99, cut: 50, expiry: null } },
    titlesByAppid: { 701: "Refresh Game" },
    onCall: (u) => {
      if (u.pathname === "/lookup/id/shop/61/v1") lookupCalls++;
    },
  });

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();
  assert.equal(lookupCalls, 1);

  await worker.fetch(new Request("https://x/api/wishlist?refresh=1"), env, ctx);
  await ctx.flush();
  assert.equal(lookupCalls, 2, "refresh=1 must bypass the itad-id cache too, not just the raw/resolved blobs");
});

test("second /api/wishlist call reuses the per-appid title cache (GetItems not re-hit, even though enrichWishlist re-runs every call)", async () => {
  const env = makeEnv({ STEAM_ID: "76561198000000012" });
  globalThis.caches = { default: makeMockCache() };

  env.TAG_CACHE.store.set(deckKey(702), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(702), JSON.stringify(goodSpyEntry()));

  let getItemsCalls = 0;
  globalThis.fetch = makeWishlistFetch({
    wishlistResponse: { response: { items: [{ appid: 702, priority: 0, date_added: 1700000000 }] } },
    itadIdByAppid: { 702: "itad-702" },
    pricesByItadId: { "itad-702": { price: 4.99, priceCents: 499, regular: 9.99, cut: 50, expiry: null } },
    titlesByAppid: { 702: "Title Cache Game" },
    onCall: (u) => {
      if (u.pathname === "/IStoreBrowseService/GetItems/v1/") getItemsCalls++;
    },
  });

  const ctx = makeCtx();
  const res1 = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();
  assert.equal((await res1.json()).wishlist[0].title, "Title Cache Game");
  assert.equal(getItemsCalls, 1);

  // Second call: the 6h resolved-candidates blob is still fresh (untouched
  // here), so buildWishlistCandidates/resolveWishlistItadIds don't even run —
  // but enrichWishlist (title/deck/spy) recomputes every request per its own
  // header comment, so this genuinely exercises the title cache's hit path,
  // not just the coarser blob's.
  const res2 = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();
  const body2 = await res2.json();
  assert.equal(body2.wishlist[0].title, "Title Cache Game");
  assert.equal(getItemsCalls, 1, "title cache must be reused — GetItems not called again");
});

test("?refresh=1 bypasses the per-appid title cache too (re-hits GetItems and picks up a renamed title)", async () => {
  const env = makeEnv({ STEAM_ID: "76561198000000013" });
  globalThis.caches = { default: makeMockCache() };

  env.TAG_CACHE.store.set(deckKey(703), JSON.stringify({ deck: 0, os: 0, frame: 0 }));
  env.TAG_CACHE.store.set(v2Key(703), JSON.stringify(goodSpyEntry()));

  let getItemsCalls = 0;
  let currentTitle = "Old Title";
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.steampowered.com" && u.pathname === "/IStoreBrowseService/GetItems/v1/") {
      getItemsCalls++;
      return jsonResponse({ response: { store_items: [{ appid: 703, name: currentTitle }] } });
    }
    if (u.hostname === "api.steampowered.com" && u.pathname === "/IWishlistService/GetWishlist/v1/") {
      return jsonResponse({ response: { items: [{ appid: 703, priority: 0, date_added: 1700000000 }] } });
    }
    if (u.pathname === "/lookup/id/shop/61/v1") {
      return jsonResponse({ "app/703": "itad-703" });
    }
    if (u.pathname === "/games/prices/v2") {
      return jsonResponse([
        {
          id: "itad-703",
          deals: [
            {
              shop: { id: 61 },
              price: { amount: 4.99, amountInt: 499 },
              regular: { amount: 9.99 },
              cut: 50,
              expiry: null,
            },
          ],
        },
      ]);
    }
    if (u.pathname === "/games/historylow/v1") {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res1 = await worker.fetch(new Request("https://x/api/wishlist"), env, ctx);
  await ctx.flush();
  assert.equal((await res1.json()).wishlist[0].title, "Old Title");
  assert.equal(getItemsCalls, 1);

  currentTitle = "New Title";
  const res2 = await worker.fetch(new Request("https://x/api/wishlist?refresh=1"), env, ctx);
  await ctx.flush();
  const body2 = await res2.json();
  assert.equal(getItemsCalls, 2, "refresh=1 must bypass the title cache too");
  assert.equal(body2.wishlist[0].title, "New Title");
});
