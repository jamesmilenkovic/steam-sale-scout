// Tests for src/rank.js — the increment-11 ranking blend, the prologue
// classifier, the two normalisers, leave-one-out, and low-confidence
// suppression.
//
// Pure-module tests. NEVER makes a network call and never needs one: the only
// impure functions here (ensureRankExclusions) talk to the node:sqlite-backed
// mock D1, so the real SQL runs against a real SQLite engine.
//
// Every test in this file maps to a numbered item in SPEC.md §10's coverage
// list or to one of the gates in §11; the mapping is named in each test title
// so a failure says which requirement broke.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LOW_CONFIDENCE_REVIEW_FLOOR,
  PROLOGUE_PATTERN,
  RANK_EXCLUDE_ALLOWLIST,
  RANK_EXCLUSION_WRITE_BATCH,
  RANK_NORMALISERS,
  RANK_NORMALISER_BY_PRESET,
  RANK_NORMALISER_DEFAULT,
  RANK_PRESETS,
  RANK_WSALE_MAX,
  SUPPRESS_LOW_CONFIDENCE_KEY,
  blendRankScore,
  classifyRankExclusion,
  ensureRankExclusions,
  isLowConfidenceSuppressed,
  minMaxNormalise,
  normaliseSimilarities,
  percentileRankNormalise,
  profileWithoutGame,
  resolveRankWeights,
  summedProfileFromContributions,
} from "../src/rank.js";
import { HISTORICAL_LOW_BONUS, cosineSimilarity } from "../src/score.js";
import { buildProfile, computeIdf } from "../src/profile.js";
import { ensureCatalogSchema } from "../src/catalog.js";
import { makeMockD1 } from "./helpers/mockD1.mjs";

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage item 1 — the prologue classifier fixture
// ---------------------------------------------------------------------------

test("§10.1 classifier: the two mandated positives are caught", () => {
  // PRD ruling 6's own worked examples: Black Book: Prologue ranked 91st
  // while Black Book itself ranked 10,811th.
  assert.equal(classifyRankExclusion({ appid: 1, name: "Black Book: Prologue" }), "prologue");
  assert.equal(classifyRankExclusion({ appid: 2, name: "Not For Broadcast: Prologue" }), "prologue");
});

test("§10.1 classifier: the three mandated NEGATIVE CONTROLS survive — this is the test the rule exists for", () => {
  // A naive `%demo%` substring search kills all three. None of them contains
  // "prologue" at all, and none contains "demo" as a WORD. If this test ever
  // fails, the matching rule has been widened past what James ruled and three
  // real games are being hidden from his ranking.
  assert.equal(classifyRankExclusion({ appid: 10, name: "HYPER DEMON" }), null);
  assert.equal(classifyRankExclusion({ appid: 11, name: "Book of Demons" }), null);
  assert.equal(classifyRankExclusion({ appid: 12, name: "Democratic Socialism Simulator" }), null);
});

test("§10.1 classifier: word boundaries, not substrings — the near-miss band", () => {
  // Inside a longer word: not a match. `Prologues` (plural) and the invented
  // `Prologuemancer` both fail \\b, which is the intended strictness — the
  // catalogue's real prologues are all suffixed `: Prologue` or `Prologue`.
  assert.equal(classifyRankExclusion({ appid: 20, name: "Prologuemancer" }), null);
  assert.equal(classifyRankExclusion({ appid: 21, name: "Epilogue" }), null);
  // Punctuation and spacing are boundaries, so every real shape matches.
  for (const name of [
    "Stoneshard: Prologue",
    "The Riftbreaker: Prologue",
    "PROLOGUE",
    "prologue",
    "A Game (Prologue)",
    "A Game - Prologue",
    "Prologue: Go Wayback!",
    "序章 Prologue",
  ]) {
    assert.equal(classifyRankExclusion({ appid: 30, name }), "prologue", name);
  }
});

test("§10.1 classifier: scope is prologue ONLY — demos, DLC and soundtracks are not touched", () => {
  // Ruling 6 measured 10 demo-named rows and 1 soundtrack surviving in
  // 18,219, and the inc-7.8 app_type classifier is what holds that line.
  // Widening this rule would buy eleven rows and risk three named real games.
  for (const name of ["Half-Life 2: Demo", "Portal Demo", "Celeste Soundtrack", "DOOM OST", "Ghost of a Tale", "Frostpunk", "Lost Ark", "Nostalgia"]) {
    assert.equal(classifyRankExclusion({ appid: 40, name }), null, name);
  }
});

test("§10.1 classifier: the allowlist is an OVERRIDE, checked before the pattern", () => {
  // Prologue: Go Wayback! is a full survival game that happens to be called
  // Prologue — findable only by James's eye, which is what gate 2 is for.
  const allowlist = new Set([777]);
  assert.equal(classifyRankExclusion({ appid: 777, name: "Prologue: Go Wayback!" }, allowlist), null);
  assert.equal(classifyRankExclusion({ appid: 778, name: "Prologue: Go Wayback!" }, allowlist), "prologue");
});

