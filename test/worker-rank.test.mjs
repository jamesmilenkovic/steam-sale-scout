// Tests for src/worker.js's /api/rank — increment 11's headline lane.
//
// NEVER makes a real network call. The library is pre-seeded into the mock
// Cache API under the exact key libraryCacheKey() builds, and ITAD_API_KEY is
// deliberately absent from the default env so the historical-low pool is
// never consulted — see handleRank's comment on why this lane is gated on
// that key rather than refusing without it. The offline guard is installed as
// `globalThis.fetch` in beforeEach and asserted empty in afterEach, so a test
// that accidentally reaches the network fails loudly at the exact test.
//
// Test titles name the SPEC.md §10 coverage item or §11 gate they hold up.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";
import { ensureCatalogSchema } from "../src/catalog.js";
import { ensureSettingsSchema, putSettings } from "../src/settings.js";
import { ensureDismissalsSchema, addDismissal } from "../src/dismissals.js";
import { RANK_PRESETS, SUPPRESS_LOW_CONFIDENCE_KEY } from "../src/rank.js";

const originalCaches = globalThis.caches;
let offlineGuard = makeOfflineFetchGuard("worker-rank");

function restoreGlobals() {
  globalThis.fetch = makeOfflineFetchGuard("worker-rank (between tests)");
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

const STEAM_ID = "76561198000000000";

function makeEnv(overrides = {}) {
  return {
    STEAM_API_KEY: "test-steam-key",
    STEAM_ID,
    // ITAD_API_KEY deliberately omitted — /api/rank must work without it.
    TAG_CACHE: makeMockKv(),
    FPM_DB: makeMockD1(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
}

/** Pre-seed the library into the Cache API under handleLibrary's own key, so
 * loadLibraryForRank finds it without any fetch. */
function seedLibrary(cache, games) {
  cache.store.set(
    `https://steam-sale-scout.cache/api/library?steamid=${STEAM_ID}`,
    new Response(JSON.stringify({ games }), { headers: { "content-type": "application/json" } }),
  );
}

const CATALOG_COLUMNS = [
  "appid", "name", "owners", "positive", "negative", "wilson", "app_type",
  "price", "price_cents", "regular", "cut", "price_checked_at", "tags", "source_owned",
  "experience_score", "game_score", "has_ending", "hours_to_value", "hours_to_good",
  "experience_reason", "experience_confidence", "experience_checked_at",
];

/** Insert catalogue rows directly. Defaults are "a normal, rankable game", so
 * each test only spells out the columns it is actually about. */
async function seedCatalog(env, rows) {
  await ensureCatalogSchema(env);
  const sql = `INSERT INTO fpm_catalog (${CATALOG_COLUMNS.join(", ")}) VALUES (${CATALOG_COLUMNS.map(() => "?").join(", ")})`;
  for (const row of rows) {
    const full = {
      owners: 100000, positive: 5000, negative: 100, wilson: 0.95, app_type: "game",
      price: null, price_cents: null, regular: null, cut: null, price_checked_at: 1,
      tags: JSON.stringify({ Puzzle: 100, Story: 50 }), source_owned: 0,
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

test.beforeEach(() => {
  offlineGuard = makeOfflineFetchGuard("worker-rank");
  globalThis.fetch = offlineGuard;
});

test.afterEach(() => {
  const calls = [...offlineGuard.calls];
  restoreGlobals();
  assert.deepEqual(calls, [], "no test in this file may reach the network");
});

// ---------------------------------------------------------------------------
// SPEC.md gate 8 — the exhaustive key set, pinned from day one for inc 12
// ---------------------------------------------------------------------------

test("gate 8: /api/rank's response key set is EXACTLY this, top level and per row", async () => {
  // Pinned deliberately and exhaustively (not a subset check) so increment
  // 12 builds its answer page against a shape that cannot drift silently, and
  // so any field added later is a conscious decision that fails this test
  // first. Same discipline as the six existing per-lane key-set assertions.
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [{ appid: 400, name: "Portal", experience_score: 98 }]);

  const { response, body } = await callRank(env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");

  assert.deepEqual(Object.keys(body).sort(), [
    "available", "count", "exclusionFill", "funnel", "normaliser", "notice",
    "ownedMode", "preset", "profileAvailable", "profileGames", "rank", "sort",
    "suppressLowConfidence", "weights", "windowMonths",
  ]);
  assert.deepEqual(Object.keys(body.weights).sort(), ["ws", "wsale", "we"].sort());
  assert.deepEqual(Object.keys(body.exclusionFill).sort(), ["checked", "excluded", "ok"]);
  assert.deepEqual(Object.keys(body.funnel).sort(), [
    "catalogTotal", "checkedNoScore", "dismissed", "endingUnknown", "endless",
    "lowConfidenceOwnedSpared", "lowConfidenceSuppressed", "nonGame", "owned", "priced",
    "pricedOwned", "rankExcluded", "ranked", "tagless", "unscored",
  ]);
  assert.deepEqual(Object.keys(body.rank[0]).sort(), [
    "appid", "atHistoricalLow", "base", "confidence", "cut", "experienceFpm",
    "experienceScore", "gameScore", "hasEnding", "hoursPlayed", "hoursToGood",
    "hoursToValue", "owned", "price", "priceCents", "priceCheckedAt", "rankScore",
    "regular", "reviewCount", "reviewPercent", "similarity", "similarityNorm",
    "tagNames", "title", "why",
  ]);
});

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage item 8 — the funnel adds up
// ---------------------------------------------------------------------------

test("§10.8 the funnel sums EXACTLY to the catalogue row count, with every subtraction named", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);

  await seedCatalog(env, [
    { appid: 1, name: "Ranked One", experience_score: 90 },
    { appid: 2, name: "Ranked Two", experience_score: 80 },
    { appid: 3, name: "A DLC", app_type: "dlc", experience_score: 70 },
    { appid: 4, name: "Unclassified", app_type: null, experience_score: 70 },
    { appid: 5, name: "LuxVR", experience_score: null, experience_checked_at: 123 },
    { appid: 6, name: "Never Judged", experience_score: null, experience_checked_at: null },
    { appid: 7, name: "Black Book: Prologue", experience_score: 85 },
    { appid: 8, name: "Dismissed Game", experience_score: 85 },
    { appid: 9, name: "Bluffed", experience_score: 88, experience_confidence: "low", positive: 10, negative: 1 },
  ]);
  await ensureDismissalsSchema(env);
  await addDismissal(env, 8, "Dismissed Game");

  const { body } = await callRank(env, ctx);
  const f = body.funnel;

  assert.equal(f.catalogTotal, 9);
  assert.equal(f.nonGame, 2); // the dlc and the unclassified row
  assert.equal(f.checkedNoScore, 1);
  assert.equal(f.unscored, 1);
  assert.equal(f.rankExcluded, 1);
  assert.equal(f.dismissed, 1);
  assert.equal(f.lowConfidenceSuppressed, 1);
  assert.equal(f.ranked, 2);

  // THE ARITHMETIC, asserted rather than eyeballed.
  assert.equal(
    f.catalogTotal - f.nonGame - f.checkedNoScore - f.unscored - f.rankExcluded - f.dismissed - f.lowConfidenceSuppressed,
    f.ranked,
  );
  assert.equal(body.count, f.ranked);
});

test("§8 a row is charged to exactly ONE funnel line — a dismissed prologue is not counted twice", async () => {
  // The funnel is only honest if the reasons partition the catalogue. A row
  // that qualifies for two subtractions must be charged to the first.
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    { appid: 1, name: "Something: Prologue", experience_score: 85, experience_confidence: "low", positive: 5, negative: 0 },
  ]);
  await ensureDismissalsSchema(env);
  await addDismissal(env, 1, "Something: Prologue");

  const { body } = await callRank(env, ctx);
  assert.equal(body.funnel.rankExcluded, 1);
  assert.equal(body.funnel.dismissed, 0);
  assert.equal(body.funnel.lowConfidenceSuppressed, 0);
  assert.equal(body.funnel.catalogTotal - body.funnel.rankExcluded, body.funnel.ranked);
});

test("§8 the of-which counts are reported: owned, endless, tagless, priced and priced-owned", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, [{ appid: 2, name: "Owned", playtime_forever: 600, rtime_last_played: 0 }]);

  await seedCatalog(env, [
    { appid: 1, name: "Plain", experience_score: 90 },
    { appid: 2, name: "Owned", experience_score: 85, source_owned: 1, price: 10, cut: 50 },
    { appid: 3, name: "Endless", experience_score: 20, has_ending: 0, hours_to_value: null },
    { appid: 4, name: "Ending Unknown", experience_score: 40, has_ending: null },
    { appid: 5, name: "Tagless", experience_score: 70, tags: null },
    { appid: 6, name: "On Sale", experience_score: 60, price: 5, cut: 75 },
  ]);

  const { body } = await callRank(env, ctx);
  const f = body.funnel;
  assert.equal(f.ranked, 6);
  assert.equal(f.owned, 1);
  // CR-4 (round-2 review): `endless` and `endingUnknown` are SEPARATE lines.
  // `has_ending` is a tri-state and the row builder already renders NULL as a
  // third state, so folding NULL into "endless" made the funnel disagree with
  // the rows it was counting. Both still mean "no per-hour figure", which is
  // why their sum is what `experienceFpm == null` matches.
  assert.equal(f.endless, 1, "has_ending 0 only");
  assert.equal(f.endingUnknown, 1, "has_ending NULL is its own line, not folded into endless");
  assert.equal(
    body.rank.filter((r) => r.experienceFpm == null).length,
    f.endless + f.endingUnknown,
    "the two lines together are exactly the rows with no per-hour figure",
  );
  assert.equal(f.tagless, 1);
  assert.equal(f.priced, 2);
  assert.equal(f.pricedOwned, 1);
});

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage items 6 and 7
// ---------------------------------------------------------------------------

