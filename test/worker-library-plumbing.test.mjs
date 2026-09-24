// QA TC-2 (increment 14) – src/worker.js's surviving library plumbing:
// `trimGame`, `libraryCacheKey` and `fetchOwnedGames`.
//
// WHY THIS FILE EXISTS. SPEC.md §2.3 keeps these three precisely because they
// feed `loadLibraryForRank`, which `handleRank` calls. Their only tripwire was
// in test/worker.test.mjs – the deleted `/api/library` suite – so after
// increment 14 `trimGame` sat at 0% coverage: making it leak every upstream
// field failed 30 tests before the deletion and 0 after. This file re-points
// the same tripwire at the route that still uses it.
//
// HOW IT REACHES THE CODE. Every other worker test PRE-SEEDS the library into
// the mock Cache API, which is exactly what keeps `fetchOwnedGames` and
// `trimGame` dark – a warm cache never calls either. So this file leaves the
// cache COLD and stubs the Steam upstream instead, which is the only path that
// runs the real fetch-and-trim.
//
// WHERE THE KEY SET IS ASSERTED, AND WHY. `trimGame`'s output is not returned
// verbatim by any surviving route – /api/rank consumes it and returns its own
// row shape. What IS verbatim is the payload `loadLibraryForRank` writes into
// the Cache API: `{games: trimmed}`. That cache entry is therefore where the
// exhaustive key-set assertion goes, and it is EXHAUSTIVE (a sorted deepEqual
// of every key) rather than a subset check, because a subset check passes
// happily while `img_logo_url`, `has_community_visible_stats` and the six
// per-platform playtime fields ride along beside it – into a cache, for 24
// hours, on a worker with no authentication.
//
// A KNOWN LIMIT, STATED PLAINLY. `fetchOwnedGames` throws four distinct
// `.status = 502` errors with four distinct messages, and after increment 14
// BOTH surviving callers (`loadLibraryForRank` and `getOwnedAppIds`) swallow
// the throw – one returns `[]`, the other an empty Set. So those messages have
// no HTTP surface left anywhere in the worker, and no black-box test can
// assert them. What this file asserts instead is the behaviour that IS
// observable and that actually matters to the user: each failure degrades
// rather than 500s, nothing bad is written to the cache, and /api/rank says so
// in its `notice`. See the QA report for increment 14.
//
// NEVER makes a real network call.

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
import { ensureCatalogSchema } from "../src/catalog.js";
import { __resetCatalogMemoForTests } from "../src/catalogCache.js";

const originalCaches = globalThis.caches;
let offlineGuard = makeOfflineFetchGuard("worker-library-plumbing");

function restoreGlobals() {
  globalThis.fetch = makeOfflineFetchGuard("worker-library-plumbing (between tests)");
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
      while (pending.length > 0 && rounds < 20) {
        await Promise.all(pending.splice(0, pending.length));
        rounds++;
      }
    },
  };
}

// Increment 15, SPEC.md §11.1/§11.2: THE LIBRARY IS NOW FETCHED AND CACHED FOR
// WHOEVER IS SIGNED IN. Both the cache key and the upstream `steamid` carry the
// SESSION'S id, not an `env` constant, so this file's one id is the session's.
// The owner id below still exists on the env because it is a real deploy-time
// constant (the sync pipeline uses it, SPEC.md §11.4) - it is simply no longer
// what /api/library or /api/rank read.
const SESSION_STEAM_ID = TEST_STEAM_ID;
const OWNER_STEAM_ID = "76561198000000000";

/** The cache key `libraryCacheKey()` builds, spelled out here rather than
 * imported (worker.js exports nothing but `default.fetch`). `v=2` is
 * LIBRARY_CACHE_VERSION, bumped at increment 12.5 when `trimGame` gained
 * `playtime_disconnected`. */
const LIBRARY_CACHE_KEY = `https://steam-sale-scout.cache/api/library?steamid=${SESSION_STEAM_ID}&v=2`;
const LIBRARY_CACHE_KEY_V1 = `https://steam-sale-scout.cache/api/library?steamid=${SESSION_STEAM_ID}&v=1`;