test("§12b.3 classifier: the shipped allowlist is EXACTLY James's gate-2 ruling — one appid, named", () => {
  // Gate 2 ruled 2026-09-03: 111 of the 112 matches approved, one spared.
  // Pinned exhaustively rather than by size, so a future addition is a
  // conscious decision that fails this test first — an allowlist that grows
  // unnoticed is how a real exclusion rule quietly stops working.
  assert.deepEqual([...RANK_EXCLUDE_ALLOWLIST], [2552440]);
  // ...and it actually spares the game it was added for, by appid.
  const kh = { appid: 2552440, name: "KINGDOM HEARTS HD 2.8 Final Chapter Prologue" };
  assert.equal(classifyRankExclusion(kh), null);
  // The RULE is untouched: the same title under any other appid still matches,
  // so this is an exception rather than a weakening of the pattern.
  assert.equal(classifyRankExclusion({ ...kh, appid: 999 }), "prologue");
});

test("§10.1 classifier: junk input never throws", () => {
  assert.equal(classifyRankExclusion(null), null);
  assert.equal(classifyRankExclusion({}), null);
  assert.equal(classifyRankExclusion({ appid: 1, name: null }), null);
  assert.equal(classifyRankExclusion({ appid: 1, name: "" }), null);
  assert.equal(classifyRankExclusion({ appid: null, name: "X: Prologue" }), "prologue");
});

test("classifier: the pattern is stateless — no /g lastIndex trap across calls", () => {
  // A /g regex would return true, false, true, false... on repeated .test()
  // calls against the same string, which over an 18k-row pass would silently
  // miss half the prologues. Proving the shipped pattern is not /g.
  assert.equal(PROLOGUE_PATTERN.global, false);
  for (let i = 0; i < 5; i++) {
    assert.equal(classifyRankExclusion({ appid: 1, name: "Black Book: Prologue" }), "prologue");
  }
});

// ---------------------------------------------------------------------------
// SPEC.md gate 1 — the migration and the self-healing, idempotent fill
// ---------------------------------------------------------------------------

async function seedRows(env, rows) {
  await ensureCatalogSchema(env);
  for (const row of rows) {
    await env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name) VALUES (?, ?)").bind(row.appid, row.name).run();
  }
}

test("gate 1: ensureRankExclusions stamps every row, and a SECOND call is a no-op", async () => {
  const env = { FPM_DB: makeMockD1() };
  await seedRows(env, [
    { appid: 1, name: "Black Book: Prologue" },
    { appid: 2, name: "Black Book" },
    { appid: 3, name: "HYPER DEMON" },
  ]);

  const first = await ensureRankExclusions(env, { nowMs: 1000 });
  assert.deepEqual(first, { checked: 3, excluded: 1, ok: true });

  const rows = (await env.FPM_DB.prepare("SELECT appid, rank_exclude_reason, rank_exclude_checked_at FROM fpm_catalog ORDER BY appid").all()).results;
  assert.deepEqual(rows.map((r) => r.rank_exclude_reason), ["prologue", null, null]);
  // EVERY row is stamped, matched or not — "checked and rankable" is a
  // different state from "never looked at", and that is what makes the second
  // call free.
  assert.deepEqual(rows.map((r) => r.rank_exclude_checked_at), [1000, 1000, 1000]);

  const second = await ensureRankExclusions(env, { nowMs: 2000 });
  assert.deepEqual(second, { checked: 0, excluded: 0, ok: true });
  const after = (await env.FPM_DB.prepare("SELECT rank_exclude_checked_at FROM fpm_catalog WHERE appid = 1").all()).results;
  assert.equal(after[0].rank_exclude_checked_at, 1000, "the second call must not re-stamp");
});

test("gate 1: the fill is self-healing — a row added later is picked up on the next call", async () => {
  const env = { FPM_DB: makeMockD1() };
  await seedRows(env, [{ appid: 1, name: "Portal" }]);
  await ensureRankExclusions(env, { nowMs: 1000 });

  await env.FPM_DB.prepare("INSERT INTO fpm_catalog (appid, name) VALUES (?, ?)").bind(9, "Späte: Prologue").run();
  const result = await ensureRankExclusions(env, { nowMs: 2000 });
  assert.deepEqual(result, { checked: 1, excluded: 1, ok: true });
});

test("gate 1: the fill batches, and honours James's allowlist when one is supplied", async () => {
  const env = { FPM_DB: makeMockD1() };
  const rows = [];
  for (let i = 1; i <= RANK_EXCLUSION_WRITE_BATCH + 25; i++) rows.push({ appid: i, name: `Game ${i}: Prologue` });
  await seedRows(env, rows);

  const result = await ensureRankExclusions(env, { nowMs: 1, allowlist: new Set([7, 8]) });
  assert.equal(result.checked, RANK_EXCLUSION_WRITE_BATCH + 25);
  assert.equal(result.excluded, RANK_EXCLUSION_WRITE_BATCH + 25 - 2);
  const spared = (await env.FPM_DB.prepare("SELECT rank_exclude_reason FROM fpm_catalog WHERE appid IN (7, 8)").all()).results;
  assert.deepEqual(spared.map((r) => r.rank_exclude_reason), [null, null]);
});

