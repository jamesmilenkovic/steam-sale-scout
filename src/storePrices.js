// Steam Sale Scout - Australian dollar prices from Steam's own store service
// (Increment 13).
//
// WHY THIS SOURCE. Chosen by the increment's probe against the decision rule
// written before the probe ran (SPEC.md §4.2): GetItems answered with a price
// or a NAMEABLE REASON for 91.5% of a 200-row sample, the only source to clear
// the 90% bar. ITAD, even with the missing `nondeals=true` parameter restored,
// reached 78% and - the deciding property - cannot say WHY a row has no price.
// On a delisted game and one refused classification in Australia it simply
// returns nothing, which is indistinguishable from an error.
//
// It is also already wired: src/deckCompat.js has called this endpoint since
// increment 5, anonymous, no key, batched at 100, already sending
// `country_code: "AU"`. It only ever asked for `include_platforms`. This module
// asks the same endpoint for the purchase options as well.
//
// TWO TRAPS THE PROBE FOUND, BOTH LIVE-VERIFIED 2026-09-06, BOTH GUARDED HERE.
//
// 1. `best_purchase_option` IS NOT ALWAYS THE GAME. For Castle Crashers it is
//    a two-game bundle at A$ 6.40; for GTA: Vice City - The Definitive Edition
//    it is the trilogy at A$ 89.95. About 190 catalogue rows have no
//    single-game option at all. Storing either number would put a confidently
//    wrong price on the card - wrong in the way that looks right, which is why
//    James ruled the guard a build blocker (ruling 13). A price is taken ONLY
//    from an option carrying a `packageid` with `included_game_count === 1`.
//    A bundle-only row is `unknown`: the game has no price of its own.
//
// 2. A DELISTED ROW COMES BACK WITH `appid: 0`. The appid that was asked for
//    survives only in `id`. src/deckCompat.js's extractAppId reads `appid`
//    first, which is harmless there (a missing Deck badge) and NOT harmless
//    here - it would silently skip exactly the rows this fill exists to
//    classify (ruling 15). This module keys on `id`.

const GETITEMS_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";

/** Max appids per GetItems call. Same 100 src/deckCompat.js has used since
 * increment 5; the probe confirmed 100 requested returns 100, no truncation. */
export const STORE_ITEMS_BATCH_SIZE = 100;

/** The closed `price_state` vocabulary (SPEC.md §5). NULL is deliberately not
 * in it: NULL means "never checked under this method" and is the fill's
 * cursor, which is a different fact from `unknown`. */
export const PRICE_STATES = Object.freeze(["priced", "free", "delisted", "region", "unknown"]);

/** The country whose prices this app quotes, everywhere, in every lane. */
const STORE_COUNTRY = "AU";

export function buildStoreItemsInput(appids) {
  return JSON.stringify({
    ids: appids.map((appid) => ({ appid })),
    context: { language: "english", country_code: STORE_COUNTRY, steam_realm: 1 },
    data_request: { include_basic_info: true, include_all_purchase_options: true },
  });
}

/**
 * The one purchase option that is THIS GAME and not a bundle containing it.
 * See trap 1 in the header. Returns null when the game is only sold as part of
 * something else, which the caller renders as `unknown` rather than guessing.
 * @param {object} storeItem
 * @returns {object|null}
 */
export function singleGamePurchaseOption(storeItem) {
  const isSingleGame = (o) => o && o.packageid != null && o.included_game_count === 1;
  const options = Array.isArray(storeItem?.purchase_options) ? storeItem.purchase_options : [];
  const found = options.find(isSingleGame);
  if (found) return found;
  return isSingleGame(storeItem?.best_purchase_option) ? storeItem.best_purchase_option : null;
}

