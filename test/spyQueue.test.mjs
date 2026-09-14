// QA TC-1 (increment 14) – unit tests for src/spyQueue.js.
//
// WHY THIS FILE EXISTS. Roughly 17 of test/worker-recs.test.mjs's 29 tests were
// spyQueue unit tests rather than /api/recs route tests, and increment 14
// deleted that file with the route. The module itself is very much alive:
// src/worker.js's /api/wishlist calls `enqueueSpyFetch`, and src/catalog.js's
// increment-9 tag backfill goes through `awaitSpySlot` for its pacing. Coverage
// went 100% -> 70% and five mutations that used to be caught went silently
// green. This file carries the module's own tests forward, free of the deleted
// route, so the loss does not recur.
//
// WHAT IS ASSERTED, AND WHY IT IS THE TTL AND NOT THE CALL. The 30d/24h/1h
// split is the whole point of the error/empty distinction (increment 4, inc-3
// flag 4): a SteamSpy blip must not strand a good game for a day. A test that
// only asserts "KV.put was called" passes with all three TTLs collapsed into
// one, which is exactly the regression the split exists to prevent – so every
// TTL assertion below reads the `expirationTtl` the mock KV recorded off the
// real `put` options argument.
//
// NEVER makes a real network call. The offline guard is installed as
// `globalThis.fetch` in beforeEach and asserted empty in afterEach, so a test
// that forgets its own stub fails loudly instead of reaching steamspy.com. The
// 1 req/sec pacing is shrunk via the module's `__setSpyMinIntervalMsForTests`
// seam, and the module-scoped queue is cleared between tests with
// `__resetSpyQueueForTests` – both are the same seams the deleted file used.

import test from "node:test";
import assert from "node:assert/strict";
import {
  TAG_CACHE_TTL_SECONDS,
  TAG_CACHE_FAIL_TTL_SECONDS,
  TAG_CACHE_ERROR_TTL_SECONDS,
  getCachedSpy,
  classifySpyResponse,
  parseOwnersMidpoint,
  computeSpyWaitMs,
  awaitSpySlot,
  enqueueSpyFetch,
  __setSpyMinIntervalMsForTests,
  __resetSpyQueueForTests,
} from "../src/spyQueue.js";
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";

let offlineGuard = makeOfflineFetchGuard("spyQueue");

/** Minimal in-memory stand-in for a Workers KV namespace binding. Records the
 * `expirationTtl` each put() was called with, so the 30d/24h/1h TTL split can
 * be asserted without a real KV clock. */
