// Tests for src/worker.js – the POST /api/fpm/sync, GET /api/fpm/sync/status
// and POST /api/fpm/sync/stop routes (Increment 7.7: FPM catalog re-source).
//
// Increment 14 deleted GET /api/fpm and this file's 26 tests for it. What is
// left is the sync lane only: the manual trigger that fills the D1 catalog
// (src/catalog.js), its status read, and its stop switch. The catalogue the
// sync builds is still consumed – by /api/rank, which is tested in
// test/worker-rank.test.mjs.
//
// NEVER makes a real network call. Spy-queue/HLTB-queue pacing and the
// catalog crawl's pacing/backoff are all shrunk to 0ms via their test seams.

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
import { SPY_CELESTE, SPY_EMPTY_UNKNOWN_APPID } from "./fixtures/spy-appdetails.mjs";
import { __setSpyMinIntervalMsForTests, __resetSpyQueueForTests } from "../src/spyQueue.js";
import { __setHltbMinIntervalMsForTests, __resetHltbQueueForTests, FPM_POOL_CAP } from "../src/hltb.js";
import {
  ensureCatalogSchema,
  upsertCatalogRows,
  recordAppType,
  recordTagsResult,
  catalogRowFromBulk,
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
  isFpmSyncRunning,
} from "../src/catalog.js";
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";

const originalCaches = globalThis.caches;

/** QA TC-6. The per-test guard, installed by beforeEach and asserted empty by
 * afterEach, so a test that forgets to stub `fetch` fails loudly instead of
 * silently reaching the real SteamSpy / Steam. */
let offlineGuard = makeOfflineFetchGuard("worker-fpm");

