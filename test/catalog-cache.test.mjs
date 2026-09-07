// Increment 13 - the catalogue snapshot, the D1 meter and the price classifier.
//
// The claim under test is a COST claim: /api/rank cost 36,620 D1 row reads per
// request and must cost single digits. That number is only trustworthy if the
// thing counting it is trustworthy, so the meter is tested before the cache
// that is scored with it.
//
// NO NETWORK. Every fetch is stubbed by the offline guard; the GetItems
// classifier is exercised against captured live shapes, not live calls.

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { makeMockD1 } from "./helpers/mockD1.mjs";
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";
import { meterEnv } from "../src/d1meter.js";
import {
  loadRankCatalogue,
  __resetCatalogMemoForTests,
  SNAPSHOT_CHUNK_ROWS,
  CATALOG_SNAPSHOT_VERSION,
} from "../src/catalogCache.js";
import {
  ensureCatalogSchema,
  bumpCatalogVersion,
  readCatalogVersion,
  recordPriceResult,
  recordPriceState,
  resolvePriceStateBatch,
  selectPriceStateBatch,
  __setPricePacingMsForTests,
  __setPriceBackoffMsForTests,
  __resetPricePacingForTests,
} from "../src/catalog.js";
import {
  buildStoreItemsInput,
  classifyStoreItem,
  fetchStoreItemsBatch,
  singleGamePurchaseOption,
  STORE_ITEMS_BATCH_SIZE,
} from "../src/storePrices.js";

let guard;
beforeEach(() => {
  guard = makeOfflineFetchGuard("catalog-cache.test.mjs");
  globalThis.fetch = guard;
  __resetCatalogMemoForTests();
});
afterEach(() => {
  assert.deepEqual(guard.calls, [], "no test in this file may reach the network");
});

function makeMockKv() {
  const store = new Map();
  return {
    store,
    puts: [],
    gets: [],
    async get(key) {
      this.gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      store.set(key, value);
      this.puts.push({ key, options });
    },
  };
}

async function makeEnv(rows = 3, overrides = {}) {
  const env = { FPM_DB: makeMockD1(), CATALOG_CACHE: makeMockKv(), ...overrides };
  await ensureCatalogSchema(env);
  for (let i = 0; i < rows; i++) {
    await env.FPM_DB.prepare(
      "INSERT INTO fpm_catalog (appid, name, app_type, experience_score, rank_exclude_checked_at) VALUES (?, ?, 'game', 90, 1)",
    )
      .bind(100 + i, `Game ${i}`)
      .run();
  }
  // A database that has never been stamped is deliberately uncacheable (first
  // boot / just restored), so stamp it the way the first real request would.
  await bumpCatalogVersion(env);
  return env;
}

const ctx = { waitUntil: (p) => p };

// ---------------------------------------------------------------------------
// The meter, first - nothing else here means anything if this is wrong.
// ---------------------------------------------------------------------------

/** A D1 stand-in that reports whatever meta we tell it to. The meter's job is
 * to SUM `meta.rows_read` faithfully; whether SQLite reports scanned or
 * returned rows is a property of D1 itself, and was proved at checkpoint 01
 * against real miniflare (a full scan of an unindexed column returning ZERO
 * rows reported 18,306, a primary-key lookup reported 1). Reproducing that
 * here would test Cloudflare, not us. */
function makeMetaDb(metas) {
  const queue = [...metas];
  return {
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: [], meta: queue.shift() }; },
        async run() { return { results: [], meta: queue.shift() }; },
      };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

test("13 GATE 1: the meter sums rows_read across every call, including a scan that returned nothing", async () => {
  // The shape that made 36,620 invisible for two increments: a query that
  // returns ZERO rows and is charged for the whole table. The meter must add
  // it, not skip it because nothing came back.
  const { env, stats } = meterEnv({
    FPM_DB: makeMetaDb([
      { rows_read: 18306, rows_written: 0 }, // the exclusion scan: 0 rows back
      { rows_read: 18306, rows_written: 0 }, // the catalogue read
      { rows_read: 6, rows_written: 0 },
      { rows_read: 1, rows_written: 2 },
    ]),
  });
  for (let i = 0; i < 3; i++) await env.FPM_DB.prepare("SELECT 1").all();
  await env.FPM_DB.prepare("UPDATE x SET y = 1").run();

  assert.equal(stats.rowsRead, 36619, "every scan counted, including the one that returned nothing");
  assert.equal(stats.rowsWritten, 2);
  assert.equal(stats.queries, 4);
  assert.equal(stats.unmetered, 0);
});

test("13: the meter counts a statement that THROWS, so failing work cannot hide", async () => {
  // Found while measuring ruling 8. The first version of this meter only
  // counted successful calls, and reported an IDENTICAL query count with 23
  // failing ALTER statements present and absent - exactly the flattering
  // number gate 1 exists to refuse.
  const base = { FPM_DB: makeMockD1() };
  const { env, stats } = meterEnv(base);
  await assert.rejects(() => env.FPM_DB.prepare("SELECT * FROM table_that_does_not_exist").all());
  assert.equal(stats.queries, 1, "the failed statement is still a statement that was sent");
  assert.equal(stats.unmetered, 1, "and it is reported as uncountable rather than as zero rows");
});

test("13: the meter is transparent - batch still works and the real binding is reachable", async () => {
  const base = { FPM_DB: makeMockD1() };
  await ensureCatalogSchema(base);
  const { env, stats } = meterEnv(base);
  const stmt = env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name) VALUES (?, ?)");
  await env.FPM_DB.batch([stmt.bind(1, "a"), stmt.bind(2, "b")]);
  const all = await env.FPM_DB.prepare("SELECT appid FROM fpm_catalog").all();
  assert.deepEqual(all.results.map((r) => r.appid), [1, 2], "batched writes landed through the wrapper");
  assert.ok(stats.queries >= 3, "a batch of two counts as two statements plus the read");
});

// ---------------------------------------------------------------------------
// The three tiers.
// ---------------------------------------------------------------------------

test("13 GATE 3: the three tiers are rebuild, then kv, then memory - and only the first reads the catalogue", async () => {
  const env = await makeEnv(5);

  const first = await loadRankCatalogue(env, ctx);
  assert.equal(first.cacheState, "rebuild");
  assert.equal(first.rows.length, 5);

  // A fresh isolate: the module memo is gone, the KV snapshot is not.
  __resetCatalogMemoForTests();
  const second = await loadRankCatalogue(env, ctx);
  assert.equal(second.cacheState, "kv");
  assert.deepEqual(second.rows.map((r) => r.appid), first.rows.map((r) => r.appid));

  const third = await loadRankCatalogue(env, ctx);
  assert.equal(third.cacheState, "memory");
  assert.deepEqual(third.rows.map((r) => r.appid), first.rows.map((r) => r.appid));
});

