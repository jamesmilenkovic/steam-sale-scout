// Tests for src/catalog.js (Increment 7.7) — the FPM catalog: SteamSpy bulk
// `all` paging/floor-qualification, D1 CRUD, and the sync pipeline that ties
// them together with src/hltb.js's existing (unmodified) queue/cache.
//
// NEVER makes a real network call. D1 is a real in-memory SQLite database
// (test/helpers/mockD1.mjs, via node:sqlite) — not a hand-rolled mock — so
// the actual SQL (including the upsert's ON CONFLICT ... WHERE clause) is
// exercised for real. HLTB queue pacing/polling is shrunk to 0ms via the
// existing + new test seams.

import test from "node:test";
import assert from "node:assert/strict";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { __setHltbMinIntervalMsForTests, __resetHltbQueueForTests } from "../src/hltb.js";
import {
  CATALOG_PAGE_SIZE,
  FPM_SYNC_BATCH,
  catalogRowFromBulk,
  floorPassesCatalogRow,
  isThrottledBody,
  computeCatalogWaitMs,
  fetchSteamSpyAllPage,
  ensureCatalogSchema,
  upsertCatalogRows,
  markOwned,
  markDeal,
  selectHltbBatch,
  recordHltbResult,
  getCatalogStats,
  selectMatchedCatalogRows,
  crawlAndUpsertCatalog,
  resolveHltbBatch,
  runFpmSyncPipeline,
  startFpmSync,
  isFpmSyncRunning,
  __setCatalogPacingMsForTests,
  __setCatalogBackoffMsForTests,
  __resetCatalogPacingForTests,
  __setHltbPollingForTests,
  __resetHltbPollingForTests,
  __resetFpmSyncStateForTests,
} from "../src/catalog.js";

const originalFetch = globalThis.fetch;

function restoreGlobals() {
  globalThis.fetch = originalFetch;
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
  return { FPM_DB: makeMockD1(), TAG_CACHE: makeMockKv(), ...overrides };
}

/** One raw SteamSpy `all` bulk row. */
function bulkRow(overrides = {}) {
  return {
    appid: 100,
    name: "Game A",
    developer: "Dev",
    publisher: "Pub",
    score_rank: "",
    positive: 9000,
    negative: 1000,
    userscore: 0,
    owners: "1,000,000 .. 2,000,000",
    average_forever: 500,
    average_2weeks: 0,
    median_forever: 400,
    median_2weeks: 0,
    price: "1999",
    initialprice: "1999",
    discount: "0",
    ccu: 100,
    ...overrides,
  };
}

test.beforeEach(() => {
  __setHltbMinIntervalMsForTests(0);
  __resetHltbQueueForTests();
  __setCatalogPacingMsForTests(0);
  __setCatalogBackoffMsForTests(0, 0);
  __setHltbPollingForTests(0, 50);
  __resetFpmSyncStateForTests();
});

test.afterEach(() => {
  restoreGlobals();
  __setHltbMinIntervalMsForTests(1000);
  __resetCatalogPacingForTests();
  __resetHltbPollingForTests();
});

// ---------------------------------------------------------------------------
// Pure: bulk-row shaping + floor qualification + throttle detection.
// ---------------------------------------------------------------------------

test("catalogRowFromBulk shapes owners (range-string), positive/negative, and Wilson quality", () => {
  const row = catalogRowFromBulk(bulkRow());
  assert.equal(row.appid, 100);
  assert.equal(row.name, "Game A");
  assert.equal(row.owners, 1_500_000);
  assert.equal(row.positive, 9000);
  assert.equal(row.negative, 1000);
  assert.ok(row.wilson > 0 && row.wilson < 1);
});

test("catalogRowFromBulk defaults missing/malformed fields rather than throwing", () => {
  const row = catalogRowFromBulk({ appid: 5 });
  assert.equal(row.appid, 5);
  assert.equal(row.name, "");
  assert.equal(row.owners, 0);
  assert.equal(row.positive, 0);
  assert.equal(row.negative, 0);
  assert.equal(row.wilson, 0);
});