function makeMockKv() {
  const store = new Map();
  const ttlByKey = new Map();
  const putCalls = [];
  return {
    store,
    ttlByKey,
    putCalls,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      store.set(key, value);
      ttlByKey.set(key, opts?.expirationTtl);
      putCalls.push({ key, value, opts });
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
      // Drain repeatedly: the queue pump kicks itself via ctx.waitUntil, so a
      // single Promise.all pass is not always enough.
      let rounds = 0;
      while (pending.length > 0 && rounds < 20) {
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

function makeEnv(overrides = {}) {
  return { TAG_CACHE: makeMockKv(), ...overrides };
}

/** KV key helper matching src/spyQueue.js's v2 key scheme. */
function v2Key(appid) {
  return `v2:spytag:${appid}`;
}

/** A raw SteamSpy `appdetails` body that classifies cleanly. */
function goodSpyRaw(overrides = {}) {
  return {
    tags: { Roguelike: 10 },
    median_forever: 300,
    positive: 90,
    negative: 10,
    owners: "50,000 .. 100,000", // midpoint 75000
    ...overrides,
  };
}

test.beforeEach(() => {
  offlineGuard = makeOfflineFetchGuard("spyQueue");
  globalThis.fetch = offlineGuard;
  __setSpyMinIntervalMsForTests(0);
  __resetSpyQueueForTests();
});

test.afterEach(() => {
  const calls = [...offlineGuard.calls];
  globalThis.fetch = makeOfflineFetchGuard("spyQueue (between tests)");
  __setSpyMinIntervalMsForTests(1000);
  __resetSpyQueueForTests();
  assert.deepEqual(calls, [], "no test in this file may reach the network");
});

// ---------------------------------------------------------------------------
// classifySpyResponse – the trim, and the three ways a body classifies to null.
// ---------------------------------------------------------------------------

test("classifySpyResponse: a normal response with tags is trimmed to exactly {tags, median, reviews, owners}", () => {
  const raw = {
    tags: { Roguelike: 100 },
    median_forever: 600,
    positive: 90,
    negative: 10,
    owners: "10,000 .. 20,000",
    name: "Ignored Field",
    developer: "Also Ignored",
  };
  // deepEqual on the whole object, not field-by-field: an upstream field
  // leaking into the cached trio would pass a subset check happily.
  assert.deepEqual(classifySpyResponse(raw), {
    tags: { Roguelike: 100 },
    median: 600,
    reviews: { positive: 90, negative: 10 },
    owners: 15000,
  });
  assert.deepEqual(Object.keys(classifySpyResponse(raw)).sort(), [
    "median",
    "owners",
    "reviews",
    "tags",
  ]);
});

test("classifySpyResponse: missing median/positive/negative default to 0 rather than undefined", () => {
  const raw = { tags: { Roguelike: 100 }, owners: "10,000 .. 20,000" };
  assert.deepEqual(classifySpyResponse(raw), {
    tags: { Roguelike: 100 },
    median: 0,
    reviews: { positive: 0, negative: 0 },
    owners: 15000,
  });
});

test("classifySpyResponse: a missing owners field parses to 0, not a throw", () => {
  const raw = { tags: { Roguelike: 100 }, median_forever: 600, positive: 90, negative: 10 };
  assert.equal(classifySpyResponse(raw).owners, 0);
});

test("classifySpyResponse: a missing tags field entirely classifies to null", () => {
  assert.equal(classifySpyResponse({ median_forever: 0 }), null);
});

test("classifySpyResponse: an EMPTY tags object classifies to null (no usable tags is not 'zero tags')", () => {
  // Distinct from the missing-field case above and from the empty-array case
  // below: SteamSpy can answer 2xx with `tags: {}`, and an entry cached as an
  // empty tag map would score every similarity term against nothing forever.
  assert.equal(classifySpyResponse({ tags: {}, median_forever: 0, positive: 0, negative: 0 }), null);
});

test("classifySpyResponse: SteamSpy's empty-ARRAY tags (DLC/bundle/unknown appid) classifies to null", () => {
  // An array is a typeof "object", so the Array.isArray guard is the only
  // thing standing between this body and a cached `tags: []`.
  assert.equal(classifySpyResponse({ tags: [], median_forever: 0, positive: 0, negative: 0 }), null);
  // A NON-empty array is the case that isolates that guard: without
  // Array.isArray it sails past the key-count check and gets cached as a tag
  // map whose "tag names" are the indices 0, 1, 2.
  assert.equal(
    classifySpyResponse({ tags: ["Roguelike", "Action"], median_forever: 0, positive: 0, negative: 0 }),
    null,
  );
});

test("classifySpyResponse: a non-object body classifies to null without throwing", () => {
  assert.equal(classifySpyResponse(null), null);
  assert.equal(classifySpyResponse(undefined), null);
  assert.equal(classifySpyResponse(0), null);
  assert.equal(classifySpyResponse(""), null);
  assert.equal(classifySpyResponse("not json at all"), null);
  assert.equal(classifySpyResponse(42), null);
  assert.equal(classifySpyResponse(true), null);
});

// ---------------------------------------------------------------------------
// parseOwnersMidpoint – SteamSpy's "10,000 .. 20,000" owners-range string.
// ---------------------------------------------------------------------------

test("parseOwnersMidpoint: parses a '..'-separated comma-thousands range to its midpoint", () => {
  assert.equal(parseOwnersMidpoint("10,000 .. 20,000"), 15000);
});

test("parseOwnersMidpoint: parses a '-'-separated range too", () => {
  assert.equal(parseOwnersMidpoint("10,000 - 20,000"), 15000);
});

test("parseOwnersMidpoint: an unparseable, empty or non-string value returns 0", () => {
  assert.equal(parseOwnersMidpoint("who knows"), 0);
  assert.equal(parseOwnersMidpoint(""), 0);
  assert.equal(parseOwnersMidpoint(undefined), 0);
  assert.equal(parseOwnersMidpoint(null), 0);
  assert.equal(parseOwnersMidpoint(15000), 0); // already a number, but not the contract
});

// ---------------------------------------------------------------------------
// getCachedSpy – "never fetched" vs "fetched, nothing usable" are different
// answers, and the whole null-caching scheme rests on telling them apart.
// ---------------------------------------------------------------------------

test("getCachedSpy: a real KV miss reports {cached:false, data:undefined}", async () => {
  const env = makeEnv();
  assert.deepEqual(await getCachedSpy(env, 440), { cached: false, data: undefined });
});

test("getCachedSpy: a cached FAILURE (the literal text 'null') reports {cached:true, data:null}, not a miss", async () => {
  // This is the distinction the 24h/1h negative caching depends on. If a
  // cached null read back as a miss, every DLC and bundle would be refetched
  // on every pass and the TTLs below would never do anything.
  const env = makeEnv();
  await env.TAG_CACHE.put(v2Key(440), "null");
  assert.deepEqual(await getCachedSpy(env, 440), { cached: true, data: null });
});

test("getCachedSpy: reads under the v2 key – a pre-v2 `spytag:` entry is a miss, not a misread", async () => {
  // Increment 4 bumped the key because the cached shape gained `owners`. The
  // old entry must be stepped over rather than read back ownerless.
  const env = makeEnv();
  env.TAG_CACHE.store.set("spytag:440", JSON.stringify({ tags: { Roguelike: 10 }, median: 300 }));
  assert.deepEqual(await getCachedSpy(env, 440), { cached: false, data: undefined });
});

// ---------------------------------------------------------------------------
// computeSpyWaitMs – the pure pacing formula, covered directly so the queue
// tests below don't have to burn real wall-clock seconds proving arithmetic.
// ---------------------------------------------------------------------------

test("computeSpyWaitMs: no wait if this is the first call ever (lastFetchAt falsy)", () => {
  assert.equal(computeSpyWaitMs(0, Date.now(), 1000), 0);
});

test("computeSpyWaitMs: no wait once the interval has already elapsed", () => {
  const now = 10_000;
  assert.equal(computeSpyWaitMs(now - 1000, now, 1000), 0); // exactly at the boundary
  assert.equal(computeSpyWaitMs(now - 2000, now, 1000), 0);
});

test("computeSpyWaitMs: waits the remainder of the interval otherwise", () => {
  const now = 10_000;
  assert.equal(computeSpyWaitMs(now - 400, now, 1000), 600);
  assert.equal(computeSpyWaitMs(now - 999, now, 1000), 1);
});

// ---------------------------------------------------------------------------
// awaitSpySlot – the SHARED reservation src/catalog.js's tag backfill uses.
// Nothing in src/worker.js calls it directly, which is precisely why it needs
// its own test rather than riding on a route's.
// ---------------------------------------------------------------------------

test("awaitSpySlot: two back-to-back reservations are spaced by the interval, not concurrent", async () => {
  __setSpyMinIntervalMsForTests(40);
  const before = Date.now();
  await awaitSpySlot();
  await awaitSpySlot();
  const elapsed = Date.now() - before;
  // The first slot is free (no prior stamp); the second pays the interval.
  assert.ok(elapsed >= 30, `two reservations took ${elapsed}ms, expected at least ~40ms of pacing`);
});

// ---------------------------------------------------------------------------
// enqueueSpyFetch / pumpSpyQueue – the queue wiring: dedupe, pacing, and one
// fetch per appid no matter how many times it is enqueued.
// ---------------------------------------------------------------------------

test("enqueueSpyFetch: each appid is fetched EXACTLY ONCE across re-enqueues", async () => {
  __setSpyMinIntervalMsForTests(20);
  const fetchedAppids = [];
  globalThis.fetch = async (url) => {
    fetchedAppids.push(new URL(url).searchParams.get("appid"));
    return jsonResponse(goodSpyRaw());
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2]);
  enqueueSpyFetch(env, ctx, [2, 3]); // appid 2 is already queued
  enqueueSpyFetch(env, ctx, [2, 3]); // and again, for good measure
  await ctx.flush();

  // Counted per appid, not just in total: a dedupe that dropped 3 and fetched
  // 1 twice would keep the total at three.
  assert.deepEqual(fetchedAppids.sort(), ["1", "2", "3"]);
  assert.equal(fetchedAppids.length, 3, `expected 3 fetches, got ${fetchedAppids.length}`);
});

test("enqueueSpyFetch: an appid enqueued again AFTER the queue drained is fetched again", async () => {
  // The other side of the dedupe contract, and a real subtlety worth pinning:
  // `spyQueued` is cleared as each appid is SHIFTED OFF, not when its fetch
  // finishes, so the dedupe window is "still waiting in the queue", not "ever
  // seen". A permanent set would silently stop the tag backfill ever
  // refreshing anything, so this behaviour is deliberate – and it means an
  // appid re-enqueued after it has drained is fetched again, which is what
  // this test holds.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse(goodSpyRaw());
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [7]);
  await ctx.flush();
  assert.equal(calls, 1);

  enqueueSpyFetch(env, ctx, [7]);
  await ctx.flush();
  assert.equal(calls, 2, "a drained appid must be refetchable, not blocked forever");
});

test("enqueueSpyFetch/pumpSpyQueue: queued appids are serialised and paced apart, not fired concurrently", async () => {
  __setSpyMinIntervalMsForTests(40);
  const timestamps = [];
  globalThis.fetch = async () => {
    timestamps.push(Date.now());
    return jsonResponse(goodSpyRaw());
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2, 3]);
  await ctx.flush();

  assert.equal(timestamps.length, 3);
  // Scheduler slack allowed, but concurrent firing would make these gaps ~0ms.
  assert.ok(timestamps[1] - timestamps[0] >= 30, `gap 0->1 was ${timestamps[1] - timestamps[0]}ms`);
  assert.ok(timestamps[2] - timestamps[1] >= 30, `gap 1->2 was ${timestamps[2] - timestamps[1]}ms`);
});

