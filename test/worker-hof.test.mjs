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
import { BESTOF_FETCH_CAP, BESTOF_MIN_CUT, BESTOF_PAGE_LIMIT, BESTOF_SORT } from "../src/deals.js";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { ensureDismissalsSchema, addDismissal } from "../src/dismissals.js";

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

/** Increment 5.5: /api/best-of reads its OWN pool cache key, entirely
 * separate from primeDeals()'s /api/deals?minCut= key above — priming the
 * deals cache no longer feeds Best-of at all. */
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

/** One RAW ITAD /deals/v2 list item (pre-normalisation shape), mirroring
 * test/worker-deals.test.mjs's rawDeal() — used by the Increment 5.5 Best-of
 * sourcing tests below, which exercise the pool at the ITAD-response level
 * (fetchBestOfPages/buildBestOfPool aren't exported, so this is driven
 * through the /api/best-of route, same testability seam as fetchDealsPages). */
function rawBestOfDeal(id, title, cut) {
  return {
    id,
    title,
    deal: {
      price: { amount: 10, amountInt: 1000 },
      regular: { amount: 20 },
      cut,
      expiry: null,
      flag: null,
    },
  };
}

/** Router-style mock fetch for the Best-of sourcing tests, mirroring
 * test/worker-deals.test.mjs's makeItadFetch() for the ITAD endpoints. */
function makeBestOfItadFetch({ dealsPagesByOffset = {}, appIdsById = {}, lowsById = {}, onCall } = {}) {
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
      const arr = ids.filter((id) => lowsById[id] !== undefined).map((id) => ({ id, low: lowsById[id] }));
      return jsonResponse(arr);
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
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
  primeBestOfPool(cache, deals);

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

test("a dismissed appid is excluded from /api/best-of even though it clears every Hall-of-Fame bar", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);
  const keptAppid = 200;
  const dismissedAppid = 201;
  primeBestOfPool(cache, [
    deal({ itadId: "itad-keep", appid: keptAppid, cut: 90, title: "Keep This All-timer" }),
    deal({ itadId: "itad-dismissed", appid: dismissedAppid, cut: 90, title: "Dismissed All-timer" }),
  ]);

  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 } })));
  const hofQualifyingReviews = { reviews: { positive: 95000, negative: 5000 } };
  env.TAG_CACHE.store.set(v2Key(keptAppid), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 }, ...hofQualifyingReviews })));
  env.TAG_CACHE.store.set(v2Key(dismissedAppid), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 }, ...hofQualifyingReviews })));

  const fpmDb = makeMockD1();
  await ensureDismissalsSchema({ FPM_DB: fpmDb });
  await addDismissal({ FPM_DB: fpmDb }, dismissedAppid, "Dismissed All-timer");
  env.FPM_DB = fpmDb;

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const body = await res.json();

  assert.equal(body.hof.length, 1);
  assert.equal(body.hof[0].appid, keptAppid);
});

test("dismissal slot-freeing (rank promotion): dismissing the top-ranked Hall-of-Fame pick promotes the runner-up into hof[0]", async () => {
  // buildHallOfFame has no top-N slice — same "prove rank promotion, not
  // just exclusion" reasoning as the Recs sibling test.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);
  const topAppid = 210;
  const runnerUpAppid = 211;
  // Identical qualifying reviews (identical Wilson quality) — the only
  // thing separating hofScore (discountDepth x qualityValue) is the
  // discount depth, deterministically making the deeper cut rank #1.
  const hofQualifyingReviews = { reviews: { positive: 95000, negative: 5000 } };
  primeBestOfPool(cache, [
    deal({ itadId: "itad-top", appid: topAppid, cut: 95, title: "Deepest Cut All-timer" }),
    deal({ itadId: "itad-runner-up", appid: runnerUpAppid, cut: 90, title: "Shallower Cut All-timer" }),
  ]);

  env.TAG_CACHE.store.set(v2Key(1), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 } })));
  env.TAG_CACHE.store.set(v2Key(topAppid), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 }, ...hofQualifyingReviews })));
  env.TAG_CACHE.store.set(v2Key(runnerUpAppid), JSON.stringify(goodSpyEntry({ tags: { Roguelike: 10 }, ...hofQualifyingReviews })));

  const fpmDb = makeMockD1();
  await ensureDismissalsSchema({ FPM_DB: fpmDb });
  env.FPM_DB = fpmDb;

  const ctx = makeCtx();

  const before = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const beforeBody = await before.json();
  assert.equal(beforeBody.hof.length, 2);
  assert.equal(beforeBody.hof[0].appid, topAppid, "baseline: the deeper-cut pick ranks #1");
  assert.equal(beforeBody.hof[1].appid, runnerUpAppid);

  await addDismissal({ FPM_DB: fpmDb }, topAppid, "Deepest Cut All-timer");

  const after = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const afterBody = await after.json();
  assert.equal(afterBody.hof.length, 1, "the dismissed row is gone, not just re-ranked");
  assert.equal(afterBody.hof[0].appid, runnerUpAppid, "promoted: the runner-up now occupies hof[0]");
});