function restoreGlobals() {
  // QA TC-6: the RESTING value between tests is a fresh guard, not the real
  // `fetch`. A ctx.waitUntil promise that lands after its test finished
  // therefore cannot reach the network either. Nothing here wants real fetch.
  globalThis.fetch = makeOfflineFetchGuard("worker-fpm (between tests)");
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
    // Increment 15, SPEC.md §11.6: renamed. It is whose app this is, a
    // deploy-time constant, not who is signed in - and nothing on /api/fpm's
    // request path reads it any more. The sync pipeline still does, by design
    // (SPEC.md §11.4).
    OWNER_STEAM_ID: "76561198000000000",
    ITAD_API_KEY: "test-itad-key",
    TAG_CACHE: makeMockKv(),
    FPM_DB: makeMockD1(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

function primeLibrary(cache, env, games) {
  // Keyed on the SESSION'S id (SPEC.md §11.1), not on anything from `env`.
  const key = `https://steam-sale-scout.cache/api/library?steamid=${TEST_STEAM_ID}&v=2`;
  cache.store.set(key, jsonResponse({ games }));
}

function primeFpmPool(cache, deals) {
  const key = "https://steam-sale-scout.cache/api/fpm/pool";
  cache.store.set(key, jsonResponse({ deals }));
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

/** Fetch-mock branch for storefront appdetails — Increment 7.8's
 * classification step now runs as part of every sync pipeline run, so any
 * test driving POST /api/fpm/sync end to end needs to answer this endpoint
 * too (unless every row involved is already pre-classified). */
function appdetailsBranch(url, type = "game") {
  const u = new URL(url);
  if (u.hostname !== "store.steampowered.com" || u.pathname !== "/api/appdetails") return null;
  const appid = u.searchParams.get("appids");
  return jsonResponse({ [appid]: { success: true, data: { type, name: "x" } } });
}

/** Fetch-mock branch for SteamSpy `appdetails` – Increment 9's tag backfill
 * runs as part of every sync pipeline run, exactly as 7.8's classification
 * does above.
 *
 * DELIBERATE (round-1 review, major 7): these stubs answer `steamspy.com`
 * with a CRAWL body, and without this branch the tag step reads that crawl
 * body as its own answer – first silently (stamping rows "no tags"), and now,
 * since fetchSpyTags only accepts a body carrying an `appid` field, as a
 * throttle it retries twenty times per row for nothing. The crawl and the
 * appdetails call must be told apart on `request=`, not on hostname. Answers
 * with a real live capture, re-appid'd to whichever row is asked about. */
function spyAppdetailsBranch(url, fixture = SPY_CELESTE) {
  const u = new URL(url);
  if (u.hostname !== "steamspy.com" || u.searchParams.get("request") !== "appdetails") return null;
  return jsonResponse({ ...fixture, appid: Number(u.searchParams.get("appid")) });
}

test.beforeEach(() => {
  offlineGuard = makeOfflineFetchGuard("worker-fpm");
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
  restoreGlobals();
  assert.deepEqual(
    offlineGuard.calls,
    [],
    "QA TC-6: this test called fetch without stubbing it — before the guard existed that was a real TLS connection",
  );
  __setSpyMinIntervalMsForTests(1000);
  __setHltbMinIntervalMsForTests(1000);
  __resetCatalogPacingForTests();
  __resetTypePacingForTests();
  __resetPricePacingForTests();
  __resetTagsPacingForTests();
  __resetHltbPollingForTests();
});

// ---------------------------------------------------------------------------
// POST /api/fpm/sync + GET /api/fpm/sync/status.
// ---------------------------------------------------------------------------

test("POST /api/fpm/sync with no FPM_DB binding -> 200 {started:false}, never a 500", async () => {
  const env = makeEnv({ FPM_DB: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.started, false);
});

test("GET /api/fpm/sync/status with no FPM_DB binding reports dbReady:false, never a 500", async () => {
  const env = makeEnv({ FPM_DB: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dbReady, false);
  assert.equal(body.running, false);
  assert.equal(body.classified, 0);
  assert.equal(body.nonGame, 0);
  assert.equal(body.lastRun, null);
});

test("GET /api/fpm/sync/status with no FPM_DB reports the Increment 9 tag funnel as ZEROS, so a client never special-cases it", async () => {
  const env = makeEnv({ FPM_DB: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const body = await res.json();

  // Same four keys as the real branch below, present and numeric — not
  // undefined, not omitted.
  assert.equal(body.tagged, 0);
  assert.equal(body.tagsEmpty, 0);
  assert.equal(body.tagsPending, 0);
  assert.equal(body.tagsKvSeeded, 0);
  assert.equal(body.tagged + body.tagsEmpty + body.tagsPending, body.total, "the funnel still adds up on the no-DB branch");
});

test("GET /api/fpm/sync/status surfaces the Increment 9 tag funnel (tagged/tagsEmpty/tagsPending/tagsKvSeeded) straight from D1", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [1, 2, 3, 4].map((appid) =>
      catalogRowFromBulk({ appid, name: `Game ${appid}`, positive: 100, negative: 0, owners: "10,000 .. 20,000" }),
    ),
    1000,
  );
  // 1: tagged from the KV seed. 2: tagged from a live fetch. 3: checked and
  // genuinely empty. 4: never attempted.
  await recordTagsResult(env, 1, { tags: SPY_CELESTE.tags, checkedAtMs: 2000, source: "kv" });
  await recordTagsResult(env, 2, { tags: SPY_CELESTE.tags, checkedAtMs: 2000, source: "live" });
  await recordTagsResult(env, 3, { tags: null, checkedAtMs: 2000, source: "live" });

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.total, 4);
  assert.equal(body.tagged, 2);
  assert.equal(body.tagsEmpty, 1);
  assert.equal(body.tagsPending, 1);
  assert.equal(body.tagsKvSeeded, 1, "the catalog-wide kv_seeded leg, read off tags_source so it survives restarts");
  assert.equal(body.tagged + body.tagsEmpty + body.tagsPending, body.total, "SPEC.md gate (c): the funnel adds up to the row count");
  assert.equal(body.lastRun, null, "no sync run happened in this test — the per-run counters must not be fabricated");
});

test("GET /api/fpm/sync/status surfaces classified/nonGame counts straight from D1, before any sync run has completed (lastRun stays null)", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await ensureCatalogSchema(env);
  await upsertCatalogRows(
    env,
    [1, 2, 3].map((appid) => catalogRowFromBulk({ appid, name: `Game ${appid}`, positive: 100, negative: 0, owners: "10,000 .. 20,000" })),
    1000,
  );
  await recordAppType(env, 1, { appType: "game", checkedAtMs: 2000 });
  await recordAppType(env, 2, { appType: "demo", checkedAtMs: 2000 });
  // appid 3: never classified

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const body = await res.json();

  assert.equal(body.total, 3);
  assert.equal(body.classified, 2);
  assert.equal(body.nonGame, 1);
  assert.equal(body.lastRun, null, "no sync run has happened in this test — the counters must not be fabricated");
});

test("a full sync run crawls the catalog, matches HLTB lengths, and status reflects it — then the poll can stop", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);

  const page0 = { 100: { appid: 100, name: "Game A", positive: 9000, negative: 1000, owners: "1,000,000 .. 2,000,000" } };
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const spyTagsRes = spyAppdetailsBranch(url); // Increment 9: the tag backfill runs inside every sync pipeline run
    if (spyTagsRes) return spyTagsRes;
    if (u.hostname === "steamspy.com") {
      return new Response(JSON.stringify(page0), { status: 200 }); // partial page -> end of crawl
    }
    const appdetailsRes = appdetailsBranch(url); // Increment 7.8: classification runs before HLTB selection
    if (appdetailsRes) return appdetailsRes;
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetOwnedGames")) {
      return jsonResponse({ response: { games: [ownedGame({ appid: 1 })] } });
    }
    if (u.pathname === "/deals/v2") {
      return jsonResponse({ list: [], hasMore: false });
    }
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      if (body.searchTerms.join(" ") === "Game A") {
        return jsonResponse({ count: 1, data: [{ game_id: 1, game_name: "Game A", comp_main: 23400 }] });
      }
      return jsonResponse({ count: 0, data: [] });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const startRes = await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  const startBody = await startRes.json();
  assert.equal(startBody.started, true);

  // While the background pipeline is still draining (before ctx.flush()),
  // status should report running:true.
  const midStatusRes = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const midStatusBody = await midStatusRes.json();
  assert.equal(midStatusBody.running, true);

  await ctx.flush();
  assert.equal(isFpmSyncRunning(), false);

  const statusRes = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.running, false, "the poll must be able to stop once idle");
  assert.equal(statusBody.total, 1);
  assert.equal(statusBody.matched, 1);
  assert.equal(statusBody.pending, 0);
  assert.equal(statusBody.classified, 1, "Increment 7.8: classified count surfaced on the status endpoint");
  assert.equal(statusBody.nonGame, 0);
  assert.ok(statusBody.lastRun, "the last-run HLTB/type funnel counters must be surfaced");
  assert.equal(statusBody.lastRun.typeClassified, 1);
  assert.equal(statusBody.lastRun.typeNonGame, 0);
  assert.equal(statusBody.lastRun.resolved, 1);

  // INCREMENT 14. This test used to end by fetching GET /api/fpm and asserting
  // the matched row rendered with mainHours 6.5. That route is deleted, so the
  // tail went with it.
  //
  // BE PRECISE ABOUT WHAT THAT COST, because the obvious summary is wrong. The
  // tail was NOT a weaker look at the same fact - it was a STRONGER one.
  // `statusBody.matched` counts rows where main_hours IS NOT NULL
  // (src/catalog.js), so it proves a value was written and never WHICH value.
  // The tail proved the value: comp_main 23400 seconds must render as 6.5
  // hours. It was redundant, not weak.
  //
  // It is safe to drop only because that conversion is asserted directly, at
  // the layer that performs it, by test/catalog.test.mjs's two resolveHltbBatch
  // write-through tests (the pre-warmed KV cache hit and the cold real-queue
  // item). Both read main_hours back through selectMatchedCatalogRows and both
  // fail if the seconds-to-hours division changes. DO NOT delete those two on
  // the strength of this comment - they are now the only detectors left.
});