test("enqueueSpyFetch: an empty appid list starts no pump and touches neither fetch nor KV", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, []);
  await ctx.flush();
  assert.deepEqual(env.TAG_CACHE.putCalls, []);
});

// ---------------------------------------------------------------------------
// The TTL split (increment 4, inc-3 flag 4): 30d success / 24h empty / 1h
// error. Asserted on the `expirationTtl` argument KV.put actually received –
// "put was called" would pass with all three collapsed into one value.
// ---------------------------------------------------------------------------

test("pumpSpyQueue TTLs: a successful classification is cached for 30 days", async () => {
  globalThis.fetch = async () => jsonResponse(goodSpyRaw());

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1]);
  await ctx.flush();

  assert.equal(TAG_CACHE_TTL_SECONDS, 30 * 24 * 60 * 60);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get(v2Key(1))).tags.Roguelike, 10);
  assert.equal(
    env.TAG_CACHE.ttlByKey.get(v2Key(1)),
    TAG_CACHE_TTL_SECONDS,
    "a good SteamSpy answer must be cached on the long 30d TTL",
  );
  // The TTL really did arrive as put()'s third-argument option, not by luck.
  assert.deepEqual(env.TAG_CACHE.putCalls[0].opts, { expirationTtl: TAG_CACHE_TTL_SECONDS });
});

