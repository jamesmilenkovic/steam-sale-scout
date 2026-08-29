// Tests for Increment 9 – the SteamSpy tag backfill in src/catalog.js, plus
// the shared 1 req/sec slot reservation in src/spyQueue.js (awaitSpySlot).
//
// SPEC.md §6 gate (f): "Full suite green; new tests mirror live probe shapes;
// at least one test proves the empty-tags array/dict duality and one proves
// resume-without-refetch."
//
// NEVER makes a real network call. `globalThis.fetch` is replaced by a
// recording spy in every test that can reach the network, and every test
// asserts on that spy's call list – so an unintended live SteamSpy request
// fails loudly rather than passing slowly. D1 is a real in-memory SQLite
// database (test/helpers/mockD1.mjs via node:sqlite), so the actual SQL runs.
// Every response body here comes from test/fixtures/spy-appdetails.mjs, which
// holds VERBATIM live captures from the 2026-08-28 probe (scratchpad/
// probe-findings-9.md) – the inc-6 lesson is that a green test against a
// hand-written mock shape proves nothing.
//
// Naming note, because it has already bitten this increment once: the empty
// witnesses are SPY_DEDICATED_SERVER (appid 5) and SPY_EMPTY_UNKNOWN_APPID
// (appid 1969360, an UNKNOWN appid) and SPY_NONEXISTENT_APPID (999999999).
// SPY_CASTLE_FULL_OF_CATS (appid 2070550) is a real game with a full 20-tag
// dict and is used here only as a POPULATED witness.

import test from "node:test";
import assert from "node:assert/strict";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import {
  SPY_CELESTE,
  SPY_TERRARIA,
  SPY_HADES,
  SPY_CASTLE_FULL_OF_CATS,
  SPY_DEDICATED_SERVER,
  SPY_EMPTY_UNKNOWN_APPID,
  SPY_NONEXISTENT_APPID,
  SPY_THROTTLE_BODY,
  SPY_THROTTLE_BODY_ALT,
} from "./fixtures/spy-appdetails.mjs";
import {
  awaitSpySlot,
  __setSpyMinIntervalMsForTests,
  __resetSpyQueueForTests,
} from "../src/spyQueue.js";
import {
  FPM_TAGS_BATCH,
  FPM_TAGS_PACING_MS,
  FPM_TAGS_MAX_CONSECUTIVE_BAD,
  FPM_TAGS_MAX_ROW_ATTEMPTS,
  FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES,
  catalogRowFromBulk,
  ensureCatalogSchema,
  upsertCatalogRows,
  markOwned,
  markDeal,
  getCatalogStats,
  fetchSpyTags,
  selectTagsBatch,
  recordTagsResult,
  backfillCatalogTags,
  requestFpmAutoContinueStop,
  __setTagsPacingMsForTests,
  __setTagsBackoffMsForTests,
  __resetTagsPacingForTests,
  __resetFpmAutoContinueStateForTests,
} from "../src/catalog.js";

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A live-captured appdetails body, re-appid'd to whichever row is asked
 * about – so the test sees the true live shape for an arbitrary appid. */
function spyBody(fixture, appid) {
  return jsonResponse({ ...fixture, appid });
}

/**
 * A recording `fetch` stub for the SteamSpy appdetails endpoint. `responder`
 * receives (appid, attemptNumberForThatAppid) and returns a Response.
 * Anything that is not the appdetails endpoint fails the test loudly.
 */
function makeTagFetch(responder = (appid) => spyBody(SPY_CELESTE, appid)) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.hostname, "steamspy.com", `unexpected host hit by the tag backfill: ${url}`);
    assert.equal(u.searchParams.get("request"), "appdetails", `unexpected SteamSpy endpoint: ${url}`);
    const appid = Number(u.searchParams.get("appid"));
    const attempt = calls.filter((c) => c.appid === appid).length + 1;
    calls.push({ appid, attempt, at: Date.now() });
    return responder(appid, attempt);
  };
  fn.calls = calls;
  fn.appids = () => calls.map((c) => c.appid);
  return fn;
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

/** Seed the 30d KV tag cache the way spyQueue.js writes it (`v2:spytag:<id>`
 * holding the classified trio), so the backfill's pass 1 sees a real hit. */
function seedKvTags(env, appid, tags) {
  env.TAG_CACHE.store.set(
    `v2:spytag:${appid}`,
    JSON.stringify({ tags, median: 0, reviews: { positive: 1, negative: 0 }, owners: 1000 }),
  );
}

/** Seed the KV cache with the literal `null` spyQueue.js writes for "checked,
 * nothing usable" – which probe 4 says must be read as a seed MISS. */
function seedKvNull(env, appid) {
  env.TAG_CACHE.store.set(`v2:spytag:${appid}`, JSON.stringify(null));
}

/** Wrap the mock D1 so the tag UPDATE can be observed and/or made to reject.
 * `hook(bindArgs)` may throw; everything else passes straight through. */
function makeD1WithTagWriteHook(db, hook) {
  return {
    _db: db._db,
    prepare(sql) {
      const inner = db.prepare(sql);
      if (!sql.includes("UPDATE fpm_catalog SET tags = ?")) return inner;
      return {
        bind(...args) {
          const bound = inner.bind(...args);
          return {
            bind: (...a) => bound.bind(...a),
            all: () => bound.all(),
            first: (c) => bound.first(c),
            async run() {
              await hook(args);
              return bound.run();
            },
          };
        },
        run: () => inner.run(),
        all: () => inner.all(),
        first: (c) => inner.first(c),
      };
    },
    batch: (statements) => db.batch(statements),
    exec: (sql) => db.exec(sql),
  };
}

function makeEnv(overrides = {}) {
  return { FPM_DB: makeMockD1(), TAG_CACHE: makeMockKv(), ...overrides };
}

/** One floor-passing bulk row, shaped exactly as the live `all` feed does. */
function bulkRow(appid, { owners = "1,000,000 .. 2,000,000", positive = 9000, negative = 1000, name } = {}) {
  return {
    appid,
    name: name ?? `Game ${appid}`,
    developer: "Dev",
    publisher: "Pub",
    score_rank: "",
    positive,
    negative,
    userscore: 0,
    owners,
    average_forever: 500,
    average_2weeks: 0,
    median_forever: 400,
    median_2weeks: 0,
    price: "1999",
    initialprice: "1999",
    discount: "0",
    ccu: 100,
  };
}

