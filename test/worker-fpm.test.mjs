// Tests for src/worker.js — the /api/fpm, /api/fpm/sync, and
// /api/fpm/sync/status routes (Increment 7.7: FPM catalog re-source).
//
// Increment 7.7 replaces FPM's old per-request pool+HLTB-queue sourcing with
// a durable D1 catalog (src/catalog.js) filled by an explicit
// POST /api/fpm/sync. GET /api/fpm is now a fast, static read: no HLTB
// traffic, no eligibility computation — it just scores+annotates whatever's
// already matched in D1. Priming env.FPM_DB directly via src/catalog.js's
// own exported CRUD (ensureCatalogSchema/upsertCatalogRows/recordHltbResult/
// markOwned/markDeal) is the fast path for GET-only tests; the /api/fpm/sync
// section further down exercises the real pipeline end to end through the
// route.
//
// NEVER makes a real network call. Spy-queue/HLTB-queue pacing and the
// catalog crawl's pacing/backoff are all shrunk to 0ms via their test seams.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { __setSpyMinIntervalMsForTests, __resetSpyQueueForTests } from "../src/spyQueue.js";
import { __setHltbMinIntervalMsForTests, __resetHltbQueueForTests, FPM_MIN_LENGTH_HOURS, FPM_POOL_CAP } from "../src/hltb.js";
import { quality } from "../src/score.js";
import {
  ensureCatalogSchema,
  upsertCatalogRows,
  recordHltbResult,
  recordAppType,
  markOwned,
  markDeal,
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
  __setHltbPollingForTests,
  __resetHltbPollingForTests,
  __resetFpmSyncStateForTests,
  __resetLastSyncStatsForTests,
  isFpmSyncRunning,
  recordPriceResult,
} from "../src/catalog.js";
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
    FPM_DB: makeMockD1(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

function primeLibrary(cache, env, games) {
  const key = `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}`;
  cache.store.set(key, jsonResponse({ games }));
}

function primeFpmPool(cache, deals) {
  const key = "https://steam-sale-scout.cache/api/fpm/pool";
  cache.store.set(key, jsonResponse({ deals }));
}

function v2Key(appid) {
  return `v2:spytag:${appid}`;
}

function deckKey(appid) {
  return `deck:${appid}`;
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

/** A minimal fetch mock for tests that don't care about Deck-compat data —
 * answers GetItems with an empty store_items list (DEFAULT_DECK_COMPAT gets
 * cached) and throws on anything else, so a forgotten mock never silently
 * falls through to a real network call. */
function stubGetItemsFetch() {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetItems")) {
      return jsonResponse({ response: { store_items: [] } });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
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

/** Prime a matched (main_hours set), floor-passing catalog row directly via
 * src/catalog.js's own CRUD — the fast path for GET /api/fpm tests, which
 * shouldn't need to exercise the whole sync pipeline. Increment 7.8:
 * defaults appType to 'game' so every existing test that primes a row and
 * expects it to render in the lane keeps working unchanged — pass
 * appType: null / 'demo' / etc explicitly to exercise the gating itself. */
async function primeMatchedRow(env, { appid, name, positive = 96000, negative = 4000, owners = 750000, mainHours = 6.5, matchMethod = "name", appType = "game" }) {
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [{ appid, name, owners, positive, negative, wilson: undefined }].map((r) => ({
    ...catalogRowFromBulk({ appid: r.appid, name: r.name, positive: r.positive, negative: r.negative, owners: `${r.owners} .. ${r.owners}` }),
  })), 1000);
  await recordHltbResult(env, appid, { mainHours, matchMethod, checkedAtMs: 2000 });
  if (appType !== undefined) {
    await recordAppType(env, appid, { appType, checkedAtMs: 3000 });
  }
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

test.beforeEach(() => {
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
  __setHltbPollingForTests(0, 50);
  __resetFpmSyncStateForTests();
  __resetLastSyncStatsForTests();
});

test.afterEach(() => {
  restoreGlobals();
  __setSpyMinIntervalMsForTests(1000);
  __setHltbMinIntervalMsForTests(1000);
  __resetCatalogPacingForTests();
  __resetTypePacingForTests();
  __resetPricePacingForTests();
  __resetHltbPollingForTests();
});

// ---------------------------------------------------------------------------
// GET /api/fpm — fail-soft, source level.
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

test("missing FPM_DB binding -> 200 {available:false}, without touching fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("should not be called", { status: 200 });
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ FPM_DB: undefined });
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(fetchCalls, 0);
});