test("gate 1 / §13.5: a D1 failure fails SOFT — reports what got through, never throws", async () => {
  const broken = { FPM_DB: { prepare: () => { throw new Error("D1 down"); } } };
  assert.deepEqual(await ensureRankExclusions(broken), { checked: 0, excluded: 0, ok: false });

  // And a failure PART-WAY through a fill keeps whatever was already written.
  const env = { FPM_DB: makeMockD1() };
  const rows = [];
  for (let i = 1; i <= RANK_EXCLUSION_WRITE_BATCH + 10; i++) rows.push({ appid: i, name: `Game ${i}` });
  await seedRows(env, rows);
  let batches = 0;
  const realBatch = env.FPM_DB.batch.bind(env.FPM_DB);
  env.FPM_DB.batch = async (statements) => {
    if (++batches > 1) throw new Error("D1 down mid-fill");
    return realBatch(statements);
  };
  const partial = await ensureRankExclusions(env, { nowMs: 1 });
  assert.equal(partial.ok, false);
  assert.equal(partial.checked, RANK_EXCLUSION_WRITE_BATCH);
  const stamped = await env.FPM_DB.prepare("SELECT count(*) AS n FROM fpm_catalog WHERE rank_exclude_checked_at IS NOT NULL").first("n");
  assert.equal(stamped, RANK_EXCLUSION_WRITE_BATCH, "partial progress is real progress and stays written");
});

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage item 2 — both normalisers
// ---------------------------------------------------------------------------

test("§10.2 min-max: maps the pool onto 0..1 and PRESERVES the shape", () => {
  assert.deepEqual(minMaxNormalise([0, 5, 10]), [0, 0.5, 1]);
  // The failure mode the probe exists to measure: a compressed pool stays
  // compressed in absolute terms only after re-expansion — min-max always
  // spans 0..1, but the INTERIOR keeps its clustering. One outlier at the top
  // crushes everything else toward zero.
  const compressed = minMaxNormalise([0.01, 0.012, 0.011, 0.9]);
  assert.ok(compressed[0] < 0.01 && compressed[1] < 0.01 && compressed[2] < 0.01);
  assert.equal(compressed[3], 1);
});

test("§10.2 min-max: a degenerate pool returns zeros rather than dividing by zero", () => {
  assert.deepEqual(minMaxNormalise([0.5, 0.5, 0.5]), [0, 0, 0]);
  assert.deepEqual(minMaxNormalise([0.5]), [0]);
  assert.deepEqual(minMaxNormalise([]), []);
});

test("§10.2 percentile: uniform on 0..1 by construction, which is why it guarantees wS force", () => {
  const out = percentileRankNormalise([0.01, 0.012, 0.011, 0.9]);
  // The same compressed pool min-max crushes is spread evenly here. THIS is
  // the choice gate 3 is about.
  assert.deepEqual(out, [0, 0.5, 0.25, 0.75]);
});

test("§10.2 percentile: the tie rule is STRICTLY-BELOW, so a zero-cosine game scores exactly 0", () => {
  // A large tie block at zero is the expected shape of this pool — every game
  // sharing no distinctive tag with the profile. The standard mid-rank
  // convention would hand that whole block half its own size instead of 0.
  const out = percentileRankNormalise([0, 0, 0, 0, 0.5]);
  assert.deepEqual(out, [0, 0, 0, 0, 0.8]);
  // Monotone everywhere, and never above 1.
  const values = [0.3, 0.1, 0.1, 0.9, 0.5];
  const norm = percentileRankNormalise(values);
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      if (values[i] < values[j]) assert.ok(norm[i] < norm[j]);
      if (values[i] === values[j]) assert.equal(norm[i], norm[j]);
    }
  }
  assert.ok(Math.max(...norm) <= 1);
});

