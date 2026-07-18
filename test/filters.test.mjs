// Tests for public/filters.js — the filter bar's pure predicates +
// persistence (Increment 5). Storage is a plain in-memory mock since Node
// (unlike a browser) has no global `localStorage` — see the file header.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILTERS,
  FILTERS_STORAGE_KEY,
  TOP_TAGS_COUNT,
  DECK_MODE_ANY,
  DECK_MODE_VERIFIED,
  DECK_MODE_VERIFIED_PLUS_PLAYABLE,
  loadFilters,
  saveFilters,
  resetFilters,
  computeTopTags,
  computeAllTagNames,
  passesMinDiscount,
  passesMaxPrice,
  passesMinSimilarity,
  passesTagFilters,
  passesQualityFloors,
  passesDeckFilter,
  passesBatteryFilter,
  passesOnSaleOnly,
  applyFilters,
} from "../public/filters.js";

/** Minimal in-memory stand-in for the browser's `localStorage`. */
function makeMockStorage() {
  const store = new Map();
  return {
    store,
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

test("loadFilters: nothing saved yet returns DEFAULT_FILTERS", () => {
  const storage = makeMockStorage();
  assert.deepEqual(loadFilters(storage), DEFAULT_FILTERS);
});

test("saveFilters + loadFilters: round-trips a full filters object", () => {
  const storage = makeMockStorage();
  const filters = {
    ...DEFAULT_FILTERS,
    minDiscount: 50,
    maxPrice: 20,
    minSimilarity: 30,
    includeTags: ["Roguelike"],
    excludeTags: ["VR"],
    minReviews: 100,
    minQuality: 0.8,
    minOwners: 1000,
    deckMode: DECK_MODE_VERIFIED,
    batteryOnly: true,
  };
  saveFilters(filters, storage);
  assert.deepEqual(loadFilters(storage), filters);
});

// Increment 5.5: min-discount moved from a server ?minCut= param into this
// bar's persisted filters (DEFAULT_FILTERS.minDiscount already existed, but
// nothing previously exercised its own round-trip explicitly).
test("saveFilters + loadFilters: minDiscount round-trips like every other filter field", () => {
  const storage = makeMockStorage();
  const filters = { ...DEFAULT_FILTERS, minDiscount: 45 };
  saveFilters(filters, storage);
  assert.equal(loadFilters(storage).minDiscount, 45);
});

test("loadFilters: a partial/older saved shape is merged over the defaults", () => {
  const storage = makeMockStorage();
  storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({ minDiscount: 75 }));
  const loaded = loadFilters(storage);
  assert.equal(loaded.minDiscount, 75);
  assert.equal(loaded.batteryOnly, false); // filled in from defaults
  assert.deepEqual(loaded.includeTags, []);
});

test("loadFilters: corrupt JSON falls back to defaults rather than throwing", () => {
  const storage = makeMockStorage();
  storage.setItem(FILTERS_STORAGE_KEY, "{not json");
  assert.deepEqual(loadFilters(storage), DEFAULT_FILTERS);
});

test("resetFilters: clears storage and returns the defaults", () => {
  const storage = makeMockStorage();
  saveFilters({ ...DEFAULT_FILTERS, minDiscount: 90 }, storage);
  const reset = resetFilters(storage);
  assert.deepEqual(reset, DEFAULT_FILTERS);
  assert.deepEqual(loadFilters(storage), DEFAULT_FILTERS);
});

// ---------------------------------------------------------------------------
// computeTopTags
// ---------------------------------------------------------------------------

test("computeTopTags: ranks by number of items carrying the tag, capped at topN", () => {
  const items = [
    { tagNames: ["A", "B"] },
    { tagNames: ["A"] },
    { tagNames: ["A", "C"] },
    { tagNames: ["B"] },
  ];
  assert.deepEqual(computeTopTags(items, 2), ["A", "B"]);
});

test("computeTopTags: ignores items with no tagNames array", () => {
  const items = [{ tagNames: ["A"] }, {}, { tagNames: null }];
  assert.deepEqual(computeTopTags(items), ["A"]);
});

test("computeTopTags: default topN matches TOP_TAGS_COUNT (30)", () => {
  assert.equal(TOP_TAGS_COUNT, 30);
  const items = Array.from({ length: 40 }, (_, i) => ({ tagNames: [`tag${i}`] }));
  assert.equal(computeTopTags(items).length, 30);
});

// ---------------------------------------------------------------------------
// computeAllTagNames
// ---------------------------------------------------------------------------

test("computeAllTagNames: every distinct tag, sorted alphabetically", () => {
  const items = [{ tagNames: ["Roguelike", "Indie"] }, { tagNames: ["Indie", "VR"] }];
  assert.deepEqual(computeAllTagNames(items), ["Indie", "Roguelike", "VR"]);
});

test("computeAllTagNames: ignores items with no tagNames, empty input returns []", () => {
  assert.deepEqual(computeAllTagNames([{ tagNames: ["A"] }, {}]), ["A"]);
  assert.deepEqual(computeAllTagNames([]), []);
  assert.deepEqual(computeAllTagNames(undefined), []);
});

// ---------------------------------------------------------------------------
// Individual predicates
// ---------------------------------------------------------------------------

test("passesMinDiscount", () => {
  assert.equal(passesMinDiscount({ cut: 60 }, 60), true);
  assert.equal(passesMinDiscount({ cut: 59 }, 60), false);
  assert.equal(passesMinDiscount({}, 0), true);
  assert.equal(passesMinDiscount({ cut: 10 }, null), true); // no floor set
});

test("passesMinDiscount: an owned row (FPM, Increment 7.6) is exempt regardless of the bar setting, since it has no cut", () => {
  assert.equal(passesMinDiscount({ owned: true, cut: null }, 60), true);
  assert.equal(passesMinDiscount({ owned: true }, 100), true);
  // A sub-10% (or any low-cut) DEAL row is NOT exempt — only owned/no-deal rows are.
  assert.equal(passesMinDiscount({ owned: false, cut: 5 }, 10), false);
  assert.equal(passesMinDiscount({ cut: 5 }, 10), false);
});

test("passesMinDiscount: a catalog row with no deal annotation at all (cut == null, Increment 7.7) is exempt, same as an owned row", () => {
  assert.equal(passesMinDiscount({ cut: null }, 60), true);
  assert.equal(passesMinDiscount({}, 60), true); // cut undefined
  // A real 0%-cut deal (cut is a number, just 0) is NOT the same as "no deal" — still evaluated normally.
  assert.equal(passesMinDiscount({ cut: 0 }, 10), false);
  assert.equal(passesMinDiscount({ cut: 0 }, 0), true);
});

test("passesOnSaleOnly (Increment 7.7, FPM-only): only rows with a real deal annotation pass when the toggle is on", () => {
  assert.equal(passesOnSaleOnly({ cut: 50 }, true), true);
  assert.equal(passesOnSaleOnly({ cut: null }, true), false);
  assert.equal(passesOnSaleOnly({}, true), false);
  assert.equal(passesOnSaleOnly({ owned: true, cut: null }, true), false, "owned isn't the same as on sale");
  assert.equal(passesOnSaleOnly({ cut: 0 }, true), true, "a real 0% cut still counts as 'has a deal annotation'");
});

test("passesOnSaleOnly: toggle off is a no-op regardless of cut", () => {
  assert.equal(passesOnSaleOnly({ cut: null }, false), true);
  assert.equal(passesOnSaleOnly({}, false), true);
});

test("passesMaxPrice", () => {
  assert.equal(passesMaxPrice({ price: 20 }, 20), true);
  assert.equal(passesMaxPrice({ price: 21 }, 20), false);
  assert.equal(passesMaxPrice({ price: 100 }, null), true); // no cap set
  assert.equal(passesMaxPrice({ price: null }, 20), true); // can't evaluate -> don't punish
});

test("passesMinSimilarity", () => {
  assert.equal(passesMinSimilarity({ similarity: 0.75 }, 70), true);
  assert.equal(passesMinSimilarity({ similarity: 0.65 }, 70), false);
  assert.equal(passesMinSimilarity({}, 0), true);
  assert.equal(passesMinSimilarity({ similarity: 0.1 }, null), true);
});

test("passesTagFilters: include requires at least one match", () => {
  assert.equal(passesTagFilters({ tagNames: ["Roguelike", "Indie"] }, ["Roguelike"], []), true);
  assert.equal(passesTagFilters({ tagNames: ["Indie"] }, ["Roguelike"], []), false);
  assert.equal(passesTagFilters({ tagNames: ["Indie"] }, [], []), true); // no include filter set
});

test("passesTagFilters: exclude rejects any match", () => {
  assert.equal(passesTagFilters({ tagNames: ["VR", "Indie"] }, [], ["VR"]), false);
  assert.equal(passesTagFilters({ tagNames: ["Indie"] }, [], ["VR"]), true);
});

test("passesTagFilters: include and exclude combine (both must hold)", () => {
  assert.equal(passesTagFilters({ tagNames: ["Roguelike"] }, ["Roguelike"], ["VR"]), true);
  assert.equal(passesTagFilters({ tagNames: ["Roguelike", "VR"] }, ["Roguelike"], ["VR"]), false);
});

test("passesTagFilters: missing tagNames treated as no tags", () => {
  assert.equal(passesTagFilters({}, ["Roguelike"], []), false);
  assert.equal(passesTagFilters({}, [], []), true);
});

test("passesQualityFloors", () => {
  const item = { reviewCount: 100, quality: 0.8, owners: 5000 };
  assert.equal(passesQualityFloors(item, 100, 0.8, 5000), true);
  assert.equal(passesQualityFloors(item, 101, null, null), false);
  assert.equal(passesQualityFloors(item, null, 0.81, null), false);
  assert.equal(passesQualityFloors(item, null, null, 5001), false);
  assert.equal(passesQualityFloors(item, null, null, null), true); // no floors set
});

test("passesDeckFilter: any mode passes everything", () => {
  assert.equal(passesDeckFilter({ deck: { deck: 0 } }, DECK_MODE_ANY), true);
  assert.equal(passesDeckFilter({ deck: { deck: 3 } }, DECK_MODE_ANY), true);
  assert.equal(passesDeckFilter({}, undefined), true);
});

test("passesDeckFilter: verified mode requires deck===3", () => {
  assert.equal(passesDeckFilter({ deck: { deck: 3 } }, DECK_MODE_VERIFIED), true);
  assert.equal(passesDeckFilter({ deck: { deck: 2 } }, DECK_MODE_VERIFIED), false);
  assert.equal(passesDeckFilter({}, DECK_MODE_VERIFIED), false); // no deck data -> unknown -> excluded
});

test("passesDeckFilter: verified+playable mode requires deck===2 or 3", () => {
  assert.equal(passesDeckFilter({ deck: { deck: 3 } }, DECK_MODE_VERIFIED_PLUS_PLAYABLE), true);
  assert.equal(passesDeckFilter({ deck: { deck: 2 } }, DECK_MODE_VERIFIED_PLUS_PLAYABLE), true);
  assert.equal(passesDeckFilter({ deck: { deck: 1 } }, DECK_MODE_VERIFIED_PLUS_PLAYABLE), false);
  assert.equal(passesDeckFilter({ deck: { deck: 0 } }, DECK_MODE_VERIFIED_PLUS_PLAYABLE), false);
});

test("passesBatteryFilter", () => {
  assert.equal(passesBatteryFilter({ batteryFriendly: true }, true), true);
  assert.equal(passesBatteryFilter({ batteryFriendly: false }, true), false);
  assert.equal(passesBatteryFilter({}, true), false);
  assert.equal(passesBatteryFilter({ batteryFriendly: false }, false), true); // toggle off -> no filter
});

// ---------------------------------------------------------------------------
// applyFilters — combinations, and the includeSimilarity/includeQualityFloors
// per-tab gating (Recs-only / Recs+Best-of-only filters).
// ---------------------------------------------------------------------------

function item(overrides = {}) {
  return {
    cut: 70,
    price: 10,
    similarity: 0.5,
    tagNames: ["Roguelike"],
    reviewCount: 1000,
    quality: 0.9,
    owners: 50000,
    deck: { deck: 3, os: 3, frame: 0 },
    batteryFriendly: true,
    ...overrides,
  };
}

test("applyFilters: combines every filter (AND semantics)", () => {
  const items = [
    item({ appid: 1, cut: 80 }),
    item({ appid: 2, cut: 40 }), // fails min discount
    item({ appid: 3, price: 999 }), // fails max price
  ];
  const filters = { ...DEFAULT_FILTERS, minDiscount: 60, maxPrice: 20 };
  const result = applyFilters(items, filters);
  assert.deepEqual(
    result.map((i) => i.appid),
    [1],
  );
});

test("applyFilters: minDiscount combines with maxPrice (bar filter wiring, Increment 5.5)", () => {
  const items = [
    item({ appid: 1, cut: 80, price: 15 }), // passes both
    item({ appid: 2, cut: 30, price: 15 }), // fails minDiscount
    item({ appid: 3, cut: 80, price: 25 }), // fails maxPrice
    item({ appid: 4, cut: 30, price: 25 }), // fails both
  ];
  const filters = { ...DEFAULT_FILTERS, minDiscount: 50, maxPrice: 20 };
  const result = applyFilters(items, filters);
  assert.deepEqual(
    result.map((i) => i.appid),
    [1],
  );
});

test("applyFilters: minSimilarity is ignored unless includeSimilarity is passed (Recs-only)", () => {
  const items = [item({ appid: 1, similarity: 0.1 })];
  const filters = { ...DEFAULT_FILTERS, minSimilarity: 90 };
  assert.equal(applyFilters(items, filters).length, 1); // ignored for e.g. Deals
  assert.equal(applyFilters(items, filters, { includeSimilarity: true }).length, 0); // applied for Recs
});

test("applyFilters: quality floors are ignored unless includeQualityFloors is passed (Recs+Best-of only)", () => {
  const items = [item({ appid: 1, reviewCount: 5 })];
  const filters = { ...DEFAULT_FILTERS, minReviews: 1000 };
  assert.equal(applyFilters(items, filters).length, 1); // ignored for Deals
  assert.equal(applyFilters(items, filters, { includeQualityFloors: true }).length, 0);
});

test("applyFilters: deck + battery + tag filters combine with the discount/price base set", () => {
  const items = [
    item({ appid: 1, tagNames: ["Roguelike"], deck: { deck: 3 }, batteryFriendly: true }),
    item({ appid: 2, tagNames: ["VR"], deck: { deck: 3 }, batteryFriendly: true }), // excluded tag
    item({ appid: 3, tagNames: ["Roguelike"], deck: { deck: 1 }, batteryFriendly: true }), // fails deck
    item({ appid: 4, tagNames: ["Roguelike"], deck: { deck: 3 }, batteryFriendly: false }), // fails battery
  ];
  const filters = {
    ...DEFAULT_FILTERS,
    excludeTags: ["VR"],
    deckMode: DECK_MODE_VERIFIED,
    batteryOnly: true,
  };
  const result = applyFilters(items, filters);
  assert.deepEqual(
    result.map((i) => i.appid),
    [1],
  );
});

test("applyFilters: empty/missing items list returns []", () => {
  assert.deepEqual(applyFilters([], DEFAULT_FILTERS), []);
  assert.deepEqual(applyFilters(undefined, DEFAULT_FILTERS), []);
});