test("§10.6 experienceFpm is explicitly NULL for has_ending 0 and for has_ending NULL — the field is present, not absent", async () => {
  // What the API owes the 4,822 endless rows (SPEC.md §8): the field ships so
  // increment 12 can render an honest "endless — no ending, so no per-hour
  // figure" badge rather than a blank cell.
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    { appid: 1, name: "Has Ending", experience_score: 90, has_ending: 1, game_score: 90, hours_to_value: 2 },
    { appid: 2, name: "Endless", experience_score: 25, has_ending: 0, hours_to_value: null },
    { appid: 3, name: "Unknown Ending", experience_score: 50, has_ending: null },
  ]);

  const { body } = await callRank(env, ctx);
  const byId = new Map(body.rank.map((r) => [r.appid, r]));
  assert.ok(Math.abs(byId.get(1).experienceFpm - Math.sqrt(90 * 90) / Math.sqrt(2)) < 1e-9);
  assert.equal(byId.get(2).experienceFpm, null);
  assert.equal(byId.get(3).experienceFpm, null);
  for (const appid of [2, 3]) {
    assert.ok("experienceFpm" in byId.get(appid), "present and null, never absent");
    assert.ok("hasEnding" in byId.get(appid));
  }
  // And the endless rows are STILL IN THE RANKING — they sink on their
  // merits, they are not filtered out (Slice 0 binding consequence 2).
  assert.equal(body.funnel.ranked, 3);
});