test("an empty (never-synced) catalog returns available:true with an empty lane and total:0", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.available, true);
  assert.equal(body.total, 0);
  assert.equal(body.matched, 0);
  assert.equal(body.pending, 0);
  assert.equal(body.ready, true);
  assert.equal(body.fpm.length, 0);
});

// ---------------------------------------------------------------------------
// GET /api/fpm — happy path + lane math (reading straight from D1, no HLTB
// traffic anywhere in this path).
// ---------------------------------------------------------------------------

test("happy path: a matched D1 row is scored/annotated with zero HLTB or eligibility-recompute network calls", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 200, name: "Portal 2", positive: 96000, negative: 4000, mainHours: 6.5 });
  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeFpmPool(cache, []); // no deal-side price data for appid 200 in this test
  env.TAG_CACHE.store.set(v2Key(200), JSON.stringify({ tags: { Puzzle: 50 } }));
  env.TAG_CACHE.store.set(deckKey(200), JSON.stringify({ deck: 3, os: 3, frame: 0 }));

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "howlongtobeat.com") throw new Error("GET /api/fpm must never call HowLongToBeat");
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetOwnedGames")) {
      throw new Error("GET /api/fpm must reuse the already-cached library, not refetch it");
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.available, true);
  assert.equal(body.ready, true);
  assert.equal(body.total, 1);
  assert.equal(body.matched, 1);
  assert.equal(body.pending, 0);
  assert.equal(body.unmatchedCount, 0);
  assert.equal(body.fpm.length, 1);

  const entry = body.fpm[0];
  assert.equal(entry.appid, 200);
  assert.equal(entry.title, "Portal 2");
  assert.equal(entry.mainHours, 6.5);
  assert.equal(entry.matchMethod, "name");
  assert.ok(Math.abs(entry.quality - quality(96000, 4000)) < 1e-9);
  assert.equal(entry.funPerHour, Math.round(((entry.quality * 100) / 6.5) * 10) / 10);
  assert.ok(Math.abs(entry.fpm - entry.quality ** 2 / Math.sqrt(6.5)) < 1e-9);
  assert.deepEqual(entry.deck, { deck: 3, os: 3, frame: 0 });
  assert.deepEqual(entry.tagNames, ["Puzzle"]);
  assert.equal(typeof entry.batteryFriendly, "boolean");
  assert.equal(entry.owned, false);
  assert.equal(entry.price, null);
  assert.equal(entry.cut, null);
});

test("a dismissed appid is excluded from /api/fpm even though it's a fully matched, qualifying row", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 200, name: "Keep This Game", mainHours: 6.5 });
  await primeMatchedRow(env, { appid: 201, name: "Dismissed Game", mainHours: 4.0 });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);

  await ensureDismissalsSchema(env);
  await addDismissal(env, 201, "Dismissed Game");

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.matched, 2, "still counted as matched in the D1-wide stats — dismissal doesn't touch D1's own record");
  assert.equal(body.fpm.length, 1);
  assert.equal(body.fpm[0].appid, 200);
});

test("with no dismissals table yet (fresh D1), /api/fpm is unaffected — dismissal join fails soft to 'nothing excluded'", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 200, name: "Portal 2", mainHours: 6.5 });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  // Deliberately never call ensureDismissalsSchema — the dismissals table
  // doesn't exist yet, mirroring a brand-new D1 that's never had anything
  // dismissed.

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.fpm.length, 1);
  assert.equal(body.fpm[0].appid, 200);
});

test("a resolved match below FPM_MIN_LENGTH_HOURS is excluded silently — not counted in unmatchedCount", async () => {
  assert.equal(FPM_MIN_LENGTH_HOURS, 1);
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 200, name: "Short Thing", mainHours: 0.5 });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.matched, 1, "still counted as matched in the D1-wide stats");
  assert.equal(body.fpm.length, 0, "but excluded from the displayed lane");
  assert.equal(body.unmatchedCount, 0, "a sub-floor MATCH is not the same as no length data");
});

