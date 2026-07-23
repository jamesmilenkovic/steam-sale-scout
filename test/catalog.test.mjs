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
  FPM_TYPE_BATCH,
  FPM_TYPE_TTL_DAYS,
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
  fetchAppType,
  selectTypeClassificationBatch,
  recordAppType,
  classifyCatalogTypes,
  ITAD_PRICE_BATCH_SIZE,
  FPM_PRICE_SYNC_BATCH,
  FPM_PRICE_TTL_HOURS,
  FPM_PRICE_MAX_CONSECUTIVE_BAD,
  fetchItadIdsBatch,
  fetchItadPricesBatch,
  selectPriceBatch,
  recordPriceResult,
  resolvePriceBatch,
  runFpmSyncPipeline,
  startFpmSync,
  isFpmSyncRunning,
  getLastSyncStats,
  runFpmSyncUntilComplete,
  startFpmAutoContinue,
  isFpmAutoContinueActive,
  requestFpmAutoContinueStop,
  __setCatalogPacingMsForTests,
  __setCatalogBackoffMsForTests,
  __resetCatalogPacingForTests,
  __setTypePacingMsForTests,
  __setTypeBackoffMsForTests,
  __resetTypePacingForTests,
  __setPricePacingMsForTests,
  __setPriceBackoffMsForTests,
  __resetPricePacingForTests,
  __setHltbPollingForTests,
  __resetHltbPollingForTests,
  __setHltbItemTimeoutMsForTests,
  __resetHltbItemTimeoutForTests,
  __resetFpmSyncStateForTests,
  __resetLastSyncStatsForTests,
  __setFpmAutoContinueMaxIterationsForTests,
  __resetFpmAutoContinueMaxIterationsForTests,
  __resetFpmAutoContinueStateForTests,
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
  __setTypePacingMsForTests(0);
  __setTypeBackoffMsForTests(0, 0);
  __setPricePacingMsForTests(0);
  __setPriceBackoffMsForTests(0, 0);
  __setHltbPollingForTests(0, 50);
  __resetFpmSyncStateForTests();
  __resetLastSyncStatsForTests();
  __resetFpmAutoContinueStateForTests();
});

test.afterEach(() => {
  restoreGlobals();
  __setHltbMinIntervalMsForTests(1000);
  __resetCatalogPacingForTests();
  __resetTypePacingForTests();
  __resetPricePacingForTests();
  __resetHltbPollingForTests();
  __resetHltbItemTimeoutForTests();
  __resetFpmAutoContinueMaxIterationsForTests();
});

/** Mark a batch of appids classified 'game' directly (bypassing the real
 * appdetails network call) — the fast path for tests that only care about
 * downstream HLTB-batch/lane behaviour, not classification itself. */
async function markAllGame(env, appids, checkedAtMs = 1000) {
  for (const appid of appids) {
    await recordAppType(env, appid, { appType: "game", checkedAtMs });
  }
}

/** Fetch-mock branch for storefront appdetails — Increment 7.8's
 * classification step now runs as part of every runFpmSyncPipeline call, so
 * any test driving the full pipeline (rather than pre-classifying via
 * markAllGame) needs to answer this endpoint too. */
function appdetailsBranch(url, type = "game") {
  const u = new URL(url);
  if (u.hostname !== "store.steampowered.com" || u.pathname !== "/api/appdetails") return null;
  const appid = u.searchParams.get("appids");
  return new Response(JSON.stringify({ [appid]: { success: true, data: { type, name: "x" } } }), { status: 200 });
}

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
  assert.deepEqual(stats, { total: 0, matched: 0, unmatched: 0, pending: 0, classified: 0, nonGame: 0, pricePending: 0 });
});

test("ensureCatalogSchema on a pre-7.8 install (table exists without app_type/type_checked_at) adds the columns without losing existing data", async () => {
  const env = makeEnv();
  // Simulate a pre-7.8 database: the OLD CREATE TABLE, no app_type/
  // type_checked_at columns at all, with a real row already in it.
  await env.FPM_DB.exec(`CREATE TABLE fpm_catalog (
    appid INTEGER PRIMARY KEY,
    name TEXT,
    owners INTEGER NOT NULL DEFAULT 0,
    positive INTEGER NOT NULL DEFAULT 0,
    negative INTEGER NOT NULL DEFAULT 0,
    wilson REAL NOT NULL DEFAULT 0,
    main_hours REAL,
    match_method TEXT,
    source_catalog INTEGER NOT NULL DEFAULT 0,
    source_owned INTEGER NOT NULL DEFAULT 0,
    source_deal INTEGER NOT NULL DEFAULT 0,
    spy_synced_at INTEGER,
    hltb_checked_at INTEGER
  )`);
  await env.FPM_DB.prepare(
    "INSERT INTO fpm_catalog (appid, name, owners, positive, negative, wilson, main_hours, match_method) VALUES (500, 'Pre-existing Game', 100000, 9000, 1000, 0.9, 6.5, 'name')",
  ).run();

  await ensureCatalogSchema(env); // must not throw, must not touch the existing row

  const row = await env.FPM_DB.prepare("SELECT * FROM fpm_catalog WHERE appid = 500").first();
  assert.equal(row.name, "Pre-existing Game", "pre-existing data must survive the ALTER TABLE");
  assert.equal(row.main_hours, 6.5);
  assert.equal(row.app_type, null, "new column exists and defaults to NULL, not dropped/errored data");
  // Increment 8.5's price-backfill columns are added the same ALTER TABLE
  // way, on the same pre-existing install.
  assert.equal(row.price, null);
  assert.equal(row.price_checked_at, null, "not yet checked — distinct from a checked-but-priceless row");

  // A second call must also be safe (column-already-exists is expected and
  // swallowed every time after the first).
  await ensureCatalogSchema(env);
  const stats = await getCatalogStats(env);
  assert.equal(stats.total, 1);
  assert.equal(stats.classified, 0);
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
  await markAllGame(env, [100]);
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
  await markAllGame(env, [1, 2, 3]);

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
  await markAllGame(env, [1]);
  await recordHltbResult(env, 1, { mainHours: 6.5, matchMethod: "name", checkedAtMs: 1000 });

  const farFutureCutoff = 1000 + 1000 * 24 * 60 * 60 * 1000; // absurdly generous "staleness" window
  const batch = await selectHltbBatch(env, { limit: 10, staleCutoffMs: farFutureCutoff });
  assert.deepEqual(batch, [], "a matched row must never be reselected, no matter the staleness cutoff");
});