test("§10.6 has_ending is returned as the INTEGER D1 holds, so 'unknown' stays distinguishable from 'endless'", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    { appid: 1, name: "A", experience_score: 90, has_ending: 1 },
    { appid: 2, name: "B", experience_score: 90, has_ending: 0 },
    { appid: 3, name: "C", experience_score: 90, has_ending: null },
  ]);
  const { body } = await callRank(env, ctx);
  const byId = new Map(body.rank.map((r) => [r.appid, r]));
  assert.equal(byId.get(1).hasEnding, 1);
  assert.equal(byId.get(2).hasEnding, 0);
  assert.equal(byId.get(3).hasEnding, null);
});

test("§10.7 a tagless row is RANKED with S = 0, not dropped — deliberately unlike scoreCandidates", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    { appid: 1, name: "Tagless But Great", experience_score: 95, tags: null },
    { appid: 2, name: "Empty Tag Object", experience_score: 94, tags: "{}" },
    { appid: 3, name: "Corrupt Tag Blob", experience_score: 93, tags: "not json at all" },
    { appid: 4, name: "Tagged", experience_score: 50 },
  ]);

  const { body } = await callRank(env, ctx);
  assert.equal(body.funnel.ranked, 4);
  assert.equal(body.funnel.tagless, 3);
  const byId = new Map(body.rank.map((r) => [r.appid, r]));
  for (const appid of [1, 2, 3]) {
    assert.equal(byId.get(appid).similarity, 0);
    assert.equal(byId.get(appid).similarityNorm, 0);
    assert.deepEqual(byId.get(appid).tagNames, []);
  }
  // experience_score is the headline, so a tagless 95 still beats a tagged 50.
  assert.equal(body.rank[0].appid, 1);
});

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage item 5 / gate 5 — owned games are never suppressed
// ---------------------------------------------------------------------------

test("§10.5 / gate 5: an owned, low-confidence, sub-floor row survives with the settings key ON and OFF", async () => {
  // The route-level guard on James's reason 1. The Excrawlers' real shape —
  // the one of his 11 owned low-confidence games still below the 200 bar
  // after §12b.1, and therefore the one the exemption actually saves.
  for (const keyValue of [undefined, true, false]) {
    const env = makeEnv();
    const ctx = makeCtx();
    globalThis.caches = { default: makeMockCache() };
    seedLibrary(caches.default, [{ appid: 2, name: "The Excrawlers", playtime_forever: 300, rtime_last_played: 0 }]);
    await seedCatalog(env, [
      { appid: 1, name: "Unowned Bluff", experience_score: 70, experience_confidence: "low", positive: 85, negative: 5 },
      { appid: 2, name: "The Excrawlers", experience_score: 62, experience_confidence: "low", positive: 85, negative: 5, source_owned: 1 },
    ]);
    if (keyValue !== undefined) {
      await ensureSettingsSchema(env);
      await putSettings(env, { [SUPPRESS_LOW_CONFIDENCE_KEY]: keyValue });
    }

    const { body } = await callRank(env, ctx);
    const appids = body.rank.map((r) => r.appid);
    assert.ok(appids.includes(2), `The Excrawlers must be ranked with the key = ${keyValue}`);
    // "Spared" means "would have been suppressed but was not". With the key
    // off nothing is being suppressed, so nothing is being spared and the
    // honest count is 0 — the row is still ranked either way, which is the
    // thing that actually matters and is asserted above.
    assert.equal(body.funnel.lowConfidenceOwnedSpared, keyValue === false ? 0 : 1);
    // HARD ASSERTION (gate 5): zero owned rows in the suppressed set, ever.
    assert.equal(body.funnel.lowConfidenceSuppressed, keyValue === false ? 0 : 1);
    if (keyValue === false) assert.ok(appids.includes(1), "the key off means the unowned bluff is ranked too");
    else assert.ok(!appids.includes(1), "the key on (or unset) suppresses the UNOWNED bluff");
  }
});

test("gate 5: the exemption holds on the LIVE library join too, not just the source_owned column", async () => {
  // Ownership is resolved as a union so the exemption can only ever spare
  // more games, never fewer — a row the sync pipeline has not stamped yet but
  // that is sitting in James's library today must still be spared.
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, [{ appid: 5, name: "Freshly Bought", playtime_forever: 60, rtime_last_played: 0 }]);
  await seedCatalog(env, [
    { appid: 5, name: "Freshly Bought", experience_score: 62, experience_confidence: "low", positive: 100, negative: 5, source_owned: 0 },
  ]);

  const { body } = await callRank(env, ctx);
  assert.equal(body.funnel.ranked, 1);
  assert.equal(body.funnel.owned, 1);
  assert.equal(body.funnel.lowConfidenceSuppressed, 0);
  assert.equal(body.rank[0].owned, true);
  assert.equal(body.rank[0].hoursPlayed, 1);
});

