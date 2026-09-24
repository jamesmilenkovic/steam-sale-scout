// QA TC-3 (increment 14) – src/worker.js's surviving `fetchBestOfPages`.
//
// WHY THIS FILE EXISTS. `fetchBestOfPages` is the one helper SPEC.md §2 argues
// hardest to keep: `buildFpmPool` calls it, `loadFpmPool` calls `buildFpmPool`,
// and both `handleRank` and `fpmSyncDeps` call `loadFpmPool`. Its only test
// went with test/worker-hof.test.mjs when `/api/best-of` was deleted, and after
// that, changing its ITAD sort order failed exactly 0 tests.
//
// WHAT IT IS ABOUT. The sort axis is not a detail – it is the increment 5.5
// bug fix in a single query parameter. Sourcing on `-cut` (the /api/deals axis)
// saturates the first 1,000 results at 92-95% off during a sale, which is pure
// shovelware, and the pool ends up containing no famous game on a real-but-
// shallower discount. `sort=rank` sources by popularity instead. And because
// rank order is NOT cut-sorted, a shallow discount partway down a page says
// nothing about the items after it – so unlike `fetchDealsPages`, this pager
// must NEVER stop early on a low cut. Both halves are asserted below.
//
// HOW IT REACHES THE CODE. `fetchBestOfPages` is module-private and the only
// way in now is a live pool build. Every existing sync test PRE-SEEDS the FPM
// pool cache, which is exactly what keeps this dark; this file leaves that
// cache COLD and drives POST /api/fpm/sync, so `loadFpmPool -> buildFpmPool ->
// fetchBestOfPages` really runs and the outgoing ITAD URLs can be captured.
//
// NEVER makes a real network call. Every upstream the sync pipeline touches
// (ITAD, SteamSpy's crawl and its appdetails, the Steam storefront, HLTB) is
// answered by the router-style stub below, and the offline guard catches
// anything that is not.

import test from "node:test";
import assert from "node:assert/strict";
import realWorker from "../src/worker.js";
import { signedWorker, TEST_STEAM_ID } from "./helpers/session.mjs";

// EVERY CALL IN THIS FILE GOES THROUGH THE DEFAULT-DENY GATE (SPEC.md §7), with
// a GENUINELY SIGNED session cookie and the matching secret on the env. Nothing
// is stubbed and the verifier is not bypassed: without this line every
// `worker.fetch` below would answer 401. See test/helpers/session.mjs.
const worker = signedWorker(realWorker);
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";
import { SPY_EMPTY_UNKNOWN_APPID } from "./fixtures/spy-appdetails.mjs";
import {
  BESTOF_SORT,
  BESTOF_PAGE_LIMIT,
  BESTOF_FETCH_CAP,
  BESTOF_MAX_PAGES,
} from "../src/deals.js";
import { __setSpyMinIntervalMsForTests, __resetSpyQueueForTests } from "../src/spyQueue.js";
import { __setHltbMinIntervalMsForTests, __resetHltbQueueForTests } from "../src/hltb.js";
import {
  __setCatalogPacingMsForTests,
  __setCatalogBackoffMsForTests,
  __resetCatalogPacingForTests,
  __setTypePacingMsForTests,
  __setTypeBackoffMsForTests,
  __resetTypePacingForTests,
  __setPricePacingMsForTests,
  __setPriceBackoffMsForTests,
  __resetPricePacingForTests,
  __setTagsPacingMsForTests,
  __setTagsBackoffMsForTests,
  __resetTagsPacingForTests,
  __setHltbPollingForTests,
  __resetHltbPollingForTests,
  __resetFpmSyncStateForTests,
  __resetLastSyncStatsForTests,
} from "../src/catalog.js";

const originalCaches = globalThis.caches;
let offlineGuard = makeOfflineFetchGuard("worker-bestof-sourcing");