test("§12b.2 the normaliser is a PROPERTY OF THE PRESET, and `?norm=` overrides either lens", () => {
  const params = (q) => new URLSearchParams(q);
  // Gate 3's ruling, pinned exhaustively. `sale` deliberately shares
  // `default`'s normaliser: it differs only in wSale, and swapping the
  // normaliser too would change two variables at once and make gate 4's
  // movement measurement unattributable.
  assert.deepEqual(RANK_NORMALISER_BY_PRESET, { default: "percentile", sale: "percentile", similarity: "minmax" });
  assert.equal(resolveRankWeights(params("preset=default")).normaliser, "percentile");
  assert.equal(resolveRankWeights(params("preset=sale")).normaliser, "percentile");
  assert.equal(resolveRankWeights(params("preset=similarity")).normaliser, "minmax");

  // The override reaches both directions, so the other list is one URL away.
  assert.equal(resolveRankWeights(params("preset=default&norm=minmax")).normaliser, "minmax");
  assert.equal(resolveRankWeights(params("preset=similarity&norm=percentile")).normaliser, "percentile");
  // Junk falls back to the preset's own choice rather than 500ing.
  assert.equal(resolveRankWeights(params("preset=similarity&norm=nonsense")).normaliser, "minmax");

  // EVERY preset must carry a normaliser. A preset added without one would
  // silently fall back to the headline lens's behaviour, which is a safe
  // default but a bad surprise — so it has to fail here first.
  for (const preset of Object.keys(RANK_PRESETS)) {
    assert.ok(RANK_NORMALISERS.has(RANK_NORMALISER_BY_PRESET[preset]), `${preset} has no normaliser`);
  }
});

test("§10.2 normaliseSimilarities dispatches on the name, and the default is a NAMED constant", () => {
  assert.deepEqual(normaliseSimilarities([0, 5, 10], "minmax"), [0, 0.5, 1]);
  assert.deepEqual(normaliseSimilarities([0, 5, 10], "percentile"), [0, 1 / 3, 2 / 3]);
  // Gate 3: the pick must be a named constant, not a buried default.
  assert.ok(RANK_NORMALISERS.has(RANK_NORMALISER_DEFAULT));
  assert.deepEqual(normaliseSimilarities([0, 5, 10]), normaliseSimilarities([0, 5, 10], RANK_NORMALISER_DEFAULT));
});

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage items 2 and 3 — the blend at all three presets
// ---------------------------------------------------------------------------

test("§10.2 the three presets are exactly SPEC.md §4.2's table", () => {
  assert.deepEqual(RANK_PRESETS.default, { we: 0.7, ws: 0.3, wsale: 0 });
  assert.deepEqual(RANK_PRESETS.sale, { we: 0.7, ws: 0.3, wsale: 0.5 });
  assert.deepEqual(RANK_PRESETS.similarity, { we: 0.4, ws: 0.6, wsale: 0 });
  // wE + wS = 1 on every preset — the invariant `base` comparability rests on.
  for (const p of Object.values(RANK_PRESETS)) assert.ok(Math.abs(p.we + p.ws - 1) < 1e-12);
});

test("§10.3 wSale = 0 is ARITHMETIC IDENTITY with base — the default preset is provably sale-blind", () => {
  // Not "approximately unaffected": the multiplier is exactly 1.0, so a 90%-
  // off row at a historical low scores identically to the same row at full
  // price. This is what makes owned and unowned compete on the same two
  // numbers under `default`.
  for (const cut of [null, 0, 50, 90]) {
    for (const atHistoricalLow of [false, true]) {
      const blend = blendRankScore(
        { experienceScore: 98, similarityNorm: 0.42, cut, atHistoricalLow },
        RANK_PRESETS.default,
      );
      assert.equal(blend.saleMultiplier, 1);
      assert.equal(blend.rankScore, blend.base);
      assert.equal(blend.base, 0.7 * 0.98 + 0.3 * 0.42);
    }
  }
});

test("§10.2 the blend is ADDITIVE for E and S — a zero similarity cannot annihilate Portal", () => {
  // The reason the formula is not multiplicative, stated as a test: under a
  // product, S = 0 would zero out a 98 experience score and put Portal
  // nowhere, which is the opposite of what "co-pillar" means.
  const portal = blendRankScore({ experienceScore: 98, similarityNorm: 0 }, RANK_PRESETS.default);
  assert.ok(portal.rankScore > 0.68);
  // And under the similarity preset, where taste leads, experience is the
  // floor that keeps shovelware out: a perfect tag match on a 20 experience
  // score still loses to Portal's 98 with no match at all.
  const shovelware = blendRankScore({ experienceScore: 20, similarityNorm: 1 }, RANK_PRESETS.similarity);
  const portalSim = blendRankScore({ experienceScore: 98, similarityNorm: 0.5 }, RANK_PRESETS.similarity);
  assert.ok(portalSim.rankScore > 0.6 && shovelware.rankScore < 0.7);
});

test("§10.2 the sale lens: a 90%-off historical low earns +52%, and it reuses HISTORICAL_LOW_BONUS", () => {
  const flat = blendRankScore({ experienceScore: 80, similarityNorm: 0.5, cut: 90 }, RANK_PRESETS.sale);
  const low = blendRankScore({ experienceScore: 80, similarityNorm: 0.5, cut: 90, atHistoricalLow: true }, RANK_PRESETS.sale);
  assert.equal(flat.saleMultiplier, 1 + 0.5 * 0.9);
  assert.equal(low.saleMultiplier, 1 + 0.5 * 0.9 * HISTORICAL_LOW_BONUS);
  assert.ok(Math.abs(low.saleMultiplier - 1.5175) < 1e-9, "SPEC.md §4.2's 'up to +52%'");
  // No new constants: the historical-low premium is the one this app already
  // uses in src/score.js.
  assert.equal(HISTORICAL_LOW_BONUS, 1.15);
});