test("§7 the settings key appears in /api/settings only ONCE WRITTEN — no zero-diff breach", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [{ appid: 1, name: "A", experience_score: 90 }]);

  // A /api/rank call reads the key. Reading must not WRITE it.
  await callRank(env, ctx);
  const settings = await (await worker.fetch(new Request("https://x.test/api/settings"), env, ctx)).json();
  assert.deepEqual(settings, { settings: {} }, "an untouched store yields an unchanged response");
});

// ---------------------------------------------------------------------------
// SPEC.md gate 6 / §4.3 — sorting, presets and the owned tri-state
// ---------------------------------------------------------------------------

test("gate 6 (§12b.4): Portal leads on experience_score and sits inside the top 10 under `default`; FPM is reachable ONLY via ?sort=fpm", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    // Portal: highest experience score, middling per-hour figure.
    { appid: 1, name: "Portal", experience_score: 98, game_score: 97, hours_to_value: 3 },
    // RULING 3, REPRODUCED: a 2-hour 92 structurally outranks a 3-hour 95 on
    // any per-hour metric. That is arithmetic, not a tuning fault, and it is
    // exactly why FPM is the secondary sort and never the headline.
    { appid: 2, name: "Short And Great", experience_score: 92, game_score: 92, hours_to_value: 2 },
  ]);

  const headline = (await callRank(env, ctx)).body;
  assert.equal(headline.sort, "experience");
  // §12b.4 corrected this gate. "Portal at #1 of the ranked set" was
  // unachievable and always was: at wS = 0.3 the similarity term genuinely
  // moves things, which is the toggle working rather than failing. What is
  // asserted now is what James ruled — Portal leads on experience_score, and
  // lands inside the top 10 of the blend.
  const byExperience = [...headline.rank].sort((a, b) => b.experienceScore - a.experienceScore);
  assert.equal(byExperience[0].title, "Portal", "1st on experience_score alone");
  const portalRank = headline.rank.findIndex((r) => r.title === "Portal");
  assert.ok(portalRank >= 0 && portalRank < 10, `Portal must be inside the top 10 under default, was ${portalRank + 1}`);

  const byFpm = (await callRank(env, ctx, "?sort=fpm")).body;
  assert.equal(byFpm.sort, "fpm");
  assert.equal(byFpm.rank[0].title, "Short And Great");
  assert.deepEqual(byFpm.rank.map((r) => r.appid).sort(), headline.rank.map((r) => r.appid).sort(), "same set, different order");

  // Anything unrecognised falls back to the headline rather than 500ing.
  assert.equal((await callRank(env, ctx, "?sort=nonsense")).body.sort, "experience");
});

test("gate 6: ?sort=fpm puts NULLs last — endless games stay in the list, visibly without a figure", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    { appid: 1, name: "Endless", experience_score: 99, has_ending: 0 },
    { appid: 2, name: "Short", experience_score: 50, game_score: 80, hours_to_value: 2 },
  ]);
  const { body } = await callRank(env, ctx, "?sort=fpm");
  assert.deepEqual(body.rank.map((r) => r.title), ["Short", "Endless"]);
  assert.equal(body.rank[1].experienceFpm, null);
});

test("§4.2 presets and overrides are echoed back, so what actually ran is never in doubt", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [{ appid: 1, name: "A", experience_score: 90 }]);

  assert.deepEqual((await callRank(env, ctx)).body.weights, RANK_PRESETS.default);
  assert.deepEqual((await callRank(env, ctx, "?preset=sale")).body.weights, RANK_PRESETS.sale);
  assert.deepEqual((await callRank(env, ctx, "?preset=similarity")).body.weights, RANK_PRESETS.similarity);
  assert.deepEqual((await callRank(env, ctx, "?ws=0.8")).body.weights, { we: 0.2, ws: 0.8, wsale: 0 });
  assert.equal((await callRank(env, ctx, "?preset=sale&wsale=0")).body.weights.wsale, 0);
  // §12b.2: the normaliser rides with the preset and is echoed back beside
  // the weights, so a list can never be read without knowing how S was scaled.
  assert.equal((await callRank(env, ctx)).body.normaliser, "percentile");
  assert.equal((await callRank(env, ctx, "?preset=sale")).body.normaliser, "percentile");
  assert.equal((await callRank(env, ctx, "?preset=similarity")).body.normaliser, "minmax");
  assert.equal((await callRank(env, ctx, "?norm=minmax")).body.normaliser, "minmax");
  assert.equal((await callRank(env, ctx, "?preset=similarity&norm=percentile")).body.normaliser, "percentile");
  assert.equal((await callRank(env, ctx, "?norm=nonsense")).body.normaliser, "percentile");
});

test("§4.1 under the default preset a discount is arithmetically INVISIBLE — owned and unowned compete on the same two numbers", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, [{ appid: 2, name: "Owned Equal", playtime_forever: 60, rtime_last_played: 0 }]);
  await seedCatalog(env, [
    { appid: 1, name: "Unowned 90pc Off", experience_score: 80, price: 1, cut: 90 },
    { appid: 2, name: "Owned Equal", experience_score: 80, source_owned: 1 },
  ]);

  const dflt = (await callRank(env, ctx)).body;
  assert.equal(dflt.rank[0].rankScore, dflt.rank[1].rankScore, "identical E and S means an identical score");
  for (const row of dflt.rank) assert.equal(row.rankScore, row.base);

  // Flip to the sale lens and the discounted unowned row pulls ahead. This is
  // §4.2's stated, accepted consequence: owned games cannot win `sale`.
  const sale = (await callRank(env, ctx, "?preset=sale")).body;
  assert.equal(sale.rank[0].appid, 1);
  assert.ok(sale.rank[0].rankScore > sale.rank[1].rankScore);
});