test("floorPassesCatalogRow: a row clearing 50 reviews / 0.7 wilson / 5000 owners passes", () => {
  const row = catalogRowFromBulk(bulkRow());
  assert.equal(floorPassesCatalogRow(row), true);
});

test("floorPassesCatalogRow: thin reviews fail regardless of owners/ratio", () => {
  const row = catalogRowFromBulk(bulkRow({ positive: 10, negative: 1, owners: "1,000,000 .. 2,000,000" }));
  assert.equal(floorPassesCatalogRow(row), false);
});

test("floorPassesCatalogRow: low owners fail even with great reviews", () => {
  const row = catalogRowFromBulk(bulkRow({ owners: "0 .. 8,000" })); // midpoint 4000, under FPM_MIN_OWNERS (5000)
  assert.equal(floorPassesCatalogRow(row), false);
});

test("isThrottledBody detects both live-probed throttle message variants", () => {
  assert.equal(isThrottledBody("Connection failed: Too many connections"), true);
  assert.equal(isThrottledBody("some other Connection failed text"), true);
  assert.equal(isThrottledBody("{}"), false);
  assert.equal(isThrottledBody(""), false);
  assert.equal(isThrottledBody(undefined), false);
});

test("computeCatalogWaitMs: 0 on a first call, remaining time otherwise", () => {
  assert.equal(computeCatalogWaitMs(0, 1000, 1500), 0);
  assert.equal(computeCatalogWaitMs(1000, 1200, 1500), 1300);
  assert.equal(computeCatalogWaitMs(1000, 3000, 1500), 0);
});

// ---------------------------------------------------------------------------
// fetchSteamSpyAllPage — network shape detection.
// ---------------------------------------------------------------------------

test("fetchSteamSpyAllPage: a normal page returns status 'ok' with Object.values(body) rows", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ 100: bulkRow(), 200: bulkRow({ appid: 200 }) }), { status: 200 });
  const result = await fetchSteamSpyAllPage(0);
  assert.equal(result.status, "ok");
  assert.equal(result.rows.length, 2);
});

test("fetchSteamSpyAllPage: the live-probed plain-text throttle body is detected even under HTTP 200", async () => {
  globalThis.fetch = async () => new Response("Connection failed: Too many connections", { status: 200 });
  const result = await fetchSteamSpyAllPage(0);
  assert.equal(result.status, "throttled");
  assert.deepEqual(result.rows, []);
});

test("fetchSteamSpyAllPage: a bare HTTP 500 is treated as throttled (backoff-and-retry), not end-of-data", async () => {
  globalThis.fetch = async () => new Response("", { status: 500 });
  const result = await fetchSteamSpyAllPage(0);
  assert.equal(result.status, "throttled");
});

test("fetchSteamSpyAllPage: a network error resolves to 'error' rather than throwing", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const result = await fetchSteamSpyAllPage(0);
  assert.equal(result.status, "error");
});

test("fetchSteamSpyAllPage: unparsable/unexpected-shape JSON resolves to 'error'", async () => {
  globalThis.fetch = async () => new Response("not json at all {", { status: 200 });
  const result1 = await fetchSteamSpyAllPage(0);
  assert.equal(result1.status, "error");

  globalThis.fetch = async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 });
  const result2 = await fetchSteamSpyAllPage(0);
  assert.equal(result2.status, "error");
});

// ---------------------------------------------------------------------------
// D1 CRUD.
// ---------------------------------------------------------------------------

test("ensureCatalogSchema is idempotent (safe to call repeatedly)", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await ensureCatalogSchema(env);
  const stats = await getCatalogStats(env);
  assert.deepEqual(stats, { total: 0, matched: 0, unmatched: 0, pending: 0 });
});

test("upsertCatalogRows: a brand-new appid inserts with main_hours/match_method NULL and source_catalog=1", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow())], 1000);

  const rows = await selectMatchedCatalogRows(env);
  assert.equal(rows.length, 0, "not matched yet — main_hours is still NULL");

  const stats = await getCatalogStats(env);
  assert.equal(stats.total, 1);
  assert.equal(stats.matched, 0);
});

