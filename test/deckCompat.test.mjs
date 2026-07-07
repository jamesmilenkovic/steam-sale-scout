// Tests for src/deckCompat.js — Steam Deck compat parsing + the batched
// GetItems fetch/cache (Increment 5).
//
// NEVER makes a real network call — globalThis.fetch is stubbed per test and
// restored afterward, mirroring test/worker-recs.test.mjs's style.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DECK_CACHE_TTL_SECONDS,
  DECK_CACHE_ERROR_TTL_SECONDS,
  DECK_BATCH_SIZE,
  DEFAULT_DECK_COMPAT,
  parseDeckCompat,
  deckBadge,
  deckCompatFromLegacyReport,
  resolveDeckCompat,
} from "../src/deckCompat.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Minimal in-memory stand-in for a Workers KV namespace binding, mirroring
 * test/worker-recs.test.mjs's makeMockKv(). */
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// parseDeckCompat — the per-device {deck, os, frame} shape (SPEC-NOTE:
// Deck/OS/Frame, not the spec's guessed Deck/Machine/Frame).
// ---------------------------------------------------------------------------

test("parseDeckCompat: reads the three per-device categories from platforms", () => {
  const storeItem = {
    appid: 1145360,
    platforms: {
      steam_deck_compat_category: 3,
      steam_os_compat_category: 3,
      steam_frame_compat_category: 0,
    },
  };
  assert.deepEqual(parseDeckCompat(storeItem), { deck: 3, os: 3, frame: 0 });
});

test("parseDeckCompat: missing platforms/fields default every device to 0 (Unknown)", () => {
  assert.deepEqual(parseDeckCompat({}), { deck: 0, os: 0, frame: 0 });
  assert.deepEqual(parseDeckCompat({ platforms: {} }), { deck: 0, os: 0, frame: 0 });
  assert.deepEqual(parseDeckCompat(null), { deck: 0, os: 0, frame: 0 });
  assert.deepEqual(parseDeckCompat(undefined), { deck: 0, os: 0, frame: 0 });
});

test("parseDeckCompat: a partially-populated platforms object only defaults the missing fields", () => {
  const storeItem = { platforms: { steam_deck_compat_category: 2 } };
  assert.deepEqual(parseDeckCompat(storeItem), { deck: 2, os: 0, frame: 0 });
});

// ---------------------------------------------------------------------------
// deckBadge
// ---------------------------------------------------------------------------

test("deckBadge: 3 -> verified, 2 -> playable, 0/1/other -> null", () => {
  assert.equal(deckBadge(3), "verified");
  assert.equal(deckBadge(2), "playable");
  assert.equal(deckBadge(1), null);
  assert.equal(deckBadge(0), null);
  assert.equal(deckBadge(undefined), null);
});

// ---------------------------------------------------------------------------
// deckCompatFromLegacyReport — documented-but-unused fallback parser.
// ---------------------------------------------------------------------------

test("deckCompatFromLegacyReport: reads results.resolved_category, defaulting to 0", () => {
  assert.equal(deckCompatFromLegacyReport({ results: { resolved_category: 3 } }), 3);
  assert.equal(deckCompatFromLegacyReport({}), 0);
  assert.equal(deckCompatFromLegacyReport(null), 0);
});

// ---------------------------------------------------------------------------
// resolveDeckCompat — batched fetch + KV cache.
// ---------------------------------------------------------------------------

function storeItemsResponse(entries) {
  // entries: [[appid, {deck, os, frame}], ...]
  return jsonResponse({
    response: {
      store_items: entries.map(([appid, compat]) => ({
        appid,
        platforms: {
          steam_deck_compat_category: compat.deck,
          steam_os_compat_category: compat.os,
          steam_frame_compat_category: compat.frame,
        },
      })),
    },
  });
}