test("selectHltbBatch: an unmatched row is retried once hltb_checked_at is older than the cutoff, not before", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await markAllGame(env, [1]);
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
  await markAllGame(env, [1, 2, 3]);
  const batch = await selectHltbBatch(env, { limit: 2, staleCutoffMs: 2000 });
  assert.equal(batch.length, 2);
});

// ---------------------------------------------------------------------------
// selectHltbBatch — app_type gating (Increment 7.8).
// ---------------------------------------------------------------------------

test("selectHltbBatch: an unclassified (app_type NULL) row is never selected — HLTB budget is not spent on it", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  // Deliberately never classified.

  const batch = await selectHltbBatch(env, { limit: 10, staleCutoffMs: 2000 });
  assert.deepEqual(batch, [], "an unclassified row must not be enqueued for HLTB");
});

test("selectHltbBatch: a row classified non-game is never selected, even though main_hours is NULL", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await recordAppType(env, 1, { appType: "demo", checkedAtMs: 1000 });

  const batch = await selectHltbBatch(env, { limit: 10, staleCutoffMs: 2000 });
  assert.deepEqual(batch, [], "a classified non-game row must never reach the HLTB queue");
});

test("selectHltbBatch: a row already selected once, then reclassified non-game, drops out of the next selection (no separate removal step)", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await markAllGame(env, [1]);

  const before = await selectHltbBatch(env, { limit: 10, staleCutoffMs: 2000 });
  assert.deepEqual(before.map((r) => r.appid), [1], "eligible while classified 'game'");

  // app_type is set-once in real usage (never re-classified once set), but
  // this proves the WHERE clause itself is what enforces the gate — no
  // separate "dequeue non-game rows" step exists or is needed.
  await env.FPM_DB.prepare("UPDATE fpm_catalog SET app_type = 'dlc' WHERE appid = 1").run();
  const after = await selectHltbBatch(env, { limit: 10, staleCutoffMs: 2000 });
  assert.deepEqual(after, [], "no longer selected once app_type stops being 'game'");
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
  // Pre-classify every row 'game' directly (Increment 7.8's classification
  // step is bounded by the much smaller FPM_TYPE_BATCH — this test is about
  // FPM_SYNC_BATCH's HLTB-side bound specifically, so classification is
  // taken out of the loop rather than tested here).
  await markAllGame(
    env,
    rows.map((r) => r.appid),
  );

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
    if (u.hostname === "store.steampowered.com") throw new Error("every row is pre-classified — appdetails must not be called");
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
  assert.deepEqual(stats, { total: 4, matched: 1, unmatched: 1, pending: 3, classified: 0, nonGame: 0, pricePending: 0 });
});

test("getCatalogStats: classified/nonGame count app_type rows independently of the HLTB matched/unmatched/pending fields", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [1, 2, 3].map((appid) => catalogRowFromBulk(bulkRow({ appid }))),
    1000,
  );
  await recordAppType(env, 1, { appType: "game", checkedAtMs: 2000 });
  await recordAppType(env, 2, { appType: "demo", checkedAtMs: 2000 });
  // appid 3: never classified

  const stats = await getCatalogStats(env);
  assert.equal(stats.total, 3);
  assert.equal(stats.classified, 2);
  assert.equal(stats.nonGame, 1);
});

test("selectMatchedCatalogRows returns only main_hours-NOT-NULL rows, carrying stored wilson/owners", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1, positive: 9000, negative: 1000 }))], 1000);
  await markAllGame(env, [1]);
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
  await markAllGame(env, [200]);
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
  await markAllGame(env, [200]);

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
// resolveHltbBatch — per-item timeout / skip-ahead (Increment 7.8, 7.7 QA
// advisory 2). A genuinely stuck item (its search fetch never resolves)
// must not block the rest of its batch for the full ~5 min safety valve —
// each item is bounded by the much shorter hltbItemTimeoutMs deadline
// instead.
// ---------------------------------------------------------------------------

test("resolveHltbBatch: a stuck item times out well before the ~5 min safety valve, its successor in the same batch still gets processed, and both give-ups are TTL-retryable", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [
      catalogRowFromBulk(bulkRow({ appid: 200, name: "Stuck Game" })),
      catalogRowFromBulk(bulkRow({ appid: 201, name: "Successor Game" })),
    ],
    1000,
  );
  await markAllGame(env, [200, 201]);

  // A short per-item deadline (test seam) and a HIGH hltbPollMaxAttempts
  // safety valve, so the deadline — not the attempt count — is what cuts
  // the loop short. hltbPollIntervalMs is set small but non-zero so the
  // deadline actually has room to elapse across a few polling iterations.
  __setHltbItemTimeoutMsForTests(30);
  __setHltbPollingForTests(5, 1000);

  // Every search hangs forever (simulates a genuinely stuck queue/fetch) —
  // this promise is intentionally never resolved. resolveHltbBatch must
  // still return in bounded time rather than waiting on it.
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") return new Promise(() => {}); // never resolves
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const start = Date.now();
  const result = await resolveHltbBatch(env, ctx, [
    { appid: 200, name: "Stuck Game" },
    { appid: 201, name: "Successor Game" },
  ]);
  const elapsedMs = Date.now() - start;

  assert.equal(result.resolved, 0);
  assert.equal(result.gaveUp, 2, "the loop must reach BOTH items, not stall forever on the first");
  assert.ok(elapsedMs < 5000, `must not wait anywhere near the 5 min safety valve (took ${elapsedMs}ms)`);

  const stuckRow = await env.FPM_DB.prepare("SELECT hltb_checked_at, match_method FROM fpm_catalog WHERE appid = 200").first();
  assert.equal(stuckRow.match_method, "none");
  assert.ok(stuckRow.hltb_checked_at != null, "a poll-timeout give-up must record hltb_checked_at so it retries on the normal TTL cycle");

  const successorRow = await env.FPM_DB.prepare("SELECT hltb_checked_at, match_method FROM fpm_catalog WHERE appid = 201").first();
  assert.equal(successorRow.match_method, "none");
  assert.ok(successorRow.hltb_checked_at != null, "the successor must also be reached and recorded, not skipped entirely");
});

