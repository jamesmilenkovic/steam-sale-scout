// Steam Sale Scout — filter bar predicates + persistence (Increment 5).
//
// Pure, dependency-free ESM so it can be imported both by the browser
// (public/index.html) and by `node --test`, mirroring public/weight.js's
// seam. Storage is passed in explicitly (rather than reading the global
// `localStorage`) so this stays testable under plain Node, which has no
// `localStorage` global — the browser passes the real one.
//
// FLAGGED (per SPEC.md's ambiguity list): the filter bar is applied to the
// sale tabs (Deals, Recs, Best-of) only, not Library — Library is owned
// games with no price/deal/tags in the same shape, so a discount/deck/
// battery/tag filter has nothing meaningful to act on there. Each
// predicate below is applied per-tab via applyFilters()'s
// includeSimilarity/includeQualityFloors flags, matching the spec's filter
// matrix (min discount + max price + genre/deck/battery: all sale tabs;
// min similarity: Recs only; quality floors: Recs + Best-of only).

export const FILTERS_STORAGE_KEY = "steam-sale-scout.filters";

/** How many tags to surface as quick-pick chips, ranked by how many
 * candidate-pool items carry them (the searchable tail covers the rest). */
export const TOP_TAGS_COUNT = 30;

export const DECK_MODE_ANY = "any";
export const DECK_MODE_VERIFIED = "verified";
export const DECK_MODE_VERIFIED_PLUS_PLAYABLE = "verified+playable";

export const DEFAULT_FILTERS = Object.freeze({
  minDiscount: 0,
  maxPrice: null,
  minSimilarity: 0,
  includeTags: [],
  excludeTags: [],
  minReviews: null,
  minQuality: null,
  minOwners: null,
  deckMode: DECK_MODE_ANY,
  batteryOnly: false,
});

/**
 * Load persisted filters from storage, merged over DEFAULT_FILTERS so a
 * partial/older saved shape (or nothing saved yet) still yields every field.
 * A malformed/corrupt stored value falls back to the defaults rather than
 * throwing.
 * @param {Storage} storage - e.g. the browser's `localStorage`.
 * @returns {object}
 */
export function loadFilters(storage) {
  const raw = storage.getItem(FILTERS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_FILTERS };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_FILTERS };
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

/**
 * Persist the given filters object as-is (callers should merge with
 * loadFilters()'s result first if they're only changing one field).
 * @param {object} filters
 * @param {Storage} storage
 */
export function saveFilters(filters, storage) {
  storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
}

/**
 * Reset persisted filters back to defaults and return the default object.
 * @param {Storage} storage
 * @returns {object}
 */
export function resetFilters(storage) {
  storage.removeItem(FILTERS_STORAGE_KEY);
  return { ...DEFAULT_FILTERS };
}

/**
 * The top `topN` tag names across a candidate pool, ranked by how many
 * items carry the tag (frequency of presence, not summed vote counts) —
 * per spec §1.4, "built from the tags present in the current candidate
 * pool (top ~30 by frequency)". Filtering itself acts on raw tag presence,
 * not IDF-weighted scores (that's a scoring concern, not a filtering one).
 * @param {Array<{tagNames?: string[]}>} items
 * @param {number} topN
 * @returns {string[]}
 */
export function computeTopTags(items, topN = TOP_TAGS_COUNT) {
  const freq = new Map();
  for (const item of items || []) {
    const names = item?.tagNames;
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      freq.set(name, (freq.get(name) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name]) => name);
}

/**
 * Every distinct tag name across a candidate pool, sorted alphabetically —
 * backs the filter bar's searchable tail (spec §1.4: "searchable for the
 * tail" beyond the top-~30 quick-pick chips from computeTopTags above).
 * @param {Array<{tagNames?: string[]}>} items
 * @returns {string[]}
 */