function restoreGlobals() {
  globalThis.fetch = makeOfflineFetchGuard("worker-bestof-sourcing (between tests)");
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
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

function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(p);
    },
    async flush() {
      let rounds = 0;
      while (pending.length > 0 && rounds < 40) {
        await Promise.all(pending.splice(0, pending.length));
        rounds++;
      }
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Increment 15, SPEC.md §11.1: the library cache key carries the SESSION'S id
// now, so the fixture primed below has to be primed under that id or
// getOwnedAppIds misses it and reaches Steam. `OWNER_STEAM_ID` is the separate
// deploy-time constant (SPEC.md §11.4/§11.6) and is left on the env for
// realism; nothing in this file's path reads it.
const SESSION_STEAM_ID = TEST_STEAM_ID;
const OWNER_STEAM_ID = "76561198000000000";

function makeEnv(overrides = {}) {
  return {
    STEAM_API_KEY: "test-steam-key",
    OWNER_STEAM_ID,
    ITAD_API_KEY: "test-itad-key",
    TAG_CACHE: makeMockKv(),
    FPM_DB: makeMockD1(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

/** Pre-seed the owned library so `getOwnedAppIds` (called at the end of
 * buildFpmPool) never reaches Steam. The FPM POOL cache is deliberately left
 * cold – that is the whole point of this file. */
function primeLibrary(cache, games) {
  cache.store.set(
    `https://steam-sale-scout.cache/api/library?steamid=${SESSION_STEAM_ID}&v=2`,
    jsonResponse({ games }),
  );
}

/** One RAW ITAD /deals/v2 list item, pre-normalisation. */
function rawDeal(id, title, cut) {
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

/** A full page of `BESTOF_PAGE_LIMIT` deals at the given offset, all at the
 * same cut unless `cuts` overrides specific indices. */
function fullPage(offset, { hasMore = true, cuts = {} } = {}) {
  return {
    list: Array.from({ length: BESTOF_PAGE_LIMIT }, (_, i) =>
      rawDeal(`itad-${offset + i}`, `Deal ${offset + i}`, cuts[i] ?? 50),
    ),
    hasMore,
  };
}

/**
 * Router-style fetch stub covering every upstream one POST /api/fpm/sync run
 * touches with a COLD pool cache.
 *
 * @param {object} opts
 * @param {(offset:number) => object} opts.dealsPage page body for an offset
 * @param {(url:URL, options:object) => void} [opts.onCall] observer
 */
function makeSyncFetch({ dealsPage, onCall }) {
  return async (input, options = {}) => {
    const u = new URL(String(input));
    onCall?.(u, options);

    // ---- ITAD -------------------------------------------------------------
    if (u.hostname === "api.isthereanydeal.com") {
      if (u.pathname === "/deals/v2") {
        return jsonResponse(dealsPage(Number(u.searchParams.get("offset") || "0")));
      }
      if (u.pathname === "/lookup/shop/61/id/v1") {
        const ids = JSON.parse(options.body);
        const body = {};
        // Every ITAD id maps to a distinct Steam appid, so nothing is dropped
        // for being unresolvable and the pool's size reflects the paging.
        for (const id of ids) body[id] = [`app/${900000 + Number(id.split("-")[1])}`];
        return jsonResponse(body);
      }
      if (u.pathname === "/games/historylow/v1") {
        return jsonResponse([]); // no historical lows; irrelevant to the sort axis
      }
    }

    // ---- SteamSpy: the catalogue crawl, and the increment-9 tag backfill ---
    if (u.hostname === "steamspy.com") {
      if (u.searchParams.get("request") === "appdetails") {
        return jsonResponse({ ...SPY_EMPTY_UNKNOWN_APPID, appid: Number(u.searchParams.get("appid")) });
      }
      return jsonResponse({}); // an empty crawl page ends the crawl immediately
    }

    // ---- Steam storefront classification, and HLTB ------------------------
    if (u.hostname === "store.steampowered.com" && u.pathname === "/api/appdetails") {
      const appid = u.searchParams.get("appids");
      return jsonResponse({ [appid]: { success: true, data: { type: "game", name: "x" } } });
    }
    if (u.hostname === "howlongtobeat.com") {
      throw new Error("HLTB down – fail-soft, and irrelevant to the ITAD sort axis");
    }

    throw new Error(`Unexpected fetch URL in test: ${u.toString()}`);
  };
}

/** Run one sync with a cold FPM pool and return every /deals/v2 URL it made. */
async function captureDealsUrls(env, cache, dealsPage) {
  const dealsUrls = [];
  globalThis.fetch = makeSyncFetch({
    dealsPage,
    onCall: (u) => {
      if (u.hostname === "api.isthereanydeal.com" && u.pathname === "/deals/v2") dealsUrls.push(u);
    },
  });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x.test/api/fpm/sync", { method: "POST" }), env, ctx);
  await ctx.flush();
  return { res, dealsUrls };
}

test.beforeEach(() => {
  offlineGuard = makeOfflineFetchGuard("worker-bestof-sourcing");
  globalThis.fetch = offlineGuard;
  __setSpyMinIntervalMsForTests(0);
  __resetSpyQueueForTests();
  __setHltbMinIntervalMsForTests(0);
  __resetHltbQueueForTests();
  __setCatalogPacingMsForTests(0);
  __setCatalogBackoffMsForTests(0, 0);
  __setTypePacingMsForTests(0);
  __setTypeBackoffMsForTests(0, 0);
  __setPricePacingMsForTests(0);
  __setPriceBackoffMsForTests(0, 0);
  __setTagsPacingMsForTests(0);
  __setTagsBackoffMsForTests(0, 0);
  __setHltbPollingForTests(0, 50);
  __resetFpmSyncStateForTests();
  __resetLastSyncStatsForTests();
});

test.afterEach(() => {
  const calls = [...offlineGuard.calls];
  restoreGlobals();
  __setSpyMinIntervalMsForTests(1000);
  __setHltbMinIntervalMsForTests(1000);
  __resetCatalogPacingForTests();
  __resetTypePacingForTests();
  __resetPricePacingForTests();
  __resetTagsPacingForTests();
  __resetHltbPollingForTests();
  assert.deepEqual(calls, [], "no test in this file may reach the network");
});

// ---------------------------------------------------------------------------
// The sort axis.
// ---------------------------------------------------------------------------

test("TC-3: a cold-pool sync sources ITAD /deals/v2 on sort=rank, never the Deals -cut axis", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  const { res, dealsUrls } = await captureDealsUrls(env, cache, (offset) =>
    offset === 0
      ? { list: [rawDeal("itad-1", "Portal 2", 75), rawDeal("itad-2", "Hades", 20)], hasMore: false }
      : { list: [], hasMore: false },
  );

  assert.equal(res.status, 200);
  assert.ok(dealsUrls.length > 0, "the pool build never called /deals/v2 – the cache was not cold");

  for (const u of dealsUrls) {
    assert.equal(
      u.searchParams.get("sort"),
      "rank",
      `sourced on sort=${u.searchParams.get("sort")} – -cut saturates at 92-95% off during a sale (increment 5.5)`,
    );
    assert.notEqual(u.searchParams.get("sort"), "-cut");
  }
  // And the constant the code reads is still the one this test names.
  assert.equal(BESTOF_SORT, "rank");
});

test("TC-3: every /deals/v2 call carries the Steam shop, the AU country and the page limit", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  const { dealsUrls } = await captureDealsUrls(env, cache, () => ({ list: [], hasMore: false }));

  assert.equal(dealsUrls.length, 1);
  const u = dealsUrls[0];
  assert.equal(u.searchParams.get("key"), "test-itad-key");
  assert.equal(u.searchParams.get("shops"), "61"); // Steam
  assert.equal(u.searchParams.get("country"), "AU");
  assert.equal(u.searchParams.get("limit"), String(BESTOF_PAGE_LIMIT));
  assert.equal(u.searchParams.get("offset"), "0");
});

// ---------------------------------------------------------------------------
// Pagination – continues past a full page, and does NOT stop on a low cut.
// ---------------------------------------------------------------------------

test("TC-3: pagination continues past a full page, stepping the offset by the page limit", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  // Three full pages, then a short one that ends the walk.
  const { dealsUrls } = await captureDealsUrls(env, cache, (offset) => {
    if (offset < BESTOF_PAGE_LIMIT * 3) return fullPage(offset);
    return { list: [rawDeal(`itad-${offset}`, `Tail ${offset}`, 50)], hasMore: false };
  });

  assert.equal(
    dealsUrls.length,
    4,
    `expected 4 pages (3 full + 1 short), got ${dealsUrls.length} – a pager that stops after page 1 sees only the 200 most popular deals`,
  );
  assert.deepEqual(
    dealsUrls.map((u) => Number(u.searchParams.get("offset"))),
    [0, BESTOF_PAGE_LIMIT, BESTOF_PAGE_LIMIT * 2, BESTOF_PAGE_LIMIT * 3],
  );
  for (const u of dealsUrls) assert.equal(u.searchParams.get("sort"), "rank");
});

test("TC-3: a SHORT page ends the walk – no extra request is made past the end of the feed", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  const { dealsUrls } = await captureDealsUrls(env, cache, (offset) => {
    if (offset === 0) return fullPage(0);
    // A page shorter than the limit means the feed is exhausted, even though
    // hasMore is (wrongly) still true – a server that lies about hasMore must
    // not make this pager spin.
    return { list: [rawDeal("itad-8888", "Tail", 50)], hasMore: true };
  });

  assert.equal(dealsUrls.length, 2);
});

test("TC-3: hasMore:false ends the walk even on a FULL page", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  const { dealsUrls } = await captureDealsUrls(env, cache, (offset) =>
    fullPage(offset, { hasMore: offset === 0 ? false : true }),
  );

  assert.equal(dealsUrls.length, 1);
});