// ---------------------------------------------------------------------------
// App-type classification (Increment 7.8) — fetchAppType, selection
// priority/resumability, batch bounds, throttle backoff.
// ---------------------------------------------------------------------------

test("fetchAppType: a real classified response returns status 'ok' with the type string", async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get("appids"), "1245620");
    assert.equal(u.searchParams.get("filters"), "basic");
    return jsonResponse({ 1245620: { success: true, data: { type: "game", name: "ELDEN RING" } } });
  };
  const result = await fetchAppType(1245620);
  assert.deepEqual(result, { status: "ok", type: "game" });
});

test("fetchAppType: success:false (e.g. a delisted appid) resolves to 'ok' with type:null — a real answer, not a failure", async () => {
  globalThis.fetch = async () => jsonResponse({ 999999999: { success: false } });
  const result = await fetchAppType(999999999);
  assert.deepEqual(result, { status: "ok", type: null });
});

test("fetchAppType: a real HTTP 429 resolves to 'throttled'", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(null), { status: 429 });
  const result = await fetchAppType(1245620);
  assert.equal(result.status, "throttled");
});

test("fetchAppType: an unexpected/non-keyed JSON body (defensive backstop) resolves to 'error', not a crash", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(null), { status: 200 });
  const result = await fetchAppType(1245620);
  assert.equal(result.status, "error");
});

test("fetchAppType: a network error resolves to 'error' rather than throwing", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const result = await fetchAppType(1245620);
  assert.equal(result.status, "error");
});

test("selectTypeClassificationBatch priority: HLTB-matched rows first, then owned/deal-first + owners desc (mirrors selectHltbBatch)", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [
      catalogRowFromBulk(bulkRow({ appid: 1, owners: "1,000,000 .. 2,000,000", positive: 100, negative: 0 })), // high owners, NOT matched
      catalogRowFromBulk(bulkRow({ appid: 2, owners: "5,000 .. 20,000", positive: 100, negative: 0 })), // low owners, but MATCHED
      catalogRowFromBulk(bulkRow({ appid: 3, owners: "5,000 .. 20,000", positive: 100, negative: 0 })), // low owners, not matched, but OWNED
    ],
    1000,
  );
  await recordHltbResult(env, 2, { mainHours: 6.5, matchMethod: "name", checkedAtMs: 1000 });
  await markOwned(env, [3]);

  const batch = await selectTypeClassificationBatch(env, { limit: 10, staleCutoffMs: 2000 });
  assert.deepEqual(
    batch.map((r) => r.appid),
    [2, 3, 1],
    "matched appid 2 first (restores the leaderboard fastest), then owned appid 3, then appid 1",
  );
});

test("selectTypeClassificationBatch: a classified row is never reselected, regardless of age", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await recordAppType(env, 1, { appType: "game", checkedAtMs: 1000 });

  const farFutureCutoff = 1000 + 1000 * 24 * 60 * 60 * 1000;
  const batch = await selectTypeClassificationBatch(env, { limit: 10, staleCutoffMs: farFutureCutoff });
  assert.deepEqual(batch, [], "a classified row must never be reselected, no matter the staleness cutoff");
});

test("selectTypeClassificationBatch: an unclassified-attempt row is retried once type_checked_at is older than the cutoff, not before", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await recordAppType(env, 1, { appType: null, checkedAtMs: 5000 });

  const notYetStale = await selectTypeClassificationBatch(env, { limit: 10, staleCutoffMs: 4000 });
  assert.deepEqual(notYetStale, []);

  const nowStale = await selectTypeClassificationBatch(env, { limit: 10, staleCutoffMs: 6000 });
  assert.deepEqual(nowStale.map((r) => r.appid), [1]);
});

test("classifyCatalogTypes: classifies rows, counts non-game separately, writes through per row, and never re-fetches an already-classified row (resumable)", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [
      catalogRowFromBulk(bulkRow({ appid: 1245620, name: "ELDEN RING" })),
      catalogRowFromBulk(bulkRow({ appid: 1396240, name: "Contraband Police: Prologue" })),
    ],
    1000,
  );

  const typesByAppid = { 1245620: "game", 1396240: "demo" };
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = new URL(url);
    const appid = u.searchParams.get("appids");
    return jsonResponse({ [appid]: { success: true, data: { type: typesByAppid[appid] } } });
  };

  const result = await classifyCatalogTypes(env, { limit: 10 });
  assert.equal(result.attempted, 2);
  assert.equal(result.classified, 2);
  assert.equal(result.nonGame, 1);
  assert.equal(calls, 2);

  const stats = await getCatalogStats(env);
  assert.equal(stats.classified, 2);
  assert.equal(stats.nonGame, 1);

  // Resumability: calling again must not re-fetch either row.
  await classifyCatalogTypes(env, { limit: 10 });
  assert.equal(calls, 2, "an already-classified row must never be re-fetched");
});