test("§10.2 the blend clamps its inputs — junk in never produces junk out", () => {
  const missing = blendRankScore({}, RANK_PRESETS.default);
  assert.equal(missing.rankScore, 0);
  const overflow = blendRankScore({ experienceScore: 500, similarityNorm: 9, cut: 900 }, RANK_PRESETS.sale);
  assert.equal(overflow.e, 1);
  assert.equal(overflow.s, 1);
  assert.equal(overflow.p, 1);
  const nan = blendRankScore({ experienceScore: NaN, similarityNorm: NaN }, RANK_PRESETS.default);
  assert.equal(nan.rankScore, 0, "NaN must never reach the sort comparator");
});

test("resolveRankWeights: presets, clamped overrides, and the one-sided complement rule", () => {
  const params = (q) => new URLSearchParams(q);
  assert.deepEqual(resolveRankWeights(params("")), { preset: "default", we: 0.7, ws: 0.3, wsale: 0, normaliser: "percentile" });
  assert.deepEqual(resolveRankWeights(params("preset=similarity")), { preset: "similarity", we: 0.4, ws: 0.6, wsale: 0, normaliser: "minmax" });
  // Unknown preset falls back rather than 500ing, same as parseFpmFormula.
  assert.equal(resolveRankWeights(params("preset=nonsense")).preset, "default");

  // One side supplied derives the other, so the base stays comparable.
  assert.deepEqual(resolveRankWeights(params("ws=0.8")), { preset: "default", we: 0.2, ws: 0.8, wsale: 0, normaliser: "percentile" });
  assert.deepEqual(resolveRankWeights(params("we=0.9")), { preset: "default", we: 0.9, ws: 0.1, wsale: 0, normaliser: "percentile" });
  // Both supplied are honoured verbatim — two numbers typed means two numbers.
  assert.deepEqual(resolveRankWeights(params("we=0.9&ws=0.9")), { preset: "default", we: 0.9, ws: 0.9, wsale: 0, normaliser: "percentile" });

  // Clamping, and garbage falling back rather than throwing.
  assert.equal(resolveRankWeights(params("we=5")).we, 1);
  assert.equal(resolveRankWeights(params("we=-3")).we, 0);
  assert.equal(resolveRankWeights(params("we=banana")).we, 0.7);
  assert.equal(resolveRankWeights(params("wsale=99")).wsale, RANK_WSALE_MAX, "gate 4 headroom, bounded");
  assert.equal(resolveRankWeights(params("preset=sale&wsale=0")).wsale, 0);
});

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage item 4 — leave-one-out, AND the guard on James's
// reason 2 (every OTHER owned game still contributes in full)
// ---------------------------------------------------------------------------

/** Three owned games with deliberately distinct tag sets, enough playtime to
 * clear MIN_PLAYTIME_MINUTES, and recent enough to survive the recency term. */
function ownedFixture(now) {
  const recent = Math.floor(now / 1000) - 24 * 60 * 60;
  return [
    { appid: 1, name: "Roguelike A", playtime_forever: 600, rtime_last_played: recent },
    { appid: 2, name: "Metroidvania B", playtime_forever: 900, rtime_last_played: recent },
    { appid: 3, name: "Deckbuilder C", playtime_forever: 1200, rtime_last_played: recent },
  ];
}

function spyFixture() {
  return new Map([
    [1, { tags: { Roguelike: 100, Pixel: 60, Difficult: 40 }, median: 500 }],
    [2, { tags: { Metroidvania: 100, Exploration: 70, Platformer: 50 }, median: 700 }],
    [3, { tags: { Deckbuilder: 100, Strategy: 80, Turn: 30 }, median: 900 }],
  ]);
}

test("§10.4 leave-one-out: an owned game no longer self-matches its own profile contribution", () => {
  const now = Date.UTC(2026, 8, 3);
  const owned = ownedFixture(now);
  const spy = spyFixture();
  const idfMap = computeIdf([...spy.values()].map((s) => s.tags));

  const { profile, contributions } = buildProfile(owned, spy, 12, now, idfMap);
  const summed = summedProfileFromContributions(contributions);
  const own = contributions.find((c) => c.appid === 1);

  const reduced = profileWithoutGame(summed, own.tagWeights, idfMap);

  // Game 1's distinctive tags are gone from the profile it is scored against.
  assert.ok(!("Roguelike" in reduced));
  assert.ok(!("Difficult" in reduced));
  // ...so its similarity against the reduced profile drops.
  const vector = { Roguelike: 0.5, Pixel: 0.3, Difficult: 0.2 };
  const full = cosineSimilarity(profile, vector);
  const loo = cosineSimilarity(reduced, vector);
  assert.ok(loo < full, "the circular self-match must shrink");
});