test("an unmatched (match_method='none') row is counted in unmatchedCount, not shown", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, [catalogRowFromBulk({ appid: 300, name: "No Match", positive: 100, negative: 10, owners: "10,000 .. 20,000" })], 1000);
  await recordHltbResult(env, 300, { mainHours: null, matchMethod: "none", checkedAtMs: 2000 });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);

  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.total, 1);
  assert.equal(body.matched, 0);
  assert.equal(body.pending, 1);
  assert.equal(body.unmatchedCount, 1);
  assert.equal(body.ready, false);
  assert.equal(body.fpm.length, 0);
});

// ---------------------------------------------------------------------------
// GET /api/fpm — app-type gating (Increment 7.8): unclassified and non-game
// rows are excluded from the lane even though HLTB-matched; they stay in D1
// (never deleted), just never render.
// ---------------------------------------------------------------------------

test("an unclassified (app_type NULL) matched row is excluded from the lane — 'unknown' means excluded here, not shown", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 200, name: "Never Classified", appType: null });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.matched, 1, "still counted as HLTB-matched in the D1-wide stats");
  assert.equal(body.fpm.length, 0, "but never shown while unclassified");

  const row = await env.FPM_DB.prepare("SELECT appid FROM fpm_catalog WHERE appid = 200").first();
  assert.ok(row, "the row must still exist in D1 — nothing is ever deleted");
});

test("a matched row classified 'demo' is excluded from the lane and stays in D1", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 1396240, name: "Contraband Police: Prologue", appType: "demo" });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.fpm.length, 0, "a classified non-game row must never render, even though it's HLTB-matched");

  const row = await env.FPM_DB.prepare("SELECT app_type FROM fpm_catalog WHERE appid = 1396240").first();
  assert.equal(row.app_type, "demo", "the classification persists in D1 — data is data, only rendering is gated");
});

test("a matched row classified 'dlc' is excluded from the lane; a 'game'-classified row alongside it still renders (mixed catalog)", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 211720, name: "Skyrim - Dawnguard", appType: "dlc" });
  await primeMatchedRow(env, { appid: 1245620, name: "ELDEN RING", appType: "game" });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.matched, 2, "both rows counted D1-wide");
  assert.deepEqual(body.fpm.map((e) => e.appid), [1245620], "only the game-classified row renders");
});

// ---------------------------------------------------------------------------
// GET /api/fpm — owned/deal annotation joins at request time, badge
// precedence, and the ?owned= tri-state filter.
// ---------------------------------------------------------------------------

test("owned annotation: a matched catalog row that's in the live owned set carries owned:true, price/cut null", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 1, name: "Owned Game" });
  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  // Even though this appid ALSO appears in the deal pool (with a real cut),
  // Owned must win — price/cut stay null.
  primeFpmPool(cache, [deal({ itadId: "itad-1", appid: 1, title: "Owned Game", cut: 80 })]);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  assert.equal(body.fpm.length, 1);
  const entry = body.fpm[0];
  assert.equal(entry.owned, true);
  assert.equal(entry.price, null);
  assert.equal(entry.cut, null);
  assert.equal(entry.atHistoricalLow, false);
});

test("?refresh=1 bypasses the cached owned status too, not just deal prices (review fix: the 'Refresh prices/owned' button must actually refresh owned)", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 1, name: "Maybe Owned Game" });
  // Stale library cache says appid 1 is NOT owned.
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const beforeRes = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const beforeBody = await beforeRes.json();
  assert.equal(beforeBody.fpm[0].owned, false, "stale cache says not owned");

  // The real Steam library (mocked upstream) now says it IS owned.
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetOwnedGames")) {
      return jsonResponse({ response: { games: [ownedGame({ appid: 1 })] } });
    }
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetItems")) {
      return jsonResponse({ response: { store_items: [] } });
    }
    if (u.pathname === "/deals/v2") return jsonResponse({ list: [], hasMore: false });
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const afterRes = await worker.fetch(new Request("https://x/api/fpm?refresh=1"), env, ctx);
  const afterBody = await afterRes.json();
  assert.equal(afterBody.fpm[0].owned, true, "refresh=1 must bypass the stale owned-status cache, not just deal prices");
});