async function seedCatalog(env, specs) {
  await ensureCatalogSchema(env);
  await upsertCatalogRows(env, specs.map((s) => catalogRowFromBulk(bulkRow(s.appid, s))), 1000);
  const owned = specs.filter((s) => s.owned).map((s) => s.appid);
  const deals = specs.filter((s) => s.deal).map((s) => s.appid);
  if (owned.length) await markOwned(env, owned);
  if (deals.length) await markDeal(env, deals);
}

function readRow(env, appid) {
  return env.FPM_DB.prepare("SELECT appid, tags, tags_checked_at, tags_source FROM fpm_catalog WHERE appid = ?")
    .bind(appid)
    .first();
}

test.beforeEach(() => {
  __setTagsPacingMsForTests(0);
  __setTagsBackoffMsForTests(0, 0);
  __setSpyMinIntervalMsForTests(0);
  __resetSpyQueueForTests();
  __resetFpmAutoContinueStateForTests();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetTagsPacingForTests();
  __setSpyMinIntervalMsForTests(1000);
  __resetSpyQueueForTests();
  __resetFpmAutoContinueStateForTests();
});

// ---------------------------------------------------------------------------
// 1. fetchSpyTags – the empty-tags array/dict duality (SPEC.md §6 gate (f)).
// ---------------------------------------------------------------------------

test("the live fixtures still carry the two shapes this increment exists to handle (array vs dict)", () => {
  // Pins the fixtures themselves, so a future edit that "tidies" `[]` into
  // `{}` can't quietly make the duality tests below vacuous.
  assert.ok(Array.isArray(SPY_DEDICATED_SERVER.tags), "appid 5 must still be the empty-ARRAY witness");
  assert.equal(SPY_DEDICATED_SERVER.tags.length, 0);
  assert.ok(Array.isArray(SPY_EMPTY_UNKNOWN_APPID.tags), "appid 1969360 (an UNKNOWN appid) is the second array witness");
  assert.ok(Array.isArray(SPY_NONEXISTENT_APPID.tags), "appid 999999999 is the third array witness");
  assert.equal(SPY_EMPTY_UNKNOWN_APPID.name, null, "1969360 is an unknown appid, NOT A Castle Full of Cats");
  assert.ok(!Array.isArray(SPY_CELESTE.tags));
  assert.equal(Object.keys(SPY_CELESTE.tags).length, 20, "populated live captures are a 20-key name->votes dict");
  assert.equal(Object.keys(SPY_CASTLE_FULL_OF_CATS.tags).length, 20, "A Castle Full of Cats (2070550) is POPULATED");
});

test("fetchSpyTags: the empty ARRAY shape (`tags: []`, appid 5) is a real answer – {status:'ok', tags:null}", async () => {
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_DEDICATED_SERVER, appid));
  globalThis.fetch = fetchSpy;

  const result = await fetchSpyTags(5);

  assert.deepEqual(result, { status: "ok", tags: null });
  assert.equal(fetchSpy.calls.length, 1);
});

test("fetchSpyTags: the empty DICT shape (`tags: {}`) is the same real answer – {status:'ok', tags:null}", async () => {
  // The other half of the duality. Never observed live (the live empty shape
  // is always `[]`), but SPEC.md §4.1 requires both be handled, and the
  // failure mode if it were not is a permanent, unrecoverable throttle loop.
  globalThis.fetch = makeTagFetch((appid) => spyBody({ ...SPY_DEDICATED_SERVER, tags: {} }, appid));

  assert.deepEqual(await fetchSpyTags(5), { status: "ok", tags: null });
});

test("fetchSpyTags: a missing `tags` field is also the empty outcome, not an error", async () => {
  globalThis.fetch = makeTagFetch((appid) => {
    const { tags, ...withoutTags } = SPY_DEDICATED_SERVER;
    return spyBody(withoutTags, appid);
  });

  assert.deepEqual(await fetchSpyTags(5), { status: "ok", tags: null });
});

test("fetchSpyTags: a populated app returns the live 20-key name->votes dict verbatim", async () => {
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  const result = await fetchSpyTags(504230);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.tags, SPY_CELESTE.tags, "the dict is passed through unmodified – SPEC.md §2 stores the live shape");
  assert.equal(Object.keys(result.tags).length, 20);
  assert.equal(result.tags["Precision Platformer"], 1432);
  assert.equal(fetchSpy.calls[0].appid, 504230, "the appid asked about is the one requested");
});

test("fetchSpyTags: the obscure-but-real game (A Castle Full of Cats, 2070550) is populated, not empty", async () => {
  globalThis.fetch = makeTagFetch((appid) => spyBody(SPY_CASTLE_FULL_OF_CATS, appid));

  const result = await fetchSpyTags(2070550);

  assert.equal(result.status, "ok");
  assert.equal(result.tags.Cats, 126);
  assert.equal(Object.keys(result.tags).length, 20);
});

// ---------------------------------------------------------------------------
// 11. The error-envelope gate: a body that isn't an appdetails row is a
//     THROTTLE (retry), never an empty (permanent stamp).
// ---------------------------------------------------------------------------

const THROTTLE_CASES = [
  {
    label: 'a JSON error envelope {"error":"db down"} (a plain object with no appid)',
    response: () => jsonResponse({ error: "db down" }),
  },
  { label: "the live plain-text throttle body under HTTP 200", response: () => new Response(SPY_THROTTLE_BODY, { status: 200 }) },
  { label: "the alternate plain-text throttle body under HTTP 200", response: () => new Response(SPY_THROTTLE_BODY_ALT, { status: 200 }) },
  { label: "an unparseable HTTP 200 body", response: () => new Response("not json at all {", { status: 200 }) },
  { label: "a bare HTTP 500 with an empty body", response: () => new Response("", { status: 500 }) },
  { label: "a JSON array body (valid JSON, wrong shape)", response: () => jsonResponse([1, 2, 3]) },
  {
    label: "a NON-empty tags ARRAY (a shape nobody has ever observed – stamping it would lose real tags)",
    response: (appid) => spyBody({ ...SPY_DEDICATED_SERVER, appid, tags: ["Roguelike", "Indie"] }, appid),
  },
];