test("classifyCatalogTypes: FPM_TYPE_BATCH bounds a single run; the remainder is picked up by the next run", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  const totalRows = FPM_TYPE_BATCH + 5;
  const rows = [];
  for (let i = 0; i < totalRows; i++) {
    rows.push(catalogRowFromBulk(bulkRow({ appid: 30000 + i, name: `Game ${i}`, owners: `${5_000_000 - i} .. ${5_000_000 - i}` })));
  }
  await upsertCatalogRows(env, rows, 1000);

  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = new URL(url);
    const appid = u.searchParams.get("appids");
    return jsonResponse({ [appid]: { success: true, data: { type: "game" } } });
  };

  const first = await classifyCatalogTypes(env);
  assert.equal(first.attempted, FPM_TYPE_BATCH);
  assert.equal(calls, FPM_TYPE_BATCH);

  const statsAfterFirst = await getCatalogStats(env);
  assert.equal(statsAfterFirst.classified, FPM_TYPE_BATCH);

  const second = await classifyCatalogTypes(env);
  assert.equal(second.attempted, 5, "second run picks up exactly the remainder");

  const statsAfterSecond = await getCatalogStats(env);
  assert.equal(statsAfterSecond.classified, totalRows);
});

test("classifyCatalogTypes: a failed/missing classification is retried after FPM_TYPE_TTL_DAYS, never sooner", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);

  globalThis.fetch = async () => jsonResponse({ 1: { success: false } }); // a real "no data" answer

  const nowMs = 1000;
  await classifyCatalogTypes(env, { limit: 10, now: nowMs });
  const stats = await getCatalogStats(env);
  assert.equal(stats.classified, 0, "a null classification is not counted as classified");

  const row = await env.FPM_DB.prepare("SELECT type_checked_at FROM fpm_catalog WHERE appid = 1").first();
  assert.equal(row.type_checked_at, nowMs);

  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return jsonResponse({ 1: { success: false } });
  };

  const justBeforeTtl = nowMs + FPM_TYPE_TTL_DAYS * 24 * 60 * 60 * 1000 - 1;
  await classifyCatalogTypes(env, { limit: 10, now: justBeforeTtl });
  assert.equal(calls, 0, "must not retry before FPM_TYPE_TTL_DAYS has elapsed");

  const afterTtl = nowMs + FPM_TYPE_TTL_DAYS * 24 * 60 * 60 * 1000 + 1;
  await classifyCatalogTypes(env, { limit: 10, now: afterTtl });
  assert.equal(calls, 1, "must retry once FPM_TYPE_TTL_DAYS has elapsed");
});

test("classifyCatalogTypes: backs off and retries the SAME appid on a throttle, never advancing on a bad response", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);

  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) return new Response(JSON.stringify(null), { status: 429 });
    return jsonResponse({ 1: { success: true, data: { type: "game" } } });
  };

  const result = await classifyCatalogTypes(env, { limit: 10 });
  assert.equal(attempts, 3, "must retry the same appid until it succeeds, never skip it");
  assert.equal(result.classified, 1);
});

// ---------------------------------------------------------------------------
// Price backfill (Increment 8.5) — fetchItadIdsBatch/fetchItadPricesBatch's
// typed-status contract, selectPriceBatch's priority/TTL, recordPriceResult,
// and resolvePriceBatch's chunked write-through/backoff orchestration.
// ---------------------------------------------------------------------------

test("fetchItadIdsBatch: resolves 'app/<appid>' -> itad id per the real /lookup/id/shop/61/v1 shape", async () => {
  let capturedBody;
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.pathname, "/lookup/id/shop/61/v1");
    capturedBody = JSON.parse(options.body);
    return jsonResponse({ "app/100": "itad-a", "app/200": null });
  };

  const result = await fetchItadIdsBatch(makeEnv({ ITAD_API_KEY: "k" }), [100, 200]);
  assert.deepEqual(capturedBody, ["app/100", "app/200"]);
  assert.equal(result.status, "ok");
  assert.equal(result.idsByAppid.get(100), "itad-a");
  assert.equal(result.idsByAppid.get(200), null);
});

test("fetchItadIdsBatch: a real HTTP 429 resolves to 'throttled', honoring retry-after when present", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(null), { status: 429, headers: { "retry-after": "7" } });
  const result = await fetchItadIdsBatch(makeEnv({ ITAD_API_KEY: "k" }), [100]);
  assert.equal(result.status, "throttled");
  assert.equal(result.retryAfterMs, 7000);
});

test("fetchItadIdsBatch: a network error resolves to 'error' rather than throwing", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const result = await fetchItadIdsBatch(makeEnv({ ITAD_API_KEY: "k" }), [100]);
  assert.equal(result.status, "error");
});

test("fetchItadPricesBatch: shapes the real /games/prices/v2 response, omitted ids simply absent from the map", async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = new URL(url);
    return jsonResponse([
      {
        id: "itad-a",
        deals: [{ shop: { id: 61 }, price: { amount: 9.99, amountInt: 999 }, regular: { amount: 19.99 }, cut: 50 }],
      },
      // itad-b has no live Steam deal — simply absent from the array (verified-live shape).
    ]);
  };

  const result = await fetchItadPricesBatch(makeEnv({ ITAD_API_KEY: "k" }), ["itad-a", "itad-b"]);
  assert.equal(capturedUrl.searchParams.get("country"), "AU");
  assert.equal(capturedUrl.searchParams.get("shops"), "61");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.priceByItadId.get("itad-a"), { price: 9.99, priceCents: 999, regular: 19.99, cut: 50 });
  assert.equal(result.priceByItadId.has("itad-b"), false);
});

test("fetchItadPricesBatch: a real HTTP 429 resolves to 'throttled'", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(null), { status: 429 });
  const result = await fetchItadPricesBatch(makeEnv({ ITAD_API_KEY: "k" }), ["itad-a"]);
  assert.equal(result.status, "throttled");
});