test("§10.4 THE GUARD ON JAMES'S REASON 2: every OTHER owned game still contributes IN FULL", () => {
  // This is the test that protects the recommendation engine. Leave-one-out
  // removes ONE game's contribution and nothing else. If it ever started
  // removing more — or rebuilding the profile from a narrowed library — the
  // library would stop being the engine's source, which is the "other big
  // aspect to this whole project" James named on 2026-09-02.
  const now = Date.UTC(2026, 8, 3);
  const owned = ownedFixture(now);
  const spy = spyFixture();
  const idfMap = computeIdf([...spy.values()].map((s) => s.tags));

  const { contributions } = buildProfile(owned, spy, 12, now, idfMap);
  const summed = summedProfileFromContributions(contributions);
  const own = contributions.find((c) => c.appid === 1);
  const reduced = profileWithoutGame(summed, own.tagWeights, idfMap);

  // Games 2 and 3 are STILL IN THERE, every tag of them.
  for (const tag of ["Metroidvania", "Exploration", "Platformer", "Deckbuilder", "Strategy", "Turn"]) {
    assert.ok(tag in reduced, `${tag} must still contribute — only game 1 was removed`);
  }

  // And their RELATIVE weights are untouched: the reduced profile is exactly
  // what buildProfile would have produced from a library of games 2 and 3.
  const rebuilt = buildProfile(owned.filter((g) => g.appid !== 1), spy, 12, now, idfMap).profile;
  assert.deepEqual(Object.keys(reduced).sort(), Object.keys(rebuilt).sort());
  for (const tag of Object.keys(rebuilt)) {
    assert.ok(Math.abs(reduced[tag] - rebuilt[tag]) < 1e-12, `${tag} weight must match a genuine rebuild`);
  }
});

test("§10.4 leave-one-out: float residue never leaves a phantom or a negative tag", () => {
  // Subtracting a float sum from itself leaves ~1e-17. Carrying 200 phantom
  // tags at 1e-17 into a cosine is noise dressed as signal; a NEGATIVE one
  // would flip that tag's sign.
  const summed = { A: 0.1 + 0.2, B: 1 };
  const reduced = profileWithoutGame(summed, { A: 0.1 + 0.2, B: 2 }, { A: 1, B: 1 });
  assert.ok(!("A" in reduced), "an exactly-cancelled tag is gone, not carried at 1e-17");
  assert.ok(!("B" in reduced), "over-subtraction clamps to gone, never negative");
  for (const v of Object.values(reduced)) assert.ok(v >= 0);
});

test("§10.4 leave-one-out: an empty or absent library degrades to an empty profile, never a throw", () => {
  assert.deepEqual(summedProfileFromContributions([]), {});
  assert.deepEqual(summedProfileFromContributions(null), {});
  assert.deepEqual(profileWithoutGame({}, {}, {}), {});
  assert.deepEqual(profileWithoutGame(null, null, null), {});
});

// ---------------------------------------------------------------------------
// SPEC.md §10 coverage item 5 — the guard on James's reason 1
// ---------------------------------------------------------------------------

test("§10.5 THE GUARD ON JAMES'S REASON 1: an owned, low-confidence, sub-floor row is NEVER suppressed", () => {
  // The Excrawlers' real shape: owned, experience 62, low confidence, 90
  // reviews. It is the one of James's 11 owned low-confidence games still
  // below the 200 bar after §12b.1, so it is the live proof the exemption is
  // load-bearing rather than decorative. Under the unowned rule it dies.
  const excrawlers = { experience_confidence: "low", positive: 85, negative: 5, source_owned: 1 };
  assert.equal(isLowConfidenceSuppressed(excrawlers), false);

  // The identical row, unowned, IS suppressible — proving the exemption is
  // what spared it and not some unrelated leniency.
  assert.equal(isLowConfidenceSuppressed({ ...excrawlers, source_owned: 0 }), true);

  // Sol Cesto (879 reviews) was suppressible at the old 1,000 bar and is not
  // at 200. Pinned so a future threshold change has to face what it re-hides.
  const solCesto = { experience_confidence: "low", positive: 800, negative: 79, source_owned: 0 };
  assert.equal(isLowConfidenceSuppressed(solCesto), false);
});

test("§10.5 the owned exemption lives INSIDE the predicate, so no call site can forget it", () => {
  // SPEC.md §7: the exemption is not behind the settings key. The predicate
  // itself returns false for an owned row before it looks at anything else,
  // so `suppressLowConfidence` on or off makes no difference to an owned row.
  const owned = { experience_confidence: "low", positive: 1, negative: 0, source_owned: 1 };
  assert.equal(isLowConfidenceSuppressed(owned), false);
  // The same row with the ONLY difference being ownership IS suppressed, which
  // is the structural claim: the exemption is inside the predicate, so no call
  // site can reach the rest of the rule without also getting the exemption.
  assert.equal(isLowConfidenceSuppressed({ ...owned, source_owned: 0 }), true);
  // The settings key is a separate, named thing the HANDLER consults. It is not
  // an argument to this predicate at all, so passing it cannot change the answer.
  assert.equal(isLowConfidenceSuppressed(owned, true), false);
  assert.equal(isLowConfidenceSuppressed(owned, false), false);
  assert.equal(SUPPRESS_LOW_CONFIDENCE_KEY, "suppressLowConfidence");
});