export function computeAllTagNames(items) {
  const names = new Set();
  for (const item of items || []) {
    if (!Array.isArray(item?.tagNames)) continue;
    for (const name of item.tagNames) names.add(name);
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Individual predicates — each takes the item + the relevant filter value(s)
// so they're independently unit-testable and combinable.
// ---------------------------------------------------------------------------

/** Owned rows (FPM only, Increment 7.6 — `item.owned === true`) carry no
 * cut at all, so the discount bar exempts them rather than always failing
 * them at any minDiscount > 0. No other tab's items ever set `owned`, so
 * this is a no-op everywhere except FPM. */
export function passesMinDiscount(item, minDiscount) {
  if (item.owned) return true;
  return (item.cut ?? 0) >= (minDiscount || 0);
}

export function passesMaxPrice(item, maxPrice) {
  if (maxPrice == null) return true;
  if (item.price == null) return true; // can't evaluate a missing price — don't punish it
  return item.price <= maxPrice;
}

/** minSimilarity is a 0-100 percentage; item.similarity is the raw 0-1
 * cosine value the engine computes. Recs-only per spec §1.3. */
export function passesMinSimilarity(item, minSimilarity) {
  if (!minSimilarity) return true;
  return (item.similarity ?? 0) * 100 >= minSimilarity;
}

export function passesTagFilters(item, includeTags, excludeTags) {
  const names = Array.isArray(item.tagNames) ? item.tagNames : [];
  if (includeTags && includeTags.length > 0 && !includeTags.some((t) => names.includes(t))) {
    return false;
  }
  if (excludeTags && excludeTags.length > 0 && excludeTags.some((t) => names.includes(t))) {
    return false;
  }
  return true;
}

/** Quality floors (min reviews/quality/owners) — advanced, user-facing
 * versions of src/score.js's MIN_REVIEWS/MIN_QUALITY/MIN_OWNERS. `null`
 * means "no user override", i.e. defer to whatever the engine already did
 * server-side. Recs + Best-of only per spec §1.5. */
export function passesQualityFloors(item, minReviews, minQuality, minOwners) {
  if (minReviews != null && (item.reviewCount ?? 0) < minReviews) return false;
  if (minQuality != null && (item.quality ?? 0) < minQuality) return false;
  if (minOwners != null && (item.owners ?? 0) < minOwners) return false;
  return true;
}

/** deckMode: "any" (no filter), "verified" (deck===3 only), or
 * "verified+playable" (deck===2 or 3). All tabs per spec §1.6 (see the
 * file-header FLAGGED note re: Library being excluded from the bar
 * entirely, not from this predicate's own logic). */
export function passesDeckFilter(item, deckMode) {
  if (!deckMode || deckMode === DECK_MODE_ANY) return true;
  const deckCategory = item.deck?.deck ?? 0;
  if (deckMode === DECK_MODE_VERIFIED) return deckCategory === 3;
  if (deckMode === DECK_MODE_VERIFIED_PLUS_PLAYABLE) return deckCategory === 2 || deckCategory === 3;
  return true;
}

export function passesBatteryFilter(item, batteryOnly) {
  if (!batteryOnly) return true;
  return Boolean(item.batteryFriendly);
}

/**
 * Apply the full combinable filter set to a list of items for one tab.
 * `includeSimilarity`/`includeQualityFloors` gate the two filters that only
 * apply to some tabs (see spec §1 matrix / file header).
 * @param {Array<object>} items
 * @param {object} filters - a loadFilters()-shaped object.
 * @param {{includeSimilarity?: boolean, includeQualityFloors?: boolean}} [options]
 * @returns {Array<object>}
 */
export function applyFilters(items, filters, { includeSimilarity = false, includeQualityFloors = false } = {}) {
  return (items || []).filter((item) => {
    if (!passesMinDiscount(item, filters.minDiscount)) return false;
    if (!passesMaxPrice(item, filters.maxPrice)) return false;
    if (includeSimilarity && !passesMinSimilarity(item, filters.minSimilarity)) return false;
    if (!passesTagFilters(item, filters.includeTags, filters.excludeTags)) return false;
    if (
      includeQualityFloors &&
      !passesQualityFloors(item, filters.minReviews, filters.minQuality, filters.minOwners)
    ) {
      return false;
    }
    if (!passesDeckFilter(item, filters.deckMode)) return false;
    if (!passesBatteryFilter(item, filters.batteryOnly)) return false;
    return true;
  });
}