/** Steam sends prices as a STRING of cents. Anything unparseable is treated as
 * absent rather than as zero - a zero price would render as "$0.00" and assert
 * a game is free when we do not know that.
 *
 * AND `Number("")` IS `0`, WHICH IS THE BUG THIS COMMENT USED TO DESCRIBE
 * WITHOUT PREVENTING (increment 13 review, SEC-4 / CR-12). So do the type and
 * emptiness checks BEFORE the coercion: an empty `final_price_in_cents`, or a
 * whitespace one, or `true`, or `[]`, all coerce to a number and all used to
 * produce `priced` at `$0.00`. Only a number, or a non-empty string that is
 * entirely numeric, counts - and it must be zero or greater, because a
 * negative price is not a fact any storefront asserts.
 *
 * "ENTIRELY NUMERIC" IS LOOSER THAN IT SOUNDS, AND THE COMMENT NOW SAYS SO
 * (round-2 review, CR-20). `Number()` also accepts hex, exponent and infinity
 * spellings: `Number("0x10")` is 16 and `Number("1e3")` is 1000. That is left
 * as-is rather than tightened to a decimal regex, because the only producer is
 * Steam's `final_price_in_cents`, which is a plain digit string, and a regex
 * here would reject a future shape (a decimal point, say) as loudly as it
 * would reject a hex one - a wrong price is the failure that matters, and
 * every accepted spelling still has to be a finite number >= 0. */
function centsOf(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * One `store_items[]` entry to one row of price state. PURE - every branch is
 * a fact the response asserted, never an inference from a missing field.
 *
 * Evaluation order matters and is the order the states were ruled in:
 *   country restriction -> delisted -> free -> single-game price -> unknown
 *
 * `free` comes only from Steam's own `is_free`, never from a price of zero
 * (SPEC.md §5). `unknown` is the honest end of the list: checked, and the
 * source could not say. That is a different state from NULL, which means
 * never checked, and the count of `unknown` is this increment's honesty line.
 *
 * @param {object|undefined} storeItem
 * @returns {{state: string, price: number|null, priceCents: number|null, regular: number|null, cut: number|null, reason: string}}
 */
export function classifyStoreItem(storeItem) {
  const none = (state, reason) => ({ state, price: null, priceCents: null, regular: null, cut: null, reason });

  if (!storeItem) return none("unknown", "not returned by GetItems");
  if (storeItem.unvailable_for_country_restriction === true) return none("region", "country restriction");
  if (storeItem.success !== 1 || storeItem.visible === false) return none("delisted", `success=${storeItem.success}`);
  if (storeItem.is_free === true) return none("free", "is_free");

  const option = singleGamePurchaseOption(storeItem);
  if (!option) {
    return none(
      "unknown",
      storeItem.best_purchase_option ? "sold only as part of a bundle" : "visible, no purchase option",
    );
  }

  const finalCents = centsOf(option.final_price_in_cents);
  if (finalCents == null) return none("unknown", "purchase option carried no price");

  const originalCents = centsOf(option.original_price_in_cents);
  const cut = Number.isFinite(Number(option.discount_pct)) ? Math.round(Number(option.discount_pct)) : 0;
  return {
    state: "priced",
    price: finalCents / 100,
    priceCents: finalCents,
    // `regular` is the list price. When nothing is discounted Steam omits the
    // original, and the list price IS the final price - recording it is what
    // makes gate 9 possible, because a later no-deal refresh then has a real
    // number to leave alone instead of a NULL to write over.
    regular: (originalCents ?? finalCents) / 100,
    cut,
    reason: option.formatted_final_price || "",
  };
}

/**
 * Fetch one batch (<=100) of appids from GetItems, keyed by the appid that was
 * ASKED FOR (trap 2). Never throws.
 * @param {number[]} appids
 * @returns {Promise<{status: 'ok'|'error', itemsByAppid?: Map<number, object>}>}
 */
export async function fetchStoreItemsBatch(appids) {
  const url = new URL(GETITEMS_URL);
  url.searchParams.set("input_json", buildStoreItemsInput(appids));

  let res;
  try {
    res = await fetch(url.toString());
  } catch {
    return { status: "error" };
  }
  if (!res.ok) return { status: "error" };

  let body;
  try {
    body = await res.json();
  } catch {
    return { status: "error" };
  }

  const items = body?.response?.store_items;
  if (!Array.isArray(items)) return { status: "error" };

  const itemsByAppid = new Map();
  for (const item of items) {
    // `id` carries the requested appid even when `appid` comes back 0.
    const key = typeof item?.id === "number" ? item.id : null;
    if (key != null) itemsByAppid.set(key, item);
  }
  return { status: "ok", itemsByAppid };
}