test("a second POST /api/fpm/sync while one is already running reports alreadyRunning", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, []);

  let resolveBlocker;
  const blocker = new Promise((r) => {
    resolveBlocker = r;
  });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const spyTagsRes = spyAppdetailsBranch(url); // Increment 9: the tag backfill runs inside every sync pipeline run
    if (spyTagsRes) return spyTagsRes;
    if (u.hostname === "steamspy.com") {
      await blocker;
      return new Response(JSON.stringify({}), { status: 200 }); // empty page -> immediate end
    }
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const first = await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  assert.equal((await first.json()).started, true);

  const second = await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  const secondBody = await second.json();
  assert.equal(secondBody.started, false);
  assert.equal(secondBody.alreadyRunning, true);

  resolveBlocker();
  await ctx.flush();
});

// ---------------------------------------------------------------------------
// Sync auto-continue (Increment 8, ride-along A) — POST /api/fpm/sync?continue=1
// and POST /api/fpm/sync/stop, exercised end to end through the route. The
// loop mechanics themselves (multi-iteration completion, safety bound,
// mid-loop stop) are covered in test/catalog.test.mjs; this just confirms
// the HTTP wiring — query-param dispatch, fail-soft with no FPM_DB, and the
// GET /api/fpm/sync/status `autoContinue` flag.
// ---------------------------------------------------------------------------

