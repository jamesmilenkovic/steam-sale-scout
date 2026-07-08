// Steam Sale Scout — deals feed logic (Increment 2).
//
// Pure, dependency-free ESM so it can be imported both by src/worker.js and
// by `node --test`, mirroring the public/weight.js seam from Increment 1.
// All HTTP/fetch/cache wiring lives in worker.js; this module only knows how
// to shape data that's already been fetched.
//
// SPEC NOTE: the increment-2 spec describes getting a deal's Steam appid by
// "parsing it from the deal's store URL". The real ITAD /deals/v2 response
// doesn't carry a store.steampowered.com URL on a deal — `deal.url` is an
// itad.link redirect. The documented way to resolve a Steam appid is a
// separate call, POST /lookup/shop/61/id/v1, batched by ITAD game id, which
// returns entries like ["app/123456"]. `parseSteamAppId` below parses THAT
// shape instead of a URL. Same purpose (a pure, testable appid extraction
// step) and same acceptance behaviour, different (correct) input shape.

/** Max ITAD game ids to fetch from /deals/v2 across all pages. */
export const DEALS_FETCH_CAP = 1000;

/** Deals-per-page requested from ITAD /deals/v2 (their documented max). */
export const DEALS_PAGE_LIMIT = 200;

/** Max ids per batch call to /games/historylow/v1 or /lookup/shop/{id}/id/v1. */
export const BATCH_SIZE = 200;

/** minCut query param bounds/default per spec. */
export const MIN_CUT_DEFAULT = 60;
export const MIN_CUT_MIN = 40;
export const MIN_CUT_MAX = 90;

// ---------------------------------------------------------------------------
// Best of Steam candidate sourcing (Increment 5.5). A dedicated pool, decoupled
// from the Deals feed above — see src/worker.js's fetchBestOfPages/
// buildBestOfPool header comment for why. Live probe (2026-07-08) found ITAD
// /deals/v2 carries no rating field and rejects `filter=rating` (400), so the
// server-side-rating tier is unavailable; `sort=rank` (ascending = most-
// popular-first) works and surfaces all-timers in the first pages. Do NOT
// switch this to `-rank` (descending) — that's a shovelware-first sort, the
// same failure mode this fix exists to avoid.
// ---------------------------------------------------------------------------

/** Popularity sort axis for the Best-of pool — ASCENDING `rank` (most popular
 * first). Never `-cut` (that's the Deals axis) and never `-rank` (shovelware). */
export const BESTOF_SORT = "rank";

/** Sourcing floor for the Best-of pool (config, not the bar filter — see
 * SPEC.md §1). Deliberately low so shallow-cut qualifiers still enter the
 * pool; the filter bar's min-discount control (§2) tightens client-side. */
export const BESTOF_MIN_CUT = 10;

/** Max ITAD game ids to fetch from /deals/v2 for the Best-of pool across all
 * pages — independent of, and much larger than, DEALS_FETCH_CAP. */
export const BESTOF_FETCH_CAP = 5000;

/** Deals-per-page requested for the Best-of pool (same as DEALS_PAGE_LIMIT). */
export const BESTOF_PAGE_LIMIT = 200;

/** Safety bound on page count when paging the Best-of pool (100 x 200/page =
 * 20,000 deals-worth of requests, well under the BESTOF_FETCH_CAP in practice
 * since paging stops once the cap is reached). */
export const BESTOF_MAX_PAGES = 100;

/**
 * A deal counts as "at its historical low" if its price is at or below the
 * recorded low plus this many cents — absorbs cent-level rounding/timing
 * noise between when the low was recorded and the current deal price.
 */
export const HISTORICAL_LOW_TOLERANCE_CENTS = 5;

/**
 * Clamp a raw (string|number|null) minCut query value into the accepted
 * 40–90 range, defaulting to 60 when missing/non-numeric.
 * @param {unknown} value
 * @returns {number}
 */
export function clampMinCut(value) {
  if (value === null || value === undefined || value === "") return MIN_CUT_DEFAULT;
  const num = Number(value);
  if (!Number.isFinite(num)) return MIN_CUT_DEFAULT;
  return Math.min(MIN_CUT_MAX, Math.max(MIN_CUT_MIN, Math.round(num)));
}