function makeEnv(overrides = {}) {
  return {
    STEAM_API_KEY: "test-steam-key",
    OWNER_STEAM_ID,
    // ITAD_API_KEY deliberately omitted – /api/rank must work without it, and
    // its absence keeps the historical-low pool out of these tests entirely.
    TAG_CACHE: makeMockKv(),
    FPM_DB: makeMockD1(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

/** One raw GetOwnedGames entry, carrying every upstream field Steam actually
 * sends. The three marked "upstream-only" are the leak this file exists to
 * catch – they are real fields from a real GetOwnedGames response, not
 * invented ones. */
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
  playtime_mac_forever: 0, // upstream-only, must NOT leak
  playtime_linux_forever: 0, // upstream-only, must NOT leak
  playtime_deck_forever: 12, // upstream-only, must NOT leak
  content_descriptorids: [2, 5], // upstream-only, must NOT leak
  // Increment 12.5: Steam sends this without being asked, and it IS one of the
  // seven fields trimGame keeps – a played SIGNAL only, never added into the
  // displayed hours.
  playtime_disconnected: 45,
};

/** The seven, and only the seven. Sorted, because the assertion is a sorted
 * deepEqual – order of keys in the object literal must not be able to break
 * or to rescue it. */
const ALLOWED_KEYS = [
  "appid",
  "name",
  "img_icon_url",
  "playtime_forever",
  "playtime_2weeks",
  "rtime_last_played",
  "playtime_disconnected",
].sort();

/** A 200 from GetOwnedGames carrying `games`. */
function steamOk(games) {
  return new Response(JSON.stringify({ response: { games } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const CATALOG_COLUMNS = [
  "appid", "name", "owners", "positive", "negative", "wilson", "app_type",
  "price", "price_cents", "regular", "cut", "price_checked_at", "price_state", "tags", "source_owned",
  "experience_score", "game_score", "has_ending", "hours_to_value", "hours_to_good",
  "experience_reason", "experience_confidence", "experience_checked_at",
];

/** Mirrors test/worker-rank.test.mjs's seeder – "a normal, rankable game" by
 * default, so each test only spells out what it is about. */
async function seedCatalog(env, rows) {
  await ensureCatalogSchema(env);
  const sql = `INSERT INTO fpm_catalog (${CATALOG_COLUMNS.join(", ")}) VALUES (${CATALOG_COLUMNS.map(() => "?").join(", ")})`;
  for (const row of rows) {
    const full = {
      owners: 100000, positive: 5000, negative: 100, wilson: 0.95, app_type: "game",
      price: null, price_cents: null, regular: null, cut: null, price_checked_at: 1, price_state: "unknown",
      tags: JSON.stringify({ Shooter: 100, Multiplayer: 50 }), source_owned: 0,
      game_score: 90, has_ending: 1, hours_to_value: 4, hours_to_good: 0,
      experience_reason: "A reason line.", experience_confidence: "high", experience_checked_at: 1,
      ...row,
    };
    await env.FPM_DB.prepare(sql).bind(...CATALOG_COLUMNS.map((c) => full[c] ?? null)).run();
  }
}

async function callRank(env, ctx, query = "") {
  const response = await worker.fetch(new Request(`https://x.test/api/rank${query}`), env, ctx);
  return { response, body: await response.json() };
}

/** Read back whatever loadLibraryForRank wrote into the Cache API. */
async function cachedLibrary(cache, key = LIBRARY_CACHE_KEY) {
  const entry = cache.store.get(key);
  if (!entry) return null;
  return JSON.parse(await entry.clone().text());
}

test.beforeEach(() => {
  offlineGuard = makeOfflineFetchGuard("worker-library-plumbing");
  globalThis.fetch = offlineGuard;
  __resetCatalogMemoForTests();
});

test.afterEach(() => {
  const calls = [...offlineGuard.calls];
  restoreGlobals();
  assert.deepEqual(calls, [], "no test in this file may reach the network");
});

// ---------------------------------------------------------------------------
// trimGame – the exhaustive key-set tripwire, on a COLD cache so the real
// fetch-and-trim path runs.
// ---------------------------------------------------------------------------

test("TC-2 tripwire: a cold /api/rank trims each owned game to EXACTLY the seven allowed fields", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);

  globalThis.fetch = async () => steamOk([RAW_GAME]);

  const ctx = makeCtx();
  const { response } = await callRank(env, ctx);
  await ctx.flush();
  assert.equal(response.status, 200);

  const cached = await cachedLibrary(cache);
  assert.ok(cached, "the cold path did not write the trimmed library to the cache at all");
  assert.equal(cached.games.length, 1);

  const trimmed = cached.games[0];
  // THE ASSERTION. Exhaustive and sorted: every key, nothing else.
  assert.deepEqual(
    Object.keys(trimmed).sort(),
    ALLOWED_KEYS,
    "trimGame's key set changed – if that was deliberate, bump LIBRARY_CACHE_VERSION in the same commit",
  );

  // And the seven carry the right values, so a trim that kept the right names
  // with the wrong contents is caught too.
  assert.equal(trimmed.appid, 440);
  assert.equal(trimmed.name, "Team Fortress 2");
  assert.equal(trimmed.img_icon_url, "abc123icon");
  assert.equal(trimmed.playtime_forever, 600);
  assert.equal(trimmed.playtime_2weeks, 30);
  assert.equal(trimmed.rtime_last_played, 1750000000);
  assert.equal(trimmed.playtime_disconnected, 45);
});

test("TC-2: each named upstream-only field is absent by name, so the failure message says WHICH leaked", async () => {
  // The sorted deepEqual above is the real gate; this is its diagnostic twin.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  globalThis.fetch = async () => steamOk([RAW_GAME]);

  const ctx = makeCtx();
  await callRank(env, ctx);
  await ctx.flush();

  const trimmed = (await cachedLibrary(cache)).games[0];
  for (const leaked of [
    "img_logo_url",
    "has_community_visible_stats",
    "playtime_windows_forever",
    "playtime_mac_forever",
    "playtime_linux_forever",
    "playtime_deck_forever",
    "content_descriptorids",
  ]) {
    assert.equal(leaked in trimmed, false, `upstream field ${leaked} leaked into the cached library`);
  }
});

test("TC-2: the trim applies to EVERY game, not just the first", async () => {
  // `games.map(trimGame)` is one character away from `trimGame(games[0])`, and
  // a single-row fixture cannot tell the difference.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 440, name: "Team Fortress 2", experience_score: 70 },
    { appid: 620, name: "Portal 2", experience_score: 80 },
    { appid: 730, name: "CS2", experience_score: 60 },
  ]);
  globalThis.fetch = async () =>
    steamOk([
      RAW_GAME,
      { ...RAW_GAME, appid: 620, name: "Portal 2" },
      { ...RAW_GAME, appid: 730, name: "CS2" },
    ]);

  const ctx = makeCtx();
  await callRank(env, ctx);
  await ctx.flush();

  const games = (await cachedLibrary(cache)).games;
  assert.equal(games.length, 3);
  for (const game of games) {
    assert.deepEqual(Object.keys(game).sort(), ALLOWED_KEYS, `appid ${game.appid} was not trimmed`);
  }
});

test("TC-2: the trimmed fields really do reach /api/rank's rows – hoursPlayed and playedSource", async () => {
  // The cache assertion above proves the shape. This proves the shape is the
  // one the lane consumes: hoursPlayed comes from `playtime_forever`, and
  // `playedSource: "steam-disconnected"` can ONLY be reached if trimGame
  // carried `playtime_disconnected` through (increment 12.5's whole point).
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 440, name: "Team Fortress 2", experience_score: 70 },
    { appid: 620, name: "Portal 2", experience_score: 80 },
  ]);

  globalThis.fetch = async () =>
    steamOk([
      RAW_GAME, // 600 minutes -> 10 hours, playedSource steam-playtime
      {
        ...RAW_GAME,
        appid: 620,
        name: "Portal 2",
        playtime_forever: 0,
        playtime_2weeks: 0,
        rtime_last_played: 0,
        playtime_disconnected: 45, // the ONLY evidence this one was played
      },
    ]);

  const ctx = makeCtx();
  const { body } = await callRank(env, ctx);
  await ctx.flush();

  const byAppid = new Map(body.rank.map((r) => [r.appid, r]));
  assert.equal(byAppid.get(440).hoursPlayed, 10);
  assert.equal(byAppid.get(440).playedSource, "steam-playtime");
  assert.equal(byAppid.get(620).hoursPlayed, 0);
  assert.equal(
    byAppid.get(620).played,
    true,
    "playtime_disconnected did not survive the trim, so a played game reads as unplayed",
  );
  assert.equal(byAppid.get(620).playedSource, "steam-disconnected");
});