test("selectPriceBatch: priority is deal-first, then owners desc, then reviews desc (mirrors selectHltbBatch)", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [
      catalogRowFromBulk(bulkRow({ appid: 1, name: "Low owners", owners: "5,000 .. 20,000", positive: 100, negative: 0 })),
      catalogRowFromBulk(bulkRow({ appid: 2, name: "On sale", owners: "5,000 .. 20,000", positive: 100, negative: 0 })),
      catalogRowFromBulk(bulkRow({ appid: 3, name: "High owners", owners: "1,000,000 .. 2,000,000", positive: 100, negative: 0 })),
    ],
    1000,
  );
  await markAllGame(env, [1, 2, 3]);
  await recordHltbResult(env, 1, { mainHours: 5, matchMethod: "name", checkedAtMs: 1000 });
  await recordHltbResult(env, 2, { mainHours: 5, matchMethod: "name", checkedAtMs: 1000 });
  await recordHltbResult(env, 3, { mainHours: 5, matchMethod: "name", checkedAtMs: 1000 });
  await markDeal(env, [2]);

  const rows = await selectPriceBatch(env, { limit: 10, staleCutoffMs: 500 });
  assert.deepEqual(rows.map((r) => r.appid), [2, 3, 1]);
});

test("selectPriceBatch: owned rows are never selected — a price is never displayed for them", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await markAllGame(env, [1]);
  await recordHltbResult(env, 1, { mainHours: 5, matchMethod: "name", checkedAtMs: 1000 });
  await markOwned(env, [1]);

  const rows = await selectPriceBatch(env, { limit: 10, staleCutoffMs: 500 });
  assert.deepEqual(rows, []);
});

test("selectPriceBatch: an unclassified or unmatched row is never selected — same gating as selectHltbBatch", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 })), catalogRowFromBulk(bulkRow({ appid: 2 }))], 1000);
  await markAllGame(env, [1]); // appid 1 classified but never HLTB-matched; appid 2 not even classified
  await recordHltbResult(env, 2, { mainHours: 5, matchMethod: "name", checkedAtMs: 1000 }); // matched but not classified

  const rows = await selectPriceBatch(env, { limit: 10, staleCutoffMs: 500 });
  assert.deepEqual(rows, []);
});

test("selectPriceBatch: a checked row (priced or not) is retried once price_checked_at is older than FPM_PRICE_TTL_HOURS, not before", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  await markAllGame(env, [1]);
  await recordHltbResult(env, 1, { mainHours: 5, matchMethod: "name", checkedAtMs: 1000 });
  await recordPriceResult(env, 1, { price: null, priceCents: null, regular: null, cut: null, itadId: null, checkedAtMs: 5000 });

  const due = await selectPriceBatch(env, { limit: 10, staleCutoffMs: 6000 });
  assert.deepEqual(due.map((r) => r.appid), [1]);
  assert.deepEqual(await selectPriceBatch(env, { limit: 10, staleCutoffMs: 4000 }), []);
});

test("recordPriceResult: writes price/discount fields and stamps price_checked_at", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);

  await recordPriceResult(env, 1, { price: 9.99, priceCents: 999, regular: 19.99, cut: 50, itadId: "itad-a", checkedAtMs: 5000 });

  const row = await env.FPM_DB.prepare("SELECT * FROM fpm_catalog WHERE appid = 1").first();
  assert.equal(row.price, 9.99);
  assert.equal(row.price_cents, 999);
  assert.equal(row.regular, 19.99);
  assert.equal(row.cut, 50);
  assert.equal(row.itad_id, "itad-a");
  assert.equal(row.price_checked_at, 5000);
});

test("recordPriceResult: a 'no price' result stamps price_checked_at with every price field left null — never a silent blank", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);

  await recordPriceResult(env, 1, { price: null, priceCents: null, regular: null, cut: null, itadId: null, checkedAtMs: 5000 });

  const row = await env.FPM_DB.prepare("SELECT * FROM fpm_catalog WHERE appid = 1").first();
  assert.equal(row.price, null);
  assert.equal(row.price_checked_at, 5000, "checked-but-priceless is distinguishable from never-checked (price_checked_at IS NULL)");
});

test("resolvePriceBatch: priced and priceless items both write through, itad-id resolution failures counted as priceless too", async () => {
  const env = makeEnv({ ITAD_API_KEY: "k" });
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [1, 2, 3].map((appid) => catalogRowFromBulk(bulkRow({ appid }))),
    1000,
  );
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/lookup/id/shop/61/v1") {
      return jsonResponse({ "app/1": "itad-1", "app/2": "itad-2", "app/3": null });
    }
    if (u.pathname === "/games/prices/v2") {
      return jsonResponse([
        { id: "itad-1", deals: [{ shop: { id: 61 }, price: { amount: 9.99, amountInt: 999 }, regular: { amount: 19.99 }, cut: 50 }] },
        // itad-2 resolves an id but ITAD has no live Steam deal for it right now.
      ]);
    }
    throw new Error(`unexpected: ${url}`);
  };

  const items = [{ appid: 1, name: "Priced" }, { appid: 2, name: "No live deal" }, { appid: 3, name: "No ITAD id" }];
  const result = await resolvePriceBatch(env, items);

  assert.deepEqual(result, { attempted: 3, priced: 1, noPrice: 2, gaveUp: 0 });
  const row1 = await env.FPM_DB.prepare("SELECT price, itad_id, price_checked_at FROM fpm_catalog WHERE appid=1").first();
  assert.equal(row1.price, 9.99);
  assert.equal(row1.itad_id, "itad-1");
  assert.ok(row1.price_checked_at);
  const row2 = await env.FPM_DB.prepare("SELECT price, itad_id, price_checked_at FROM fpm_catalog WHERE appid=2").first();
  assert.equal(row2.price, null);
  assert.equal(row2.itad_id, "itad-2");
  assert.ok(row2.price_checked_at, "checked, ITAD confirmed no live deal — must still be stamped");
  const row3 = await env.FPM_DB.prepare("SELECT price, itad_id, price_checked_at FROM fpm_catalog WHERE appid=3").first();
  assert.equal(row3.itad_id, null);
  assert.ok(row3.price_checked_at, "no resolvable ITAD id is also a genuine checked-no-price outcome");
});