for (const { label, response } of THROTTLE_CASES) {
  test(`fetchSpyTags: ${label} classifies as 'throttled', NOT as empty`, async () => {
    globalThis.fetch = makeTagFetch((appid) => response(appid));

    const result = await fetchSpyTags(504230);

    assert.deepEqual(result, { status: "throttled", tags: null });
  });

  test(`backfillCatalogTags: ${label} leaves the row UNSTAMPED so it is retried, never recorded as "no tags"`, async () => {
    const env = makeEnv();
    await seedCatalog(env, [{ appid: 100 }]);
    const fetchSpy = makeTagFetch((appid) => response(appid));
    globalThis.fetch = fetchSpy;

    const result = await backfillCatalogTags(env, { limit: 10, now: 5000 });

    assert.equal(result.attempted, 0, "an unclassifiable answer is not an attempt that concluded");
    assert.equal(result.tagged, 0);
    assert.equal(result.empty, 0, "THE point of the gate: this must never land in the empty leg");
    assert.equal(result.skipped, 1, `the row is walked past after ${FPM_TAGS_MAX_ROW_ATTEMPTS} attempts`);
    const row = await readRow(env, 100);
    assert.equal(row.tags_checked_at, null, "unstamped – §3.6 never revisits a stamped row, so a bad hour must not bake in");
    assert.equal(row.tags, null);
    assert.equal(row.tags_source, null);
    const stats = await getCatalogStats(env);
    assert.equal(stats.tagsPending, 1, "still pending, still in the funnel");
    assert.equal(fetchSpy.calls.length, FPM_TAGS_MAX_ROW_ATTEMPTS);
  });
}

test("fetchSpyTags: a thrown network error resolves to 'error' rather than throwing", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await fetchSpyTags(100), { status: "error", tags: null });
});

test("fetchSpyTags: a non-2xx that isn't a 500 resolves to 'error' (still not empty)", async () => {
  globalThis.fetch = makeTagFetch(() => new Response("nope", { status: 404 }));
  assert.deepEqual(await fetchSpyTags(100), { status: "error", tags: null });
});

// ---------------------------------------------------------------------------
// 3. selectTagsBatch – SPEC.md §3.4 priority order.
// ---------------------------------------------------------------------------

test("selectTagsBatch: owned rows first, then on-sale rows, then the remainder by owners DESC", async () => {
  const env = makeEnv();
  await seedCatalog(env, [
    // The owned row deliberately has the FEWEST owners, so owner count
    // cannot be what puts it first.
    { appid: 1, owned: true, owners: "5,000 .. 20,000" },
    { appid: 2, deal: true, owners: "100,000 .. 200,000" },
    { appid: 3, owners: "10,000,000 .. 20,000,000" },
    { appid: 4, owners: "1,000,000 .. 2,000,000" },
  ]);

  const batch = await selectTagsBatch(env, { limit: 10 });

  assert.deepEqual(
    batch.map((r) => r.appid),
    [1, 2, 3, 4],
    "owned (taste-profile input for inc 11) > on-sale > owners DESC",
  );
  assert.equal(batch[0].name, "Game 1", "the batch carries the name column the log lines use");
});

test("selectTagsBatch: honours `limit` and takes the highest-priority rows first", async () => {
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 1, owners: "5,000 .. 20,000" },
    { appid: 2, owned: true, owners: "5,000 .. 20,000" },
    { appid: 3, owners: "10,000,000 .. 20,000,000" },
  ]);

  const batch = await selectTagsBatch(env, { limit: 2 });

  assert.deepEqual(batch.map((r) => r.appid), [2, 3]);
});

test("FPM_TAGS_BATCH/FPM_TAGS_PACING_MS are the sizing/pacing the increment was sized against", () => {
  assert.equal(FPM_TAGS_BATCH, 3000);
  assert.equal(FPM_TAGS_PACING_MS, 1000, "SPEC.md §3.1's ~1 req/sec ceiling for this host");
});

// ---------------------------------------------------------------------------
// 2. Resume without re-fetch (SPEC.md §3.6 + gate (a)/(f)).
// ---------------------------------------------------------------------------

test("resume: rows with tags_checked_at set are NEVER reselected and cost ZERO SteamSpy requests, across two runs", async () => {
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 1, owned: true },
    { appid: 2 },
    { appid: 3 },
    { appid: 4 },
  ]);
  // Row 1 was tagged on an earlier run; row 2 came back EMPTY on an earlier
  // run (tags NULL, stamp SET). Row 2 is the load-bearing one: the no-TTL
  // policy keys off tags_checked_at, NOT off tags, so an empty row must be as
  // "done" as a tagged one.
  await recordTagsResult(env, 1, { tags: SPY_CELESTE.tags, checkedAtMs: 111, source: "live" });
  await recordTagsResult(env, 2, { tags: null, checkedAtMs: 222, source: "live" });

  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_TERRARIA, appid));
  globalThis.fetch = fetchSpy;

  const batch = await selectTagsBatch(env, { limit: 100 });
  assert.deepEqual(batch.map((r) => r.appid), [3, 4], "selectTagsBatch skips both stamped rows, tagged AND empty");

  const run1 = await backfillCatalogTags(env, { limit: 100, now: 5000 });
  assert.equal(run1.attempted, 2);
  assert.equal(run1.tagged, 2);
  const afterRun1 = fetchSpy.calls.length;
  assert.equal(afterRun1, 2, "only the two unstamped rows were fetched");
  assert.deepEqual(fetchSpy.appids().sort(), [3, 4]);

  const run2 = await backfillCatalogTags(env, { limit: 100, now: 6000 });

  assert.deepEqual(run2, { attempted: 0, tagged: 0, kvSeeded: 0, empty: 0, kvFailed: 0, writeFailed: 0, skipped: 0, gaveUp: 0 });
  assert.equal(fetchSpy.calls.length, afterRun1, "the second run made ZERO further SteamSpy requests");
  assert.ok(!fetchSpy.appids().includes(1), "the previously TAGGED row was never re-fetched");
  assert.ok(!fetchSpy.appids().includes(2), "the previously EMPTY row was never re-fetched either");

  // And the earlier rows' stored values are untouched by the later runs.
  const row1 = await readRow(env, 1);
  assert.equal(row1.tags_checked_at, 111);
  assert.deepEqual(JSON.parse(row1.tags), SPY_CELESTE.tags);
  const row2 = await readRow(env, 2);
  assert.equal(row2.tags_checked_at, 222);
  assert.equal(row2.tags, null);
});