test("resolveDeckCompat: fetches uncached appids, caches for 30d, returns the parsed map", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = new URL(url);
    const input = JSON.parse(u.searchParams.get("input_json"));
    assert.deepEqual(
      input.ids.map((i) => i.appid),
      [1145360, 1174180],
    );
    assert.equal(input.data_request.include_platforms, true);
    return storeItemsResponse([
      [1145360, { deck: 3, os: 3, frame: 0 }],
      [1174180, { deck: 2, os: 2, frame: 0 }],
    ]);
  };

  const env = { TAG_CACHE: makeMockKv() };
  const result = await resolveDeckCompat(env, [1145360, 1174180]);

  assert.equal(calls, 1);
  assert.deepEqual(result.get(1145360), { deck: 3, os: 3, frame: 0 });
  assert.deepEqual(result.get(1174180), { deck: 2, os: 2, frame: 0 });
  assert.equal(env.TAG_CACHE.ttlByKey.get("deck:1145360"), DECK_CACHE_TTL_SECONDS);
  assert.equal(env.TAG_CACHE.ttlByKey.get("deck:1174180"), DECK_CACHE_TTL_SECONDS);
});

test("resolveDeckCompat: a cached appid is served from KV, no fetch call for it", async () => {
  const env = { TAG_CACHE: makeMockKv() };
  env.TAG_CACHE.store.set("deck:1145360", JSON.stringify({ deck: 3, os: 3, frame: 0 }));

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return storeItemsResponse([[1174180, { deck: 2, os: 2, frame: 0 }]]);
  };

  const result = await resolveDeckCompat(env, [1145360, 1174180]);

  assert.equal(calls, 1); // only the uncached appid triggers a fetch
  assert.deepEqual(result.get(1145360), { deck: 3, os: 3, frame: 0 });
  assert.deepEqual(result.get(1174180), { deck: 2, os: 2, frame: 0 });
});

test("resolveDeckCompat: an appid GetItems has nothing for defaults to DEFAULT_DECK_COMPAT", async () => {
  globalThis.fetch = async () => storeItemsResponse([]); // no entries at all
  const env = { TAG_CACHE: makeMockKv() };

  const result = await resolveDeckCompat(env, [999]);
  assert.deepEqual(result.get(999), DEFAULT_DECK_COMPAT);
});

test("resolveDeckCompat: a non-2xx response caches DEFAULT_DECK_COMPAT with the short error TTL, without throwing", async () => {
  globalThis.fetch = async () => new Response("server error", { status: 500 });
  const env = { TAG_CACHE: makeMockKv() };

  const result = await resolveDeckCompat(env, [1]);
  assert.deepEqual(result.get(1), DEFAULT_DECK_COMPAT);
  assert.equal(env.TAG_CACHE.ttlByKey.get("deck:1"), DECK_CACHE_ERROR_TTL_SECONDS);
});

test("resolveDeckCompat: a thrown network error caches DEFAULT_DECK_COMPAT with the short error TTL, without throwing", async () => {
  globalThis.fetch = async () => {
    throw new Error("ECONNRESET");
  };
  const env = { TAG_CACHE: makeMockKv() };

  const result = await resolveDeckCompat(env, [1]);
  assert.deepEqual(result.get(1), DEFAULT_DECK_COMPAT);
  assert.equal(env.TAG_CACHE.ttlByKey.get("deck:1"), DECK_CACHE_ERROR_TTL_SECONDS);
});

test("resolveDeckCompat: chunks into batches of DECK_BATCH_SIZE", async () => {
  const appids = Array.from({ length: DECK_BATCH_SIZE + 1 }, (_, i) => i + 1);
  const batchSizes = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const input = JSON.parse(u.searchParams.get("input_json"));
    batchSizes.push(input.ids.length);
    return storeItemsResponse(input.ids.map((i) => [i.appid, { deck: 3, os: 0, frame: 0 }]));
  };
  const env = { TAG_CACHE: makeMockKv() };

  const result = await resolveDeckCompat(env, appids);
  assert.deepEqual(batchSizes, [DECK_BATCH_SIZE, 1]);
  assert.equal(result.size, DECK_BATCH_SIZE + 1);
});

test("resolveDeckCompat: empty appid list makes no fetch call", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return storeItemsResponse([]);
  };
  const env = { TAG_CACHE: makeMockKv() };
  const result = await resolveDeckCompat(env, []);
  assert.equal(calls, 0);
  assert.equal(result.size, 0);
});