test("§12b.1 suppression: both conditions are required, and the floor is 200 reviews", () => {
  // RULED DOWN FROM 1,000 (James, 2026-09-03). At 1,000 this filter removed
  // 6,812 rows — 37% of the scored catalogue — including Desvelado at
  // experience 91, which is not what "stop a bluffed score" was meant to do.
  assert.equal(LOW_CONFIDENCE_REVIEW_FLOOR, 200);
  // Low confidence but well-reviewed: kept. Enough eyes to check the score.
  assert.equal(isLowConfidenceSuppressed({ experience_confidence: "low", positive: 200, negative: 0, source_owned: 0 }), false);
  assert.equal(isLowConfidenceSuppressed({ experience_confidence: "low", positive: 199, negative: 0, source_owned: 0 }), true);
  // The band the ruling reopened: 200–999 reviews is now ranked, not hidden.
  assert.equal(isLowConfidenceSuppressed({ experience_confidence: "low", positive: 500, negative: 0, source_owned: 0 }), false);
  // Thin reviews but a confident judgement: kept. The model was not bluffing.
  assert.equal(isLowConfidenceSuppressed({ experience_confidence: "medium", positive: 10, negative: 0, source_owned: 0 }), false);
  assert.equal(isLowConfidenceSuppressed({ experience_confidence: "high", positive: 10, negative: 0, source_owned: 0 }), false);
  assert.equal(isLowConfidenceSuppressed({ experience_confidence: null, positive: 10, negative: 0, source_owned: 0 }), false);
  assert.equal(isLowConfidenceSuppressed({}), false);
  assert.equal(isLowConfidenceSuppressed(null), false);
});

// ---------------------------------------------------------------------------
// QA gap-closure tests, written after James's diff gate of 2026-09-04.
//
// Each of the five below was written to fail against a specific mutation of
// src/ that the 752-test suite passed unchanged. They are proof tests: they
// exist because the behaviour they assert was correct but UNPINNED, so a
// later edit could have silently undone it. Every one was run against the
// broken version first and confirmed red before being kept.
// ---------------------------------------------------------------------------

/** Two owned games that SHARE a tag, which is the shape the real catalogue
 * actually has (`Indie` and `Singleplayer` overlap across most of James's
 * library) and the shape the original leave-one-out fixtures did not.
 *
 * TC-3. With fully DISJOINT owned fixtures, over-subtraction in
 * profileWithoutGame is invisible: `value - 1.5 * tagWeights[tag]` and even
 * `value - 5 * tagWeights[tag]` both pass, because the only tags that get
 * over-subtracted are the removed game's own, and those clamp to 0 and are
 * dropped either way. A shared tag is the only thing that can see it. */
function overlappingOwnedFixture(now) {
  const recent = Math.floor(now / 1000) - 24 * 60 * 60;
  return [
    { appid: 1, name: "Owned Roguelike", playtime_forever: 600, rtime_last_played: recent },
    { appid: 2, name: "Owned Metroidvania", playtime_forever: 900, rtime_last_played: recent },
  ];
}

function overlappingSpyFixture() {
  return new Map([
    // `Indie` is the shared tag – in BOTH games, exactly as in the live library.
    [1, { tags: { Indie: 100, Roguelike: 80, Difficult: 40 }, median: 500 }],
    [2, { tags: { Indie: 100, Metroidvania: 90, Exploration: 50 }, median: 700 }],
  ]);
}

/** A corpus wide enough that the shared tag keeps a NON-ZERO idf. Computed
 * over the two owned games alone, `Indie` would sit in 2 of 2 documents and
 * earn ln(1) = 0, which would delete the overlap this test exists to look at.
 * In the real handler the idf corpus is the ~14k-row eligible pool. */
function overlappingIdf() {
  return computeIdf([
    { Indie: 1, Roguelike: 1, Difficult: 1 },
    { Indie: 1, Metroidvania: 1, Exploration: 1 },
    { Racing: 1, Sports: 1 },
    { Shooter: 1, Action: 1 },
  ]);
}