test("resume: a KV-seeded row is equally done – the second run neither re-reads KV usefully nor fetches", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 10 }]);
  seedKvTags(env, 10, SPY_HADES.tags);
  const fetchSpy = makeTagFetch();
  globalThis.fetch = fetchSpy;

  const run1 = await backfillCatalogTags(env, { limit: 10, now: 5000 });
  assert.equal(run1.kvSeeded, 1);
  assert.equal(fetchSpy.calls.length, 0, "a KV hit spends no SteamSpy request (gate (d))");

  const run2 = await backfillCatalogTags(env, { limit: 10, now: 6000 });
  assert.equal(run2.attempted, 0);
  assert.equal(fetchSpy.calls.length, 0);
  const row = await readRow(env, 10);
  assert.equal(row.tags_checked_at, 5000, "still stamped with the FIRST run's timestamp");
});

// ---------------------------------------------------------------------------
// 4. tags_source – 'kv' vs 'live', and the catalog-wide kv_seeded leg.
// ---------------------------------------------------------------------------

test("tags_source: a KV-seeded row lands 'kv', a live-fetched row lands 'live', an EMPTY row still writes a non-NULL source", async () => {
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 1, owned: true },
    { appid: 2, owners: "10,000,000 .. 20,000,000" },
    { appid: 3, owners: "1,000,000 .. 2,000,000" },
  ]);
  seedKvTags(env, 1, SPY_CELESTE.tags);
  const fetchSpy = makeTagFetch((appid) =>
    // appid 2 answers populated; appid 3 answers with the live EMPTY array.
    appid === 2 ? spyBody(SPY_TERRARIA, appid) : spyBody(SPY_DEDICATED_SERVER, appid),
  );
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.kvSeeded, 1);
  assert.equal(result.tagged, 2, "the KV row and the live populated row both stored tags");
  assert.equal(result.empty, 1);
  assert.equal(result.attempted, 3);

  const kvRow = await readRow(env, 1);
  assert.equal(kvRow.tags_source, "kv");
  assert.deepEqual(JSON.parse(kvRow.tags), SPY_CELESTE.tags);

  const liveRow = await readRow(env, 2);
  assert.equal(liveRow.tags_source, "live");

  const emptyRow = await readRow(env, 3);
  assert.equal(emptyRow.tags, null, "the deliberate deviation from §3.5: empty is SQL NULL, not `{}`");
  assert.equal(emptyRow.tags_checked_at, 7000, "…but it IS stamped, so it is never refetched");
  assert.equal(emptyRow.tags_source, "live", "tags_source is non-NULL exactly when tags_checked_at is");
});

test("tags_source: getCatalogStats().tagsKvSeeded accumulates ACROSS separate backfill runs (the whole reason the column exists)", async () => {
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 1, owned: true },
    { appid: 2, deal: true },
    { appid: 3, owners: "5,000 .. 20,000" },
  ]);
  seedKvTags(env, 1, SPY_CELESTE.tags);
  seedKvTags(env, 2, SPY_TERRARIA.tags);
  const fetchSpy = makeTagFetch();
  globalThis.fetch = fetchSpy;

  // Run 1 takes only the owned row. A per-run counter would report 1 and be
  // overwritten; the column has to survive.
  const run1 = await backfillCatalogTags(env, { limit: 1, now: 7000 });
  assert.equal(run1.kvSeeded, 1);
  let stats = await getCatalogStats(env);
  assert.equal(stats.tagsKvSeeded, 1);

  const run2 = await backfillCatalogTags(env, { limit: 1, now: 8000 });
  assert.equal(run2.kvSeeded, 1, "this RUN saw one KV seed…");
  stats = await getCatalogStats(env);
  assert.equal(stats.tagsKvSeeded, 2, "…but the CATALOG-wide count is cumulative across runs");
  assert.equal(fetchSpy.calls.length, 0, "two KV-seeded runs spent zero SteamSpy requests");

  // A third run fills the last row live – kv_seeded must not move.
  globalThis.fetch = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  await backfillCatalogTags(env, { limit: 10, now: 9000 });
  stats = await getCatalogStats(env);
  assert.equal(stats.tagsKvSeeded, 2, "a live fill does not inflate the kv_seeded leg");
  assert.equal(stats.tagged, 3);
});

test("a KV entry cached as literal `null` is a seed MISS, not an empty – it falls through to the live fetch (probe 4)", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 42 }]);
  seedKvNull(env, 42); // spyQueue caches null for 3 different reasons; it cannot mean "definitely no tags"
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.kvSeeded, 0);
  assert.equal(fetchSpy.calls.length, 1, "the row went to the live fill so the outcome is classified honestly");
  const row = await readRow(env, 42);
  assert.equal(row.tags_source, "live");
  assert.deepEqual(JSON.parse(row.tags), SPY_CELESTE.tags);
});

