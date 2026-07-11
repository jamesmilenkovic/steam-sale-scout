// Tests for src/wishlist.js — the pure wishlist-lane logic (Increment 6).
//
// Pure module, no fetch/cache stubbing needed. Fixtures are shaped from the
// live-verified IWishlistService/GetWishlist response documented at the top
// of wishlist.js (see probe-findings.md): `{ response: { items: [...] } }`,
// each item `{appid, priority, date_added}`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  WISHLIST_MIN_CUT,
  parseWishlist,
  qualifiesForWishlistLane,
  sortWishlistLane,
  wishlistWhyLine,
} from "../src/wishlist.js";

// ---------------------------------------------------------------------------
// parseWishlist — THE repair surface. Valid shape parses; any deviation from
// the documented shape throws (fail-soft trigger — worker.js's handleWishlist
// catches this and hides the lane rather than crashing).
// ---------------------------------------------------------------------------

test("parseWishlist: valid response shape parses into normalized items", () => {
  const raw = {
    response: {
      items: [
        { appid: 95400, priority: 0, date_added: 1742695036 },
        { appid: 231200, priority: 5, date_added: 1700000000 },
      ],
    },
  };
  assert.deepEqual(parseWishlist(raw), [
    { appid: 95400, priority: 0, dateAdded: 1742695036 },
    { appid: 231200, priority: 5, dateAdded: 1700000000 },
  ]);
});

test("parseWishlist: an item missing `priority` defaults to 0 rather than throwing", () => {
  const raw = { response: { items: [{ appid: 95400, date_added: 1742695036 }] } };
  assert.deepEqual(parseWishlist(raw), [{ appid: 95400, priority: 0, dateAdded: 1742695036 }]);
});

test("parseWishlist: missing `response` throws", () => {
  assert.throws(() => parseWishlist({}), /Unexpected wishlist response shape/);
});

test("parseWishlist: missing `items` throws", () => {
  assert.throws(() => parseWishlist({ response: {} }), /Unexpected wishlist response shape/);
});

test("parseWishlist: `items` present but not an array throws", () => {
  assert.throws(
    () => parseWishlist({ response: { items: { appid: 1 } } }),
    /Unexpected wishlist response shape/,
  );
});

test("parseWishlist: a renamed field (e.g. `date_added` -> `dateAdded` upstream) throws rather than silently dropping data", () => {
  assert.throws(
    () => parseWishlist({ response: { items: [{ appid: 95400, priority: 0, dateAdded: 1742695036 }] } }),
    /Unexpected wishlist item shape/,
  );
});

test("parseWishlist: an item missing `appid` throws", () => {
  assert.throws(
    () => parseWishlist({ response: { items: [{ priority: 0, date_added: 1742695036 }] } }),
    /Unexpected wishlist item shape/,
  );
});

// ---------------------------------------------------------------------------
// qualifiesForWishlistLane — cut-only / low-only / both / neither matrix.
// ---------------------------------------------------------------------------

test("qualifiesForWishlistLane: cut >= minCut, not at historical low -> qualifies", () => {
  assert.equal(qualifiesForWishlistLane({ cut: 10, atHistoricalLow: false }), true);
  assert.equal(qualifiesForWishlistLane({ cut: WISHLIST_MIN_CUT, atHistoricalLow: false }), true);
});

test("qualifiesForWishlistLane: cut below minCut, but at historical low -> qualifies", () => {
  assert.equal(qualifiesForWishlistLane({ cut: 5, atHistoricalLow: true }), true);
});

test("qualifiesForWishlistLane: cut >= minCut AND at historical low -> qualifies", () => {
  assert.equal(qualifiesForWishlistLane({ cut: 50, atHistoricalLow: true }), true);
});

test("qualifiesForWishlistLane: cut below minCut and not at historical low -> does not qualify", () => {
  assert.equal(qualifiesForWishlistLane({ cut: 5, atHistoricalLow: false }), false);
  assert.equal(qualifiesForWishlistLane({ cut: 0, atHistoricalLow: false }), false);
  assert.equal(qualifiesForWishlistLane({}), false);
});

test("qualifiesForWishlistLane: respects a custom minCut argument", () => {
  assert.equal(qualifiesForWishlistLane({ cut: 20, atHistoricalLow: false }, 25), false);
  assert.equal(qualifiesForWishlistLane({ cut: 25, atHistoricalLow: false }, 25), true);
});

// ---------------------------------------------------------------------------
// sortWishlistLane — at-low first, then cut depth desc, then priority asc.
// ---------------------------------------------------------------------------

test("sortWishlistLane: at-historical-low first, then cut depth desc, then priority asc as the final tiebreak", () => {
  const items = [
    { title: "Deep cut, not low, low priority number", cut: 80, atHistoricalLow: false, priority: 1 },
    { title: "At low, shallow cut, high priority number", cut: 10, atHistoricalLow: true, priority: 9 },
    { title: "At low, shallow cut, low priority number (tiebreak winner)", cut: 10, atHistoricalLow: true, priority: 2 },
    { title: "Not low, mid cut", cut: 40, atHistoricalLow: false, priority: 0 },
  ];

  const sorted = sortWishlistLane(items);

  assert.deepEqual(
    sorted.map((i) => i.title),
    [
      "At low, shallow cut, low priority number (tiebreak winner)",
      "At low, shallow cut, high priority number",
      "Deep cut, not low, low priority number",
      "Not low, mid cut",
    ],
  );
});

test("sortWishlistLane does not mutate the input array", () => {
  const items = [
    { cut: 10, atHistoricalLow: false, priority: 0 },
    { cut: 90, atHistoricalLow: false, priority: 1 },
  ];
  const copy = [...items];
  sortWishlistLane(items);
  assert.deepEqual(items, copy);
});

// ---------------------------------------------------------------------------
// wishlistWhyLine — deterministic formatting for a fixed unix-seconds ts.
// ---------------------------------------------------------------------------

test("wishlistWhyLine: formats a fixed unix-seconds timestamp deterministically", () => {
  // 1742695036 -> 2025-03-23T05:57:16.000Z (UTC), per the live-verified
  // probe-findings.md fixture (appid 95400).
  assert.equal(wishlistWhyLine(1742695036), "On your wishlist since 23 Mar 2025");
});

test("wishlistWhyLine: a different fixed timestamp formats correctly too", () => {
  // 1700000000 -> 2023-11-14T22:13:20.000Z (UTC).
  assert.equal(wishlistWhyLine(1700000000), "On your wishlist since 14 Nov 2023");
});