test("TC-3: a LOW-CUT item partway down a full page does NOT halt pagination – the /api/deals early stop must not exist here", async () => {
  // This is the increment 5.5 fix expressed as a test. `fetchDealsPages`
  // deliberately stops early on a low cut because that feed IS cut-sorted;
  // rank order is not, so the same shortcut here would truncate the pool at
  // whatever popular-but-shallow discount happened to appear first.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  const { dealsUrls } = await captureDealsUrls(env, cache, (offset) => {
    if (offset === 0) {
      // A 0% cut in position 1 of a full page: the worst case for any
      // cut-based early stop.
      return fullPage(0, { hasMore: true, cuts: { 1: 0, 2: 0, 3: 5 } });
    }
    return { list: [rawDeal(`itad-${offset}`, `Page 2 qualifier`, 80)], hasMore: false };
  });

  assert.equal(
    dealsUrls.length,
    2,
    "pagination stopped on a low-cut item – that is the saturation bug increment 5.5 fixed",
  );
});

test("TC-3: an endless feed is stopped by the fetch cap, not by a cut, and never exceeds it", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  // Every offset answers a full page with hasMore:true – an apparently endless
  // feed. Only BESTOF_FETCH_CAP / BESTOF_MAX_PAGES may stop it.
  const { dealsUrls } = await captureDealsUrls(env, cache, (offset) => fullPage(offset));

  const expectedPages = Math.min(BESTOF_FETCH_CAP / BESTOF_PAGE_LIMIT, BESTOF_MAX_PAGES);
  assert.equal(dealsUrls.length, expectedPages, `expected ${expectedPages} pages before the cap`);
  const maxOffset = Math.max(...dealsUrls.map((u) => Number(u.searchParams.get("offset"))));
  assert.ok(maxOffset < BESTOF_FETCH_CAP, `offset ${maxOffset} ran past BESTOF_FETCH_CAP`);
  for (const u of dealsUrls) assert.equal(u.searchParams.get("sort"), "rank");
});