test("resolvePriceBatch: chunks at ITAD_PRICE_BATCH_SIZE per ITAD call, never fewer, larger requests", async () => {
  const env = makeEnv({ ITAD_API_KEY: "k" });
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    Array.from({ length: ITAD_PRICE_BATCH_SIZE + 50 }, (_, i) => catalogRowFromBulk(bulkRow({ appid: i + 1 }))),
    1000,
  );
  const idBatchSizes = [];
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.pathname === "/lookup/id/shop/61/v1") {
      idBatchSizes.push(JSON.parse(options.body).length);
      return jsonResponse({});
    }
    throw new Error(`unexpected: ${url}`); // no ids resolved -> /games/prices/v2 never called
  };

  const items = Array.from({ length: ITAD_PRICE_BATCH_SIZE + 50 }, (_, i) => ({ appid: i + 1, name: `Game ${i}` }));
  const result = await resolvePriceBatch(env, items);

  assert.deepEqual(idBatchSizes, [ITAD_PRICE_BATCH_SIZE, 50]);
  assert.equal(result.attempted, items.length);
  assert.equal(result.noPrice, items.length, "no ids resolved anywhere -> every item is a genuine no-price result");
});

test("resolvePriceBatch: backs off and retries the SAME chunk on a throttle, never advancing on a bad response", async () => {
  const env = makeEnv({ ITAD_API_KEY: "k" });
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);
  let attempts = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/lookup/id/shop/61/v1") {
      attempts++;
      if (attempts < 3) return new Response(JSON.stringify(null), { status: 429 });
      return jsonResponse({ "app/1": null });
    }
    throw new Error(`unexpected: ${url}`);
  };

  const result = await resolvePriceBatch(env, [{ appid: 1, name: "Game" }]);
  assert.equal(attempts, 3, "must retry the same chunk until it succeeds, never skip it");
  assert.equal(result.noPrice, 1);
});

test("resolvePriceBatch: gives up after FPM_PRICE_MAX_CONSECUTIVE_BAD throttles, leaving remaining items unattempted (price_checked_at untouched) for the next run", async () => {
  const env = makeEnv({ ITAD_API_KEY: "k" });
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1 }))], 1000);

  globalThis.fetch = async () => new Response(JSON.stringify(null), { status: 429 });

  const result = await resolvePriceBatch(env, [{ appid: 1, name: "Game" }]);
  assert.equal(result.gaveUp, 1);
  assert.equal(result.attempted, 0);

  const row = await env.FPM_DB.prepare("SELECT price_checked_at FROM fpm_catalog WHERE appid=1").first();
  assert.equal(row.price_checked_at, null, "never attempted this run — must stay selectable by the next sync run");
});

test("resolvePriceBatch: with zero items, resolves immediately without touching fetch", async () => {
  globalThis.fetch = async () => {
    throw new Error("must not be called");
  };
  const result = await resolvePriceBatch(makeEnv({ ITAD_API_KEY: "k" }), []);
  assert.deepEqual(result, { attempted: 0, priced: 0, noPrice: 0, gaveUp: 0 });
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
    const appdetailsRes = appdetailsBranch(url); // Increment 7.8: classification runs before HLTB selection
    if (appdetailsRes) return appdetailsRes;
    return hltbFetch(url, options);
  };

  assert.equal(getLastSyncStats(), null, "no run has completed yet");

  const ctx = makeCtx();
  await runFpmSyncPipeline(env, ctx, {
    loadOwnedAppIds: async () => new Set([1]),
    loadDealAppIds: async () => [2],
  });

  const stats = await getCatalogStats(env);
  assert.equal(stats.total, 2);
  assert.equal(stats.matched, 2);
  assert.equal(stats.classified, 2);
  assert.equal(stats.nonGame, 0);

  const ownedRow = await env.FPM_DB.prepare("SELECT source_owned, source_deal FROM fpm_catalog WHERE appid=1").first();
  assert.equal(ownedRow.source_owned, 1);
  assert.equal(ownedRow.source_deal, 0);
  const dealRow = await env.FPM_DB.prepare("SELECT source_owned, source_deal FROM fpm_catalog WHERE appid=2").first();
  assert.equal(dealRow.source_deal, 1);

  // Increment 7.8: the pipeline's HLTB/type funnel counters are now
  // surfaced (previously computed but discarded) — getLastSyncStats reports
  // the most recent run.
  const lastRun = getLastSyncStats();
  assert.equal(lastRun.typeAttempted, 2);
  assert.equal(lastRun.typeClassified, 2);
  assert.equal(lastRun.typeNonGame, 0);
  assert.equal(lastRun.resolved, 2);
  assert.equal(lastRun.cacheHits, 0);
  assert.equal(lastRun.gaveUp, 0);
});

