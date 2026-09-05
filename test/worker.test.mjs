// Tests for src/worker.js — the /api/library route, with a MOCKED upstream.
//
// worker.js only exports `default.fetch` (no individually-exported route
// function), so these tests drive the route through the top-level fetch
// handler with a Request for /api/library, exactly as the runtime would.
// TESTABILITY NOTE: because handleLibrary/trimGame/jsonError are private to
// the module, we can only assert on the HTTP-visible surface (status, body,
// headers) — that's sufficient for every criterion the spec lists, so this
// is a note, not a blocker.
//
// The Workers-only globals `caches` and `fetch` are not present in plain
// Node, so each test stubs `globalThis.fetch` and `globalThis.caches.default`
// with minimal in-memory fakes and restores the originals afterward.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

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

function makeEnv(overrides = {}) {
  return {
    STEAM_API_KEY: "test-key",
    STEAM_ID: "76561198000000000",
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

function upstreamOk(body) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const RAW_GAME = {
  appid: 440,
  name: "Team Fortress 2",
  img_icon_url: "abc123icon",
  img_logo_url: "abc123logo", // upstream-only, must NOT leak
  playtime_forever: 600,
  playtime_2weeks: 30,
  rtime_last_played: 1750000000,
  has_community_visible_stats: true, // upstream-only, must NOT leak
  playtime_windows_forever: 500, // upstream-only, must NOT leak
  // Increment 12.5: Steam sends this without being asked, and it is now one of
  // the seven fields trimGame keeps. Measured on the live library 2026-09-05:
  // 42 owned games carry it, and every one of them is already inside the 45
  // that `rtime_last_played` recovers, so it recovers nothing today. It is a
  // played SIGNAL only and is NEVER added into the displayed hours.
  playtime_disconnected: 45,
};

const EXPECTED_KEYS = [
  "appid",
  "name",
  "img_icon_url",
  "playtime_forever",
  "playtime_2weeks",
  "rtime_last_played",
  "playtime_disconnected",
].sort();

test.afterEach(() => {
  restoreGlobals();
});

test("trims each game to exactly the seven allowed fields, no upstream extras leak", async () => {
  globalThis.fetch = upstreamOk({ response: { games: [RAW_GAME] } });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.games.length, 1);

  const game = body.games[0];
  assert.deepEqual(Object.keys(game).sort(), EXPECTED_KEYS);
  assert.equal(game.appid, 440);
  assert.equal(game.name, "Team Fortress 2");
  assert.equal(game.img_icon_url, "abc123icon");
  assert.equal(game.playtime_forever, 600);
  assert.equal(game.playtime_2weeks, 30);
  assert.equal(game.rtime_last_played, 1750000000);
  assert.equal(game.playtime_disconnected, 45);
  assert.equal("img_logo_url" in game, false);
  assert.equal("has_community_visible_stats" in game, false);
  assert.equal("playtime_windows_forever" in game, false);
});

test("sets cache-control: public, max-age=86400 on a successful 200", async () => {
  globalThis.fetch = upstreamOk({ response: { games: [RAW_GAME] } });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);
  await ctx.flush();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=86400");
});

test("missing STEAM_API_KEY returns a 500 with a clear message, without touching fetch", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("should not be called", { status: 200 });
  };
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ STEAM_API_KEY: undefined });
  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /STEAM_API_KEY/);
  assert.equal(fetchCalls, 0);
});

test("missing STEAM_ID returns a 500 with a clear message", async () => {
  globalThis.fetch = async () => new Response("should not be called", { status: 200 });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv({ STEAM_ID: undefined });
  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /STEAM_API_KEY|STEAM_ID/);
});

test("empty games array returns the private-profile hint error (502)", async () => {
  globalThis.fetch = upstreamOk({ response: { games: [] } });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /privacy/i);
});

test("absent games key returns the private-profile hint error (502)", async () => {
  globalThis.fetch = upstreamOk({ response: {} });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /privacy/i);
});

test("upstream non-200 surfaces a 502 mentioning the upstream status", async () => {
  globalThis.fetch = async () => new Response("forbidden", { status: 403 });
  globalThis.caches = { default: makeMockCache() };

  const env = makeEnv();
  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /403/);
});

