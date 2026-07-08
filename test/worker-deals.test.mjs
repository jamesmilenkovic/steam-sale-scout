// Tests for src/worker.js — the /api/deals route (Increment 2), with a
// MOCKED ITAD upstream and mocked Steam library cache.
//
// Mirrors test/worker.test.mjs's style: drive everything through the
// top-level `worker.default.fetch(request, env, ctx)`, stub `globalThis.fetch`
// and `globalThis.caches.default` with minimal in-memory fakes, restore
// afterward. See that file's header comment for the testability rationale
// (handleDeals/buildDealsFeed/etc are private to worker.js).
//
// NEVER makes a real network call — all ITAD responses below are fixtures
// shaped from the real /deals/v2, /lookup/shop/61/id/v1, and
// /games/historylow/v1 response shapes documented in src/deals.js.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { __setSpyMinIntervalMsForTests, __resetSpyQueueForTests } from "../src/spyQueue.js";
import { BESTOF_FETCH_CAP, BESTOF_SORT, DEALS_FETCH_CAP } from "../src/deals.js";

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

// Increment 5: /api/deals now also enriches each deal with SteamSpy
// tags/battery (lazy, KV-only — see src/worker.js's enrichDeals) and Steam
// Deck compat (a batched, KV-cached GetItems fetch — see src/deckCompat.js).
// Both need a TAG_CACHE binding on env (added to makeEnv() below); the
// SteamSpy half also shares the same background queue /api/recs drives, so
// tests shrink its pacing to 0ms the same way test/worker-recs.test.mjs
// does, to avoid real per-appid 1-second waits when a test's deals carry
// many candidate appids.
test.beforeEach(() => {
  __setSpyMinIntervalMsForTests(0);
  __resetSpyQueueForTests();
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

/** Minimal in-memory stand-in for a Workers KV namespace binding, mirroring
 * test/worker-recs.test.mjs's makeMockKv() — needed since Increment 5's
 * /api/deals enrichment reads/writes TAG_CACHE (SteamSpy tag lookups +
 * Steam Deck compat cache). */
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

function makeEnv(overrides = {}) {
  return {
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

/**
 * Builds a router-style mock `fetch` dispatching on the ITAD endpoints
 * worker.js hits. `dealsPagesByOffset` maps an offset (number) -> raw
 * /deals/v2 page. `appIdsById` maps itad id -> array of shop-native ids
 * (e.g. ["app/440"]). `lowsById` maps itad id -> `low` record or omits it.
 */
function makeItadFetch({
  dealsPagesByOffset = {},
  appIdsById = {},
  lowsById = {},
  onCall,
} = {}) {
  return async (url, options = {}) => {
    const u = new URL(url);
    onCall?.(u, options);

    if (u.pathname === "/deals/v2") {
      const offset = Number(u.searchParams.get("offset") || "0");
      const page = dealsPagesByOffset[offset] ?? { list: [], hasMore: false };
      return jsonResponse(page);
    }

    if (u.pathname === "/lookup/shop/61/id/v1") {
      const ids = JSON.parse(options.body);
      const body = {};
      for (const id of ids) body[id] = appIdsById[id] ?? [];
      return jsonResponse(body);
    }

    if (u.pathname === "/games/historylow/v1") {
      const ids = JSON.parse(options.body);
      const arr = ids
        .filter((id) => lowsById[id] !== undefined)
        .map((id) => ({ id, low: lowsById[id] }));
      return jsonResponse(arr);
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
}

/** One raw ITAD /deals/v2 list item. */
function rawDeal(id, title, cut, priceAmount) {
  const amountInt = Math.round(priceAmount * 100);
  return {
    id,
    title,
    deal: {
      price: { amount: priceAmount, amountInt },
      regular: { amount: priceAmount * 2 },
      cut,
      expiry: null,
      flag: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Increment 5 enrichment: tagNames/batteryFriendly/deck, keyed off
// TAG_CACHE (v2:spytag:<appid> for SteamSpy, deck:<appid> for Deck compat).
// Mirrors test/worker-hof.test.mjs's v2Key/deckKey helpers.
// ---------------------------------------------------------------------------

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

test.afterEach(() => {
  restoreGlobals();
  __setSpyMinIntervalMsForTests(1000);
});

// ---------------------------------------------------------------------------
// Assembled/filtered/owned-excluded shape, incl. empty tags slot per deal.
// ---------------------------------------------------------------------------

test("mocked ITAD upstream -> /api/deals returns assembled/filtered/owned-excluded deals with empty tags", async () => {
  const dealA = rawDeal("itad-a", "Above Threshold Game", 75, 9.99); // kept, not owned
  const dealB = rawDeal("itad-b", "At Threshold Game", 60, 19.99); // kept, at historical low
  const dealC = rawDeal("itad-c", "Below Threshold Game", 50, 29.99); // filtered out
  const dealD = rawDeal("itad-d", "Owned Game", 80, 4.99); // filtered by owned-exclusion

  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: {
      0: { list: [dealA, dealB, dealC, dealD], hasMore: false },
    },
    appIdsById: {
      "itad-a": ["app/100"],
      "itad-b": ["app/200"],
      "itad-d": ["app/999"], // this is the owned appid
    },
    lowsById: {
      "itad-b": { amount: 19.99, amountInt: 1999 }, // exactly at deal price -> flagged
    },
  });

  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv({ STEAM_API_KEY: "steam-key", STEAM_ID: "76561198000000000" });
  // Prime the library cache so owned-exclusion doesn't need its own fetch mock.
  const libraryCacheKey = `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}`;
  cache.store.set(libraryCacheKey, jsonResponse({ games: [{ appid: 999 }] }));

  const ctx = makeCtx();
  const req = new Request("https://x/api/deals"); // default minCut = 60
  const res = await worker.fetch(req, env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.minCut, 60);

  const titles = body.deals.map((d) => d.title).sort();
  assert.deepEqual(titles, ["Above Threshold Game", "At Threshold Game"]);

  for (const deal of body.deals) {
    assert.deepEqual(deal.tags, []); // empty tags slot, populated by inc 3
  }

  const atThreshold = body.deals.find((d) => d.title === "At Threshold Game");
  assert.equal(atThreshold.appid, 200);
  assert.equal(atThreshold.atHistoricalLow, true);
  assert.equal(atThreshold.historicalLow, 19.99);

  const above = body.deals.find((d) => d.title === "Above Threshold Game");
  assert.equal(above.appid, 100);
  assert.equal(above.atHistoricalLow, false);
});

test("a deal with no resolvable Steam appid is kept in the response with appid=null", async () => {
  const dealNoAppid = rawDeal("itad-noapp", "Bundle-only Deal", 70, 5.0);

  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list: [dealNoAppid], hasMore: false } },
    appIdsById: { "itad-noapp": ["bundle/12"] }, // no app/ entry -> parseSteamAppId -> null
    lowsById: {},
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deals.length, 1);
  assert.equal(body.deals[0].appid, null);
});

// ---------------------------------------------------------------------------
// minCut query param plumbing (clamped via clampMinCut, exercised end to end).
// ---------------------------------------------------------------------------

test("?minCut=90 filters out deals below 90% even if they'd pass the default", async () => {
  const deal80 = rawDeal("itad-80", "80pc off", 80, 10);
  const deal95 = rawDeal("itad-95", "95pc off", 95, 2);

  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list: [deal80, deal95], hasMore: false } },
    appIdsById: { "itad-80": ["app/1"], "itad-95": ["app/2"] },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals?minCut=90"), env, ctx);
  await ctx.flush();

  const body = await res.json();
  assert.equal(body.minCut, 90);
  assert.equal(body.deals.length, 1);
  assert.equal(body.deals[0].title, "95pc off");
});

test("?minCut=20 (out of range) clamps to 40, not passed through raw", async () => {
  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list: [], hasMore: false } },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals?minCut=20"), env, ctx);
  await ctx.flush();

  const body = await res.json();
  assert.equal(body.minCut, 40);
});