test("POST /api/fpm/sync?continue=1 starts an auto-continue run, and status reports autoContinue:true while it's in flight", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, []);

  let resolveBlocker;
  const blocker = new Promise((r) => {
    resolveBlocker = r;
  });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const spyTagsRes = spyAppdetailsBranch(url); // Increment 9: the tag backfill runs inside every sync pipeline run
    if (spyTagsRes) return spyTagsRes;
    if (u.hostname === "steamspy.com") {
      await blocker;
      return new Response(JSON.stringify({}), { status: 200 }); // empty page -> immediate end of crawl
    }
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const startRes = await worker.fetch(new Request("https://x/api/fpm/sync?continue=1", { method: "POST" }), env, ctx);
  assert.deepEqual(await startRes.json(), { started: true });

  const statusRes = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.running, true);
  assert.equal(statusBody.autoContinue, true);

  resolveBlocker();
  await ctx.flush();

  const finalStatusRes = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const finalStatusBody = await finalStatusRes.json();
  assert.equal(finalStatusBody.running, false);
  assert.equal(finalStatusBody.autoContinue, false);
});

test("a plain POST /api/fpm/sync (no ?continue=1) is a single batch — status reports autoContinue:false while it runs", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, []);

  let resolveBlocker;
  const blocker = new Promise((r) => {
    resolveBlocker = r;
  });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const spyTagsRes = spyAppdetailsBranch(url); // Increment 9: the tag backfill runs inside every sync pipeline run
    if (spyTagsRes) return spyTagsRes;
    if (u.hostname === "steamspy.com") {
      await blocker;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  const statusRes = await worker.fetch(new Request("https://x/api/fpm/sync/status"), env, ctx);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.running, true);
  assert.equal(statusBody.autoContinue, false);

  resolveBlocker();
  await ctx.flush();
});

test("POST /api/fpm/sync/stop with no FPM_DB binding -> 200 {stopping:false, notice:...}, never a 500", async () => {
  const env = makeEnv({ FPM_DB: undefined });
  const res = await worker.fetch(new Request("https://x/api/fpm/sync/stop", { method: "POST" }), env, makeCtx());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stopping, false);
});

test("POST /api/fpm/sync/stop with FPM_DB configured but nothing running -> 200 {stopping:true}, not an error", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://x/api/fpm/sync/stop", { method: "POST" }), env, makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stopping: true });
});