// ---------------------------------------------------------------------------
// fetchOwnedGames – the outgoing request, and the cache key it writes under.
// ---------------------------------------------------------------------------

test("TC-2: the upstream call is GetOwnedGames with include_appinfo and include_played_free_games set", async () => {
  // `include_appinfo=1` is what makes Steam send `name`/`img_icon_url` at all;
  // without it the trim keeps two fields that are always undefined and the
  // whole catalogue joins on nothing.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);

  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return steamOk([RAW_GAME]);
  };

  const ctx = makeCtx();
  await callRank(env, ctx);
  await ctx.flush();

  assert.equal(urls.length, 1, `expected exactly one upstream call, got ${urls.length}`);
  const u = urls[0];
  assert.equal(u.hostname, "api.steampowered.com");
  assert.match(u.pathname, /GetOwnedGames/);
  assert.equal(u.searchParams.get("key"), "test-steam-key");
  assert.equal(u.searchParams.get("steamid"), SESSION_STEAM_ID);
  assert.equal(u.searchParams.get("include_appinfo"), "1");
  assert.equal(u.searchParams.get("include_played_free_games"), "1");
});

test("TC-2: the fetched library is cached under the v=2 key, and a v=1 entry is stepped over", async () => {
  // LIBRARY_CACHE_VERSION exists because a payload cached before increment
  // 12.5 has no `playtime_disconnected`, so a game whose only play evidence is
  // that field reads "never played" for up to 24 hours – and the symptom looks
  // exactly like the new code not working.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);

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
    LIBRARY_CACHE_KEY_V1,
    new Response(JSON.stringify({ games: [staleGame] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return steamOk([RAW_GAME]);
  };

  const ctx = makeCtx();
  const { body } = await callRank(env, ctx);
  await ctx.flush();

  assert.equal(fetchCalls, 1, "the v=1 entry was served, so the version bump does nothing");
  assert.equal(cache.store.has(LIBRARY_CACHE_KEY), true, "nothing was written under the bumped key");
  assert.equal((await cachedLibrary(cache)).games[0].playtime_disconnected, 45);
  assert.equal(body.rank.find((r) => r.appid === 440).playedSource, "steam-playtime");
});

test("TC-2: a warm v=2 cache entry is served and the upstream is NOT re-hit", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  cache.store.set(
    LIBRARY_CACHE_KEY,
    new Response(JSON.stringify({ games: [{ appid: 440, playtime_forever: 120 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return steamOk([RAW_GAME]);
  };

  const ctx = makeCtx();
  const { body } = await callRank(env, ctx);
  await ctx.flush();

  assert.equal(fetchCalls, 0, "a warm library cache must not re-hit Steam");
  assert.equal(body.rank.find((r) => r.appid === 440).hoursPlayed, 2); // the CACHED 120 minutes
});

test("TC-2: ?refresh=1 bypasses the warm cache, re-hits Steam and repopulates under the same key", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  cache.store.set(
    LIBRARY_CACHE_KEY,
    new Response(JSON.stringify({ games: [{ appid: 440, playtime_forever: 120 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return steamOk([RAW_GAME]);
  };

  const ctx = makeCtx();
  const { body } = await callRank(env, ctx, "?refresh=1");
  await ctx.flush();

  assert.equal(fetchCalls, 1);
  assert.equal(body.rank.find((r) => r.appid === 440).hoursPlayed, 10); // the FRESH 600 minutes
  assert.deepEqual(Object.keys((await cachedLibrary(cache)).games[0]).sort(), ALLOWED_KEYS);
});

// ---------------------------------------------------------------------------
// fetchOwnedGames' failure paths. Each throws a 502-flavoured Error inside
// fetchOwnedGames; loadLibraryForRank catches every one and returns [], so
// what is assertable is the DEGRADATION, not the message. See this file's
// header note.
// ---------------------------------------------------------------------------

/** Every failure below must land on the same three observable facts. */
async function assertDegradedNotRefused(cache, env, ctx, response, body) {
  assert.equal(response.status, 200, "a Steam failure must degrade /api/rank, never 500 it");
  assert.equal(body.available, true);
  assert.match(
    body.notice,
    /Steam library unavailable/,
    "the empty library was absorbed silently instead of being reported",
  );
  assert.equal(body.profileAvailable, false);
  assert.equal(body.profileGames, 0);
  assert.equal(
    cache.store.has(LIBRARY_CACHE_KEY),
    false,
    "a failed library fetch must not be written to the 24h cache",
  );
  // The catalogue still ranks – the lane degrades to pure experience value.
  assert.ok(body.rank.length > 0, "the catalogue stopped ranking because the library failed");
  assert.equal(body.rank[0].hoursPlayed, null);
}

test("TC-2 private profile: an EMPTY games array degrades /api/rank with a notice, and caches nothing", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  globalThis.fetch = async () => steamOk([]);

  const ctx = makeCtx();
  const { response, body } = await callRank(env, ctx);
  await ctx.flush();
  await assertDegradedNotRefused(cache, env, ctx, response, body);
});

test("TC-2 private profile: an ABSENT games key degrades the same way", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ response: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const ctx = makeCtx();
  const { response, body } = await callRank(env, ctx);
  await ctx.flush();
  await assertDegradedNotRefused(cache, env, ctx, response, body);
});

test("TC-2 upstream non-200: a 403 carrying a PERFECTLY VALID body is still refused, not read", async () => {
  // The body here is a well-formed GetOwnedGames payload with a real game in
  // it – deliberately, because a 403 with an unparsable body is refused by the
  // JSON guard further down and would mask whether the status check exists at
  // all. Steam returns JSON error envelopes on 403, and reading one as a
  // library would cache a wrong answer for 24 hours.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ response: { games: [RAW_GAME] } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  const ctx = makeCtx();
  const { response, body } = await callRank(env, ctx);
  await ctx.flush();
  await assertDegradedNotRefused(cache, env, ctx, response, body);
});

test("TC-2 upstream non-200: a 500 from Steam degrades the same way", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  const ctx = makeCtx();
  const { response, body } = await callRank(env, ctx);
  await ctx.flush();
  await assertDegradedNotRefused(cache, env, ctx, response, body);
});

test("TC-2 unparsable upstream: a 200 that is not JSON degrades rather than throwing out of the handler", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  globalThis.fetch = async () => new Response("<html>maintenance</html>", { status: 200 });

  const ctx = makeCtx();
  const { response, body } = await callRank(env, ctx);
  await ctx.flush();
  await assertDegradedNotRefused(cache, env, ctx, response, body);
});

test("TC-2 network failure: a thrown fetch degrades rather than throwing out of the handler", async () => {
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);
  globalThis.fetch = async () => {
    throw new Error("ECONNRESET");
  };

  const ctx = makeCtx();
  const { response, body } = await callRank(env, ctx);
  await ctx.flush();
  await assertDegradedNotRefused(cache, env, ctx, response, body);
});

test("TC-2: with NO Steam credentials the upstream is never called, and that is a config state, not a fault", async () => {
  // The contrast that makes the `notice` above meaningful: credentials absent
  // is reported through profileAvailable/profileGames, NOT as an outage.
  const cache = makeMockCache();
  globalThis.caches = { default: cache };
  const env = makeEnv({ STEAM_API_KEY: undefined, OWNER_STEAM_ID: undefined });
  await seedCatalog(env, [{ appid: 440, name: "Team Fortress 2", experience_score: 70 }]);

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return steamOk([RAW_GAME]);
  };

  const ctx = makeCtx();
  const { response, body } = await callRank(env, ctx);
  await ctx.flush();

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 0, "Steam was called with no credentials configured");
  assert.equal(body.notice, null, "missing credentials must not be reported as a Steam outage");
  assert.equal(body.profileAvailable, false);
});