test("a KV entry holding an EMPTY tag dict is also a seed miss (only a real dict is seeded)", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 43 }]);
  seedKvTags(env, 43, {});
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.kvSeeded, 0);
  assert.equal(fetchSpy.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 5. Funnel partition (SPEC.md gate (c)).
// ---------------------------------------------------------------------------

test("funnel: tagged + tagsEmpty + tagsPending === total on a mixed catalog, and a corrupt row is not double-counted", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }, { appid: 2 }, { appid: 3 }, { appid: 4 }, { appid: 5 }, { appid: 6 }]);
  await recordTagsResult(env, 1, { tags: SPY_CELESTE.tags, checkedAtMs: 100, source: "live" });
  await recordTagsResult(env, 2, { tags: SPY_TERRARIA.tags, checkedAtMs: 100, source: "kv" });
  await recordTagsResult(env, 3, { tags: null, checkedAtMs: 100, source: "live" }); // empty
  // 4 and 5 stay pending.
  // 6 is DELIBERATELY corrupt: tags set but the stamp missing – a state the
  // code cannot produce, asserted here so the partition is proven exhaustive
  // rather than merely consistent with the happy path.
  await env.FPM_DB.prepare("UPDATE fpm_catalog SET tags = ?, tags_checked_at = NULL WHERE appid = 6")
    .bind(JSON.stringify({ Weird: 1 }))
    .run();

  const stats = await getCatalogStats(env);

  assert.equal(stats.total, 6);
  assert.equal(stats.tagged, 2);
  assert.equal(stats.tagsEmpty, 1);
  assert.equal(stats.tagsPending, 3, "4, 5 and the corrupt 6 – an unstamped row is pending whatever `tags` holds");
  assert.equal(
    stats.tagged + stats.tagsEmpty + stats.tagsPending,
    stats.total,
    "gate (c): the three legs partition the catalog exactly, no silent blanks and no double count",
  );
  assert.equal(stats.tagsKvSeeded, 1, "kv_seeded is a SUBSET of tagged, not a fourth slice – do not add it to the sum");
});

test("funnel: an all-zero catalog and a fully-filled catalog both partition exactly", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }, { appid: 2 }]);

  let stats = await getCatalogStats(env);
  assert.equal(stats.tagged + stats.tagsEmpty + stats.tagsPending, stats.total);
  assert.equal(stats.tagsPending, 2);

  globalThis.fetch = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  await backfillCatalogTags(env, { limit: 10, now: 7000 });

  stats = await getCatalogStats(env);
  assert.equal(stats.tagsPending, 0, "gate (b)'s terminating condition is reachable");
  assert.equal(stats.tagged + stats.tagsEmpty + stats.tagsPending, stats.total);
});

// ---------------------------------------------------------------------------
// 6. sanitizeTagDict, observed through recordTagsResult (it is not exported).
// ---------------------------------------------------------------------------

async function storeTags(env, appid, tags, checkedAtMs = 900) {
  const returned = await recordTagsResult(env, appid, { tags, checkedAtMs, source: "live" });
  const row = await readRow(env, appid);
  return { returned, row, stored: row.tags == null ? null : JSON.parse(row.tags) };
}

test("write boundary: a numeric-STRING vote is stored as a real NUMBER (a string would NaN every inc-11 tag weight)", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);

  const { stored } = await storeTags(env, 1, { Roguelike: "42", Indie: 7 });

  assert.equal(typeof stored.Roguelike, "number");
  assert.equal(stored.Roguelike, 42);
  assert.equal(stored.Indie, 7);
});

test("write boundary: zero, negative, NaN and non-numeric votes are dropped; a valid sibling survives", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);

  const { stored } = await storeTags(env, 1, {
    Zero: 0,
    Negative: -5,
    NotANumber: Number.NaN,
    Rubbish: "abc",
    Infinite: Number.POSITIVE_INFINITY,
    Good: 10,
  });

  assert.deepEqual(stored, { Good: 10 });
});

test("write boundary: an empty tag NAME is dropped", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);

  const { stored } = await storeTags(env, 1, { "": 100, Puzzle: 5 });

  assert.deepEqual(stored, { Puzzle: 5 });
});

test("write boundary: a 60-tag dict is capped to the top 40 BY VOTES – the dropped 20 are the low-vote ones", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);
  const oversized = {};
  for (let i = 1; i <= 60; i++) oversized[`Tag${String(i).padStart(2, "0")}`] = i; // votes 1..60

  const { stored } = await storeTags(env, 1, oversized);

  const keys = Object.keys(stored);
  assert.equal(keys.length, 40, "capped at TAGS_MAX_ENTRIES (40)");
  const votes = Object.values(stored);
  assert.equal(Math.max(...votes), 60);
  assert.equal(Math.min(...votes), 21, "the 40 KEPT are votes 60..21 – the cap sorts by votes, it does not just truncate");
  assert.equal(stored.Tag60, 60);
  assert.equal(stored.Tag21, 21);
  for (let i = 1; i <= 20; i++) {
    assert.ok(!(`Tag${String(i).padStart(2, "0")}` in stored), `the low-vote Tag${i} must be the one dropped`);
  }
});

test("write boundary: a live 20-tag capture passes through completely untouched (the cap never reshapes today's data)", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);

  const { stored } = await storeTags(env, 1, SPY_TERRARIA.tags);

  assert.deepEqual(stored, SPY_TERRARIA.tags);
});

test("write boundary: an all-junk dict yields the EMPTY outcome – NULL tags, stamped, non-NULL source", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);

  const { returned, row } = await storeTags(env, 1, { A: 0, B: -1, "": 99 }, 4242);

  assert.equal(returned, null, "recordTagsResult returns what was STORED, so callers count D1 not the network");
  assert.equal(row.tags, null);
  assert.equal(row.tags_checked_at, 4242);
  assert.equal(row.tags_source, "live");
});

test("write boundary: a fetched all-junk dict is counted in `empty`, not `tagged` (counters key off what D1 holds)", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);
  globalThis.fetch = makeTagFetch((appid) => spyBody({ ...SPY_CELESTE, tags: { Bogus: 0, Worse: -3 } }, appid));

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.attempted, 1);
  assert.equal(result.tagged, 0);
  assert.equal(result.empty, 1);
  const stats = await getCatalogStats(env);
  assert.equal(stats.tagged, 0);
  assert.equal(stats.tagsEmpty, 1);
});

// ---------------------------------------------------------------------------
// 7. awaitSpySlot – ONE shared ~1 req/sec ceiling for the whole SteamSpy host.
// ---------------------------------------------------------------------------