// ---------------------------------------------------------------------------
// TC-14: THE TIERS MUST AGREE ON VALUES, NOT JUST ON WHICH GAMES ARE PRESENT.
// The tier tests above compared `rows.map(r => r.appid)` and row COUNTS, and
// nothing compared the row bodies. The audit proved the gap by mutation:
// forcing the KV tier to return rows with experience_score 1, tags null and
// price null - every tag and price wiped, and the ranking moved - left all 922
// tests green. SPEC.md §7 item 5 names caching as the one door a hosting
// increment turns into a ranking increment through, so this is the assertion
// that door is shut with.
// ---------------------------------------------------------------------------

/** The FULL selectRankCatalogRows column list, which is the list a snapshot
 * has to carry across a KV round trip intact. Kept here as data so the
 * fixture cannot quietly cover fewer columns than the query selects. */
const RANK_CATALOG_COLUMNS = [
  "appid", "name", "owners", "positive", "negative", "wilson", "app_type",
  "price", "price_cents", "regular", "cut", "price_checked_at", "price_state",
  "tags", "source_owned",
  "experience_score", "game_score", "has_ending", "hours_to_value", "hours_to_good",
  "experience_reason", "experience_confidence", "experience_checked_at",
  "rank_exclude_reason", "rank_exclude_checked_at",
];

/** Three rows that between them exercise every column: a discounted game with
 * tags, a free game with none, and a row that is null nearly everywhere. */
async function seedRichCatalog(env) {
  const rows = [
    {
      appid: 100, name: "Discounted Game", owners: 500000, positive: 9000, negative: 100, wilson: 0.97,
      app_type: "game", price: 14.98, price_cents: 1498, regular: 29.95, cut: 50, price_checked_at: 1700,
      price_state: "priced", tags: JSON.stringify({ Puzzle: 120, Story: 60 }), source_owned: 0,
      experience_score: 91, game_score: 88, has_ending: 1, hours_to_value: 3, hours_to_good: 1,
      experience_reason: "A reason line, with a comma.", experience_confidence: "high",
      experience_checked_at: 1600, rank_exclude_reason: null, rank_exclude_checked_at: 1,
    },
    {
      appid: 101, name: "Free Game", owners: 2000000, positive: 40000, negative: 4000, wilson: 0.9,
      app_type: "game", price: null, price_cents: null, regular: null, cut: null, price_checked_at: 1700,
      price_state: "free", tags: null, source_owned: 1,
      experience_score: 70, game_score: 65, has_ending: 0, hours_to_value: 8, hours_to_good: 20,
      experience_reason: null, experience_confidence: "low", experience_checked_at: 1600,
      rank_exclude_reason: null, rank_exclude_checked_at: 1,
    },
    {
      // owners/positive/negative/wilson are NOT NULL in the schema; every
      // other column on this row is null, which is what it is here to cover.
      appid: 102, name: "Barely Known", owners: 0, positive: 0, negative: 0, wilson: 0,
      app_type: null, price: null, price_cents: null, regular: null, cut: null, price_checked_at: null,
      price_state: null, tags: null, source_owned: 0,
      experience_score: null, game_score: null, has_ending: null, hours_to_value: null, hours_to_good: null,
      experience_reason: null, experience_confidence: null, experience_checked_at: null,
      rank_exclude_reason: "no reviews", rank_exclude_checked_at: 1,
    },
  ];
  const sql = `INSERT INTO fpm_catalog (${RANK_CATALOG_COLUMNS.join(", ")})
               VALUES (${RANK_CATALOG_COLUMNS.map(() => "?").join(", ")})`;
  for (const row of rows) {
    await env.FPM_DB.prepare(sql).bind(...RANK_CATALOG_COLUMNS.map((c) => row[c] ?? null)).run();
  }
}

/** node:sqlite hands back null-prototype objects and JSON.parse hands back
 * plain ones, which strict deepEqual counts as a difference. Real D1 returns
 * plain objects, so the prototype is a property of the test mock and nothing
 * else; the VALUES are what this file is comparing. */
const plain = (rows) => rows.map((r) => ({ ...r }));

test("13 TC-14: the KV and memory tiers return the SAME ROW VALUES as the rebuild, column for column", async () => {
  const env = { FPM_DB: makeMockD1(), CATALOG_CACHE: makeMockKv() };
  await ensureCatalogSchema(env);
  await seedRichCatalog(env);
  await bumpCatalogVersion(env);

  const rebuilt = await loadRankCatalogue(env, ctx);
  assert.equal(rebuilt.cacheState, "rebuild");

  // The fixture must actually carry values, or every assertion below is
  // vacuous - three rows of nulls would compare equal to three rows of nulls.
  assert.deepEqual(
    Object.keys(rebuilt.rows[0]).sort(),
    [...RANK_CATALOG_COLUMNS].sort(),
    "the snapshot carries every column selectRankCatalogRows selects - if this list changed, CATALOG_SNAPSHOT_VERSION must be bumped by hand",
  );
  assert.equal(rebuilt.rows[0].tags, JSON.stringify({ Puzzle: 120, Story: 60 }));
  assert.equal(rebuilt.rows[0].price, 14.98);
  assert.equal(rebuilt.rows[0].cut, 50);
  assert.equal(rebuilt.rows[0].experience_score, 91);

  // A fresh isolate: the memo is gone, the KV snapshot is not.
  __resetCatalogMemoForTests();
  const fromKv = await loadRankCatalogue(env, ctx);
  assert.equal(fromKv.cacheState, "kv");
  assert.deepEqual(plain(fromKv.rows), plain(rebuilt.rows), "the KV tier is the rebuild, value for value - not merely the same appids");

  const fromMemo = await loadRankCatalogue(env, ctx);
  assert.equal(fromMemo.cacheState, "memory");
  assert.deepEqual(plain(fromMemo.rows), plain(rebuilt.rows), "and so is the memo tier");
});