// ---------------------------------------------------------------------------
// The pages actually become the pool the sync consumes.
// ---------------------------------------------------------------------------

test("TC-3: the paged results reach the FPM pool cache, so the sourcing is not paged into a void", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);

  await captureDealsUrls(env, cache, (offset) => {
    if (offset === 0) return fullPage(0);
    return { list: [rawDeal("itad-9999", "Page 2 Game", 80)], hasMore: false };
  });

  const pooled = cache.store.get("https://steam-sale-scout.cache/api/fpm/pool");
  assert.ok(pooled, "buildFpmPool never wrote its pool – nothing downstream of the pager ran");
  const body = JSON.parse(await pooled.clone().text());
  assert.equal(body.deals.length, BESTOF_PAGE_LIMIT + 1, "the second page's item did not reach the pool");
  assert.ok(
    body.deals.some((d) => d.title === "Page 2 Game"),
    "the page-2 item is missing from the pool, so pagination fed nothing",
  );
  // No BESTOF_MIN_CUT floor on THIS pool – that omission is why it exists
  // separately from the old Best-of pool.
  assert.ok(body.deals.every((d) => d.appid != null), "appid resolution did not run over the paged results");
});

test("TC-3: a warm FPM pool cache short-circuits the pager entirely – /deals/v2 is not called at all", async () => {
  // The control for every test above: they only prove anything because the
  // pool cache was cold. This is what says so.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, []);
  cache.store.set(
    "https://steam-sale-scout.cache/api/fpm/pool",
    jsonResponse({ deals: [{ itadId: "itad-warm", appid: 1, title: "Warm", cut: 50 }] }),
  );

  const { dealsUrls } = await captureDealsUrls(env, cache, () => ({ list: [], hasMore: false }));
  assert.deepEqual(dealsUrls, []);
});