test("sync is resumable: re-running after a partial fill only enqueues rows still NULL", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, []);

  const page0 = {
    1: { appid: 1, name: "Game One", positive: 9000, negative: 1000, owners: "1,000,000 .. 2,000,000" },
    2: { appid: 2, name: "Game Two", positive: 9000, negative: 1000, owners: "1,000,000 .. 2,000,000" },
  };
  const queriesSeen = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const spyTagsRes = spyAppdetailsBranch(url); // Increment 9: the tag backfill runs inside every sync pipeline run
    if (spyTagsRes) return spyTagsRes;
    if (u.hostname === "steamspy.com") return new Response(JSON.stringify(page0), { status: 200 });
    const appdetailsRes = appdetailsBranch(url); // Increment 7.8: classification runs before HLTB selection
    if (appdetailsRes) return appdetailsRes;
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    if (u.pathname === "/api/bleed/init") return jsonResponse({ token: "tok", hpKey: "hpk", hpVal: "hpv" });
    if (u.pathname === "/api/bleed") {
      const body = JSON.parse(options.body);
      const query = body.searchTerms.join(" ");
      queriesSeen.push(query);
      if (query === "Game One") return jsonResponse({ count: 1, data: [{ game_id: 1, game_name: "Game One", comp_main: 3600 }] });
      return jsonResponse({ count: 0, data: [] });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  await ctx.flush();
  assert.deepEqual(queriesSeen.sort(), ["Game One", "Game Two"]);

  queriesSeen.length = 0;
  await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  await ctx.flush();
  assert.deepEqual(queriesSeen, [], "Game One is matched, Game Two was just checked — neither re-enqueues immediately");
});

test("sync's deal-pool union actually slices to FPM_POOL_CAP (top 300 of the rank-sorted pool), not the whole pool", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, []);

  // A deal pool bigger than FPM_POOL_CAP, already rank-sorted (as
  // loadFpmPool's real contract requires) — array order IS priority order.
  const poolSize = FPM_POOL_CAP + 10;
  const pool = [];
  const catalogRows = [];
  for (let i = 0; i < poolSize; i++) {
    const appid = 6000 + i;
    pool.push(deal({ itadId: `itad-${i}`, appid, title: `Deal Game ${i}` }));
    catalogRows.push(
      catalogRowFromBulk({ appid, name: `Deal Game ${i}`, positive: 9000, negative: 1000, owners: "1,000,000 .. 2,000,000" }),
    );
  }
  primeFpmPool(cache, pool);
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, catalogRows, 1000);

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    // Increment 9: the tag backfill runs inside every sync pipeline run.
    // Answered with the live EMPTY-tags shape – this test is about deal-pool
    // flagging, so each row's tag lookup should resolve in one call.
    const spyTagsRes = spyAppdetailsBranch(url, SPY_EMPTY_UNKNOWN_APPID);
    if (spyTagsRes) return spyTagsRes;
    if (u.hostname === "steamspy.com") return new Response(JSON.stringify({}), { status: 200 }); // empty page -> immediate end of crawl
    if (u.hostname === "howlongtobeat.com") throw new Error("HLTB down — irrelevant here, must fail soft and not affect source_deal flagging");
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  await worker.fetch(new Request("https://x/api/fpm/sync", { method: "POST" }), env, ctx);
  await ctx.flush();

  const flaggedResult = await env.FPM_DB.prepare("SELECT appid FROM fpm_catalog WHERE source_deal = 1").all();
  const flaggedAppids = new Set(flaggedResult.results.map((r) => r.appid));
  assert.equal(flaggedAppids.size, FPM_POOL_CAP, "only the top FPM_POOL_CAP deal-pool entries get flagged, not the whole pool");
  for (let i = 0; i < FPM_POOL_CAP; i++) {
    assert.ok(flaggedAppids.has(6000 + i), `appid ${6000 + i} (within top ${FPM_POOL_CAP}) should be flagged source_deal`);
  }
  for (let i = FPM_POOL_CAP; i < poolSize; i++) {
    assert.ok(!flaggedAppids.has(6000 + i), `appid ${6000 + i} (beyond top ${FPM_POOL_CAP}) should NOT be flagged`);
  }
});