test("13 GATE 3: a warm load issues exactly ONE D1 statement - the version stamp and nothing else", async () => {
  // The whole increment in one assertion. Before it, every page load ran the
  // 18,306-row catalogue read AND an 18,306-row exclusion scan; after it, the
  // catalogue costs one lookup of a single-row table. (The row-read figure
  // itself is gate 3's live capture - the mock database here is real SQLite
  // and does not report Cloudflare's row accounting.)
  const base = await makeEnv(40);
  await loadRankCatalogue(base, ctx);

  const { env, stats } = meterEnv(base);
  const warm = await loadRankCatalogue(env, ctx);
  assert.equal(warm.cacheState, "memory");
  assert.equal(stats.queries, 1, "one statement: SELECT value FROM catalog_meta");
  assert.equal(warm.rows.length, 40, "and the whole catalogue still came back");
});

test("13 GATE 4: a version bump REBUILDS - it does not serve the previous catalogue once", async () => {
  // BLOCKER CR-2, and the correction to what this test used to assert. It
  // previously required cacheState "stale" here, on the reasoning that no
  // visitor should wait. That was wrong, and the reasoning belongs to the
  // OTHER trigger: stale means past its TTL, where the rows in hand are still
  // the rows the database holds. A version bump means the catalogue CHANGED -
  // it fires at the end of every sync and on every `npm run restore` - and
  // serving the previous version even once is serving rows the database may
  // no longer hold, which §9.9 forbids outright.
  const env = await makeEnv(4);
  await loadRankCatalogue(env, ctx);
  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "memory");

  await bumpCatalogVersion(env);
  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "rebuild", "the new version is read from D1, not memory");
  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "memory", "and the new snapshot is then the warm one");
});

test("13 GATE 4 / §4.1: a snapshot past its TTL IS served, with the rebuild behind the response", async () => {
  // The half of gate 4 that survives CR-2 unchanged, and §4.1's actual
  // rationale: the unlucky visitor every six hours must not pay a full
  // catalogue read. Same version, aged past SNAPSHOT_TTL_SECONDS - so the
  // rows are still the rows the database holds, and serving them is honest.
  const env = await makeEnv(4);
  await loadRankCatalogue(env, ctx);
  __resetCatalogMemoForTests();

  // Age the KV snapshot rather than the clock: rewrite the manifest's
  // writtenAt to seven hours ago, leaving version and nonce untouched.
  const version = await readCatalogVersion(env);
  const key = `catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}:manifest`;
  const manifest = JSON.parse(env.CATALOG_CACHE.store.get(key));
  manifest.writtenAt = Date.now() - 7 * 60 * 60 * 1000;
  env.CATALOG_CACHE.store.set(key, JSON.stringify(manifest));

  const waited = [];
  const aged = await loadRankCatalogue(env, { waitUntil: (p) => waited.push(p) });
  assert.equal(aged.cacheState, "stale", "the visitor is not made to wait for a full rebuild");
  assert.equal(aged.rows.length, 4);
  await Promise.all(waited);

  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "memory", "and the rebuild landed behind them");
});

test("13 GATE 4: ?refresh=1 forces a rebuild even when the memo is current", async () => {
  const env = await makeEnv(4);
  await loadRankCatalogue(env, ctx);
  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "memory");
  assert.equal((await loadRankCatalogue(env, ctx, true)).cacheState, "rebuild");
});

test("13 GATE 4: the FIRST response after a deletion already omits the deleted row", async () => {
  // The negative half of gate 4, and the one that matters: a cache that can
  // outlive a deletion is a cache that shows games nobody can buy.
  //
  // CR-2 / SEC-5 renamed and rewrote this. It used to be titled "a stale
  // snapshot NEVER serves a row the database no longer holds" and then
  // DISCARDED the return value of the one call that could have shown it,
  // asserting instead on a later call after the rebuild had landed. It proved
  // "eventually stops", which is not its title. The assertion now lands on the
  // very first response after the delete, which is the claim.
  const env = await makeEnv(4);
  const before = await loadRankCatalogue(env, ctx);
  assert.equal(before.rows.length, 4);

  await env.FPM_DB.prepare("DELETE FROM fpm_catalog WHERE appid = 101").run();
  await bumpCatalogVersion(env);

  const waited = [];
  const next = await loadRankCatalogue(env, { waitUntil: (p) => waited.push(p) });
  assert.equal(next.cacheState, "rebuild", "a version bump is not a TTL expiry and must not serve stale");
  assert.equal(next.rows.length, 3, "the response IN HAND is already short one row");
  assert.ok(!next.rows.some((r) => r.appid === 101), "and the deleted row is not in the response the visitor got");
  await Promise.all(waited);

  const after = await loadRankCatalogue(env, ctx);
  assert.equal(after.rows.length, 3);
  assert.ok(!after.rows.some((r) => r.appid === 101), "still gone once the snapshot is warm again");
});

