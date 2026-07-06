// Tests for src/deals.js — the pure deals-feed logic (Increment 2).
//
// Pure module, no fetch/cache stubbing needed. Fixtures are shaped from the
// real ITAD /deals/v2 and /games/historylow/v1 response shapes as documented
// in the SPEC-NOTE comments at the top of deals.js (parseSteamAppId parses
// /lookup/shop/61/id/v1 entries like "app/123456", not a store URL).

import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_CUT_DEFAULT,
  MIN_CUT_MIN,
  MIN_CUT_MAX,
  HISTORICAL_LOW_TOLERANCE_CENTS,
  clampMinCut,
  chunk,
  mergeDealPages,
  filterByMinCut,
  parseSteamAppId,
  normalizeDeal,
  applyHistoricalLow,
  buildOwnedAppIdSet,
  excludeOwned,
} from "../src/deals.js";

// ---------------------------------------------------------------------------
// clampMinCut — default-when-missing regression guard + 40-90 clamping.
// ---------------------------------------------------------------------------

test("clampMinCut: null/undefined/empty-string all default to 60 (regression guard)", () => {
  assert.equal(clampMinCut(null), 60);
  assert.equal(clampMinCut(undefined), 60);
  assert.equal(clampMinCut(""), 60);
  assert.equal(MIN_CUT_DEFAULT, 60);
});

test("clampMinCut: non-numeric string also defaults to 60", () => {
  assert.equal(clampMinCut("not-a-number"), 60);
  assert.equal(clampMinCut("NaN"), 60);
});

test("clampMinCut: clamps below MIN_CUT_MIN (40) up to 40", () => {
  assert.equal(clampMinCut("20"), 40);
  assert.equal(clampMinCut(0), 40);
  assert.equal(clampMinCut(MIN_CUT_MIN), 40);
});

test("clampMinCut: clamps above MIN_CUT_MAX (90) down to 90", () => {
  assert.equal(clampMinCut("120"), 90);
  assert.equal(clampMinCut(999), 90);
  assert.equal(clampMinCut(MIN_CUT_MAX), 90);
});

test("clampMinCut: passes through in-range values unchanged", () => {
  assert.equal(clampMinCut("60"), 60);
  assert.equal(clampMinCut(75), 75);
  assert.equal(clampMinCut("40"), 40);
  assert.equal(clampMinCut("90"), 90);
});

test("clampMinCut: rounds fractional values", () => {
  assert.equal(clampMinCut("55.6"), 56);
  assert.equal(clampMinCut("61.4"), 61);
  assert.equal(clampMinCut(74.5), 75); // round-half-up per Math.round
});

// ---------------------------------------------------------------------------
// chunk — batching helper for the ≤200-ids-per-call ITAD batch endpoints.
// ---------------------------------------------------------------------------

test("chunk: splits into groups of at most `size`, preserving order", () => {
  const ids = Array.from({ length: 5 }, (_, i) => `id${i}`);
  assert.deepEqual(chunk(ids, 2), [["id0", "id1"], ["id2", "id3"], ["id4"]]);
});

test("chunk: exact multiple of size produces no trailing partial chunk", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(chunk(ids, 2), [["a", "b"], ["c", "d"]]);
});

test("chunk: empty array yields no chunks", () => {
  assert.deepEqual(chunk([], 200), []);
});

// ---------------------------------------------------------------------------
// mergeDealPages — pagination assembly: multi-page accumulation + cap.
// ---------------------------------------------------------------------------

test("mergeDealPages: accumulates .list arrays from multiple pages in order", () => {
  const pages = [
    { list: [{ id: "a" }, { id: "b" }], hasMore: true },
    { list: [{ id: "c" }], hasMore: false },
  ];
  const merged = mergeDealPages(pages, 100);
  assert.deepEqual(
    merged.map((d) => d.id),
    ["a", "b", "c"],
  );
});

test("mergeDealPages: tolerates a page with a missing .list", () => {
  const pages = [{ list: [{ id: "a" }] }, {}, { list: [{ id: "b" }] }];
  const merged = mergeDealPages(pages, 100);
  assert.deepEqual(
    merged.map((d) => d.id),
    ["a", "b"],
  );
});

test("mergeDealPages: caps the merged total at `cap` (the ~1,000 spec cap, parameterised small here)", () => {
  const pages = [
    { list: Array.from({ length: 4 }, (_, i) => ({ id: `p1-${i}` })) },
    { list: Array.from({ length: 4 }, (_, i) => ({ id: `p2-${i}` })) },
  ];
  const merged = mergeDealPages(pages, 5);
  assert.equal(merged.length, 5);
  assert.deepEqual(
    merged.map((d) => d.id),
    ["p1-0", "p1-1", "p1-2", "p1-3", "p2-0"],
  );
});

test("mergeDealPages: cap=0/falsy disables capping (returns full merge)", () => {
  const pages = [{ list: [{ id: "a" }, { id: "b" }, { id: "c" }] }];
  const merged = mergeDealPages(pages, 0);
  assert.equal(merged.length, 3);
});