test("runFpmSyncPipeline: with ITAD_API_KEY set, also price-checks newly-matched unowned rows in the SAME run — owned rows are skipped entirely", async () => {
  const env = makeEnv({ ITAD_API_KEY: "k" });

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
  let priceIdsRequested;
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") {
      const page = u.searchParams.get("page");
      if (page === "0") return new Response(JSON.stringify(page0), { status: 200 });
    }
    const appdetailsRes = appdetailsBranch(url);
    if (appdetailsRes) return appdetailsRes;
    if (u.pathname === "/lookup/id/shop/61/v1") {
      priceIdsRequested = JSON.parse(options.body);
      return jsonResponse({ "app/2": "itad-2" }); // only Deal Game is ever asked about (Owned Game is source_owned=1)
    }
    if (u.pathname === "/games/prices/v2") {
      return jsonResponse([
        { id: "itad-2", deals: [{ shop: { id: 61 }, price: { amount: 4.99, amountInt: 499 }, regular: { amount: 9.99 }, cut: 50 }] },
      ]);
    }
    return hltbFetch(url, options);
  };

  const ctx = makeCtx();
  await runFpmSyncPipeline(env, ctx, {
    loadOwnedAppIds: async () => new Set([1]),
    loadDealAppIds: async () => [2],
  });

  assert.deepEqual(priceIdsRequested, ["app/2"], "the owned row (appid 1) is never even asked about — no ITAD budget spent on it");

  const ownedRow = await env.FPM_DB.prepare("SELECT price, price_checked_at FROM fpm_catalog WHERE appid=1").first();
  assert.equal(ownedRow.price, null);
  assert.equal(ownedRow.price_checked_at, null, "owned rows are never price-checked — a price is never displayed for them");

  const dealRow = await env.FPM_DB.prepare("SELECT price, cut, price_checked_at FROM fpm_catalog WHERE appid=2").first();
  assert.equal(dealRow.price, 4.99);
  assert.equal(dealRow.cut, 50);
  assert.ok(dealRow.price_checked_at);

  const stats = await getCatalogStats(env);
  assert.equal(stats.pricePending, 0);

  const lastRun = getLastSyncStats();
  assert.equal(lastRun.priceAttempted, 1);
  assert.equal(lastRun.priced, 1);
  assert.equal(lastRun.noPrice, 0);
});

test("runFpmSyncPipeline: without ITAD_API_KEY, the price step is skipped entirely — no ITAD calls, existing behaviour unchanged", async () => {
  const env = makeEnv(); // no ITAD_API_KEY

  const page0 = { 1: bulkRow({ appid: 1, name: "Game One" }) };
  const hltbFetch = makeHltbFetch({
    searchResultsByQuery: { "Game One": [rawHltbEntry({ game_name: "Game One", comp_main: 3600 })] },
  });
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") return new Response(JSON.stringify(page0), { status: 200 });
    const appdetailsRes = appdetailsBranch(url);
    if (appdetailsRes) return appdetailsRes;
    if (u.pathname === "/lookup/id/shop/61/v1" || u.pathname === "/games/prices/v2") {
      throw new Error("must never be called without an ITAD_API_KEY");
    }
    return hltbFetch(url, options);
  };

  const ctx = makeCtx();
  await runFpmSyncPipeline(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });

  const lastRun = getLastSyncStats();
  assert.equal(lastRun.priceAttempted, 0);
  assert.equal(lastRun.priced, 0);
  assert.equal(lastRun.noPrice, 0);
  assert.equal(lastRun.priceGaveUp, 0);
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
    const appdetailsRes = appdetailsBranch(url); // Increment 7.8: classification runs before HLTB selection
    if (appdetailsRes) return appdetailsRes;
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

// ---------------------------------------------------------------------------
// Sync auto-continue (Increment 8, ride-along A) — runFpmSyncUntilComplete
// keeps calling the SAME unmodified runFpmSyncPipeline until both funnels
// (classification, HLTB) are empty. No pacing/backoff changes here at all —
// these tests only exercise the "keep calling it" loop logic itself.
// ---------------------------------------------------------------------------

test("runFpmSyncUntilComplete: a catalog that fully resolves in one batch stops after exactly one iteration", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [catalogRowFromBulk(bulkRow({ appid: 1, name: "Game One" })), catalogRowFromBulk(bulkRow({ appid: 2, name: "Game Two" }))],
    1000,
  );

  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") return jsonResponse({}); // empty page -> immediate end of crawl
    const appdetailsRes = appdetailsBranch(url);
    if (appdetailsRes) return appdetailsRes; // classification always succeeds
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      const name = body.searchTerms.join(" ");
      return jsonResponse({ count: 1, data: [rawHltbEntry({ game_name: name, comp_main: 3600 })] });
    }
    throw new Error(`unexpected: ${url}`);
  };

  const ctx = makeCtx();
  const result = await runFpmSyncUntilComplete(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });

  assert.equal(result.iterations, 1);
  assert.equal(result.stoppedEarly, false);
  const stats = await getCatalogStats(env);
  assert.equal(stats.pending, 0);
  assert.equal(stats.classified, stats.total);
});

test("runFpmSyncUntilComplete: with ITAD_API_KEY set, the loop also waits on the price-backfill funnel (Increment 8.5), not just classification/HLTB", async () => {
  const env = makeEnv({ ITAD_API_KEY: "k" });
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1, name: "Game One" }))], 1000);

  let priceLookupCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") return jsonResponse({}); // empty page -> immediate end of crawl, every run
    const appdetailsRes = appdetailsBranch(url);
    if (appdetailsRes) return appdetailsRes;
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      return jsonResponse({ count: 1, data: [rawHltbEntry({ game_name: body.searchTerms.join(" "), comp_main: 3600 })] });
    }
    if (u.pathname === "/lookup/id/shop/61/v1") {
      priceLookupCalls++;
      // Throttled for FPM_PRICE_MAX_CONSECUTIVE_BAD calls in a row —
      // resolvePriceBatch's own internal retry (within one pipeline run)
      // exhausts its give-up budget and stops, leaving the row pending;
      // succeeds starting the NEXT pipeline run's first attempt.
      if (priceLookupCalls <= FPM_PRICE_MAX_CONSECUTIVE_BAD) return new Response(JSON.stringify(null), { status: 429 });
      return jsonResponse({ "app/1": "itad-1" });
    }
    if (u.pathname === "/games/prices/v2") return jsonResponse([]); // no live deal -> a genuine, terminal "no price"
    throw new Error(`unexpected: ${url}`);
  };

  const ctx = makeCtx();
  const result = await runFpmSyncUntilComplete(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });

  assert.equal(result.stoppedEarly, false);
  assert.equal(
    result.iterations,
    2,
    "pass 1: classification+HLTB finish but price gives up after its own retry budget (still pending); pass 2: price recovers",
  );
  const stats = await getCatalogStats(env);
  assert.equal(stats.pending, 0);
  assert.equal(stats.classified, stats.total);
  assert.equal(stats.pricePending, 0);
});