test("13 TC-1: TWO DATABASES SHARING A VERSION STAMP DO NOT SHARE A CATALOGUE", async () => {
  // THE WORST THING THIS MODULE COULD SHIP, and until now nothing tested it.
  // `memo.db === db` is the only thing standing between database A's rows and
  // a request against database B. Every other test in this file resets the
  // memo in beforeEach, which hides the failure by construction; this one
  // deliberately does NOT reset between the two envs, because a Worker isolate
  // does not either.
  //
  // The version stamp is forced IDENTICAL in both, which is the whole point.
  // In the field the stamps are random and a collision is unlikely - but "the
  // rows of a different database are served under an unlikely condition" is
  // not a property worth resting on, and a restore or a fixed-seed test
  // harness can produce it deliberately.
  const a = await makeEnv(4);
  const b = await makeEnv(2);
  const sharedVersion = "same-stamp-in-both";
  for (const env of [a, b]) {
    await env.FPM_DB.prepare(
      "INSERT INTO catalog_meta (key, value, updated_at) VALUES ('catalog_version', ?, 1)\n" +
      " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(sharedVersion).run();
  }

  const fromA = await loadRankCatalogue(a, ctx);
  assert.equal(fromA.rows.length, 4);

  // No memo reset. Same process, same module, same stamp, different database.
  const fromB = await loadRankCatalogue(b, ctx);
  assert.equal(fromB.rows.length, 2, "database B got database B's rows, not database A's four");
  assert.notEqual(fromB.cacheState, "memory", "and it did not claim a memory hit on someone else's snapshot");
  assert.deepEqual(fromB.rows.map((r) => r.appid).sort(), [100, 101]);

  // And back the other way, still with no reset: A must not now be serving B's.
  const backToA = await loadRankCatalogue(a, ctx);
  assert.equal(backToA.rows.length, 4, "and A is not left holding B's two rows either");
});

test("13 TC-1: the STALE branch is database-scoped too, not just the fresh one", async () => {
  // The same guard appears twice, on two different branches, and a mutation
  // that removed it from only the stale branch would leave the test above
  // green. Age A's snapshot past its TTL so B's request lands on the stale
  // branch with A's rows sitting in the memo.
  const a = await makeEnv(4);
  const b = await makeEnv(2);
  const sharedVersion = "same-stamp-stale-branch";
  for (const env of [a, b]) {
    await env.FPM_DB.prepare(
      "INSERT INTO catalog_meta (key, value, updated_at) VALUES ('catalog_version', ?, 1)\n" +
      " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(sharedVersion).run();
  }

  await loadRankCatalogue(a, ctx);
  // Age BOTH the memo (via A's KV manifest, which the memo mirrors) and B's
  // own snapshot, so nothing is "fresh" and the stale branch is the one taken.
  const key = `catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${sharedVersion}:manifest`;
  const aged = JSON.parse(a.CATALOG_CACHE.store.get(key));
  aged.writtenAt = Date.now() - 7 * 60 * 60 * 1000;
  a.CATALOG_CACHE.store.set(key, JSON.stringify(aged));

  const waited = [];
  const fromB = await loadRankCatalogue(b, { waitUntil: (p) => waited.push(p) });
  assert.equal(fromB.rows.length, 2, "B is never handed A's rows, stale or fresh");
  assert.ok(!fromB.rows.some((r) => r.appid === 103), "and specifically not the row only A has");
  await Promise.all(waited);
});

test("13 SEC-2: a chunk of right-length JUNK rebuilds rather than being served as rows", async () => {
  // Length alone would accept an array of the right size full of nulls, and
  // the first property read on one of those happens in handleRank's funnel,
  // OUTSIDE its try - a 500 on a page that must never be able to 500.
  const env = await makeEnv(3);
  await loadRankCatalogue(env, ctx);
  __resetCatalogMemoForTests();

  const version = await readCatalogVersion(env);
  const chunk0 = `catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}:0`;
  const good = JSON.parse(env.CATALOG_CACHE.store.get(chunk0));
  env.CATALOG_CACHE.store.set(chunk0, JSON.stringify({ nonce: good.nonce, rows: [null, null, null] }));

  const result = await loadRankCatalogue(env, ctx);
  assert.equal(result.cacheState, "rebuild");
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every((r) => typeof r.appid === "number"), "real rows, from the database");
});

test("13 SEC-3: chunks from two different writes are never assembled into one catalogue", async () => {
  // Two rebuilds can be in flight under the SAME version - a ?refresh=1
  // alongside a TTL-expiry background rebuild is enough - and both write the
  // same chunk keys. The write nonce makes a mixed read detectable, and a
  // detected mix rebuilds.
  const env = await makeEnv(3);
  await loadRankCatalogue(env, ctx);
  __resetCatalogMemoForTests();

  const version = await readCatalogVersion(env);
  const chunk0 = `catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}:0`;
  const written = JSON.parse(env.CATALOG_CACHE.store.get(chunk0));
  assert.equal(typeof written.nonce, "string", "every chunk carries the identity of the write that made it");
  // The same rows, from a different write.
  env.CATALOG_CACHE.store.set(chunk0, JSON.stringify({ nonce: "some-other-write", rows: written.rows }));

  const result = await loadRankCatalogue(env, ctx);
  assert.equal(result.cacheState, "rebuild", "a chunk the manifest did not commit is not served");
  assert.equal(result.rows.length, 3);
});

test("13 TC-8: a database with NO version stamp always REBUILDS - a warm memo is not trusted across a restore", async () => {
  // The `justMinted` rule, unpinned until now. An unstamped database is first
  // boot or a database straight out of a restore. With nothing to compare
  // against, every tier below would happily hand back whatever was last in
  // memory - which on a DIFFERENT database is the one thing §9.9 forbids
  // outright. The spec is explicit that this is the one case allowed to pay
  // the cold cost.
  //
  // WHAT THIS DOES AND DOES NOT PIN, stated because a reviewer will check. It
  // pins the BEHAVIOUR - rebuild, the right rows, and a stamp minted so the
  // next request can be warm. It does NOT isolate the `!justMinted` clause:
  // after blocker CR-2 the version guard reaches the same answer on its own,
  // so removing that clause leaves this green. Recorded in the source rather
  // than dressed up as coverage it does not have.
  const env = await makeEnv(4);
  await loadRankCatalogue(env, ctx);
  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "memory", "warm, with a stamp");

  // Wipe the stamp, exactly as a restore of a dump with no `catalog_meta` does
  // (SEC-6: catalog_meta is no longer backed up), and swap the rows out too so
  // a stale answer would be visible rather than coincidentally right.
  await env.FPM_DB.prepare("DELETE FROM catalog_meta WHERE key = 'catalog_version'").run();
  assert.equal(await readCatalogVersion(env), null);
  await env.FPM_DB.prepare("DELETE FROM fpm_catalog WHERE appid >= 102").run();

  const next = await loadRankCatalogue(env, ctx);
  assert.equal(next.cacheState, "rebuild", "no stamp means no trustworthy snapshot, whatever is in the memo");
  assert.equal(next.rows.length, 2, "and the rows are the ones the database actually holds now");

  // And it MINTS one, rather than rebuilding on every request forever.
  const minted = await readCatalogVersion(env);
  assert.notEqual(minted, null, "a stamp is written, so the next request can be warm");
  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "memory");
});

test("13 GATE 4 / §9.9: no CATALOG_CACHE binding degrades to a direct read, never a failure", async () => {
  const env = await makeEnv(3, { CATALOG_CACHE: undefined });
  const first = await loadRankCatalogue(env, ctx);
  assert.equal(first.cacheState, "rebuild");
  assert.equal(first.rows.length, 3);
  // The module memo still works without KV, so the second call is free.
  assert.equal((await loadRankCatalogue(env, ctx)).cacheState, "memory");
});

test("13 §9.9: a KV that throws on every call still yields a full catalogue", async () => {
  const angry = {
    async get() { throw new Error("KV is down"); },
    async put() { throw new Error("KV is down"); },
  };
  const env = await makeEnv(3, { CATALOG_CACHE: angry });
  const result = await loadRankCatalogue(env, ctx);
  assert.equal(result.cacheState, "rebuild");
  assert.equal(result.rows.length, 3);
});