// ---------------------------------------------------------------------------
// filterByMinCut — at threshold, above, below.
// ---------------------------------------------------------------------------

test("filterByMinCut: keeps deals exactly at the threshold", () => {
  const items = [{ id: "at-threshold", deal: { cut: 60 } }];
  assert.deepEqual(filterByMinCut(items, 60), items);
});

test("filterByMinCut: keeps deals above the threshold", () => {
  const items = [{ id: "above", deal: { cut: 75 } }];
  assert.deepEqual(filterByMinCut(items, 60), items);
});

test("filterByMinCut: drops deals below the threshold", () => {
  const items = [{ id: "below", deal: { cut: 59 } }];
  assert.deepEqual(filterByMinCut(items, 60), []);
});

test("filterByMinCut: mixed set keeps only qualifying deals, order preserved", () => {
  const items = [
    { id: "a", deal: { cut: 90 } },
    { id: "b", deal: { cut: 59 } },
    { id: "c", deal: { cut: 60 } },
    { id: "d", deal: { cut: 40 } },
  ];
  const kept = filterByMinCut(items, 60).map((d) => d.id);
  assert.deepEqual(kept, ["a", "c"]);
});

test("filterByMinCut: a deal with no `deal.cut` at all is treated as 0% and dropped (minCut >= 40)", () => {
  const items = [{ id: "no-cut", deal: {} }, { id: "no-deal" }];
  assert.deepEqual(filterByMinCut(items, 40), []);
});

// ---------------------------------------------------------------------------
// parseSteamAppId — resolution from /lookup/shop/61/id/v1 entries, incl. the
// "no resolvable Steam appid" case (bundle/sub-only, or empty).
// ---------------------------------------------------------------------------

test("parseSteamAppId: extracts the numeric id from an 'app/<id>' entry", () => {
  assert.equal(parseSteamAppId(["app/440"]), 440);
});

test("parseSteamAppId: finds the app/ entry even when other shop-native ids are present", () => {
  assert.equal(parseSteamAppId(["sub/123", "app/999", "bundle/5"]), 999);
});

test("parseSteamAppId: returns null when no app/ entry is present (bundle/sub-only listing)", () => {
  assert.equal(parseSteamAppId(["bundle/12"]), null);
  assert.equal(parseSteamAppId(["sub/789"]), null);
});

test("parseSteamAppId: returns null for an empty array", () => {
  assert.equal(parseSteamAppId([]), null);
});

test("parseSteamAppId: returns null for non-array input (undefined/null)", () => {
  assert.equal(parseSteamAppId(undefined), null);
  assert.equal(parseSteamAppId(null), null);
});

test("parseSteamAppId: returns null if the app/ suffix isn't numeric", () => {
  assert.equal(parseSteamAppId(["app/not-a-number"]), null);
});

// ---------------------------------------------------------------------------
// normalizeDeal — shape, and the "no resolvable appid" pass-through (kept,
// no link — appid stays null rather than the deal being dropped here).
// ---------------------------------------------------------------------------

test("normalizeDeal: maps all documented fields and leaves tags empty (populated by inc 3)", () => {
  const raw = {
    id: "itad-1",
    title: "Half-Life 3",
    deal: {
      price: { amount: 19.99, amountInt: 1999 },
      regular: { amount: 49.99 },
      cut: 60,
      expiry: "2026-08-01T00:00:00Z",
      flag: "LOWEST_EVER",
    },
  };
  const deal = normalizeDeal(raw, 440);
  assert.deepEqual(deal, {
    itadId: "itad-1",
    appid: 440,
    title: "Half-Life 3",
    price: 19.99,
    priceCents: 1999,
    regular: 49.99,
    cut: 60,
    expiry: "2026-08-01T00:00:00Z",
    flag: "LOWEST_EVER",
    atHistoricalLow: false,
    historicalLow: null,
    tags: [],
  });
});

test("normalizeDeal: a deal with no resolvable Steam appid is kept with appid=null, not dropped", () => {
  const raw = { id: "itad-2", title: "Bundle-only Thing", deal: { cut: 70 } };
  const deal = normalizeDeal(raw, null);
  assert.equal(deal.appid, null);
  assert.equal(deal.title, "Bundle-only Thing");
  assert.deepEqual(deal.tags, []);
});

test("normalizeDeal: missing deal sub-fields degrade to null rather than throwing", () => {
  const raw = { id: "itad-3", title: "Sparse", deal: {} };
  const deal = normalizeDeal(raw, null);
  assert.equal(deal.price, null);
  assert.equal(deal.priceCents, null);
  assert.equal(deal.regular, null);
  assert.equal(deal.cut, null);
  assert.equal(deal.expiry, null);
  assert.equal(deal.flag, null);
});

// ---------------------------------------------------------------------------
// applyHistoricalLow — flagging incl. cents tolerance.
// ---------------------------------------------------------------------------

function baseDeal(priceCents) {
  return normalizeDeal(
    { id: "x", title: "x", deal: { price: { amount: priceCents / 100, amountInt: priceCents } } },
    123,
  );
}