test("deal annotation (Increment 8.5): an unowned matched row's price/cut come from its own D1 price-backfill columns; historicalLow still comes from the deal pool", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 200, name: "Portal 2" });
  await recordPriceResult(env, 200, { price: 4.99, priceCents: 499, regular: 19.99, cut: 75, itadId: "itad-200", checkedAtMs: 1000 });
  primeLibrary(cache, env, []);
  // Deliberately DIFFERENT cut/price than the D1 row above — proves price/
  // cut genuinely come from D1 now, not silently still from this pool.
  // historicalLow (out of scope this increment) is still sourced from here.
  primeFpmPool(cache, [
    deal({ itadId: "itad-200", appid: 200, title: "Portal 2", cut: 90, price: 1.99, atHistoricalLow: true, historicalLow: 4.99 }),
  ]);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  const entry = body.fpm[0];
  assert.equal(entry.owned, false);
  assert.equal(entry.cut, 75);
  assert.equal(entry.price, 4.99);
  assert.equal(entry.atHistoricalLow, true);
  assert.equal(entry.historicalLow, 4.99);
});

test("price-blind/no-price counts (Increment 8.5, gate a/f): distinguishes never-checked from checked-but-ITAD-has-no-deal, both unowned only", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 1, name: "Never checked" });
  await primeMatchedRow(env, { appid: 2, name: "Checked, priced" });
  await recordPriceResult(env, 2, { price: 9.99, priceCents: 999, regular: 19.99, cut: 50, itadId: "itad-2", checkedAtMs: 1000 });
  await primeMatchedRow(env, { appid: 3, name: "Checked, no live deal" });
  await recordPriceResult(env, 3, { price: null, priceCents: null, regular: null, cut: null, itadId: null, checkedAtMs: 1000 });
  await primeMatchedRow(env, { appid: 4, name: "Owned, never checked" });
  primeLibrary(cache, env, [ownedGame({ appid: 4 })]);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const body = await res.json();

  // appid 4 is owned — never counted either way, regardless of its own
  // (absent) price_checked_at, since a price is never displayed for it.
  assert.equal(body.priceBlindCount, 1, "only 'Never checked' (appid 1) is price-blind");
  assert.equal(body.noPriceCount, 1, "only 'Checked, no live deal' (appid 3) is a genuine no-price residual");
});

test("price-blind/no-price counts (review fix, round 1): stay at the real full-set numbers under ?owned=only and ?owned=hide, never silently 0", async () => {
  // Regression test for a review-caught bug: priceBlindCount/noPriceCount
  // used to be computed AFTER the ?owned= filter reassigned `annotated`,
  // so under ?owned=only (which narrows annotated to JUST owned rows) the
  // unowned-only counts silently came out 0 — wrong, not "no price-blind
  // rows left". Same fixture as the test above; only the query param and
  // the pre-fix-vs-post-fix expectation differ.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 1, name: "Never checked" });
  await primeMatchedRow(env, { appid: 2, name: "Checked, priced" });
  await recordPriceResult(env, 2, { price: 9.99, priceCents: 999, regular: 19.99, cut: 50, itadId: "itad-2", checkedAtMs: 1000 });
  await primeMatchedRow(env, { appid: 3, name: "Checked, no live deal" });
  await recordPriceResult(env, 3, { price: null, priceCents: null, regular: null, cut: null, itadId: null, checkedAtMs: 1000 });
  await primeMatchedRow(env, { appid: 4, name: "Owned, never checked" });
  primeLibrary(cache, env, [ownedGame({ appid: 4 })]);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();

  const onlyRes = await worker.fetch(new Request("https://x/api/fpm?owned=only"), env, ctx);
  const onlyBody = await onlyRes.json();
  assert.deepEqual(onlyBody.fpm.map((r) => r.title), ["Owned, never checked"], "sanity check: ?owned=only really did narrow the visible rows");
  assert.equal(onlyBody.priceBlindCount, 1, "?owned=only must not silently zero out the full-catalog price-blind count");
  assert.equal(onlyBody.noPriceCount, 1, "?owned=only must not silently zero out the full-catalog no-price count");

  const hideRes = await worker.fetch(new Request("https://x/api/fpm?owned=hide"), env, ctx);
  const hideBody = await hideRes.json();
  assert.equal(hideBody.fpm.length, 3, "sanity check: ?owned=hide really did narrow out the owned row");
  assert.equal(hideBody.priceBlindCount, 1);
  assert.equal(hideBody.noPriceCount, 1);
});