test("13 §9.9: a corrupt snapshot rebuilds rather than serving a SHORT catalogue", async () => {
  // A missing chunk is a corrupt snapshot, not a smaller one. Returning the
  // rows that did arrive would silently drop games off the page.
  const env = await makeEnv(3);
  await loadRankCatalogue(env, ctx);
  __resetCatalogMemoForTests();

  const version = await readCatalogVersion(env);
  env.CATALOG_CACHE.store.delete(`catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}:0`);

  const result = await loadRankCatalogue(env, ctx);
  assert.equal(result.cacheState, "rebuild");
  assert.equal(result.rows.length, 3, "the whole catalogue, not the surviving chunks");
});

test("13 §5: the snapshot is written as chunks plus a manifest, with a TTL on every value", async () => {
  const env = await makeEnv(3);
  await loadRankCatalogue(env, ctx);

  const keys = [...env.CATALOG_CACHE.store.keys()];
  assert.ok(keys.some((k) => k.endsWith(":manifest")), "a manifest key is written");
  assert.ok(keys.some((k) => k.endsWith(":0")), "at least one chunk key is written");
  assert.ok(keys.every((k) => k.startsWith(`catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:`)),
    "every key carries the hand-bumped shape version, so a shape change cannot read an old snapshot");
  assert.ok(env.CATALOG_CACHE.puts.every((p) => p.options?.expirationTtl > 0),
    "every value expires, so a writer that bypasses the version bump is still bounded");
  // The manifest commits the write, so it must be written LAST.
  assert.ok(env.CATALOG_CACHE.puts.at(-1).key.endsWith(":manifest"),
    "the manifest is the commit and goes last, or a reader could find it pointing at chunks that do not exist");
});

// ---------------------------------------------------------------------------
// TC-5: CHUNKING, EXERCISED FOR REAL. Every test above uses a 3-row fixture,
// which is ONE chunk - so production, which writes FIVE, was covered by
// nothing. The seed below is 8,001 rows at the production SNAPSHOT_CHUNK_ROWS
// (no test seam, no shrunken constant), which is three chunks with a deliberate
// ragged last one. It costs about 50 ms.
// ---------------------------------------------------------------------------

async function makeBigEnv(rows) {
  const env = { FPM_DB: makeMockD1(), CATALOG_CACHE: makeMockKv() };
  await ensureCatalogSchema(env);
  const stmt = env.FPM_DB.prepare(
    "INSERT INTO fpm_catalog (appid, name, app_type, experience_score, rank_exclude_checked_at) VALUES (?, ?, 'game', 90, 1)",
  );
  for (let i = 0; i < rows; i++) await stmt.bind(100 + i, `Game ${i}`).run();
  await bumpCatalogVersion(env);
  return env;
}

test("13 TC-5: a MULTI-CHUNK snapshot round-trips exactly, in order, with a ragged last chunk", async () => {
  const total = 2 * SNAPSHOT_CHUNK_ROWS + 1; // 8,001: two full chunks and one holding a single row
  const env = await makeBigEnv(total);

  const built = await loadRankCatalogue(env, ctx);
  assert.equal(built.cacheState, "rebuild");
  assert.equal(built.rows.length, total);

  const chunkKeys = [...env.CATALOG_CACHE.store.keys()].filter((k) => !k.endsWith(":manifest"));
  assert.equal(chunkKeys.length, 3, "three chunks at the PRODUCTION chunk size, not one");
  const manifest = JSON.parse([...env.CATALOG_CACHE.store.entries()].find(([k]) => k.endsWith(":manifest"))[1]);
  assert.equal(manifest.chunks, 3);
  assert.equal(manifest.rows, total);
  assert.equal(JSON.parse(env.CATALOG_CACHE.store.get(chunkKeys[2])).rows.length, 1, "the last chunk is the remainder");

  // Now read it back from KV alone, and check the ORDER survived reassembly -
  // three chunks concatenated in the wrong order would still have the right
  // count, and every test before this one had only one chunk to get right.
  __resetCatalogMemoForTests();
  const fromKv = await loadRankCatalogue(env, ctx);
  assert.equal(fromKv.cacheState, "kv");
  assert.equal(fromKv.rows.length, total);
  assert.deepEqual(fromKv.rows.map((r) => r.appid), built.rows.map((r) => r.appid), "same rows, same order");
});

test("13 TC-5: EACH of readSnapshotFromKv's guards is load-bearing on a multi-chunk snapshot", async () => {
  // Both guards survived removal individually while the fixture was one chunk.
  // Each case below corrupts a DIFFERENT chunk in a different way, and each
  // must rebuild rather than serve.
  const total = 2 * SNAPSHOT_CHUNK_ROWS + 1;
  const keyOf = (version, i) => `catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}:${i}`;

  const cases = [
    ["a MIDDLE chunk missing", (kv, v) => kv.store.delete(keyOf(v, 1))],
    ["the LAST chunk missing", (kv, v) => kv.store.delete(keyOf(v, 2))],
    ["a chunk of the right length full of nulls", (kv, v) => {
      const c = JSON.parse(kv.store.get(keyOf(v, 1)));
      kv.store.set(keyOf(v, 1), JSON.stringify({ nonce: c.nonce, rows: c.rows.map(() => null) }));
    }],
    ["a chunk whose rows have no appid", (kv, v) => {
      const c = JSON.parse(kv.store.get(keyOf(v, 0)));
      kv.store.set(keyOf(v, 0), JSON.stringify({ nonce: c.nonce, rows: c.rows.map(() => ({ name: "x" })) }));
    }],
    ["a chunk from a DIFFERENT write", (kv, v) => {
      const c = JSON.parse(kv.store.get(keyOf(v, 1)));
      kv.store.set(keyOf(v, 1), JSON.stringify({ nonce: "another-write", rows: c.rows }));
    }],
    ["a chunk still in the OLD bare-array shape", (kv, v) => {
      const c = JSON.parse(kv.store.get(keyOf(v, 1)));
      kv.store.set(keyOf(v, 1), JSON.stringify(c.rows));
    }],
    ["a manifest whose row count does not match what arrived", (kv, v) => {
      const k = `catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${v}:manifest`;
      const m = JSON.parse(kv.store.get(k));
      kv.store.set(k, JSON.stringify({ ...m, rows: m.rows - 1 }));
    }],
  ];

  for (const [label, corrupt] of cases) {
    const env = await makeBigEnv(total);
    await loadRankCatalogue(env, ctx);
    __resetCatalogMemoForTests();
    corrupt(env.CATALOG_CACHE, await readCatalogVersion(env));

    const result = await loadRankCatalogue(env, ctx);
    assert.equal(result.cacheState, "rebuild", `${label}: must rebuild`);
    assert.equal(result.rows.length, total, `${label}: the WHOLE catalogue, never the surviving chunks`);
  }
});