test("applyHistoricalLow: price exactly at the recorded low -> flagged", () => {
  const deal = baseDeal(1999);
  const low = { price: { amount: 19.99, amountInt: 1999 } };
  const result = applyHistoricalLow(deal, low);
  assert.equal(result.atHistoricalLow, true);
  assert.equal(result.historicalLow, 19.99);
});

test("applyHistoricalLow: price within the cents tolerance (low + tolerance) -> flagged", () => {
  const low = { price: { amount: 19.99, amountInt: 1999 } };
  const deal = baseDeal(1999 + HISTORICAL_LOW_TOLERANCE_CENTS); // exactly at the tolerance edge
  const result = applyHistoricalLow(deal, low, HISTORICAL_LOW_TOLERANCE_CENTS);
  assert.equal(result.atHistoricalLow, true);
});

test("applyHistoricalLow: price just outside the tolerance -> NOT flagged", () => {
  const low = { price: { amount: 19.99, amountInt: 1999 } };
  const deal = baseDeal(1999 + HISTORICAL_LOW_TOLERANCE_CENTS + 1); // one cent past the edge
  const result = applyHistoricalLow(deal, low, HISTORICAL_LOW_TOLERANCE_CENTS);
  assert.equal(result.atHistoricalLow, false);
  assert.equal(result.historicalLow, 19.99); // low is still reported for display
});

test("applyHistoricalLow: price above the low by a lot -> not flagged", () => {
  const low = { price: { amount: 9.99, amountInt: 999 } };
  const deal = baseDeal(2999);
  const result = applyHistoricalLow(deal, low);
  assert.equal(result.atHistoricalLow, false);
});

test("applyHistoricalLow: no low record (null/undefined) -> not flagged, historicalLow null", () => {
  const deal = baseDeal(1999);
  assert.equal(applyHistoricalLow(deal, null).atHistoricalLow, false);
  assert.equal(applyHistoricalLow(deal, null).historicalLow, null);
  assert.equal(applyHistoricalLow(deal, undefined).atHistoricalLow, false);
});

test("applyHistoricalLow: low record with no .price -> not flagged", () => {
  const deal = baseDeal(1999);
  const result = applyHistoricalLow(deal, {});
  assert.equal(result.atHistoricalLow, false);
  assert.equal(result.historicalLow, null);
});

test("applyHistoricalLow: deal with no priceCents (unparseable price) -> not flagged", () => {
  const deal = normalizeDeal({ id: "y", title: "y", deal: {} }, null);
  const low = { price: { amount: 9.99, amountInt: 999 } };
  const result = applyHistoricalLow(deal, low);
  assert.equal(result.atHistoricalLow, false);
});

test("applyHistoricalLow: does not mutate the input deal object", () => {
  const deal = baseDeal(1999);
  const low = { price: { amount: 19.99, amountInt: 1999 } };
  applyHistoricalLow(deal, low);
  assert.equal(deal.atHistoricalLow, false); // original untouched
});

// ---------------------------------------------------------------------------
// buildOwnedAppIdSet / excludeOwned — owned-exclusion.
// ---------------------------------------------------------------------------

test("buildOwnedAppIdSet: builds a Set of appids from a library games array", () => {
  const set = buildOwnedAppIdSet([{ appid: 440 }, { appid: 570 }]);
  assert.equal(set.has(440), true);
  assert.equal(set.has(570), true);
  assert.equal(set.has(10), false);
});

test("buildOwnedAppIdSet: handles null/undefined games gracefully", () => {
  assert.equal(buildOwnedAppIdSet(undefined).size, 0);
  assert.equal(buildOwnedAppIdSet(null).size, 0);
});

test("excludeOwned: drops a deal whose appid is in the owned set", () => {
  const owned = buildOwnedAppIdSet([{ appid: 440 }]);
  const deals = [{ appid: 440, title: "TF2" }];
  assert.deepEqual(excludeOwned(deals, owned), []);
});

test("excludeOwned: keeps a deal whose appid is not owned", () => {
  const owned = buildOwnedAppIdSet([{ appid: 440 }]);
  const deals = [{ appid: 570, title: "Dota 2" }];
  assert.deepEqual(excludeOwned(deals, owned), deals);
});

test("excludeOwned: mixed owned/non-owned, order preserved for survivors", () => {
  const owned = buildOwnedAppIdSet([{ appid: 440 }, { appid: 620 }]);
  const deals = [
    { appid: 440, title: "owned-1" },
    { appid: 570, title: "keep-1" },
    { appid: 620, title: "owned-2" },
    { appid: 730, title: "keep-2" },
  ];
  const kept = excludeOwned(deals, owned).map((d) => d.title);
  assert.deepEqual(kept, ["keep-1", "keep-2"]);
});

test("excludeOwned: a deal with appid=null (unresolvable) is never accidentally matched/dropped", () => {
  const owned = buildOwnedAppIdSet([{ appid: 440 }]);
  const deals = [{ appid: null, title: "no-appid-deal" }];
  assert.deepEqual(excludeOwned(deals, owned), deals);
});