test("upsertCatalogRows idempotence: re-upserting an already-matched appid never resets main_hours/match_method", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 100 }))], 1000);
  await recordHltbResult(env, 100, { mainHours: 6.5, matchMethod: "name", checkedAtMs: 2000 });

  // A later sync re-crawls and re-upserts the same appid (fresh stats) —
  // main_hours/match_method must survive untouched.
  const farFuture = 1000 + 8 * 24 * 60 * 60 * 1000; // past the 7-day spy TTL, so stats DO refresh
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 100, positive: 99999 }))], farFuture);

  const rows = await selectMatchedCatalogRows(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].main_hours, 6.5);
  assert.equal(rows[0].match_method, "name");
  assert.equal(rows[0].positive, 99999, "stats themselves DO refresh once stale");
});

test("upsertCatalogRows staleness gate: re-upserting within FPM_SPY_TTL_DAYS leaves stats untouched", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 100, positive: 100 }))], 1000);

  const oneHourLater = 1000 + 60 * 60 * 1000;
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 100, positive: 555555 }))], oneHourLater);

  const stats = await getCatalogStats(env);
  assert.equal(stats.total, 1, "still one row, not a duplicate");
  // Read the raw row back via the D1 mock to check positive wasn't touched.
  const row = await env.FPM_DB.prepare("SELECT positive FROM fpm_catalog WHERE appid = ?").bind(100).first();
  assert.equal(row.positive, 100, "a fresh (within-TTL) row's stats must not be overwritten");
});

test("markOwned/markDeal only touch appids already in the catalog, and never clear once set", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 100 }))], 1000);

  await markOwned(env, [100, 999]); // 999 was never a floor-passer — no-op, no error
  await markDeal(env, [100]);

  const row = await env.FPM_DB.prepare("SELECT source_owned, source_deal FROM fpm_catalog WHERE appid = ?").bind(100).first();
  assert.equal(row.source_owned, 1);
  assert.equal(row.source_deal, 1);

  // Re-upserting (a later crawl re-seeing the same appid) must not clear
  // these flags — the UPSERT_SQL's SET list never touches them.
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 100 }))], 1000 + 8 * 24 * 60 * 60 * 1000);
  const row2 = await env.FPM_DB.prepare("SELECT source_owned, source_deal FROM fpm_catalog WHERE appid = ?").bind(100).first();
  assert.equal(row2.source_owned, 1);
  assert.equal(row2.source_deal, 1);
});

test("selectHltbBatch priority order: owned-or-deal first, then owners desc, then reviews desc", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [
      catalogRowFromBulk(bulkRow({ appid: 1, owners: "5,000 .. 20,000", positive: 100, negative: 0 })), // low owners, not owned/deal
      catalogRowFromBulk(bulkRow({ appid: 2, owners: "1,000,000 .. 2,000,000", positive: 100, negative: 0 })), // high owners, not owned/deal
      catalogRowFromBulk(bulkRow({ appid: 3, owners: "5,000 .. 20,000", positive: 100, negative: 0 })), // low owners, but OWNED
    ],
    1000,
  );
  await markOwned(env, [3]);

  const batch = await selectHltbBatch(env, { limit: 10, staleCutoffMs: 2000 });
  assert.deepEqual(
    batch.map((r) => r.appid),
    [3, 2, 1],
    "owned appid 3 first despite low owners, then appid 2 (higher owners) before appid 1",
  );
});

test("selectHltbBatch: a matched row (main_hours set) is never selected, regardless of age", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await recordHltbResult(env, 1, { mainHours: 6.5, matchMethod: "name", checkedAtMs: 1000 });

  const farFutureCutoff = 1000 + 1000 * 24 * 60 * 60 * 1000; // absurdly generous "staleness" window
  const batch = await selectHltbBatch(env, { limit: 10, staleCutoffMs: farFutureCutoff });
  assert.deepEqual(batch, [], "a matched row must never be reselected, no matter the staleness cutoff");
});

test("selectHltbBatch: an unmatched row is retried once hltb_checked_at is older than the cutoff, not before", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await recordHltbResult(env, 1, { mainHours: null, matchMethod: "none", checkedAtMs: 5000 });

  const notYetStale = await selectHltbBatch(env, { limit: 10, staleCutoffMs: 4000 }); // cutoff before the check -> not stale yet
  assert.deepEqual(notYetStale, []);

  const nowStale = await selectHltbBatch(env, { limit: 10, staleCutoffMs: 6000 }); // cutoff after the check -> stale
  assert.deepEqual(nowStale.map((r) => r.appid), [1]);
});