test("13 TC-5: a missing chunk ABANDONS the read immediately - it does not fetch the rest", async () => {
  // The `if (raw == null) return null` guard has a backstop: even if it read
  // on, `rows.length !== manifest.rows` would still force a rebuild, so
  // swapping the return for a `continue` leaves the OUTCOME correct. Its own
  // distinct property is cost - a snapshot already known to be corrupt must
  // not go on paying for the chunks after the hole. That is what this pins,
  // and it is the property `continue` breaks.
  const env = await makeBigEnv(2 * SNAPSHOT_CHUNK_ROWS + 1);
  await loadRankCatalogue(env, ctx);
  __resetCatalogMemoForTests();

  const version = await readCatalogVersion(env);
  env.CATALOG_CACHE.store.delete(`catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}:0`);
  env.CATALOG_CACHE.gets.length = 0;

  const result = await loadRankCatalogue(env, ctx);
  assert.equal(result.cacheState, "rebuild");
  const chunkReads = env.CATALOG_CACHE.gets.filter((k) => /:\d+$/.test(k));
  assert.deepEqual(chunkReads, [`catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}:0`],
    "it asked for chunk 0, found nothing, and stopped - it did not go on to read chunks 1 and 2");
});

// ---------------------------------------------------------------------------
// Gate 9 - the defect that would have undone the whole fill, weeks later.
// ---------------------------------------------------------------------------

test("13 GATE 9: a list price won by the fill SURVIVES the next no-deal ITAD refresh", async () => {
  // recordPriceResult used to write `regular = NULL` whenever a check found no
  // live deal - which is most checks. Increment 13's fill wins a list price for
  // ~11,400 ranked rows, and the next routine sale refresh would have erased
  // every one of them silently. This is the test that stops that returning.
  const env = { FPM_DB: makeMockD1() };
  await ensureCatalogSchema(env);
  await env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name, app_type) VALUES (620, 'Portal 2', 'game')").run();

  await recordPriceState(env, 620, { state: "priced", price: 14.5, priceCents: 1450, regular: 14.5, cut: 0 }, "getitems", 1000);

  // The sale lane runs and finds no live deal, exactly as it does for most
  // rows on most days.
  await recordPriceResult(env, 620, { price: null, priceCents: null, regular: null, cut: null, itadId: "itad-x", checkedAtMs: 2000 });

  const row = (await env.FPM_DB.prepare("SELECT price, price_cents, regular, cut, price_state, price_checked_at FROM fpm_catalog WHERE appid = 620").all()).results[0];
  assert.equal(row.regular, 14.5, "the list price is still there");
  assert.equal(row.price, 14.5, "and the card still shows a number - the sale ended, the price did not vanish");
  assert.equal(row.price_cents, 1450);
  assert.equal(row.cut, 0, "no discount, stated as zero rather than as unknown");
  assert.equal(row.price_state, "priced");
  assert.equal(row.price_checked_at, 2000, "the TTL cycle is unchanged");
});

test("13 GATE 9: a real deal still overwrites everything, including the list price", async () => {
  const env = { FPM_DB: makeMockD1() };
  await ensureCatalogSchema(env);
  await env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name, app_type) VALUES (620, 'Portal 2', 'game')").run();
  await recordPriceState(env, 620, { state: "priced", price: 14.5, priceCents: 1450, regular: 14.5, cut: 0 }, "getitems", 1000);

  await recordPriceResult(env, 620, { price: 3.62, priceCents: 362, regular: 14.5, cut: 75, itadId: "itad-x", checkedAtMs: 3000 });

  const row = (await env.FPM_DB.prepare("SELECT price, regular, cut FROM fpm_catalog WHERE appid = 620").all()).results[0];
  assert.deepEqual([row.price, row.regular, row.cut], [3.62, 14.5, 75]);
});

// ---------------------------------------------------------------------------
// The fill's cursor and the GetItems classifier.
// ---------------------------------------------------------------------------

test("13 GATE 7: the cursor is price_state IS NULL, so a kill and resume loses nothing and repeats nothing", async () => {
  const env = { FPM_DB: makeMockD1() };
  await ensureCatalogSchema(env);
  for (let i = 0; i < 10; i++) {
    await env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name, app_type) VALUES (?, ?, 'game')").bind(i, `g${i}`).run();
  }

  const first = await selectPriceStateBatch(env, { limit: 4 });
  assert.deepEqual(first.map((r) => r.appid), [0, 1, 2, 3]);
  for (const r of first) await recordPriceState(env, r.appid, { state: "unknown" }, "getitems", 1);

  // The "kill" happens here - nothing else was written.
  const second = await selectPriceStateBatch(env, { limit: 4 });
  assert.deepEqual(second.map((r) => r.appid), [4, 5, 6, 7], "resumes exactly where it stopped");

  for (const r of second) await recordPriceState(env, r.appid, { state: "unknown" }, "getitems", 1);
  const third = await selectPriceStateBatch(env, { limit: 100 });
  assert.deepEqual(third.map((r) => r.appid), [8, 9]);
  for (const r of third) await recordPriceState(env, r.appid, { state: "unknown" }, "getitems", 1);
  assert.deepEqual(await selectPriceStateBatch(env, { limit: 100 }), [], "and it terminates");
});

test("13 SEC-1 / GATE 4: the price fill BUMPS THE VERSION, so the next request cannot serve pre-fill rows", async () => {
  // SPEC.md gate 4 promises "a price write bumps the version and the next
  // request rebuilds", and it was FALSE for the only new price writer:
  // tools/fill-prices.mjs runs outside runFpmSyncPipeline, which was the only
  // thing that bumped. KV survives the wrangler restart the tool asks for, so
  // the next request would find an unchanged stamp and serve pre-fill rows for
  // up to six hours. The bump now lives in the function that does the writing,
  // where a future caller cannot forget it.
  const env = await makeEnv(1);
  const before = await readCatalogVersion(env);

  // A stub, not the guard: this is the classifier's own upstream shape.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      response: { store_items: [{ id: 100, success: 1, visible: true, is_free: true }] },
    }), { status: 200, headers: { "content-type": "application/json" } });

  const tally = await resolvePriceStateBatch(env, [{ appid: 100, name: "Game 0" }], { nowMs: 1000 });
  assert.equal(tally.attempted, 1);
  assert.notEqual(await readCatalogVersion(env), before, "the stamp moved, so every tier is invalidated");
});