test("runFpmSyncUntilComplete: keeps calling the batch step across an HLTB outage until both funnels are empty (throttle-pause self-recovery)", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [catalogRowFromBulk(bulkRow({ appid: 1, name: "Game One" })), catalogRowFromBulk(bulkRow({ appid: 2, name: "Game Two" }))],
    1000,
  );

  let hltbInitCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") return jsonResponse({}); // empty page -> immediate end of crawl, every run
    const appdetailsRes = appdetailsBranch(url);
    if (appdetailsRes) return appdetailsRes; // classification always succeeds, both rows, run 1
    if (u.pathname === "/api/bleed/init") {
      hltbInitCalls++;
      if (hltbInitCalls === 1) return new Response("down", { status: 503 }); // HLTB unreachable on pass 1
      return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" }); // recovered by pass 2
    }
    if (u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      const name = body.searchTerms.join(" ");
      return jsonResponse({ count: 1, data: [rawHltbEntry({ game_name: name, comp_main: 3600 })] });
    }
    throw new Error(`unexpected: ${url}`);
  };

  const ctx = makeCtx();
  const result = await runFpmSyncUntilComplete(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });

  assert.equal(result.stoppedEarly, false);
  assert.equal(result.iterations, 2, "pass 1: classification succeeds but HLTB is down (0 progress); pass 2: HLTB recovers and finishes both rows");

  const stats = await getCatalogStats(env);
  assert.equal(stats.pending, 0);
  assert.equal(stats.classified, stats.total);
});

test("runFpmSyncUntilComplete: a stop request takes effect after the current batch step, not mid-batch", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [catalogRowFromBulk(bulkRow({ appid: 1, name: "Game One" })), catalogRowFromBulk(bulkRow({ appid: 2, name: "Game Two" }))],
    1000,
  );

  // HLTB never resolves (no match, ever) — classification succeeds, so
  // classified reaches total on pass 1 but pending never reaches 0, meaning
  // the loop would otherwise keep going. Requesting a stop after pass 1
  // should end the loop early rather than running forever.
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") return jsonResponse({});
    const appdetailsRes = appdetailsBranch(url);
    if (appdetailsRes) return appdetailsRes;
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") return jsonResponse({ count: 0, data: [] }); // never matches
    throw new Error(`unexpected: ${url}`);
  };

  const ctx = makeCtx();
  const promise = runFpmSyncUntilComplete(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });
  // A poll-timeout give-up (HLTB_ITEM_TIMEOUT_MS_DEFAULT) writes
  // hltb_checked_at, so a NEVER-matching search still finishes pass 1 rather
  // than hanging — request the stop immediately so pass 2 never starts.
  requestFpmAutoContinueStop();
  const result = await promise;

  assert.equal(result.stoppedEarly, true);
  assert.ok(result.iterations >= 1);
});

test("runFpmSyncUntilComplete: gives up after the safety-bound iteration count rather than looping forever", async () => {
  __setFpmAutoContinueMaxIterationsForTests(2);
  __setHltbItemTimeoutMsForTests(0); // give up on every HLTB item instantly

  const env = makeEnv();
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk(bulkRow({ appid: 1, name: "Game One" }))], 1000);

  // Classification always succeeds; HLTB init always fails, so pending
  // NEVER reaches 0 — this run can only stop via the safety bound.
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com") return jsonResponse({});
    const appdetailsRes = appdetailsBranch(url);
    if (appdetailsRes) return appdetailsRes;
    if (u.pathname === "/api/bleed/init") return new Response("down", { status: 503 });
    throw new Error(`unexpected: ${url}`);
  };

  const ctx = makeCtx();
  const result = await runFpmSyncUntilComplete(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });

  assert.equal(result.iterations, 2);
  assert.equal(result.stoppedEarly, false);
  const stats = await getCatalogStats(env);
  assert.ok(stats.pending > 0, "still stuck — the safety bound, not completion, ended the loop");
});

test("startFpmAutoContinue: isFpmAutoContinueActive is true only while the loop is driving, and reports via isFpmSyncRunning too", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  let resolveFirstFetch;
  const blocker = new Promise((r) => {
    resolveFirstFetch = r;
  });
  globalThis.fetch = async () => {
    await blocker;
    return jsonResponse({}); // empty page -> immediate end of crawl
  };

  const ctx = makeCtx();
  assert.equal(isFpmAutoContinueActive(), false);

  const result = startFpmAutoContinue(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });
  assert.deepEqual(result, { started: true });
  assert.equal(isFpmAutoContinueActive(), true);
  assert.equal(isFpmSyncRunning(), true, "the existing running flag covers auto-continue too — no new polling semantics needed");

  resolveFirstFetch();
  await ctx.flush();
  assert.equal(isFpmAutoContinueActive(), false);
  assert.equal(isFpmSyncRunning(), false);
});

test("startFpmAutoContinue: refuses to start a second run (auto-continue or manual) while one is already active", async () => {
  const env = makeEnv();
  await ensureCatalogSchema(env);
  let resolveFirstFetch;
  const blocker = new Promise((r) => {
    resolveFirstFetch = r;
  });
  globalThis.fetch = async () => {
    await blocker;
    return jsonResponse({});
  };

  const ctx = makeCtx();
  const first = startFpmAutoContinue(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });
  assert.deepEqual(first, { started: true });

  const second = startFpmAutoContinue(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });
  assert.deepEqual(second, { started: false, alreadyRunning: true });

  const manualWhileAutoContinuing = startFpmSync(env, ctx, { loadOwnedAppIds: async () => new Set(), loadDealAppIds: async () => [] });
  assert.deepEqual(manualWhileAutoContinuing, { started: false, alreadyRunning: true });

  resolveFirstFetch();
  await ctx.flush();
});