test("similarity is attached as a secondary field but never used to exclude a qualifying candidate", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  // Owned game's tags share nothing with the candidate — similarity ~0.
  primeLibrary(cache, env, [ownedGame({ appid: 1, name: "Owned", playtime_forever: 600 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-hof", appid: 200, cut: 80 })]);

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
  primeBestOfPool(cache, [deal({ itadId: "itad-hof", appid: 200, cut: 75 })]);

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
  primeBestOfPool(cache, [deal({ appid: 200 })]);

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ready, false);
  assert.equal(body.hof.length, 0);
  assert.equal(body.pendingCount, 1);

  await ctx.flush();
});

// ---------------------------------------------------------------------------
// Increment 5.5: dedicated Best-of candidate sourcing (the fix). Own sort
// axis, own floor, own cap, own cache — none of this shared with the Deals
// pool (see test/worker-deals.test.mjs's regression test for the other half).
// ---------------------------------------------------------------------------

test("Best-of sourcing: ITAD /deals/v2 is paged sort=rank (never -cut), and the pool floors at cut >= BESTOF_MIN_CUT", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);

  const capturedSorts = [];
  globalThis.fetch = makeBestOfItadFetch({
    dealsPagesByOffset: {
      0: {
        list: [
          rawBestOfDeal("itad-below-floor", "Below floor", BESTOF_MIN_CUT - 1),
          rawBestOfDeal("itad-at-floor", "At floor", BESTOF_MIN_CUT),
          rawBestOfDeal("itad-above-floor", "Above floor", 50),
        ],
        hasMore: false,
      },
    },
    appIdsById: {
      "itad-at-floor": ["app/10"],
      "itad-above-floor": ["app/50"],
    },
    onCall: (u) => {
      if (u.pathname === "/deals/v2") capturedSorts.push(u.searchParams.get("sort"));
    },
  });

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  await ctx.flush();

  assert.ok(capturedSorts.length > 0, "expected at least one /deals/v2 call");
  assert.ok(
    capturedSorts.every((s) => s === BESTOF_SORT),
    `expected every /deals/v2 call to use sort=${BESTOF_SORT}, got: ${capturedSorts}`,
  );
  assert.ok(!capturedSorts.includes("-cut"), "Best-of must never source with the Deals -cut axis");
  assert.equal(BESTOF_SORT, "rank");

  const pooled = cache.store.get("https://steam-sale-scout.cache/api/best-of/pool");
  const pooledBody = await pooled.clone().json();
  const titles = pooledBody.deals.map((d) => d.title).sort();
  assert.deepEqual(titles, ["Above floor", "At floor"]); // below-floor excluded; at-floor kept (>=)
});

test("Best-of sourcing caps at BESTOF_FETCH_CAP (paging well past DEALS_FETCH_CAP=1000) without an early cut-based stop", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);

  let dealsCallCount = 0;
  let maxOffsetSeen = -1;
  // Every offset returns a full page (hasMore:true) — an apparently endless
  // feed. Only the BESTOF_FETCH_CAP/BESTOF_MAX_PAGES bound should stop
  // paging, never a low-cut item (rank order isn't cut-sorted, so an early
  // low-cut stop would recreate the exact saturation bug this fixes).
  globalThis.fetch = makeBestOfItadFetch({
    dealsPagesByOffset: new Proxy(
      {},
      {
        get(_target, prop) {
          const offset = Number(prop);
          if (!Number.isFinite(offset)) return undefined;
          return {
            list: Array.from({ length: BESTOF_PAGE_LIMIT }, (_, i) =>
              rawBestOfDeal(`o${offset}-${i}`, `Deal ${offset}-${i}`, 50),
            ),
            hasMore: true,
          };
        },
      },
    ),
    onCall: (u) => {
      if (u.pathname === "/deals/v2") {
        dealsCallCount++;
        maxOffsetSeen = Math.max(maxOffsetSeen, Number(u.searchParams.get("offset")));
      }
    },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  assert.equal(dealsCallCount, BESTOF_FETCH_CAP / BESTOF_PAGE_LIMIT); // 25 pages, capped
  assert.ok(maxOffsetSeen < BESTOF_FETCH_CAP);
});