test("13 SEC-8: a fill that WROTE and then GAVE UP still bumps - the error path is not an escape hatch", async () => {
  // The bump used to sit after the chunk loop, and the give-up return fired
  // before it. A run that wrote several chunks and then abandoned left the
  // stamp unmoved, so the memo and KV served PRE-FILL rows for up to the
  // six-hour TTL - SEC-1's failure mode surviving on the error path, and
  // tools/fill-prices.mjs breaks on exactly that tally.
  const env = await makeEnv(STORE_ITEMS_BATCH_SIZE + 1);
  const before = await readCatalogVersion(env);
  __setPricePacingMsForTests(0);
  __setPriceBackoffMsForTests(0, 0);
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls > 1) return new Response("upstream is unhappy", { status: 503 });
      const items = Array.from({ length: STORE_ITEMS_BATCH_SIZE }, (_, i) => ({ id: 100 + i, success: 1, visible: true, is_free: true }));
      return new Response(JSON.stringify({ response: { store_items: items } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const items = Array.from({ length: STORE_ITEMS_BATCH_SIZE + 1 }, (_, i) => ({ appid: 100 + i, name: `Game ${i}` }));
    const tally = await resolvePriceStateBatch(env, items, { nowMs: 1000 });

    assert.equal(tally.attempted, STORE_ITEMS_BATCH_SIZE, "the first chunk was written through");
    assert.equal(tally.gaveUp, 1, "and then the run abandoned the rest");
    assert.notEqual(await readCatalogVersion(env), before, "the rows it DID write are visible to the very next request");
  } finally {
    __resetPricePacingForTests();
  }
});

test("13 SEC-1: a fill run that attempted NOTHING does not bump - an idle rebuild is not free", async () => {
  const env = await makeEnv(1);
  const before = await readCatalogVersion(env);
  const tally = await resolvePriceStateBatch(env, [], { nowMs: 1000 });
  assert.equal(tally.attempted, 0);
  assert.equal(await readCatalogVersion(env), before);
});

test("13: selectPriceStateBatch has no main_hours gate and no source_owned gate", async () => {
  // Both gates on its increment-8.5 sibling were wrong for this job: main_hours
  // is a dead column from the retired /api/fpm lane, and an owned row still
  // needs a STATE even though its price is never rendered, or the funnel's
  // price block cannot partition the ranked pool.
  const env = { FPM_DB: makeMockD1() };
  await ensureCatalogSchema(env);
  await env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name, app_type, main_hours, source_owned) VALUES (1, 'no hours', 'game', NULL, 0)").run();
  await env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name, app_type, main_hours, source_owned) VALUES (2, 'owned', 'game', NULL, 1)").run();
  const rows = await selectPriceStateBatch(env, { limit: 10 });
  assert.deepEqual(rows.map((r) => r.appid), [1, 2]);
});

test("13 RULING 13: the bundle guard - a game sold only inside a bundle gets NO price", async () => {
  // Live shapes captured 2026-09-06. Castle Crashers' best_purchase_option is
  // a TWO-GAME bundle at A$ 6.40 and GTA: Vice City Definitive's is the
  // trilogy at A$ 89.95. Either number on the card would be confidently wrong,
  // which is what made this a build blocker rather than a nicety.
  const bundleOnly = {
    id: 204360, appid: 204360, success: 1, visible: true, name: "Castle Crashers",
    best_purchase_option: {
      bundleid: 82671, included_game_count: 2, final_price_in_cents: "640",
      formatted_final_price: "A$ 6.40", discount_pct: 62,
    },
    purchase_options: [{ bundleid: 82671, included_game_count: 2, final_price_in_cents: "640" }],
  };
  assert.equal(singleGamePurchaseOption(bundleOnly), null);
  const verdict = classifyStoreItem(bundleOnly);
  assert.equal(verdict.state, "unknown");
  assert.equal(verdict.price, null, "no number reaches the row");
  assert.match(verdict.reason, /bundle/);
});

test("13 RULING 13: a single-game package IS taken, even when a bundle is listed first", async () => {
  const both = {
    id: 400, appid: 400, success: 1, visible: true,
    purchase_options: [
      { bundleid: 99, included_game_count: 3, final_price_in_cents: "9999" },
      { packageid: 1, included_game_count: 1, final_price_in_cents: "595", original_price_in_cents: "1190", discount_pct: 50, formatted_final_price: "A$ 5.95" },
    ],
  };
  const verdict = classifyStoreItem(both);
  assert.deepEqual(
    { state: verdict.state, price: verdict.price, regular: verdict.regular, cut: verdict.cut },
    { state: "priced", price: 5.95, regular: 11.9, cut: 50 },
  );
});

test("13: classifyStoreItem produces all five states from the shapes Steam actually returns", async () => {
  // Every one of these is a captured live response from the probe, including
  // Steam's own typo in `unvailable_for_country_restriction`.
  const cases = [
    ["priced", { id: 2070550, success: 1, visible: true, purchase_options: [{ packageid: 739774, included_game_count: 1, final_price_in_cents: "595", formatted_final_price: "A$ 5.95" }] }],
    ["free", { id: 440, success: 1, visible: true, is_free: true, purchase_options: [{ packageid: 469, included_game_count: 4, final_price_in_cents: "2950" }] }],
    ["delisted", { id: 241040, appid: 0, success: 15, visible: false, name: "" }],
    ["region", { id: 274170, appid: 274170, success: 15, visible: false, unvailable_for_country_restriction: true }],
    ["unknown", { id: 420, success: 1, visible: true, name: "Half-Life 2: Episode Two" }],
    ["unknown", undefined],
  ];
  for (const [expected, item] of cases) {
    assert.equal(classifyStoreItem(item).state, expected, JSON.stringify(item)?.slice(0, 60));
  }
});

test("13: `free` comes only from is_free, never from a price of zero", async () => {
  // ITAD reports free-to-play games as $0.00 and cannot tell them apart from a
  // game it has no price for. That is one of the reasons it lost the probe,
  // and it must not be reintroduced here by inference.
  const zeroPriced = {
    id: 1, success: 1, visible: true,
    purchase_options: [{ packageid: 1, included_game_count: 1, final_price_in_cents: "0" }],
  };
  const verdict = classifyStoreItem(zeroPriced);
  assert.equal(verdict.state, "priced", "a zero price is a price, not a claim that the game is free");
  assert.equal(verdict.price, 0);
});