// ---------------------------------------------------------------------------
// Cache behaviour: hit avoids re-fetch; ?refresh=1 bypasses + repopulates.
// ---------------------------------------------------------------------------

test("cache hit returns the cached deals response and does not call fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("fetch should not be called on a cache hit");
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  const cacheKey = "https://steam-sale-scout.cache/api/deals?minCut=60";
  cache.store.set(cacheKey, jsonResponse({ deals: [{ title: "cached-hit" }], minCut: 60 }));

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);

  assert.equal(fetchCalls, 0);
  const body = await res.json();
  assert.equal(body.deals[0].title, "cached-hit");
});

test("?refresh=1 bypasses the deals cache and re-hits ITAD, repopulating the cache", async () => {
  let dealsCalls = 0;
  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: {
      0: { list: [rawDeal("itad-fresh", "Fresh Deal", 70, 15)], hasMore: false },
    },
    appIdsById: { "itad-fresh": ["app/1"] },
    onCall: (u) => {
      if (u.pathname === "/deals/v2") dealsCalls++;
    },
  });
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  const cacheKey = "https://steam-sale-scout.cache/api/deals?minCut=60";
  cache.store.set(cacheKey, jsonResponse({ deals: [{ title: "stale-cached" }], minCut: 60 }));

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals?refresh=1"), env, ctx);
  await ctx.flush();

  assert.equal(dealsCalls, 1);
  const body = await res.json();
  assert.equal(body.deals[0].title, "Fresh Deal");

  // Cache was repopulated with the fresh response (not the stale one).
  const repopulated = cache.store.get(cacheKey);
  assert.ok(repopulated, "expected the cache to be repopulated after refresh");
  const repopulatedBody = await repopulated.clone().json();
  assert.equal(repopulatedBody.deals[0].title, "Fresh Deal");
});