test("awaitSpySlot: concurrent callers are SPACED by the interval, not co-fired (the slot is reserved BEFORE the sleep)", async () => {
  __setSpyMinIntervalMsForTests(60);
  __resetSpyQueueForTests();

  // Fired together, deliberately: if the reservation were stamped AFTER the
  // sleep, all three would read the same spyLastFetchAt, wait the same amount
  // and then all fire at once – 3 req in one instant, the exact bug this
  // function exists to prevent.
  const firedAt = await Promise.all([
    awaitSpySlot().then(() => Date.now()),
    awaitSpySlot().then(() => Date.now()),
    awaitSpySlot().then(() => Date.now()),
  ]);

  const gap1 = firedAt[1] - firedAt[0];
  const gap2 = firedAt[2] - firedAt[1];
  assert.ok(gap1 >= 45, `second caller must be spaced ~60ms after the first, got ${gap1}ms`);
  assert.ok(gap2 >= 45, `third caller must be spaced ~60ms after the second, got ${gap2}ms`);
});

test("awaitSpySlot: a first call after a reset is immediate (the pacer never adds latency it doesn't owe)", async () => {
  __setSpyMinIntervalMsForTests(500);
  __resetSpyQueueForTests();

  const t0 = Date.now();
  await awaitSpySlot();

  assert.ok(Date.now() - t0 < 100, "no wait is owed when no slot has been taken");
});

test("the tag fill and the /api/recs spy queue share ONE ceiling: the fill waits out a slot the recs path just took", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 100 }]);
  __setSpyMinIntervalMsForTests(120);
  __setTagsPacingMsForTests(120);
  __resetSpyQueueForTests();

  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  // The recs background queue takes the slot at t0…
  await awaitSpySlot();
  const t0 = Date.now();

  // …and the tag backfill must queue behind it rather than firing straight
  // away on its own private pacer (round-1 review, major 5: two pacers each
  // individually well-behaved were jointly 2 req/sec on the same host).
  await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(fetchSpy.calls.length, 1);
  const delay = fetchSpy.calls[0].at - t0;
  assert.ok(delay >= 90, `the tag fetch must wait out the shared slot (~120ms), fired after ${delay}ms`);
});

// ---------------------------------------------------------------------------
// 9. Two-pass structure – all the free KV wins land before any network call.
// ---------------------------------------------------------------------------

test("two passes: exactly the KV MISSES reach SteamSpy, and every KV write happens BEFORE the first network call", async () => {
  const env0 = makeMockD1();
  const events = [];
  const env = makeEnv({
    FPM_DB: makeD1WithTagWriteHook(env0, (args) => {
      // bind args are [tagsJson, checkedAtMs, source, appid]
      events.push(`write:${args[2]}:${args[3]}`);
    }),
  });
  await seedCatalog(env, [
    { appid: 1, owned: true },
    { appid: 2, owners: "10,000,000 .. 20,000,000" },
    { appid: 3, owners: "5,000,000 .. 6,000,000" },
    { appid: 4, owners: "1,000,000 .. 2,000,000" },
  ]);
  seedKvTags(env, 1, SPY_CELESTE.tags);
  seedKvTags(env, 3, SPY_TERRARIA.tags);
  const fetchSpy = makeTagFetch((appid) => {
    events.push(`fetch:${appid}`);
    return spyBody(SPY_CASTLE_FULL_OF_CATS, appid);
  });
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.kvSeeded, 2);
  assert.deepEqual(fetchSpy.appids().sort(), [2, 4], "only the KV misses spend a SteamSpy request");

  const firstFetchIndex = events.findIndex((e) => e.startsWith("fetch:"));
  const lastKvWriteIndex = events.map((e, i) => (e.startsWith("write:kv:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(firstFetchIndex > -1 && lastKvWriteIndex > -1);
  assert.ok(
    lastKvWriteIndex < firstFetchIndex,
    `every free KV win must be banked before pass 2 risks anything: ${JSON.stringify(events)}`,
  );
});

test("two passes: a total SteamSpy outage still banks the pass-1 KV wins before giving up", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1, owned: true }, ...Array.from({ length: 6 }, (_, i) => ({ appid: 10 + i }))]);
  seedKvTags(env, 1, SPY_CELESTE.tags);
  globalThis.fetch = makeTagFetch(() => new Response(SPY_THROTTLE_BODY, { status: 200 }));

  const result = await backfillCatalogTags(env, { limit: 100, now: 7000 });

  assert.equal(result.kvSeeded, 1, "the free win landed even though pass 2 collapsed");
  const row = await readRow(env, 1);
  assert.equal(row.tags_source, "kv");
  assert.equal(row.tags_checked_at, 7000);
  const stats = await getCatalogStats(env);
  assert.equal(stats.tagged, 1, "one row of real progress, not a wasted auto-continue iteration");
});

// ---------------------------------------------------------------------------
// 14. Per-row skip valve (FPM_TAGS_MAX_ROW_ATTEMPTS) – one poisoned row must
//     not stall the fill. The counter is the easy half; the ADVANCE is the fix.
// ---------------------------------------------------------------------------

test("per-row skip: a row that never answers usably is skipped after 5 attempts and the loop ADVANCES to the next rows", async () => {
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 1, owned: true }, // poisoned – always plain-text throttle
    { appid: 2, owners: "10,000,000 .. 20,000,000" },
    { appid: 3, owners: "1,000,000 .. 2,000,000" },
  ]);
  const fetchSpy = makeTagFetch((appid) =>
    appid === 1 ? new Response(SPY_THROTTLE_BODY, { status: 200 }) : spyBody(SPY_CELESTE, appid),
  );
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.skipped, 1);
  assert.equal(result.gaveUp, 0, "the pass-level valve did NOT fire – the run completed");
  assert.equal(result.attempted, 2, "the two healthy rows behind the poisoned one were still filled");
  assert.equal(result.tagged, 2);
  assert.deepEqual(
    fetchSpy.appids(),
    [1, 1, 1, 1, 1, 2, 3],
    `exactly ${FPM_TAGS_MAX_ROW_ATTEMPTS} attempts on the poisoned row, then the loop moves on`,
  );

  const poisoned = await readRow(env, 1);
  assert.equal(poisoned.tags_checked_at, null, "a skipped row is left UNSTAMPED – nothing is baked in");
  assert.equal(poisoned.tags_source, null);
  assert.ok((await readRow(env, 2)).tags_checked_at, "the row behind it got filled");
  assert.ok((await readRow(env, 3)).tags_checked_at);

  const stats = await getCatalogStats(env);
  assert.equal(stats.tagsPending, 1, "the skipped row stays visible in the funnel");
  const next = await selectTagsBatch(env, { limit: 10 });
  assert.deepEqual(next.map((r) => r.appid), [1], "and it is reselected on a later run rather than lost");
});