test("13 RULING 13 / TC-3: the COUNT clause alone stops a 4-game package pricing a single game", async () => {
  // TC-3, and it is the mutation that puts a WRONG PRICE ON A CARD. The Castle
  // Crashers fixture above carries `bundleid`, so BOTH halves of the guard
  // reject it and either half alone still passes - the test could not tell
  // them apart. This shape has a `packageid`, so the packageid clause accepts
  // it, and ONLY `included_game_count === 1` refuses it. Deleting that clause
  // yields `priced` at A$ 29.50 on a single game.
  const multiGamePackage = {
    id: 440, success: 1, visible: true, name: "A game sold in a 4-pack",
    purchase_options: [{ packageid: 469, included_game_count: 4, final_price_in_cents: "2950" }],
  };
  assert.equal(singleGamePurchaseOption(multiGamePackage), null, "a packageid is not enough - the count decides");
  const verdict = classifyStoreItem(multiGamePackage);
  assert.equal(verdict.state, "unknown");
  assert.equal(verdict.price, null, "A$ 29.50 must not reach the row");
  assert.equal(verdict.priceCents, null);
});

test("13 RULING 13 / TC-3: the PACKAGEID clause alone stops a single-game BUNDLE pricing a game", async () => {
  // The other half, pinned the same way. `included_game_count === 1` accepts
  // this shape, so only `packageid != null` refuses it. A bundle that happens
  // to contain one game is still a bundle - a different product with a
  // different page - and its price is not this game's price.
  const singleGameBundle = {
    id: 400, success: 1, visible: true,
    purchase_options: [{ bundleid: 82671, included_game_count: 1, final_price_in_cents: "640" }],
  };
  assert.equal(singleGamePurchaseOption(singleGameBundle), null, "no packageid - not a package, whatever the count says");
  assert.equal(classifyStoreItem(singleGameBundle).price, null);
});

test("13 RULING 13 / TC-3: best_purchase_option is held to the SAME two clauses as the list", async () => {
  // singleGamePurchaseOption falls back to best_purchase_option when the list
  // has no single-game entry, and that fallback must not be the loose door.
  const bestIsBundle = {
    id: 12210, success: 1, visible: true,
    best_purchase_option: { bundleid: 7, included_game_count: 3, final_price_in_cents: "8995" },
    purchase_options: [],
  };
  assert.equal(singleGamePurchaseOption(bestIsBundle), null);
  assert.equal(classifyStoreItem(bestIsBundle).price, null, "A$ 89.95 must not reach the row");

  const bestIsSingle = {
    id: 12211, success: 1, visible: true,
    best_purchase_option: { packageid: 5, included_game_count: 1, final_price_in_cents: "1995" },
    purchase_options: [],
  };
  assert.equal(classifyStoreItem(bestIsSingle).price, 19.95, "and the legitimate fallback still works");
});

test("13 SEC-4 / CR-12: an EMPTY price string is absent, not zero - `Number(\"\")` is 0", async () => {
  // The function's own comment promised this and the code did not do it.
  // `Number("")`, `Number(" ")`, `Number([])` and `Number(true)` are all
  // finite, so every one of these used to produce `priced` at $0.00 - which is
  // the app asserting a game is free when it has no idea.
  for (const bad of ["", "   ", [], true, "A$ 5.95", {}, "-100"]) {
    const item = {
      id: 1, success: 1, visible: true,
      purchase_options: [{ packageid: 1, included_game_count: 1, final_price_in_cents: bad }],
    };
    const verdict = classifyStoreItem(item);
    assert.equal(verdict.state, "unknown", `final_price_in_cents ${JSON.stringify(bad)} must not price the row`);
    assert.equal(verdict.price, null);
  }
  // A real zero from a real numeric string is still a price, unchanged.
  assert.equal(classifyStoreItem({
    id: 1, success: 1, visible: true,
    purchase_options: [{ packageid: 1, included_game_count: 1, final_price_in_cents: "0" }],
  }).price, 0);
});

test("13 RULING 15 / TC-4: fetchStoreItemsBatch keys the map on `id`, so a delisted row is NOT skipped", async () => {
  // TC-4: the old test asserted `delisted.appid === 0` against a literal it
  // had written two lines earlier, and never called the function the ruling is
  // about. `fetchStoreItemsBatch` had ZERO test references, so keying its map
  // on `item.appid` left the suite green - the exact silent skip ruling 15
  // exists to prevent.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      response: { store_items: [
        // The delisted shape, live-captured: the requested appid survives only in `id`.
        { id: 241040, appid: 0, success: 15, visible: false, name: "" },
        { id: 2070550, appid: 2070550, success: 1, visible: true },
      ] },
    }), { status: 200, headers: { "content-type": "application/json" } });

  const result = await fetchStoreItemsBatch([241040, 2070550]);
  assert.equal(result.status, "ok");
  assert.ok(result.itemsByAppid.has(241040), "the delisted row is reachable under the appid we ASKED for");
  assert.equal(result.itemsByAppid.has(0), false, "and never under 0, which would collide across every delisted row");
  assert.equal(classifyStoreItem(result.itemsByAppid.get(241040)).state, "delisted");
  assert.equal(result.itemsByAppid.size, 2);
});

test("13 TC-4: fetchStoreItemsBatch never throws - a network error, a non-200 and junk all resolve to 'error'", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  assert.equal((await fetchStoreItemsBatch([1])).status, "error");

  globalThis.fetch = async () => new Response("nope", { status: 503 });
  assert.equal((await fetchStoreItemsBatch([1])).status, "error");

  globalThis.fetch = async () => new Response("not json", { status: 200 });
  assert.equal((await fetchStoreItemsBatch([1])).status, "error");

  globalThis.fetch = async () => new Response(JSON.stringify({ response: {} }), { status: 200 });
  assert.equal((await fetchStoreItemsBatch([1])).status, "error", "a response with no store_items array is an error, not an empty batch");
});

test("13 TC-11: buildStoreItemsInput asks AU, and asks for the fields the classifier reads", async () => {
  // Nothing pinned the request side at all. `country_code: "AU"` is the whole
  // reason the prices on the cards are Australian dollars, and
  // `include_all_purchase_options` is what makes ruling 13's guard have
  // anything to guard - without it there is no purchase_options list and every
  // row would come back `unknown`.
  const input = JSON.parse(buildStoreItemsInput([440, 620]));
  assert.deepEqual(input.ids, [{ appid: 440 }, { appid: 620 }]);
  assert.equal(input.context.country_code, "AU", "every price this app quotes is Australian");
  assert.equal(input.data_request.include_all_purchase_options, true);
  assert.equal(input.data_request.include_basic_info, true);
});