test("§4.3 the owned tri-state filters the VIEW, and the funnel still reports the whole catalogue", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, [{ appid: 2, name: "Mine", playtime_forever: 6000, rtime_last_played: 0 }]);
  await seedCatalog(env, [
    { appid: 1, name: "Theirs", experience_score: 90 },
    { appid: 2, name: "Mine", experience_score: 80, source_owned: 1 },
  ]);

  const all = (await callRank(env, ctx)).body;
  assert.equal(all.ownedMode, "all");
  assert.equal(all.count, 2);

  const hide = (await callRank(env, ctx, "?owned=hide")).body;
  assert.deepEqual(hide.rank.map((r) => r.appid), [1]);
  const only = (await callRank(env, ctx, "?owned=only")).body;
  assert.deepEqual(only.rank.map((r) => r.appid), [2]);
  assert.equal(only.rank[0].hoursPlayed, 100);

  // The funnel is computed BEFORE the view filter, so it reports the real
  // catalogue-wide numbers whichever view was asked for.
  for (const body of [all, hide, only]) {
    assert.equal(body.funnel.ranked, 2);
    assert.equal(body.funnel.owned, 1);
  }
  assert.equal(hide.count, 1);
});

test("§4.3 leave-one-out at the route level: an owned game does not self-match, but still shapes every other row", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  const recent = Math.floor(Date.now() / 1000) - 3600;
  seedLibrary(caches.default, [{ appid: 1, name: "Owned Roguelike", playtime_forever: 3000, rtime_last_played: recent }]);
  await seedCatalog(env, [
    { appid: 1, name: "Owned Roguelike", experience_score: 80, source_owned: 1, tags: JSON.stringify({ Roguelike: 100, Pixel: 50 }) },
    { appid: 2, name: "Another Roguelike", experience_score: 80, tags: JSON.stringify({ Roguelike: 100, Pixel: 50 }) },
    { appid: 3, name: "A Racing Game", experience_score: 80, tags: JSON.stringify({ Racing: 100, Cars: 50 }) },
  ]);

  const { body } = await callRank(env, ctx, "?preset=similarity");
  const byId = new Map(body.rank.map((r) => [r.appid, r]));
  // The owned game is scored against a profile with its own contribution
  // removed — which, with a one-game library, leaves nothing to match.
  assert.equal(byId.get(1).similarity, 0);
  // Its twin, unowned, is scored against the FULL profile the owned game
  // built — so the library is still doing its job as the engine's source.
  assert.ok(byId.get(2).similarity > byId.get(3).similarity);
  // And the owned game is still IN the ranking, never excluded.
  assert.equal(body.funnel.ranked, 3);
  assert.equal(body.funnel.owned, 1);
});

// ---------------------------------------------------------------------------
// SPEC.md §7 / gate 7 — the exclusion column, and zero diff on the old lanes
// ---------------------------------------------------------------------------

test("gate 1: /api/rank runs the exclusion fill at the top, and reports what it did", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    { appid: 1, name: "Black Book: Prologue", experience_score: 85 },
    { appid: 2, name: "Black Book", experience_score: 55 },
  ]);

  const first = (await callRank(env, ctx)).body;
  assert.deepEqual(first.exclusionFill, { checked: 2, excluded: 1, ok: true });
  assert.deepEqual(first.rank.map((r) => r.title), ["Black Book"]);

  // Second request: the fill is a no-op, the exclusion still holds.
  const second = (await callRank(env, ctx)).body;
  assert.deepEqual(second.exclusionFill, { checked: 0, excluded: 0, ok: true });
  assert.equal(second.funnel.rankExcluded, 1);
});

test("gate 7: /api/fpm is byte-identical before and after the rank columns exist AND are filled", async () => {
  // The one zero-diff risk this increment actually creates: two new columns
  // on the shared table, and a fill that writes to every row of it. If
  // selectMatchedCatalogRows or the FPM row builder ever picked either
  // column up, this fires.
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await seedCatalog(env, [
    { appid: 1, name: "Portal", experience_score: 98 },
    { appid: 2, name: "Black Book: Prologue", experience_score: 85 },
  ]);
  await env.FPM_DB.prepare("UPDATE fpm_catalog SET main_hours = 5, match_method = 'name'").run();

  // /api/fpm's own enrichment path DOES talk to ITAD/SteamSpy/Steam, so this
  // one test stubs them all to empty. Nothing in the assertion depends on
  // what they return — only on the two calls returning the SAME thing.
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.includes("isthereanydeal.com")) return new Response(JSON.stringify({ list: [], hasMore: false }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
  };

  const fpmEnv = { ...env, ITAD_API_KEY: "test-itad-key" };
  const before = await (await worker.fetch(new Request("https://x.test/api/fpm"), fpmEnv, ctx)).text();

  await callRank(env, ctx); // fills rank_exclude_reason on every row
  const filled = await env.FPM_DB.prepare("SELECT count(*) AS n FROM fpm_catalog WHERE rank_exclude_checked_at IS NOT NULL").first("n");
  assert.equal(filled, 2, "the fill really did write to both rows");

  const after = await (await worker.fetch(new Request("https://x.test/api/fpm"), fpmEnv, ctx)).text();
  assert.equal(after, before, "/api/fpm must be byte-identical across the exclusion fill");
  // And the prologue is STILL in the legacy lane — the new column gates the
  // new lane only. /api/fpm retires at increment 12 unchanged.
  assert.ok(after.includes("Black Book: Prologue"));
});