test("TC-3 §10.4 leave-one-out subtracts EXACTLY ONE game's share of a SHARED tag – not more", () => {
  // THE DEFECT THIS CATCHES: over-subtraction. James's reason 2 is that the
  // owned library feeds the similarity engine, and a leave-one-out that
  // removed 1.5x or 5x of the candidate's contribution would quietly strip
  // weight belonging to OTHER owned games off every tag they share with it.
  // On the live catalogue that is `Indie` and `Singleplayer` on nearly every
  // row, so the damage would be broad and invisible.
  const now = Date.UTC(2026, 8, 4);
  const owned = overlappingOwnedFixture(now);
  const spy = overlappingSpyFixture();
  const idfMap = overlappingIdf();

  const { contributions } = buildProfile(owned, spy, 12, now, idfMap);
  const c1 = contributions.find((c) => c.appid === 1);
  const c2 = contributions.find((c) => c.appid === 2);
  const summed = summedProfileFromContributions(contributions);

  // Fixture integrity first: if this ever stops being a genuinely SHARED tag
  // the test below silently stops testing anything, so it is asserted, not
  // assumed.
  assert.ok(c1.tagWeights.Indie > 0, "game 1 must contribute to the shared tag");
  assert.ok(c2.tagWeights.Indie > 0, "game 2 must contribute to the shared tag");
  assert.ok(idfMap.Indie > 0, "the shared tag must survive IDF or the overlap vanishes");
  assert.ok(summed.Indie > c2.tagWeights.Indie, "the summed profile must hold BOTH games' share");
  assert.ok(Math.abs(summed.Indie - (c1.tagWeights.Indie + c2.tagWeights.Indie)) < 1e-15);

  const reduced = profileWithoutGame(summed, c1.tagWeights, idfMap);

  // THE EXACT CLAIM, and the one that fails under any over-subtraction: what
  // is LEFT on the shared tag is precisely game 2's contribution and nothing
  // less. Asserted as a ratio against one of game 2's exclusive tags, because
  // `reduced` is L2-normalised and only directions are comparable – an
  // over-subtracted `Indie` tilts the vector away from game 2's true
  // direction, and the ratio is what sees the tilt.
  assert.ok("Indie" in reduced, "the shared tag must survive: game 2 still contributes it");
  const observed = reduced.Indie / reduced.Metroidvania;
  const expected =
    (idfMap.Indie * c2.tagWeights.Indie) / (idfMap.Metroidvania * c2.tagWeights.Metroidvania);
  assert.ok(
    Math.abs(observed - expected) < 1e-12,
    `shared-tag weight must equal game 2's contribution exactly: expected ratio ${expected}, got ${observed}`,
  );

  // And the whole vector, term for term, is what buildProfile would have
  // produced from a library that never contained game 1 at all.
  const rebuilt = buildProfile(
    owned.filter((g) => g.appid !== 1),
    spy,
    12,
    now,
    idfMap,
  ).profile;
  assert.deepEqual(Object.keys(reduced).sort(), Object.keys(rebuilt).sort());
  for (const tag of Object.keys(rebuilt)) {
    assert.ok(
      Math.abs(reduced[tag] - rebuilt[tag]) < 1e-12,
      `${tag}: leave-one-out must match a genuine rebuild (${reduced[tag]} vs ${rebuilt[tag]})`,
    );
  }
});

test("TC-5 §4.1 the sale term MULTIPLIES base – 'a boost, never a gate' is the multiplication", () => {
  // THE DEFECT THIS CATCHES: `rankScore = base + wsale * p`, an additive sale
  // term. saleMultiplier was asserted in isolation and rankScore was asserted
  // to equal base at wSale = 0, but nothing asserted the two were joined by a
  // MULTIPLICATION – so an additive composition passed the whole suite.
  //
  // Why the multiplication is the product claim, not a detail: an additive
  // term adds the same absolute amount to a 20 experience score as to a 98,
  // which lets a deep discount on shovelware overtake a great game. A
  // multiplier scales what is already there, so sale can only ever reorder
  // WITHIN what experience and taste already earned. That is what "boost,
  // never a gate" means arithmetically.
  const low = blendRankScore(
    { experienceScore: 80, similarityNorm: 0.5, cut: 90, atHistoricalLow: true },
    RANK_PRESETS.sale,
  );
  assert.equal(low.rankScore, low.base * low.saleMultiplier);

  const flat = blendRankScore(
    { experienceScore: 80, similarityNorm: 0.5, cut: 90, atHistoricalLow: false },
    RANK_PRESETS.sale,
  );
  assert.equal(flat.rankScore, flat.base * flat.saleMultiplier);

  // An additive composition would produce a different number here, so the
  // assertion above genuinely discriminates rather than holding by accident.
  assert.notEqual(low.rankScore, low.base + RANK_PRESETS.sale.wsale * low.p);

  // The consequence, stated as behaviour: the same discount is worth
  // PROPORTIONALLY the same to every row, so it scales the order rather than
  // shifting it. Doubling base doubles rankScore at a fixed sale term.
  const half = blendRankScore(
    { experienceScore: 40, similarityNorm: 0.25, cut: 90, atHistoricalLow: true },
    RANK_PRESETS.sale,
  );
  assert.ok(Math.abs(half.base * 2 - low.base) < 1e-15, "fixture: base really is halved");
  assert.ok(Math.abs(half.rankScore * 2 - low.rankScore) < 1e-15, "a multiplier scales, it does not shift");
});