test("cache hit returns the cached response and does not call fetch again", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ response: { games: [RAW_GAME] } }), {
      status: 200,
    });
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  const cacheKey = `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}&v=2`;
  cache.store.set(
    cacheKey,
    new Response(JSON.stringify({ games: [{ appid: 1, name: "cached-hit" }] }), {
      status: 200,
      headers: { "cache-control": "public, max-age=86400" },
    }),
  );

  const ctx = makeCtx();
  const req = new Request("https://x/api/library");
  const res = await worker.fetch(req, env, ctx);

  assert.equal(fetchCalls, 0);
  const body = await res.json();
  assert.equal(body.games[0].name, "cached-hit");
});

test("12.5 TC-5: a v=1 payload cached BEFORE the increment is MISSED, not served – the trap the version bump exists to close", async () => {
  // THE TRAP, IN ITS OWN WORDS. A library payload cached before 12.5 has no
  // `playtime_disconnected` key, so a game whose only play evidence is that
  // field reads "no play recorded" for up to 24 hours, and the symptom looks
  // exactly like the new code not working. The bump is what removes it.
  //
  // Until now the bump was pinned by nothing but five test helpers hardcoding
  // `&v=2` in a seed string – all of which would happily follow the constant
  // down to 1 and stay green. This test seeds the OLD key with the OLD shape
  // and asserts the worker steps over it.
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ response: { games: [RAW_GAME] } }), { status: 200 });
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  const oldKey = `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}&v=1`;
  const newKey = `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}&v=2`;

  // The pre-12.5 payload, verbatim: six keys, and `playtime_disconnected` is
  // not one of them. This is one of the 42 – its ONLY play evidence is the
  // field the old shape does not carry.
  const staleGame = {
    appid: 440,
    name: "Team Fortress 2",
    img_icon_url: "abc123icon",
    playtime_forever: 0,
    playtime_2weeks: 0,
    rtime_last_played: 0,
  };
  assert.equal("playtime_disconnected" in staleGame, false, "the stale fixture must genuinely lack the field");
  cache.store.set(
    oldKey,
    new Response(JSON.stringify({ games: [staleGame] }), {
      status: 200,
      headers: { "cache-control": "public, max-age=86400" },
    }),
  );

  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://x/api/library"), env, ctx);
  await ctx.flush();

  // 1. The stale entry was not served, and the upstream WAS re-hit.
  assert.equal(fetchCalls, 1, "the v=1 entry was served, so the version bump does nothing");
  const body = await res.json();

  // 2. What came back carries the field, so derivePlayed can see the evidence.
  assert.equal(body.games.length, 1);
  assert.equal(body.games[0].playtime_disconnected, 45);
  assert.deepEqual(Object.keys(body.games[0]).sort(), EXPECTED_KEYS);

  // 3. The fresh payload is written under the NEW key, and the old entry is
  //    left where it is to expire on its own rather than being rewritten.
  assert.equal(cache.store.has(newKey), true, "the refetch was not cached under the bumped key");
  assert.equal(
    JSON.parse(await cache.store.get(newKey).clone().text()).games[0].playtime_disconnected,
    45,
  );
  assert.equal(
    JSON.parse(await cache.store.get(oldKey).clone().text()).games[0].name,
    "Team Fortress 2",
  );
});

test("?refresh=1 bypasses the cache and re-hits the upstream", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ response: { games: [RAW_GAME] } }), {
      status: 200,
    });
  };
  const cache = makeMockCache();
  globalThis.caches = { default: cache };

  const env = makeEnv();
  const cacheKey = `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}&v=2`;
  cache.store.set(
    cacheKey,
    new Response(JSON.stringify({ games: [{ appid: 1, name: "stale-cached" }] }), {
      status: 200,
    }),
  );

  const ctx = makeCtx();
  const req = new Request("https://x/api/library?refresh=1");
  const res = await worker.fetch(req, env, ctx);
  await ctx.flush();

  assert.equal(fetchCalls, 1);
  const body = await res.json();
  assert.equal(body.games[0].appid, 440); // fresh data, not the stale cache entry
});