// ---------------------------------------------------------------------------
// SPEC.md §13.5 — fail-soft everywhere
// ---------------------------------------------------------------------------

test("§13.5 fail-soft: a missing FPM_DB returns an honest 200, never a 500", async () => {
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  const { response, body } = await callRank(makeEnv({ FPM_DB: undefined }), ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(body, { available: false, notice: "FPM_DB not configured" });
});

test("§13.5 fail-soft: a D1 hiccup returns an honest 200, never a 500", async () => {
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  const env = makeEnv({ FPM_DB: { prepare: () => { throw new Error("D1 down"); }, batch: async () => {} } });
  const { response, body } = await callRank(env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(body, { available: false, notice: "Ranking unavailable" });
});

test("§13.5 fail-soft: no Steam credentials means no taste profile, NOT a broken lane", async () => {
  // The deliberate difference from /api/recs, which refuses to run without a
  // library. This lane does not exclude owned games, it ranks them, so a
  // Steam outage costs a profile (every row S = 0) rather than correctness.
  const env = makeEnv({ STEAM_API_KEY: undefined, STEAM_ID: undefined });
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  await seedCatalog(env, [
    { appid: 1, name: "A", experience_score: 90 },
    { appid: 2, name: "B", experience_score: 80 },
  ]);

  const { response, body } = await callRank(env, ctx);
  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.funnel.ranked, 2);
  for (const row of body.rank) assert.equal(row.similarityNorm, 0);
  // Pure experience value, in order.
  assert.deepEqual(body.rank.map((r) => r.title), ["A", "B"]);
  // SEC-1: no profile, and the response SAYS SO. No credentials is a
  // configuration state rather than a fault, so it is visible in the two
  // profile fields but earns no `notice` — there is no outage to report.
  assert.equal(body.profileAvailable, false);
  assert.equal(body.profileGames, 0);
  assert.equal(body.notice, null);
});

test("SEC-1: a Steam OUTAGE with credentials present is announced, not absorbed", async () => {
  // The defect this pins. loadLibraryForRank returns [] on a missing key, a
  // cache error OR a Steam outage. With an empty profile every cosine is 0,
  // so under `?preset=similarity` min-max over an all-equal pool returns all
  // zeros and the similarity lens collapses into pure `wE * E` — a materially
  // different list that used to report `available: true` and a normal-looking
  // funnel with nothing said. That is SPEC.md §1's reason 2 failing quietly,
  // which is the worst shape it could take.
  const env = makeEnv(); // credentials PRESENT
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() }; // cold — forces the upstream call
  globalThis.fetch = async () => new Response("nope", { status: 503 });
  await seedCatalog(env, [
    { appid: 1, name: "A", experience_score: 90 },
    { appid: 2, name: "B", experience_score: 80 },
  ]);

  const { body } = await callRank(env, ctx, "?preset=similarity");
  assert.equal(body.available, true);
  assert.equal(body.profileAvailable, false);
  assert.equal(body.profileGames, 0);
  assert.match(body.notice, /taste profile is empty/);
  assert.match(body.notice, /similarity/i);
  // And the collapse the notice is describing is real: every S is 0, so the
  // similarity preset returns experience order.
  for (const row of body.rank) assert.equal(row.similarityNorm, 0);
  assert.deepEqual(body.rank.map((r) => r.title), ["A", "B"]);
});

test("SEC-1 + CR-3: a healthy profile reports its contributing-game count, and windowMonths is echoed", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, [
    { appid: 400, name: "Portal", playtime_forever: 600, rtime_last_played: Math.floor(Date.now() / 1000) - 3600 },
  ]);
  await seedCatalog(env, [
    { appid: 400, name: "Portal", experience_score: 98, source_owned: 1, tags: JSON.stringify({ Puzzle: 100 }) },
    { appid: 401, name: "Puzzler", experience_score: 70, tags: JSON.stringify({ Puzzle: 100 }) },
  ]);

  const { body } = await callRank(env, ctx, "?windowMonths=6");
  assert.equal(body.profileAvailable, true);
  assert.equal(body.profileGames, 1);
  assert.equal(body.notice, null);
  // CR-3: the only resolved input that used not to be echoed.
  assert.equal(body.windowMonths, 6);
  // And the default is echoed too, so a reader never has to guess it.
  const { body: dflt } = await callRank(env, ctx);
  assert.equal(dflt.windowMonths, 12);
});

test("§13.5 fail-soft: a Steam fetch that fails degrades to no profile rather than throwing", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() }; // cold — forces the upstream call
  globalThis.fetch = async () => new Response("nope", { status: 503 });
  await seedCatalog(env, [{ appid: 1, name: "A", experience_score: 90 }]);

  const { response, body } = await callRank(env, ctx);
  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.rank[0].similarityNorm, 0);
});

test("§13.5 an empty catalogue produces an honest empty answer, and a funnel that still sums", async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  await ensureCatalogSchema(env);

  const { body } = await callRank(env, ctx);
  assert.equal(body.available, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.rank, []);
  assert.equal(body.funnel.catalogTotal, 0);
  assert.equal(body.funnel.ranked, 0);
});