test("pumpSpyQueue TTLs: a genuinely empty 2xx (no usable tags) is cached null for 24h, NOT 30d and NOT 1h", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ tags: [], median_forever: 0, positive: 0, negative: 0 });

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1]);
  await ctx.flush();

  assert.equal(TAG_CACHE_FAIL_TTL_SECONDS, 24 * 60 * 60);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get(v2Key(1))), null);
  assert.equal(env.TAG_CACHE.ttlByKey.get(v2Key(1)), TAG_CACHE_FAIL_TTL_SECONDS);
  assert.notEqual(env.TAG_CACHE.ttlByKey.get(v2Key(1)), TAG_CACHE_TTL_SECONDS);
  assert.notEqual(env.TAG_CACHE.ttlByKey.get(v2Key(1)), TAG_CACHE_ERROR_TTL_SECONDS);
});

test("pumpSpyQueue TTLs: a non-2xx response is cached null for only 1h, and the queue keeps going", async () => {
  globalThis.fetch = async (url) => {
    const appid = new URL(url).searchParams.get("appid");
    if (appid === "1") return new Response("server error", { status: 500 });
    return jsonResponse(goodSpyRaw());
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2]);
  await ctx.flush();

  assert.equal(TAG_CACHE_ERROR_TTL_SECONDS, 60 * 60);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get(v2Key(1))), null);
  assert.equal(env.TAG_CACHE.ttlByKey.get(v2Key(1)), TAG_CACHE_ERROR_TTL_SECONDS);
  assert.notEqual(
    env.TAG_CACHE.ttlByKey.get(v2Key(1)),
    TAG_CACHE_FAIL_TTL_SECONDS,
    "a SteamSpy blip cached for 24h strands a good game for a day – that is the bug this split closes",
  );
  // appid 2, queued behind the failure, must still be processed on the long TTL.
  assert.equal(JSON.parse(env.TAG_CACHE.store.get(v2Key(2))).tags.Roguelike, 10);
  assert.equal(env.TAG_CACHE.ttlByKey.get(v2Key(2)), TAG_CACHE_TTL_SECONDS);
});