// ---------------------------------------------------------------------------
// THE VERB IS PART OF THE ROUTE (increment 15 follow-up, 2026-09-25)
//
// These three routes dispatched on PATH ALONE and ran their handler on any
// method. Neither the router nor any of the three handlers looked at
// `request.method`, so `GET /api/fpm/sync` started a multi-hour crawl of
// SteamSpy, ITAD and Steam.
//
// THE GATE DOES NOT COVER THIS, and DEPLOY-BLOCKERS.md wrongly said it did.
// `SameSite=Lax` withholds the cookie from a SUBRESOURCE, which is why
// increment 14's SEC-1 `<img>` vector really is dead. But Lax DELIBERATELY
// ATTACHES the cookie to a top-level GET navigation, so a plain link in an
// email or a chat message, clicked by the signed-in owner, arrived with a valid
// session. A 401 gate answers "who are you"; it cannot answer "should a GET be
// allowed to do that".
//
// Measured live at 47d9c67 before the fix: `GET /api/fpm/sync/stop` -> 200,
// handler ran. All 909 tests passed with the hole open, which is why these
// exist. This is the same lesson `src/worker.js`'s `/:appid` comment records
// after a GET destroyed a mark at increment 12.5 - these three routes simply
// never got the fix.
// ---------------------------------------------------------------------------

for (const method of ["GET", "PUT", "DELETE", "HEAD", "PATCH"]) {
  test(`VERB GUARD: ${method} /api/fpm/sync -> 405, and the sync does NOT start`, async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    // A real fetch would mean the crawl began. If the guard fails, this throws
    // rather than quietly spending an afternoon of upstream requests.
    const fetchCalls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      fetchCalls.push(String(args[0]));
      throw new Error("the sync pipeline ran on a non-POST - the verb guard failed");
    };
    try {
      const res = await worker.fetch(
        new Request("https://x/api/fpm/sync", { method }),
        env,
        ctx,
      );
      assert.equal(res.status, 405, `${method} must be refused, not dispatched`);
      assert.deepEqual(await res.json(), { error: "method not allowed" });
      assert.deepEqual(fetchCalls, [], "no upstream call may be made");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
  test(`VERB GUARD: ${method} /api/fpm/sync/stop -> 405`, async () => {
    const res = await worker.fetch(
      new Request("https://x/api/fpm/sync/stop", { method }),
      makeEnv(),
      makeCtx(),
    );
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: "method not allowed" });
  });
}

for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
  test(`VERB GUARD: ${method} /api/fpm/sync/status -> 405 (status is a READ)`, async () => {
    const res = await worker.fetch(
      new Request("https://x/api/fpm/sync/status", { method }),
      makeEnv(),
      makeCtx(),
    );
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: "method not allowed" });
  });
}

test("VERB GUARD: the correct verb still works on all three - the guard refuses, it does not break", async () => {
  const env = makeEnv();
  // GET status is the one of the three that is safe to actually run: it reads
  // counters and starts nothing.
  const status = await worker.fetch(
    new Request("https://x/api/fpm/sync/status"),
    env,
    makeCtx(),
  );
  assert.equal(status.status, 200, "GET /api/fpm/sync/status must still answer");
  assert.equal(typeof (await status.json()), "object");

  // POST stop is also safe - stopping a sync that is not running is a no-op.
  const stop = await worker.fetch(
    new Request("https://x/api/fpm/sync/stop", { method: "POST" }),
    env,
    makeCtx(),
  );
  assert.notEqual(stop.status, 405, "POST /api/fpm/sync/stop must not be refused");
});