// ---------------------------------------------------------------------------
// Error paths: missing ITAD_API_KEY, upstream 429.
// ---------------------------------------------------------------------------

test("missing ITAD_API_KEY returns a 500 with a clear message, without touching fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("should not be called", { status: 200 });
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ ITAD_API_KEY: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /ITAD_API_KEY/);
  assert.equal(fetchCalls, 0);
});

test("upstream 429 from ITAD is surfaced as 429 with the Retry-After header", async () => {
  globalThis.fetch = async () =>
    new Response("rate limited", { status: 429, headers: { "retry-after": "42" } });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);

  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
  const body = await res.json();
  assert.match(body.error, /rate limit/i);
});

test("upstream 429 with no Retry-After header still surfaces 429 without a bogus header", async () => {
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);

  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), null);
});

// ---------------------------------------------------------------------------
// Pagination integration behaviour (fetchDealsPages lives in worker.js, not
// a pure export — covered here at the route level; DEALS_PAGE_LIMIT=200).
// ---------------------------------------------------------------------------

test("pagination: continues to a second page when the first is full and still above minCut", async () => {
  const page0 = {
    list: Array.from({ length: 200 }, (_, i) => rawDeal(`p0-${i}`, `Deal ${i}`, 80, 10)),
    hasMore: true,
  };
  const page1 = { list: [rawDeal("p1-0", "Last Deal", 75, 5)], hasMore: false };

  let dealsCallCount = 0;
  const appIdsById = {};
  for (const item of page0.list) appIdsById[item.id] = [`app/${item.id}`];
  appIdsById["p1-0"] = ["app/9999"];

  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: page0, 200: page1 },
    appIdsById,
    onCall: (u) => {
      if (u.pathname === "/deals/v2") dealsCallCount++;
    },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals?minCut=60"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  assert.equal(dealsCallCount, 2); // paginated to offset=200 before exhausting
  const body = await res.json();
  assert.equal(body.deals.length, 201);
});

test("pagination: stops early (no second page fetched) once a full page's last item drops below minCut", async () => {
  // A full page (200 items) but the last one is below minCut=60 — since the
  // upstream sort is -cut, worker.js should NOT fetch a further page.
  const list = Array.from({ length: 200 }, (_, i) =>
    rawDeal(`q-${i}`, `Deal ${i}`, i === 199 ? 50 : 80, 10),
  );
  let dealsCallCount = 0;

  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list, hasMore: true } }, // hasMore true, but should still stop
    appIdsById: Object.fromEntries(list.map((item) => [item.id, [`app/${item.id}`]])),
    onCall: (u) => {
      if (u.pathname === "/deals/v2") dealsCallCount++;
    },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals?minCut=60"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  assert.equal(dealsCallCount, 1); // early-stopped, did not request offset=200
  const body = await res.json();
  // 199 deals at cut=80 kept, the 1 at cut=50 filtered out by filterByMinCut.
  assert.equal(body.deals.length, 199);
});

// ---------------------------------------------------------------------------
// Increment 5: /api/deals enrichment (tagNames, batteryFriendly, deck) and
// the cache-control regression lock (reviewer issue #2).
// ---------------------------------------------------------------------------