test("per-row skip: a row that recovers on its 5th attempt is filled, not skipped (the valve is a ceiling, not a quota)", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);
  const fetchSpy = makeTagFetch((appid, attempt) =>
    attempt < FPM_TAGS_MAX_ROW_ATTEMPTS ? new Response(SPY_THROTTLE_BODY, { status: 200 }) : spyBody(SPY_CELESTE, appid),
  );
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.skipped, 0);
  assert.equal(result.tagged, 1);
  assert.equal(fetchSpy.calls.length, FPM_TAGS_MAX_ROW_ATTEMPTS);
  assert.deepEqual(JSON.parse((await readRow(env, 1)).tags), SPY_CELESTE.tags);
});

// ---------------------------------------------------------------------------
// 10. Pass-level give-up valve (FPM_TAGS_MAX_CONSECUTIVE_BAD).
// ---------------------------------------------------------------------------

test("give-up: 20 consecutive bad responses abandon the run's remaining rows, all left unstamped and reselected next run", async () => {
  const env = makeEnv();
  const appids = [1, 2, 3, 4, 5];
  await seedCatalog(
    env,
    appids.map((appid) => ({ appid, owners: `${10 - appid},000,000 .. ${11 - appid},000,000` })),
  );
  const fetchSpy = makeTagFetch(() => new Response(SPY_THROTTLE_BODY, { status: 200 }));
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  // Rows 1-3 each burn FPM_TAGS_MAX_ROW_ATTEMPTS (5) and are skipped; the
  // 20th consecutive bad response lands on row 4, tripping the pass valve
  // with rows 4 and 5 unresolved.
  assert.equal(fetchSpy.calls.length, FPM_TAGS_MAX_CONSECUTIVE_BAD, "the run stops spending requests at the valve");
  assert.equal(result.skipped, 3);
  assert.equal(result.gaveUp, 2, "the rows abandoned unresolved when the valve tripped");
  assert.equal(result.attempted, 0);
  assert.equal(result.tagged, 0);
  assert.equal(result.empty, 0);

  for (const appid of appids) {
    const row = await readRow(env, appid);
    assert.equal(row.tags_checked_at, null, `appid ${appid} must be left unstamped`);
  }
  const stats = await getCatalogStats(env);
  assert.equal(stats.tagsPending, 5);
  const next = await selectTagsBatch(env, { limit: 10 });
  assert.deepEqual(next.map((r) => r.appid).sort(), appids, "the next run picks every one of them straight back up");
});

test("give-up: a recovery resets the consecutive-bad counter so a healthy tail is still filled", async () => {
  const env = makeEnv();
  await seedCatalog(env, [
    { appid: 1, owned: true },
    { appid: 2, owners: "9,000,000 .. 10,000,000" },
    { appid: 3, owners: "1,000,000 .. 2,000,000" },
  ]);
  // Rows 1 and 2 each burn 5 bad responses (10 consecutive) but row 3
  // succeeds – 10 < 20, so nothing gives up.
  const fetchSpy = makeTagFetch((appid) =>
    appid === 3 ? spyBody(SPY_CELESTE, appid) : new Response(SPY_THROTTLE_BODY, { status: 200 }),
  );
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.skipped, 2);
  assert.equal(result.gaveUp, 0);
  assert.equal(result.tagged, 1);
});

// ---------------------------------------------------------------------------
// 8. writeFailed / kvFailed – the two counters that used to be swallowed.
// ---------------------------------------------------------------------------

test("writeFailed: a rejected D1 UPDATE increments writeFailed, leaves the row unstamped, and does NOT count as attempted/tagged", async () => {
  const env = makeEnv({
    FPM_DB: makeD1WithTagWriteHook(makeMockD1(), () => {
      throw new Error("D1_ERROR: database is locked (simulated)");
    }),
  });
  await seedCatalog(env, [{ appid: 1 }]);
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.writeFailed, 1);
  assert.equal(result.attempted, 0, "an answer D1 refused to store is not an attempt that concluded");
  assert.equal(result.tagged, 0);
  assert.equal(result.empty, 0);
  assert.equal(result.gaveUp, 0, "one failure is not the valve");
  assert.equal(fetchSpy.calls.length, 1, "the fetch itself succeeded – the row is not retried against SteamSpy");

  const row = await readRow(env, 1);
  assert.equal(row.tags_checked_at, null, "unstamped, so the next run retries it");
  const stats = await getCatalogStats(env);
  assert.equal(stats.tagsPending, 1);
});

test("writeFailed: backfillCatalogTags NEVER throws when D1 refuses writes – it returns counters", async () => {
  const env = makeEnv({
    FPM_DB: makeD1WithTagWriteHook(makeMockD1(), () => {
      throw new Error("D1_ERROR: simulated");
    }),
  });
  await seedCatalog(env, [{ appid: 1 }, { appid: 2 }]);
  globalThis.fetch = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(typeof result.writeFailed, "number", "a throw here would die inside startFpmAutoContinue's silent catch");
  assert.ok(result.writeFailed >= 1);
});

test("backfillCatalogTags: a failing batch SELECT returns a zeroed result rather than throwing", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);
  const good = env.FPM_DB;
  env.FPM_DB = {
    prepare(sql) {
      if (sql.includes("FROM fpm_catalog") && sql.includes("tags_checked_at IS NULL")) {
        return {
          bind: () => ({
            all: async () => {
              throw new Error("D1_ERROR: simulated select failure");
            },
          }),
        };
      }
      return good.prepare(sql);
    },
  };
  const fetchSpy = makeTagFetch();
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.deepEqual(result, { attempted: 0, tagged: 0, kvSeeded: 0, empty: 0, kvFailed: 0, writeFailed: 0, skipped: 0, gaveUp: 0 });
  assert.equal(fetchSpy.calls.length, 0);
});