test("selectHltbBatch respects limit", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [1, 2, 3].map((appid) => catalogRowFromBulk(bulkRow({ appid }))),
    1000,
  );
  const batch = await selectHltbBatch(env, { limit: 2, staleCutoffMs: 2000 });
  assert.equal(batch.length, 2);
});

test("FPM_SYNC_BATCH (3000) bounds per-run HLTB enqueues; a second run picks up exactly the remainder", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);

  // Seed FPM_SYNC_BATCH + 10 floor-passing rows, owners strictly
  // descending by appid so priority order (no owned/deal flags here) is
  // deterministic: appid 20000..22999 is the expected first-3000 batch,
  // appid 23000..23009 is the expected remainder.
  const totalRows = FPM_SYNC_BATCH + 10;
  const rows = [];
  for (let i = 0; i < totalRows; i++) {
    rows.push(
      catalogRowFromBulk(
        bulkRow({ appid: 20000 + i, name: `Game ${i}`, owners: `${5_000_000 - i} .. ${5_000_000 - i}` }),
      ),
    );
  }
  await upsertCatalogRows(env, rows, 1000);

  // Pre-warm KV for exactly the expected first-3000 batch — resolveHltbBatch
  // resolves these instantly from cache with zero HLTB network traffic,
  // keeping this test fast regardless of FPM_SYNC_BATCH's size. The
  // remaining 10 are deliberately left uncached.
  for (let i = 0; i < FPM_SYNC_BATCH; i++) {
    const appid = 20000 + i;
    env.TAG_CACHE.store.set(
      `hltb:${appid}`,
      JSON.stringify({ hltbId: appid, compMain: 3600, compPlus: 3600, comp100: 3600, matchMethod: "name" }),
    );
  }

  let searchCalls = 0;
  const searchedTitles = new Set();
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") return new Response(JSON.stringify({}), { status: 200 }); // empty page -> immediate end of crawl, no new rows
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") {
      searchCalls++;
      const body = JSON.parse(options.body);
      const query = body.searchTerms.join(" ");
      searchedTitles.add(query);
      const idx = Number(query.replace("Game ", ""));
      return jsonResponse({ count: 1, data: [{ game_id: idx, game_name: query, comp_main: 3600 }] });
    }
    throw new Error(`unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const deps = { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] };
  await runFpmSyncPipeline(env, ctx, deps);

  const statsAfterFirst = await getCatalogStats(env);
  assert.equal(statsAfterFirst.matched, FPM_SYNC_BATCH, "exactly FPM_SYNC_BATCH rows matched in one run (all from the pre-warmed cache)");
  assert.equal(statsAfterFirst.pending, 10, "the beyond-cap remainder is untouched");
  assert.equal(searchCalls, 0, "the beyond-cap remainder must never even be enqueued/searched in this run");
  for (let i = 0; i < 10; i++) {
    assert.ok(!searchedTitles.has(`Game ${FPM_SYNC_BATCH + i}`), "a beyond-cap title must not be queried");
  }

  // Second run: now the remaining 10 CAN be resolved for real (uncached) —
  // resumability + the exact bound together: only the remainder is queried.
  await runFpmSyncPipeline(env, ctx, deps);

  const statsAfterSecond = await getCatalogStats(env);
  assert.equal(statsAfterSecond.matched, totalRows, "second run picks up exactly the remaining 10");
  assert.equal(searchCalls, 10, "second run enqueues only the remainder, not the whole 3010 again");
});

test("getCatalogStats: total/matched/unmatched/pending are computed correctly across a mixed catalog", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [1, 2, 3, 4].map((appid) => catalogRowFromBulk(bulkRow({ appid }))),
    1000,
  );
  await recordHltbResult(env, 1, { mainHours: 6.5, matchMethod: "name", checkedAtMs: 2000 }); // matched
  await recordHltbResult(env, 2, { mainHours: null, matchMethod: "none", checkedAtMs: 2000 }); // unmatched
  // appid 3, 4: never checked

  const stats = await getCatalogStats(env);
  assert.deepEqual(stats, { total: 4, matched: 1, unmatched: 1, pending: 3 });
});

test("selectMatchedCatalogRows returns only main_hours-NOT-NULL rows, carrying stored wilson/owners", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1, positive: 9000, negative: 1000 }))], 1000);
  await recordHltbResult(env, 1, { mainHours: 6.5, matchMethod: "name", checkedAtMs: 2000 });

  const rows = await selectMatchedCatalogRows(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].appid, 1);
  assert.equal(rows[0].main_hours, 6.5);
  assert.ok(rows[0].wilson > 0);
  assert.equal(rows[0].owners, 1_500_000);
});

// ---------------------------------------------------------------------------
// crawlAndUpsertCatalog — multi-page crawl, end signals, backoff/retry.
// ---------------------------------------------------------------------------

test("crawlAndUpsertCatalog stops at a partial (< page-size) page and upserts every floor-passer seen", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);

  const page0 = {};
  for (let i = 0; i < CATALOG_PAGE_SIZE; i++) page0[i] = bulkRow({ appid: i, positive: 9000, negative: 1000 });
  const page1Rows = { 9000: bulkRow({ appid: 9000, positive: 9000, negative: 1000 }) }; // partial page (1 row)

  let calls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const page = u.searchParams.get("page");
    calls++;
    if (page === "0") return new Response(JSON.stringify(page0), { status: 200 });
    if (page === "1") return new Response(JSON.stringify(page1Rows), { status: 200 });
    throw new Error(`unexpected page requested: ${page}`);
  };

  const result = await crawlAndUpsertCatalog(env);
  assert.equal(result.pagesCrawled, 2);
  assert.equal(result.totalPassers, CATALOG_PAGE_SIZE + 1);
  assert.equal(calls, 2, "must stop after the partial page, never request page 2");

  const stats = await getCatalogStats(env);
  assert.equal(stats.total, CATALOG_PAGE_SIZE + 1);
});

/** A full (CATALOG_PAGE_SIZE-row) page with exactly one floor-passer (appid
 * `passerAppid`) and the rest filler rows that fail the floor — so the page
 * itself is "full" (doesn't trip the partial-page end signal) while still
 * being distinguishable from a genuine zero-passer full page. */
function fullPageWithOnePasser(passerAppid) {
  const page = { [passerAppid]: bulkRow({ appid: passerAppid, positive: 9000, negative: 1000 }) };
  for (let i = 0; i < CATALOG_PAGE_SIZE - 1; i++) {
    const appid = 500_000 + i;
    page[appid] = bulkRow({ appid, positive: 1, negative: 1 }); // fails floor — filler only
  }
  return page;
}

test("crawlAndUpsertCatalog stops when a full page yields zero floor-passers", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);

  const passingFullPage = fullPageWithOnePasser(1);
  const zeroPasserFullPage = {};
  for (let i = 0; i < CATALOG_PAGE_SIZE; i++) {
    zeroPasserFullPage[i + 1000] = bulkRow({ appid: i + 1000, positive: 1, negative: 1 }); // fails floor
  }

  let calls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const page = u.searchParams.get("page");
    calls++;
    if (page === "0") return new Response(JSON.stringify(passingFullPage), { status: 200 });
    if (page === "1") return new Response(JSON.stringify(zeroPasserFullPage), { status: 200 });
    throw new Error(`unexpected page requested: ${page}`);
  };

  const result = await crawlAndUpsertCatalog(env);
  assert.equal(result.pagesCrawled, 2);
  assert.equal(result.totalPassers, 1);
  assert.equal(calls, 2);
});

test("crawlAndUpsertCatalog backs off and retries the SAME page on a throttle, then continues once it clears", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);

  const page0 = fullPageWithOnePasser(1);
  let page0Attempts = 0;

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const page = u.searchParams.get("page");
    if (page === "0") {
      page0Attempts++;
      if (page0Attempts < 3) {
        return new Response("Connection failed: Too many connections", { status: 200 });
      }
      return new Response(JSON.stringify(page0), { status: 200 });
    }
    // page 1: partial page -> end of crawl
    return new Response(JSON.stringify({ 2: bulkRow({ appid: 2, positive: 9000, negative: 1000 }) }), { status: 200 });
  };

  const result = await crawlAndUpsertCatalog(env);
  assert.equal(page0Attempts, 3, "page 0 must be retried until it succeeds, never skipped");
  assert.equal(result.pagesCrawled, 2);
  assert.equal(result.totalPassers, 2);
});

test("crawlAndUpsertCatalog gives up after CATALOG_MAX_CONSECUTIVE_BAD_PAGES throttles in a row, without hanging forever", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  globalThis.fetch = async () => new Response("Connection failed: Too many connections", { status: 200 });

  const result = await crawlAndUpsertCatalog(env);
  assert.equal(result.pagesCrawled, 0);
  assert.equal(result.totalPassers, 0);
});

// ---------------------------------------------------------------------------
// resolveHltbBatch — cache hits, queue resolution + D1 writeback, fail-soft.
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeHltbFetch({ searchResultsByQuery = {} } = {}) {
  return async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed/init") {
      return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    }
    if (u.hostname === "howlongtobeat.com" && u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      const query = body.searchTerms.join(" ");
      const entries = searchResultsByQuery[query] ?? [];
      return jsonResponse({ count: entries.length, data: entries });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
}

function rawHltbEntry(overrides = {}) {
  return {
    game_id: 1,
    game_name: "Portal 2",
    game_alias: "",
    comp_main: 23400, // 6.5h
    comp_plus: 40000,
    comp_100: 50000,
    ...overrides,
  };
}

test("resolveHltbBatch: a pre-warmed KV cache hit resolves instantly with zero HLTB network traffic", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 200, name: "Portal 2" }))], 1000);
  env.TAG_CACHE.store.set(
    "hltb:200",
    JSON.stringify({ hltbId: 1, compMain: 23400, compPlus: 40000, comp100: 50000, matchMethod: "name" }),
  );

  let hltbCalls = 0;
  globalThis.fetch = async () => {
    hltbCalls++;
    throw new Error("must not be called on a warm cache");
  };

  const ctx = makeCtx();
  const result = await resolveHltbBatch(env, ctx, [{ appid: 200, name: "Portal 2" }]);
  assert.equal(result.cacheHits, 1);
  assert.equal(hltbCalls, 0);

  const rows = await selectMatchedCatalogRows(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].main_hours, 6.5);
});

test("resolveHltbBatch: a cold item is enqueued, resolved via the real HLTB queue, and written through to D1", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 200, name: "Portal 2" }))], 1000);

  globalThis.fetch = makeHltbFetch({ searchResultsByQuery: { "Portal 2": [rawHltbEntry()] } });

  const ctx = makeCtx();
  const result = await resolveHltbBatch(env, ctx, [{ appid: 200, name: "Portal 2" }]);
  assert.equal(result.resolved, 1);
  assert.equal(result.gaveUp, 0);

  const rows = await selectMatchedCatalogRows(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].main_hours, 6.5);
  assert.equal(rows[0].match_method, "name");
});

test("resolveHltbBatch: a search with no match writes match_method='none', main_hours NULL — never re-selected until stale", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 200, name: "Some Obscure Game" }))], 1000);

  globalThis.fetch = makeHltbFetch({ searchResultsByQuery: {} });

  const ctx = makeCtx();
  await resolveHltbBatch(env, ctx, [{ appid: 200, name: "Some Obscure Game" }]);

  const stats = await getCatalogStats(env);
  assert.equal(stats.matched, 0);
  assert.equal(stats.unmatched, 1);
});

test("resolveHltbBatch: hltbInit() failure leaves every item pending (fail-soft, never throws)", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 200, name: "Portal 2" }))], 1000);

  globalThis.fetch = async () => {
    throw new Error("HLTB is down");
  };

  const ctx = makeCtx();
  const result = await resolveHltbBatch(env, ctx, [{ appid: 200, name: "Portal 2" }]);
  assert.equal(result.gaveUp, 1);

  const stats = await getCatalogStats(env);
  assert.equal(stats.total, 1);
  assert.equal(stats.matched, 0);
  assert.equal(stats.unmatched, 0, "never checked at all -- not the same as a negative result");
});

// ---------------------------------------------------------------------------
// runFpmSyncPipeline / startFpmSync — the whole thing wired together.
// ---------------------------------------------------------------------------

test("runFpmSyncPipeline: crawl -> union owned/deal -> priority HLTB batch, end to end", async () => {
  const env = makeEnv();

  const page0 = {
    1: bulkRow({ appid: 1, name: "Owned Game", owners: "5,000 .. 20,000", positive: 100, negative: 0 }),
    2: bulkRow({ appid: 2, name: "Deal Game", owners: "1,000,000 .. 2,000,000", positive: 100, negative: 0 }),
  };
  const hltbFetch = makeHltbFetch({
    searchResultsByQuery: {
      "Owned Game": [rawHltbEntry({ game_name: "Owned Game", comp_main: 18000 })],
      "Deal Game": [rawHltbEntry({ game_name: "Deal Game", comp_main: 7200 })],
    },
  });
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") {
      const page = u.searchParams.get("page");
      if (page === "0") return new Response(JSON.stringify(page0), { status: 200 }); // partial page -> end of crawl
    }
    return hltbFetch(url, options);
  };

  const ctx = makeCtx();
  await runFpmSyncPipeline(env, ctx, {
    loadOwnedAppIds: async () => new Set([1]),
    loadDealAppIds: async () => [2],
  });

  const stats = await getCatalogStats(env);
  assert.equal(stats.total, 2);
  assert.equal(stats.matched, 2);

  const ownedRow = await env.FPM_DB.prepare("SELECT source_owned, source_deal FROM fpm_catalog WHERE appid=1").first();
  assert.equal(ownedRow.source_owned, 1);
  assert.equal(ownedRow.source_deal, 0);
  const dealRow = await env.FPM_DB.prepare("SELECT source_owned, source_deal FROM fpm_catalog WHERE appid=2").first();
  assert.equal(dealRow.source_deal, 1);
});

test("startFpmSync: a second call while a sync is running reports alreadyRunning, doesn't start a duplicate", async () => {
  const env = makeEnv();
  let resolveFirstFetch;
  const blocker = new Promise((r) => {
    resolveFirstFetch = r;
  });
  globalThis.fetch = async () => {
    await blocker;
    return new Response(JSON.stringify({}), { status: 200 }); // empty page -> immediate end of crawl
  };

  const ctx = makeCtx();
  const first = startFpmSync(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });
  assert.deepEqual(first, { started: true });
  assert.equal(isFpmSyncRunning(), true);

  const second = startFpmSync(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });
  assert.deepEqual(second, { started: false, alreadyRunning: true });

  resolveFirstFetch();
  await ctx.flush();
  assert.equal(isFpmSyncRunning(), false);
});

test("runFpmSyncPipeline is resumable: a second run only enqueues rows the first run left NULL", async () => {
  const env = makeEnv();
  const page0 = { 1: bulkRow({ appid: 1, name: "Game One" }), 2: bulkRow({ appid: 2, name: "Game Two" }) };

  const queriesSeen = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") {
      return new Response(JSON.stringify(page0), { status: 200 }); // partial page -> end of crawl every time
    }
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      queriesSeen.push(body.searchTerms.join(" "));
      if (body.searchTerms.join(" ") === "Game One") {
        return jsonResponse({ count: 1, data: [rawHltbEntry({ game_name: "Game One", comp_main: 3600 })] });
      }
      return jsonResponse({ count: 0, data: [] }); // "Game Two" never matches
    }
    throw new Error(`unexpected: ${url}`);
  };

  const ctx = makeCtx();
  const deps = { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] };
  await runFpmSyncPipeline(env, ctx, deps);
  assert.deepEqual(queriesSeen.sort(), ["Game One", "Game Two"]);

  queriesSeen.length = 0;
  await runFpmSyncPipeline(env, ctx, deps);
  assert.deepEqual(queriesSeen, [], "Game One is matched (never re-enqueued); Game Two was just checked (not yet stale)");
});