test("?owned=hide filters owned rows out; ?owned=only keeps only owned rows; default 'all' keeps both", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  await primeMatchedRow(env, { appid: 1, name: "Owned Game" });
  await primeMatchedRow(env, { appid: 200, name: "Portal 2" });
  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeFpmPool(cache, [deal({ itadId: "itad-200", appid: 200, title: "Portal 2" })]);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();

  const allRes = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const allBody = await allRes.json();
  assert.equal(allBody.fpm.length, 2);

  const hideRes = await worker.fetch(new Request("https://x/api/fpm?owned=hide"), env, ctx);
  const hideBody = await hideRes.json();
  assert.deepEqual(hideBody.fpm.map((e) => e.appid), [200]);

  const onlyRes = await worker.fetch(new Request("https://x/api/fpm?owned=only"), env, ctx);
  const onlyBody = await onlyRes.json();
  assert.deepEqual(onlyBody.fpm.map((e) => e.appid), [1]);
});

test("a bad ?owned= value falls back to 'all', never a 500", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await primeMatchedRow(env, { appid: 1, name: "Owned Game" });
  primeLibrary(cache, env, [ownedGame({ appid: 1 })]);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm?owned=banana"), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.fpm.length, 1);
});

// ---------------------------------------------------------------------------
// GET /api/fpm — scoring overrides (Increment 7.5, unchanged behaviour) —
// re-rank matched D1 rows with zero HLTB traffic (there's no HLTB call left
// anywhere in this route).
// ---------------------------------------------------------------------------

test("an unrecognized ?formula= falls back to the sqrt default, never a 500", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await primeMatchedRow(env, { appid: 200, name: "Portal 2" });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const bogusRes = await worker.fetch(new Request("https://x/api/fpm?formula=not-a-real-formula"), env, ctx);
  assert.equal(bogusRes.status, 200);
  const bogusBody = await bogusRes.json();

  const sqrtRes = await worker.fetch(new Request("https://x/api/fpm?formula=sqrt"), env, ctx);
  const sqrtBody = await sqrtRes.json();

  assert.equal(bogusBody.fpm[0].fpm, sqrtBody.fpm[0].fpm);
  assert.equal(bogusBody.fpm[0].why, sqrtBody.fpm[0].why);
});

test("?formula= flip re-ranks an already-matched row's score/why-line instantly", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await primeMatchedRow(env, { appid: 200, name: "Portal 2" });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const linearRes = await worker.fetch(new Request("https://x/api/fpm?formula=linear"), env, ctx);
  const linearBody = await linearRes.json();
  const logRes = await worker.fetch(new Request("https://x/api/fpm?formula=log"), env, ctx);
  const logBody = await logRes.json();

  assert.equal(linearBody.fpm[0].why.endsWith("fun/hr"), true);
  assert.equal(logBody.fpm[0].why.endsWith("· log ranking"), true);
  assert.equal(linearBody.fpm[0].funPerHour, logBody.fpm[0].funPerHour);
  assert.notEqual(linearBody.fpm[0].fpm, logBody.fpm[0].fpm);
});

test("non-numeric / out-of-range ?qexp=/?breadth= fall back to config defaults, never a 500", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await primeMatchedRow(env, { appid: 200, name: "Portal 2" });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const defaultRes = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const defaultBody = await defaultRes.json();

  const garbageRes = await worker.fetch(new Request("https://x/api/fpm?qexp=banana&breadth=nope"), env, ctx);
  assert.equal(garbageRes.status, 200);
  const garbageBody = await garbageRes.json();
  assert.equal(garbageBody.fpm[0].fpm, defaultBody.fpm[0].fpm);

  const outOfRangeRes = await worker.fetch(new Request("https://x/api/fpm?qexp=9999&breadth=-5"), env, ctx);
  const outOfRangeBody = await outOfRangeRes.json();
  assert.equal(outOfRangeBody.fpm[0].fpm, defaultBody.fpm[0].fpm);
});