// ---------------------------------------------------------------------------
// QA gap-closure tests, written after James's diff gate of 2026-09-04.
//
// Three route-level proof tests. Each was written to fail against a specific
// mutation of src/worker.js that the 752-test suite passed unchanged, and each
// was confirmed red against that mutation before being kept. They pin
// behaviour that was correct but UNASSERTED, which is the same defect class
// that shipped once already in this increment's spared-rows counter.
// ---------------------------------------------------------------------------

test("TC-2 gate 5 / §12b.1: the spared counter asks the REAL predicate – an owned 200–999-review row is NOT spared", async () => {
  // THE DEFECT THIS CATCHES, and it is the one that already shipped once:
  // computing `lowConfidenceOwnedSpared` by restating the suppression rule
  // inline instead of calling isLowConfidenceSuppressed. The inline version
  // hardcoded `< 1000` and drifted the moment §12b.1 moved the floor to 200,
  // reporting 11 rows spared when only 1 was.
  //
  // The pre-existing fixture could not see it: The Excrawlers sits at 90
  // reviews, where the 200-floor predicate and a hardcoded 1,000 restatement
  // AGREE. Sol Cesto's real shape – owned, low confidence, 879 reviews – sits
  // in the band where they disagree, which is the only band that proves which
  // one is running.
  //
  // Each case is (reviews, expected spared count). 199/200 pin the floor
  // itself at the route level, not just in the predicate's unit test.
  const cases = [
    { positive: 85, negative: 5, spared: 1, note: "The Excrawlers – 90 reviews, genuinely spared" },
    { positive: 190, negative: 9, spared: 1, note: "199 reviews – one below the floor" },
    { positive: 190, negative: 10, spared: 0, note: "200 reviews – exactly at the floor, clears on merit" },
    { positive: 800, negative: 79, spared: 0, note: "Sol Cesto – 879 reviews, clears on merit" },
    { positive: 999, negative: 0, spared: 0, note: "999 reviews – the top of the disagreement band" },
  ];

  for (const c of cases) {
    const env = makeEnv();
    const ctx = makeCtx();
    globalThis.caches = { default: makeMockCache() };
    seedLibrary(caches.default, [{ appid: 1, name: "Owned Low Confidence", playtime_forever: 300, rtime_last_played: 0 }]);
    await seedCatalog(env, [
      {
        appid: 1, name: "Owned Low Confidence", experience_score: 66,
        experience_confidence: "low", positive: c.positive, negative: c.negative, source_owned: 1,
      },
      // A control that IS suppressed under either reading, so a zero spared
      // count can never be confused with "suppression is switched off".
      { appid: 2, name: "Unowned Bluff", experience_score: 70, experience_confidence: "low", positive: 85, negative: 5 },
    ]);

    const { body } = await callRank(env, ctx);
    assert.equal(body.funnel.lowConfidenceOwnedSpared, c.spared, c.note);
    // Whatever the counter says, the owned row is RANKED in every case – that
    // is James's reason 1 and it does not depend on the counter being right.
    assert.ok(body.rank.map((r) => r.appid).includes(1), `${c.note}: the owned row must be ranked`);
    assert.equal(body.funnel.lowConfidenceSuppressed, 1, `${c.note}: the unowned control is still suppressed`);
  }
});