test("Best-of sourcing: an early low-cut item on a full hasMore page does not halt pagination — a page-2 qualifier still enters the pool", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);

  // Page 1 (offset=0): a FULL page, hasMore:true, opening with a below-floor
  // item (cut=5) — if any early-stop-on-cut logic existed (the exact bug
  // this fix removes; fetchDealsPages has one, fetchBestOfPages must not),
  // pagination would stop right here and page 2 would never be fetched.
  const page0List = [
    rawBestOfDeal("itad-below-floor", "Below floor early item", 5),
    ...Array.from({ length: BESTOF_PAGE_LIMIT - 1 }, (_, i) =>
      rawBestOfDeal(`itad-filler-${i}`, `Filler ${i}`, 50),
    ),
  ];
  // Page 2 (offset=BESTOF_PAGE_LIMIT): a famous high-cut qualifier, exhausted.
  const page1List = [rawBestOfDeal("itad-famous", "Famous Qualifier", 80)];

  globalThis.fetch = makeBestOfItadFetch({
    dealsPagesByOffset: {
      0: { list: page0List, hasMore: true },
      [BESTOF_PAGE_LIMIT]: { list: page1List, hasMore: false },
    },
    appIdsById: {
      "itad-famous": ["app/8080"],
    },
  });

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  await ctx.flush();

  const pooled = cache.store.get("https://steam-sale-scout.cache/api/best-of/pool");
  const pooledBody = await pooled.clone().json();
  const titles = pooledBody.deals.map((d) => d.title);

  assert.ok(
    titles.includes("Famous Qualifier"),
    "pagination must continue past the low-cut early item to pick up the page-2 qualifier",
  );
  const famous = pooledBody.deals.find((d) => d.title === "Famous Qualifier");
  assert.equal(famous.appid, 8080);
  assert.ok(
    !titles.includes("Below floor early item"),
    "the below-floor item must still be excluded by the BESTOF_MIN_CUT floor",
  );
});

test("Best-of pool cache: a primed pool is served without refetching ITAD; ?refresh=1 bypasses and repopulates it", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1, playtime_forever: 600 })]);
  primeBestOfPool(cache, [deal({ itadId: "itad-stale", appid: 900, title: "Stale pooled deal", cut: 80 })]);

  let dealsV2Calls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/deals/v2") dealsV2Calls++;
    throw new Error("unexpected fetch on a Best-of pool cache hit");
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/best-of"), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(dealsV2Calls, 0, "a primed pool must be served without hitting ITAD");
  const body = await res.json();
  assert.equal(body.pendingCount, 1); // confirms the primed pool actually fed this response

  // ?refresh=1 bypasses the primed pool (and the primed library) and
  // repopulates both from a fresh upstream fetch.
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname.includes("steampowered") && u.pathname.includes("GetOwnedGames")) {
      return jsonResponse({
        response: { games: [ownedGame({ appid: 1, playtime_forever: 600 })] },
      });
    }
    return makeBestOfItadFetch({
      dealsPagesByOffset: { 0: { list: [rawBestOfDeal("itad-fresh", "Fresh pooled deal", 80)], hasMore: false } },
      appIdsById: { "itad-fresh": ["app/901"] },
      onCall: (u2) => {
        if (u2.pathname === "/deals/v2") dealsV2Calls++;
      },
    })(url, options);
  };

  const ctx2 = makeCtx();
  const res2 = await worker.fetch(new Request("https://x/api/best-of?refresh=1"), env, ctx2);
  await ctx2.flush();
  assert.equal(res2.status, 200);
  assert.ok(dealsV2Calls > 0, "refresh=1 should re-hit ITAD");

  const repopulated = cache.store.get("https://steam-sale-scout.cache/api/best-of/pool");
  const repopulatedBody = await repopulated.clone().json();
  assert.deepEqual(repopulatedBody.deals.map((d) => d.title), ["Fresh pooled deal"]);
});