// ---------------------------------------------------------------------------
// GET /api/fpm — enrichment (Deck/tags), incl. the enrich-cap fail-soft
// "unknown, not excluded" convention.
// ---------------------------------------------------------------------------

test("a catalog row with no cached SteamSpy tags yet still appears (unknown, not excluded)", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await primeMatchedRow(env, { appid: 200, name: "Portal 2" });
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  globalThis.fetch = stubGetItemsFetch();

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res.json();

  assert.equal(body.fpm.length, 1);
  assert.deepEqual(body.fpm[0].tagNames, []);
  assert.equal(body.fpm[0].batteryFriendly, false);
  assert.deepEqual(body.fpm[0].deck, { deck: 0, os: 0, frame: 0 });
});

test("enrichment cap (mirrors src/worker.js's private FPM_ENRICH_CAP=500, not exported — main-module constraint): rows past the cap never trigger a new SteamSpy/GetItems fetch, but already-cached data still shows and no row is excluded", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  const ENRICH_CAP = 500;
  const totalRows = ENRICH_CAP + 10;
  const baseAppid = 40000;

  // Seed matched rows with mainHours strictly increasing by index so the
  // fpm-score sort order is deterministic (all rows share identical
  // quality via primeMatchedRow's defaults, so fpm is strictly decreasing
  // as mainHours increases): index 0..499 is exactly the top-ENRICH_CAP
  // set, index 500..509 is past the cap.
  for (let i = 0; i < totalRows; i++) {
    await primeMatchedRow(env, { appid: baseAppid + i, name: `Catalog Game ${i}`, mainHours: 5 + i * 0.001 });
  }
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);

  // Prime SteamSpy tags for every WITHIN-cap appid so no new spy fetch is
  // needed there either — isolates this test to the Deck-compat cap, the
  // branch with actually-differing logic (getCachedSpy is already a free
  // read for every row regardless of cap; only enqueueSpyFetch's NEW-fetch
  // triggering is capped).
  for (let i = 0; i < ENRICH_CAP; i++) {
    env.TAG_CACHE.store.set(v2Key(baseAppid + i), JSON.stringify({ tags: { Indie: 1 } }));
  }
  const pastCapNoTagsAppid = baseAppid + ENRICH_CAP + 2; // index 502 — deliberately never cached

  // One past-cap appid has an already-primed Deck KV entry (proves
  // "cache-only, still shows real data" — no new fetch needed to surface
  // it); a different past-cap appid has NO Deck cache at all (proves
  // "unknown, not excluded" fail-soft).
  const pastCapPrimedDeckAppid = baseAppid + ENRICH_CAP + 5; // index 505
  env.TAG_CACHE.store.set(deckKey(pastCapPrimedDeckAppid), JSON.stringify({ deck: 3, os: 2, frame: 0 }));
  const pastCapUnprimedDeckAppid = baseAppid + ENRICH_CAP + 8; // index 508

  const getItemsCalls = [];
  let appdetailsCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetItems")) {
      const inputJson = JSON.parse(u.searchParams.get("input_json"));
      const appids = inputJson.ids.map((x) => x.appid);
      getItemsCalls.push(appids);
      return jsonResponse({
        response: { store_items: appids.map((appid) => ({ appid, platforms: { steam_deck_compat_category: 2 } })) },
      });
    }
    if (u.hostname === "steamspy.com" && u.searchParams.get("request") === "appdetails") {
      appdetailsCalls++;
      return jsonResponse({});
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const body = await res.json();

  assert.equal(body.fpm.length, totalRows, "every matched row is present regardless of the enrichment cap");

  const requestedAppids = new Set(getItemsCalls.flat());
  for (const appid of requestedAppids) {
    assert.ok(appid < baseAppid + ENRICH_CAP, `GetItems must never be called for a past-cap appid (got ${appid})`);
  }
  assert.equal(appdetailsCalls, 0, "a past-cap appid with no cached SteamSpy tags must never trigger a new SteamSpy fetch");

  const byAppid = new Map(body.fpm.map((e) => [e.appid, e]));

  const primedRow = byAppid.get(pastCapPrimedDeckAppid);
  assert.ok(primedRow, "a past-cap row must still be present, not excluded");
  assert.deepEqual(primedRow.deck, { deck: 3, os: 2, frame: 0 }, "a past-cap row's ALREADY-CACHED deck data must still surface (cache-only read)");

  const unprimedRow = byAppid.get(pastCapUnprimedDeckAppid);
  assert.ok(unprimedRow, "a past-cap row with no cached deck data must still be present (fail-soft, not excluded)");
  assert.deepEqual(unprimedRow.deck, { deck: 0, os: 0, frame: 0 }, "an uncached past-cap row shows the default 'unknown' compat shape");

  const noTagsRow = byAppid.get(pastCapNoTagsAppid);
  assert.ok(noTagsRow, "a past-cap row with no cached tags is still present");
  assert.deepEqual(noTagsRow.tagNames, [], "a past-cap row with no cached tags shows empty tagNames, never triggering a new SteamSpy fetch");
});