test("pumpSpyQueue TTLs: a THROWN network error is cached null for 1h too, and does not wedge the queue", async () => {
  globalThis.fetch = async (url) => {
    const appid = new URL(url).searchParams.get("appid");
    if (appid === "1") throw new Error("ECONNRESET");
    return jsonResponse(goodSpyRaw());
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1, 2]);
  await ctx.flush();

  assert.equal(JSON.parse(env.TAG_CACHE.store.get(v2Key(1))), null);
  assert.equal(env.TAG_CACHE.ttlByKey.get(v2Key(1)), TAG_CACHE_ERROR_TTL_SECONDS);
  assert.equal(JSON.parse(env.TAG_CACHE.store.get(v2Key(2))).tags.Roguelike, 10);
  assert.equal(env.TAG_CACHE.ttlByKey.get(v2Key(2)), TAG_CACHE_TTL_SECONDS);
});

test("pumpSpyQueue TTLs: an unparsable 2xx body is an ERROR (1h), not an empty answer (24h)", async () => {
  // `res.json()` throwing lands in the same catch as a network failure, which
  // is the right call – a mangled body says nothing about whether SteamSpy has
  // tags for this appid, so it must be retried soon.
  globalThis.fetch = async () => new Response("<html>not json</html>", { status: 200 });

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [1]);
  await ctx.flush();

  assert.equal(JSON.parse(env.TAG_CACHE.store.get(v2Key(1))), null);
  assert.equal(env.TAG_CACHE.ttlByKey.get(v2Key(1)), TAG_CACHE_ERROR_TTL_SECONDS);
});

test("pumpSpyQueue: the outgoing request is SteamSpy's appdetails endpoint for that exact appid, under the v2 key", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return jsonResponse(goodSpyRaw());
  };

  const env = makeEnv();
  const ctx = makeCtx();
  enqueueSpyFetch(env, ctx, [440]);
  await ctx.flush();

  assert.equal(urls.length, 1);
  assert.equal(urls[0].hostname, "steamspy.com");
  assert.equal(urls[0].pathname, "/api.php");
  assert.equal(urls[0].searchParams.get("request"), "appdetails");
  assert.equal(urls[0].searchParams.get("appid"), "440");
  // The write lands under the v2 key, so getCachedSpy finds it next pass.
  assert.deepEqual([...env.TAG_CACHE.store.keys()], [v2Key(440)]);
  assert.deepEqual(await getCachedSpy(env, 440), {
    cached: true,
    data: { tags: { Roguelike: 10 }, median: 300, reviews: { positive: 90, negative: 10 }, owners: 75000 },
  });
});