test("kvFailed: a rejecting TAG_CACHE.get is counted and falls through to the live fetch rather than failing the row", async () => {
  const env = makeEnv({
    TAG_CACHE: {
      async get() {
        throw new Error("KV binding unavailable (simulated)");
      },
      async put() {},
    },
  });
  await seedCatalog(env, [{ appid: 1 }, { appid: 2 }]);
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(result.kvFailed, 2, "a silently-unavailable cache is the gate (d) signal that used to be swallowed");
  assert.equal(result.kvSeeded, 0);
  assert.equal(result.tagged, 2, "the rows still got filled – a KV failure is a missed free win, not a lost row");
  assert.deepEqual(fetchSpy.appids().sort(), [1, 2]);
  assert.equal((await readRow(env, 1)).tags_source, "live");
});

// ---------------------------------------------------------------------------
// 16. Write-failure valve (FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES).
// ---------------------------------------------------------------------------

test("write valve: 5 consecutive D1 write failures stop the run instead of spending the whole SteamSpy budget storing nothing", async () => {
  const env = makeEnv({
    FPM_DB: makeD1WithTagWriteHook(makeMockD1(), () => {
      throw new Error("D1_ERROR: simulated persistent write failure");
    }),
  });
  const appids = [1, 2, 3, 4, 5, 6, 7, 8];
  await seedCatalog(env, appids.map((appid) => ({ appid, owners: `${20 - appid},000,000 .. ${21 - appid},000,000` })));
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 100, now: 7000 });

  assert.equal(result.writeFailed, FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES);
  assert.equal(
    fetchSpy.calls.length,
    FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES,
    "the run stopped spending SteamSpy requests once D1 was clearly broken – 5 fetches, not 8",
  );
  assert.equal(result.gaveUp, appids.length - FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES + 1, "the unresolved remainder is reported");
  assert.equal(result.attempted, 0);
  for (const appid of appids) {
    assert.equal((await readRow(env, appid)).tags_checked_at, null, `appid ${appid} left unstamped`);
  }
});

test("write valve: an intermittent write failure does NOT trip the valve (the counter is consecutive, not cumulative)", async () => {
  let calls = 0;
  const env = makeEnv({
    FPM_DB: makeD1WithTagWriteHook(makeMockD1(), () => {
      calls++;
      if (calls % 2 === 1) throw new Error("D1_ERROR: simulated flap");
    }),
  });
  const appids = [1, 2, 3, 4, 5, 6, 7, 8];
  await seedCatalog(env, appids.map((appid) => ({ appid, owners: `${20 - appid},000,000 .. ${21 - appid},000,000` })));
  const fetchSpy = makeTagFetch((appid) => spyBody(SPY_CELESTE, appid));
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 100, now: 7000 });

  assert.equal(result.gaveUp, 0, "alternating failures never reach 5 in a row");
  assert.equal(result.writeFailed, 4);
  assert.equal(result.tagged, 4);
  assert.equal(fetchSpy.calls.length, 8, "every row was still attempted");
});

// ---------------------------------------------------------------------------
// 15. Interruptible backoff (round-2 review, SEC-7).
// ---------------------------------------------------------------------------

test("interruptible backoff: a Stop requested before the backoff sleep returns immediately instead of running the doubling ladder", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }, { appid: 2 }, { appid: 3 }]);
  // A REAL production-scale backoff: without the stop check this run would
  // sleep 90s on its very first bad response.
  __setTagsBackoffMsForTests(90_000, 600_000);
  const fetchSpy = makeTagFetch(() => {
    requestFpmAutoContinueStop(); // the operator hits Stop while the request is in flight
    return new Response(SPY_THROTTLE_BODY, { status: 200 });
  });
  globalThis.fetch = fetchSpy;

  const t0 = Date.now();
  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 2000, `the run must bail out of the backoff promptly, took ${elapsed}ms of a 90s ladder`);
  assert.equal(result.gaveUp, 3, "all three unresolved rows are reported, none half-written");
  assert.equal(fetchSpy.calls.length, 1, "no further SteamSpy requests after the Stop");
  for (const appid of [1, 2, 3]) {
    assert.equal((await readRow(env, appid)).tags_checked_at, null);
  }
});

test("interruptible backoff: a Stop requested DURING the sleep is honoured within about a second, not after the full backoff", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);
  __setTagsBackoffMsForTests(8000, 600_000); // 8s backoff; the stop check ticks every 1s
  globalThis.fetch = makeTagFetch(() => new Response(SPY_THROTTLE_BODY, { status: 200 }));
  const stopAt = Date.now() + 50;
  setTimeout(() => requestFpmAutoContinueStop(), 50).unref?.();

  const t0 = Date.now();
  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 4000, `Stop must be noticed mid-sleep (~1s), not after the full 8s backoff – took ${elapsed}ms`);
  assert.ok(Date.now() >= stopAt, "sanity: the stop really was requested during the sleep");
  assert.equal(result.gaveUp, 1);
  assert.equal((await readRow(env, 1)).tags_checked_at, null);
});

test("interruptible backoff: with NO stop requested the backoff still runs its course and the row is retried", async () => {
  const env = makeEnv();
  await seedCatalog(env, [{ appid: 1 }]);
  __setTagsBackoffMsForTests(0, 0);
  const fetchSpy = makeTagFetch((appid, attempt) =>
    attempt === 1 ? new Response(SPY_THROTTLE_BODY, { status: 200 }) : spyBody(SPY_CELESTE, appid),
  );
  globalThis.fetch = fetchSpy;

  const result = await backfillCatalogTags(env, { limit: 10, now: 7000 });

  assert.equal(fetchSpy.calls.length, 2, "backoff-and-retry hits the SAME appid again – it never advances on one bad response");
  assert.deepEqual(fetchSpy.appids(), [1, 1]);
  assert.equal(result.tagged, 1);
  assert.equal(result.gaveUp, 0);
});