test("dismissal slot-freeing against the real FPM_ENRICH_CAP: a row just past the cap gets promoted into the enrichment budget once the top row is dismissed", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();

  const ENRICH_CAP = 500;
  const baseAppid = 50000;

  // 501 matched rows, mainHours strictly increasing by index (identical
  // quality via primeMatchedRow's defaults) so the fpm-score sort is
  // deterministic: index 0 is rank 1 (best), index 500 is rank 501 — the
  // FIRST row that falls just past FPM_ENRICH_CAP=500 and so, on a cold
  // cache, would NOT get a new SteamSpy fetch triggered for it.
  for (let i = 0; i <= ENRICH_CAP; i++) {
    await primeMatchedRow(env, { appid: baseAppid + i, name: `Slot Game ${i}`, mainHours: 5 + i * 0.001 });
  }
  primeLibrary(cache, env, []);
  primeFpmPool(cache, []);
  // Cold TAG_CACHE across the board — every fetch below is a genuinely NEW
  // one, so "did appid X get fetched this call" is unambiguous.

  const fetchedAppids = new Set();
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "steamspy.com" && u.searchParams.get("request") === "appdetails") {
      const appid = Number(u.searchParams.get("appid"));
      fetchedAppids.add(appid);
      return jsonResponse({}); // no usable tags — irrelevant to this test, we only care WHETHER a fetch happened
    }
    if (u.hostname === "api.steampowered.com" && u.pathname.includes("GetItems")) {
      const inputJson = JSON.parse(u.searchParams.get("input_json"));
      return jsonResponse({
        response: { store_items: inputJson.ids.map(({ appid }) => ({ appid, platforms: { steam_deck_compat_category: 0 } })) },
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const rank501Appid = baseAppid + ENRICH_CAP; // index 500 — one past the cap at baseline
  const ctx = makeCtx();

  // Baseline: rank501Appid is past the cap, so it must NOT get a new fetch.
  const before = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  await before.json();
  assert.equal(fetchedAppids.has(rank501Appid), false, "baseline: the 501st-ranked row is past FPM_ENRICH_CAP, no fetch triggered for it");

  // Dismiss the #1-ranked row (appid+0) — every other row's rank shifts up
  // by one, so what was rank 501 (rank501Appid) is now rank 500: INSIDE the
  // enrichment cap.
  await ensureDismissalsSchema(env);
  await addDismissal(env, baseAppid, "Slot Game 0");
  fetchedAppids.clear();

  const after = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  await ctx.flush();
  const afterBody = await after.json();

  assert.equal(afterBody.fpm.length, ENRICH_CAP, "the dismissed row is gone; 500 rows remain");
  assert.equal(
    fetchedAppids.has(rank501Appid),
    true,
    "promoted: now ranked 500th (inside the cap), the same row DOES trigger a new SteamSpy fetch this time",
  );
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

  const fpmRes = await worker.fetch(new Request("https://x/api/fpm"), env, ctx);
  const fpmBody = await fpmRes.json();
  assert.equal(fpmBody.fpm.length, 1);
  assert.equal(fpmBody.fpm[0].mainHours, 6.5);
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