test("a deal with a known appid gets deck populated from a primed deck-cache KV entry", async () => {
  const dealKnown = rawDeal("itad-deck", "Deck-checked Game", 75, 9.99);

  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list: [dealKnown], hasMore: false } },
    appIdsById: { "itad-deck": ["app/440"] },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  // Prime the deck-cache KV entry directly — resolveDeckCompat should read
  // this cached entry rather than hitting GetItems (no GetItems mock wired
  // into makeItadFetch's router, so any live call here would throw and fail
  // the test).
  env.TAG_CACHE.store.set(deckKey(440), JSON.stringify({ deck: 3, os: 2, frame: 0 }));

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deals.length, 1);
  const enriched = body.deals[0];
  assert.equal(enriched.appid, 440);
  assert.deepEqual(enriched.deck, { deck: 3, os: 2, frame: 0 });
  // The badge-relevant category (deckBadge(3) === "verified") is carried
  // through on the `deck.deck` field, not dropped/renamed.
  assert.equal(enriched.deck.deck, 3);
});

test("tagNames and batteryFriendly are present on enriched deals", async () => {
  const dealTagged = rawDeal("itad-tags", "Tagged Game", 70, 4.99);

  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list: [dealTagged], hasMore: false } },
    appIdsById: { "itad-tags": ["app/555"] },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  // Prime both the SteamSpy tag cache (drives tagNames/batteryFriendly) and
  // the deck cache (so this test doesn't also need a GetItems mock).
  env.TAG_CACHE.store.set(
    v2Key(555),
    JSON.stringify(goodSpyEntry({ tags: { Puzzle: 40, "2D": 20 } })),
  );
  env.TAG_CACHE.store.set(deckKey(555), JSON.stringify({ deck: 0, os: 0, frame: 0 }));

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);
  await ctx.flush();

  const body = await res.json();
  assert.equal(body.deals.length, 1);
  const enriched = body.deals[0];
  assert.deepEqual(enriched.tagNames.sort(), ["2D", "Puzzle"]);
  assert.equal(typeof enriched.batteryFriendly, "boolean");
  // Puzzle + 2D are both LOW_POWER tags with no HIGH_POWER hit -> true.
  assert.equal(enriched.batteryFriendly, true);
});

test("a deal with appid == null is handled cleanly: no deck fetch, no crash", async () => {
  const dealNoAppid = rawDeal("itad-noapp-enrich", "Bundle-only Deal", 70, 5.0);

  let getItemsCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.steampowered.com") {
      getItemsCalls++;
      throw new Error("GetItems should never be called for a null-appid deal");
    }
    return makeItadFetch({
      dealsPagesByOffset: { 0: { list: [dealNoAppid], hasMore: false } },
      appIdsById: { "itad-noapp-enrich": ["bundle/12"] }, // no app/ entry -> appid=null
    })(url, options);
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deals.length, 1);
  const enriched = body.deals[0];
  assert.equal(enriched.appid, null);
  assert.deepEqual(enriched.tagNames, []);
  assert.equal(enriched.batteryFriendly, false);
  assert.deepEqual(enriched.deck, { deck: 0, os: 0, frame: 0 });
  assert.equal(getItemsCalls, 0, "a null-appid deal must never trigger a Deck compat fetch");
});

// ---------------------------------------------------------------------------
// Increment 5.5 regression: /api/deals' own sourcing (sort=-cut, cap=1000)
// must stay byte-identical now that /api/best-of has a separate pool with
// its own sort/cap (see src/deals.js's BESTOF_* config, test/worker-hof.
// test.mjs's sourcing tests). The two configs must coexist without either
// bleeding into the other.
// ---------------------------------------------------------------------------

test("Deals-pool-unchanged regression: /api/deals still sources sort=-cut, independent of the Best-of config", async () => {
  const capturedSorts = [];
  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list: [rawDeal("itad-1", "A Deal", 70, 10)], hasMore: false } },
    appIdsById: { "itad-1": ["app/1"] },
    onCall: (u) => {
      if (u.pathname === "/deals/v2") capturedSorts.push(u.searchParams.get("sort"));
    },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals?minCut=60"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.minCut, 60);
  assert.deepEqual(capturedSorts, ["-cut"]);
  assert.notEqual(BESTOF_SORT, "-cut");
  assert.notEqual(BESTOF_SORT, capturedSorts[0]); // the two pools' sort axes never collide
  assert.equal(DEALS_FETCH_CAP, 1000);
  assert.notEqual(DEALS_FETCH_CAP, BESTOF_FETCH_CAP); // the two pools' caps coexist independently
});

test("/api/deals response carries the restored cache-control: public, max-age=21600 header", async () => {
  globalThis.fetch = makeItadFetch({
    dealsPagesByOffset: { 0: { list: [], hasMore: false } },
  });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/deals"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=21600");
});