/**
 * Split an array into chunks of at most `size` (used to respect ITAD's
 * ≤200-ids-per-call batch limits).
 * @param {Array} array
 * @param {number} size
 * @returns {Array[]}
 */
export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

/**
 * Merge the `.list` arrays of one or more raw ITAD /deals/v2 page responses
 * into a single capped array. Pure pagination-assembly step.
 * @param {Array<{list?: Array}>} pages
 * @param {number} cap
 * @returns {Array}
 */
export function mergeDealPages(pages, cap = DEALS_FETCH_CAP) {
  const merged = pages.flatMap((page) => page.list || []);
  return cap ? merged.slice(0, cap) : merged;
}

/**
 * Filter raw ITAD deal items (as returned by /deals/v2, pre-normalisation)
 * down to those at or above the minimum discount percentage.
 * @param {Array<{deal?: {cut?: number}}>} rawDeals
 * @param {number} minCut
 * @returns {Array}
 */
export function filterByMinCut(rawDeals, minCut) {
  return rawDeals.filter((item) => (item.deal?.cut ?? 0) >= minCut);
}

/**
 * Extract a numeric Steam appid from a /lookup/shop/61/id/v1 result entry
 * (an array of shop-native ids like "app/123456", "sub/789", "bundle/12").
 * Returns null if no "app/" entry is present (e.g. a bundle/package-only
 * listing that can't be linked to a single Steam store page).
 * @param {string[]|undefined} shopIds
 * @returns {number|null}
 */
export function parseSteamAppId(shopIds) {
  if (!Array.isArray(shopIds)) return null;
  const appEntry = shopIds.find((s) => typeof s === "string" && s.startsWith("app/"));
  if (!appEntry) return null;
  const appid = Number(appEntry.slice("app/".length));
  return Number.isFinite(appid) ? appid : null;
}

/**
 * Normalise one raw ITAD deal item (with its already-resolved Steam appid)
 * into the shape the UI and increment 3's scorer consume.
 * @param {{id: string, title: string, deal: object}} rawItem
 * @param {number|null} appid
 * @returns {object}
 */
export function normalizeDeal(rawItem, appid) {
  const deal = rawItem.deal || {};
  return {
    itadId: rawItem.id,
    appid,
    title: rawItem.title,
    price: deal.price?.amount ?? null,
    priceCents: deal.price?.amountInt ?? null,
    regular: deal.regular?.amount ?? null,
    cut: deal.cut ?? null,
    expiry: deal.expiry ?? null,
    flag: deal.flag ?? null,
    atHistoricalLow: false,
    historicalLow: null,
    tags: [], // populated by increment 3; left empty here deliberately.
  };
}

/**
 * Apply a historical-low record (from /games/historylow/v1, `low` field) to
 * a normalised deal, flagging atHistoricalLow within the cents tolerance.
 * @param {object} deal - a normalizeDeal() result.
 * @param {{price?: {amount: number, amountInt: number}}|null|undefined} lowRecord
 * @param {number} toleranceCents
 * @returns {object} a new deal object (does not mutate the input).
 */
export function applyHistoricalLow(
  deal,
  lowRecord,
  toleranceCents = HISTORICAL_LOW_TOLERANCE_CENTS,
) {
  if (!lowRecord || !lowRecord.price || deal.priceCents == null) {
    return { ...deal, atHistoricalLow: false, historicalLow: null };
  }
  const atHistoricalLow = deal.priceCents <= lowRecord.price.amountInt + toleranceCents;
  return { ...deal, atHistoricalLow, historicalLow: lowRecord.price.amount };
}

/**
 * Build the set of owned Steam appids from a trimmed library games array
 * (the same shape /api/library returns).
 * @param {Array<{appid: number}>} games
 * @returns {Set<number>}
 */
export function buildOwnedAppIdSet(games) {
  return new Set((games || []).map((g) => g.appid));
}

/**
 * Drop deals whose appid is in the owned set.
 * @param {Array<{appid: number|null}>} deals
 * @param {Set<number>} ownedAppIds
 * @returns {Array}
 */
export function excludeOwned(deals, ownedAppIds) {
  return deals.filter((d) => !ownedAppIds.has(d.appid));
}
