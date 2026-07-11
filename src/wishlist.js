// Steam Sale Scout — Wishlist lane logic (Increment 6).
//
// Pure, dependency-free ESM so it can be imported both by src/worker.js and
// by `node --test`, mirroring src/deals.js's seam. All HTTP/cache wiring
// besides the GET itself lives in worker.js; this module owns parsing,
// qualification, sorting, and the "why" line — data-shaping only.
//
// ISOLATION NOTE (per SPEC.md): IWishlistService/GetWishlist has zero
// official Valve documentation and replaced an endpoint Valve killed Nov
// 2024 — it could change without notice. parseWishlist() below is THE single
// parse function/repair surface: if Valve renames or drops a field, this is
// the one place to fix. Until it's fixed, the lane fails soft (worker.js's
// handleWishlist catches the throw and hides the lane) rather than taking
// the rest of the app down with it.
//
// LIVE-VERIFIED SHAPE (2026-07-08, see probe-findings.md): GET with only a
// `steamid` param, no `key` — confirmed HTTP 200, no auth needed. Shape:
// `{ response: { items: [ {appid, priority, date_added}, ... ] } }`.
// `priority` is an int (0 = top of the list), `date_added` is unix seconds.

export const WISHLIST_URL = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/";

/** Qualification floor for the wishlist lane (config, not the bar filter —
 * see the client-side filter bar in public/index.html for that). Deliberately
 * low: explicit intent (being on the wishlist at all) beats discount depth,
 * per SPEC.md §3. */
export const WISHLIST_MIN_CUT = 10;

/**
 * Fetch the raw wishlist for env.STEAM_ID. No key required (confirmed live
 * — see file header). Throws an Error with a `.status` on any network/non-2xx
 * failure, mirroring worker.js's fetchOwnedGames/fetchItadJson.
 * @param {object} env - needs env.STEAM_ID.
 * @returns {Promise<object>} raw JSON body
 */
export async function fetchWishlist(env) {
  const url = new URL(WISHLIST_URL);
  url.searchParams.set("steamid", env.STEAM_ID);

  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    const e = new Error(`Failed to reach Steam Wishlist API: ${err.message}`);
    e.status = 502;
    throw e;
  }

  if (!res.ok) {
    const e = new Error(`Steam Wishlist API returned ${res.status}`);
    e.status = 502;
    throw e;
  }

  try {
    return await res.json();
  } catch (err) {
    const e = new Error("Steam Wishlist API returned an unparsable response.");
    e.status = 502;
    throw e;
  }
}

/**
 * Parse the raw IWishlistService/GetWishlist response into a normalized
 * items array. THE single parse function/repair surface (see file header) —
 * validates the shape defensively and throws a clear Error on anything
 * unexpected (missing `response`, missing/non-array `items`, or an item
 * missing its `appid`/`date_added`), so a Valve-side change hides the lane
 * (worker.js catches this) rather than corrupting or crashing the rest of
 * the app.
 * @param {object} json - raw GetWishlist response body.
 * @returns {Array<{appid: number, priority: number, dateAdded: number}>}
 */
export function parseWishlist(json) {
  const items = json?.response?.items;
  if (!Array.isArray(items)) {
    throw new Error("Unexpected wishlist response shape — missing response.items array.");
  }
  return items.map((item) => {
    if (typeof item?.appid !== "number" || typeof item?.date_added !== "number") {
      throw new Error("Unexpected wishlist item shape — missing appid or date_added.");
    }
    return {
      appid: item.appid,
      priority: typeof item.priority === "number" ? item.priority : 0,
      dateAdded: item.date_added,
    };
  });
}

/**
 * Pure lane-qualification predicate for one price/history-resolved wishlist
 * item. Explicit intent (wishlist membership) beats discount depth (spec
 * §3): a shallow cut still qualifies if the item is at/near its recorded
 * historical low.
 * @param {{cut?: number|null, atHistoricalLow?: boolean}} item
 * @param {number} minCut
 * @returns {boolean}
 */
export function qualifiesForWishlistLane(item, minCut = WISHLIST_MIN_CUT) {
  return (item.cut ?? 0) >= minCut || item.atHistoricalLow === true;
}

/**
 * Stable sort for the wishlist lane: at-historical-low items first, then by
 * cut depth descending, then Steam wishlist `priority` ascending (0 = top of
 * James's list) as the final tiebreak. Does not mutate the input.
 * @param {Array<{cut?: number|null, atHistoricalLow?: boolean, priority?: number}>} items
 * @returns {Array<object>}
 */
export function sortWishlistLane(items) {
  return [...items].sort((a, b) => {
    const aLow = a.atHistoricalLow === true ? 1 : 0;
    const bLow = b.atHistoricalLow === true ? 1 : 0;
    if (aLow !== bLow) return bLow - aLow;

    const cutDiff = (b.cut ?? 0) - (a.cut ?? 0);
    if (cutDiff !== 0) return cutDiff;

    return (a.priority ?? Infinity) - (b.priority ?? Infinity);
  });
}

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Deterministic "why" line for the wishlist lane: formats a unix-seconds
 * `date_added` timestamp as "On your wishlist since <D Mon YYYY>" (e.g.
 * "On your wishlist since 23 Mar 2025"). Takes the timestamp as an argument
 * rather than reading Date.now(), so it's pure and testable. Uses UTC date
 * fields so the output doesn't depend on the machine's local timezone.
 * @param {number} dateAdded - unix seconds, per GetWishlist's date_added.
 * @returns {string}
 */
export function wishlistWhyLine(dateAdded) {
  const date = new Date(dateAdded * 1000);
  const day = date.getUTCDate();
  const month = MONTH_ABBREVIATIONS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `On your wishlist since ${day} ${month} ${year}`;
}