test("TC-1 §12b.2 / gate 3: the chosen normaliser changes the similarityNorm VALUES, not just the echoed label", async () => {
  // THE DEFECT THIS CATCHES: hardcoding the normaliser at the call site –
  // `normaliseSimilarities(cosinesForNormalisation, "percentile")`, or
  // "minmax" – passed the entire suite, because the only thing asserted about
  // the normaliser was `body.normaliser`, the LABEL. A label that does not
  // describe what ran is worse than no label: gate 3 is James picking a
  // normaliser by measurement, and the pick is worthless if the pick is not
  // applied.
  //
  // Three tagged rows with three DISTINCT cosines make the two normalisers
  // arithmetically distinguishable at the top of the pool:
  //   min-max     -> top row is exactly 1 (distance from the best match)
  //   percentile  -> top row is exactly 2/3 (2 of 3 rows strictly below it)
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  // The profile source is app_type 'dlc', so it feeds the taste vector (tags
  // are read from every catalogue row) but is NOT in the ranked pool – which
  // keeps the pool at exactly 3 and the percentile denominator exactly 3.
  seedLibrary(caches.default, [
    { appid: 100, name: "Profile Source", playtime_forever: 600, rtime_last_played: Math.floor(Date.now() / 1000) - 3600 },
  ]);
  await seedCatalog(env, [
    { appid: 100, name: "Profile Source", app_type: "dlc", source_owned: 1, experience_score: 80, tags: JSON.stringify({ Puzzle: 100, Story: 100 }) },
    { appid: 1, name: "Exact Taste Match", experience_score: 60, tags: JSON.stringify({ Puzzle: 100, Story: 100 }) },
    { appid: 2, name: "Half Taste Match", experience_score: 60, tags: JSON.stringify({ Puzzle: 100, Action: 100 }) },
    { appid: 3, name: "No Taste Match", experience_score: 60, tags: JSON.stringify({ Racing: 100, Sports: 100 }) },
  ]);

  const percentile = (await callRank(env, ctx)).body; // default preset
  const minmax = (await callRank(env, ctx, "?preset=similarity")).body;
  assert.equal(percentile.normaliser, "percentile");
  assert.equal(minmax.normaliser, "minmax");
  assert.equal(percentile.funnel.ranked, 3, "the pool must be exactly 3 or the expected values change");
  assert.equal(percentile.funnel.tagless, 0);

  const pByAppid = new Map(percentile.rank.map((r) => [r.appid, r]));
  const mByAppid = new Map(minmax.rank.map((r) => [r.appid, r]));

  // Fixture integrity: three genuinely distinct raw cosines, and the raw
  // cosine itself is identical under both normalisers (it is the INPUT).
  const raw = [1, 2, 3].map((id) => pByAppid.get(id).similarity);
  assert.equal(new Set(raw).size, 3, "the three cosines must be distinct or both normalisers agree");
  assert.ok(raw[0] > raw[1] && raw[1] > raw[2], "exact > half > none");
  for (const id of [1, 2, 3]) assert.equal(mByAppid.get(id).similarity, pByAppid.get(id).similarity);

  // THE CLAIM. Same rows, same cosines, two different normalisers, two
  // different S values – and each is the exact value its own normaliser
  // defines, not merely "different".
  assert.equal(mByAppid.get(1).similarityNorm, 1, "min-max: the best match is exactly 1");
  assert.equal(pByAppid.get(1).similarityNorm, 2 / 3, "percentile: 2 of 3 rows strictly below");
  assert.equal(pByAppid.get(2).similarityNorm, 1 / 3);
  assert.equal(pByAppid.get(3).similarityNorm, 0, "percentile: nothing strictly below the worst match");
  assert.equal(mByAppid.get(3).similarityNorm, 0, "min-max: the worst match is exactly 0");
  // The middle row is where the two shapes differ most visibly.
  assert.notEqual(mByAppid.get(2).similarityNorm, pByAppid.get(2).similarityNorm);
  assert.ok(mByAppid.get(2).similarityNorm > 0 && mByAppid.get(2).similarityNorm < 1);

  // And `?norm=` genuinely overrides the preset's choice, values and all –
  // the same URL escape hatch 06-toggle-movement.md tells James to use to
  // separate the weight change from the normaliser change.
  const forced = (await callRank(env, ctx, "?preset=similarity&norm=percentile")).body;
  const fByAppid = new Map(forced.rank.map((r) => [r.appid, r]));
  assert.equal(fByAppid.get(1).similarityNorm, 2 / 3, "?norm= must move the VALUES, not just the label");
});

test("TC-4 gate 6: the headline order is monotone non-increasing in rankScore over 12 rows whose FPM order is the exact reverse", async () => {
  // THE DEFECT THIS CATCHES: the default lane's sort comparator is not pinned
  // to rankScore. Sorting the headline by experienceFpm passed the whole
  // suite, because gate 6's `portalRank < 10` cannot fail on a two-row
  // fixture – on two rows every position is inside the top 10.
  //
  // Twelve rows, experience descending and hours_to_value descending with it,
  // so experienceFpm = sqrt(quality * experience) / sqrt(hours) runs in the
  // OPPOSITE direction. Blend order and FPM order disagree at every single
  // position, which is what makes the assertion discriminate.
  const env = makeEnv();
  const ctx = makeCtx();
  globalThis.caches = { default: makeMockCache() };
  seedLibrary(caches.default, []);
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      appid: i + 1,
      name: i === 0 ? "Portal" : `Row ${i + 1}`,
      experience_score: 99 - 3 * i, // 99 down to 66
      game_score: 90,
      hours_to_value: 200 - 18 * i, // 200 down to 2
      has_ending: 1,
    });
  }
  await seedCatalog(env, rows);

  const { body } = await callRank(env, ctx);
  assert.equal(body.funnel.ranked, 12);
  assert.equal(body.sort, "experience");

  // 1. THE HEADLINE CLAIM: the returned order is monotone non-increasing in
  //    rankScore. This is the blend, and nothing else, deciding the order.
  for (let i = 1; i < body.rank.length; i++) {
    assert.ok(
      body.rank[i - 1].rankScore >= body.rank[i].rankScore,
      `position ${i} breaks rankScore order: ${body.rank[i - 1].rankScore} then ${body.rank[i].rankScore}`,
    );
  }
  assert.deepEqual(body.rank.map((r) => r.appid), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // 2. FIXTURE INTEGRITY: the FPM order really is the reverse, so a headline
  //    sorted by experienceFpm would fail assertion 1 at position 1 rather
  //    than passing by coincidence.
  const byFpm = (await callRank(env, ctx, "?sort=fpm")).body;
  assert.deepEqual(byFpm.rank.map((r) => r.appid), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.notDeepEqual(body.rank.map((r) => r.appid), byFpm.rank.map((r) => r.appid));

  // 3. And gate 6's Portal check on a fixture where it CAN fail: 12 rows mean
  //    positions 11 and 12 are outside the top 10, and an FPM-sorted headline
  //    would put Portal dead last.
  const portalRank = body.rank.findIndex((r) => r.title === "Portal");
  assert.ok(portalRank >= 0 && portalRank < 10, `Portal must be inside the top 10 of 12, was ${portalRank + 1}`);
  assert.equal(byFpm.rank.findIndex((r) => r.title === "Portal"), 11, "fixture: FPM would put Portal 12th of 12");
});
