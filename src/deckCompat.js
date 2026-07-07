// Steam Sale Scout — Steam Deck compatibility signals (Increment 5).
//
// Pure classification/parsing helpers plus the batched
// IStoreBrowseService/GetItems fetch + KV cache, mirroring src/spyQueue.js's
// split between pure logic and fetch/cache wiring so both halves are
// importable by src/worker.js and by `node --test`. Lives in its own module
// for the same load-bearing reason as spyQueue.js: src/worker.js is
// wrangler's `main` entry module, and workerd treats every named export of
// the main module as a potential handler — see spyQueue.js's header comment.
//
// LIVE-VERIFIED SHAPE (2026-07-07): the spec guessed a Deck/Machine/Frame
// split (`steam_machine_compat_category`); the real GetItems response
// carries Deck/OS/Frame instead — there is NO `steam_machine_compat_category`
// field. Confirmed live against
// https://api.steampowered.com/IStoreBrowseService/GetItems/v1/ (anonymous,
// no key) with `input_json={"ids":[{"appid":N},...],"context":{"language":
// "english","country_code":"AU","steam_realm":1},"data_request":
// {"include_platforms":true}}`. Each of steam_deck_compat_category /
// steam_os_compat_category / steam_frame_compat_category is an int 0-3 (0
// Unknown, 1 Unsupported, 2 Playable, 3 Verified), read from
// `response.store_items[i].platforms.*`.
//
// Because GetItems already carries deck compat directly, the spec's
// fallback (`saleaction/ajaxgetdeckappcompatibilityreport`) is NOT wired up
// live — see deckCompatFromLegacyReport() below, kept as a documented but
// unused helper in case GetItems ever stops carrying platforms data.

const GETITEMS_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";

/** Deck/OS/Frame compat data is near-static — cache a successful lookup for
 * 30 days, mirroring spyQueue.js's TAG_CACHE_TTL_SECONDS. */
export const DECK_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A network error or non-2xx GetItems response gets only a short retry
 * window, mirroring spyQueue.js's TAG_CACHE_ERROR_TTL_SECONDS rationale. */
export const DECK_CACHE_ERROR_TTL_SECONDS = 60 * 60;

/** Max appids per GetItems call, chunked to stay comfortably under any
 * practical length limit for the JSON-in-a-query-param `input_json` payload
 * (spec says "batchable... chunk to ≤100 to be safe"). */
export const DECK_BATCH_SIZE = 100;

/** Default per-device compat shape for an appid GetItems has nothing for
 * (unlisted, delisted, or upstream error) — 0 (Unknown) on every device. */
export const DEFAULT_DECK_COMPAT = Object.freeze({ deck: 0, os: 0, frame: 0 });

function deckCacheKey(appid) {
  return `deck:${appid}`;
}

async function getCachedDeckCompat(env, appid) {
  const raw = await env.TAG_CACHE.get(deckCacheKey(appid));
  if (raw == null) return { cached: false, data: undefined };
  return { cached: true, data: JSON.parse(raw) };
}

async function setCachedDeckCompat(env, appid, data, ttlSeconds) {
  await env.TAG_CACHE.put(deckCacheKey(appid), JSON.stringify(data), {
    expirationTtl: ttlSeconds,
  });
}

/**
 * Parse one GetItems `store_items[]` entry's platform compat fields into the
 * per-device shape the rest of the app uses. Missing fields (a field Steam
 * hasn't populated for this app, or an item with no `platforms` at all)
 * default to 0 (Unknown) rather than throwing.
 * @param {{platforms?: {steam_deck_compat_category?: number, steam_os_compat_category?: number, steam_frame_compat_category?: number}}} storeItem
 * @returns {{deck: number, os: number, frame: number}}
 */
export function parseDeckCompat(storeItem) {
  const platforms = storeItem?.platforms || {};
  return {
    deck: platforms.steam_deck_compat_category ?? 0,
    os: platforms.steam_os_compat_category ?? 0,
    frame: platforms.steam_frame_compat_category ?? 0,
  };
}

/**
 * Map a Deck compat category (0-3) to the badge the UI shows. Only Verified
 * and Playable get a badge — Unknown/Unsupported show nothing, per spec §2.
 * @param {number} deckCategory
 * @returns {"verified"|"playable"|null}
 */
export function deckBadge(deckCategory) {
  if (deckCategory === 3) return "verified";
  if (deckCategory === 2) return "playable";
  return null;
}

/**
 * Documented-but-unused fallback parser for the legacy per-app
 * `saleaction/ajaxgetdeckappcompatibilityreport?nAppID=` endpoint named in
 * the spec, kept in case GetItems ever stops carrying platforms data (see
 * file header) — not called from resolveDeckCompat below.
 * @param {{results?: {resolved_category?: number}}} raw
 * @returns {number} deck category (0-3), defaulting to 0 (Unknown).
 */
export function deckCompatFromLegacyReport(raw) {
  return raw?.results?.resolved_category ?? 0;
}

function buildInputJson(appids) {
  return JSON.stringify({
    ids: appids.map((appid) => ({ appid })),
    context: { language: "english", country_code: "AU", steam_realm: 1 },
    data_request: { include_platforms: true },
  });
}

/** Pull an appid back out of one GetItems `store_items[]` entry. The
 * documented shape nests it as `{appid: N}`, but this defensively also
 * checks a couple of plausible alternate shapes rather than assuming one. */
function extractAppId(storeItem) {
  if (typeof storeItem?.appid === "number") return storeItem.appid;
  if (typeof storeItem?.id === "number") return storeItem.id;
  if (typeof storeItem?.id?.appid === "number") return storeItem.id.appid;
  return null;
}

async function fetchDeckCompatBatch(appids) {
  const url = new URL(GETITEMS_URL);
  url.searchParams.set("input_json", buildInputJson(appids));
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`GetItems returned ${res.status}`);
  }
  const body = await res.json();
  return body?.response?.store_items || [];
}

/**
 * Resolve Deck/OS/Frame compat for a set of candidate appids, batched
 * ≤DECK_BATCH_SIZE/call via GetItems, with a 30d per-appid KV cache (1h on
 * error). Candidates only — never called for the owned library (spec §2).
 *
 * Best-effort: an upstream failure caches DEFAULT_DECK_COMPAT for the short
 * error TTL rather than throwing, so a GetItems outage degrades to "no
 * badge" instead of taking down the whole /api/deals, /api/recs, or
 * /api/best-of response.
 * @param {object} env - needs env.TAG_CACHE (the shared KV namespace).
 * @param {number[]} appids
 * @returns {Promise<Map<number, {deck: number, os: number, frame: number}>>}
 */
export async function resolveDeckCompat(env, appids) {
  const result = new Map();
  const idsToFetch = [];

  for (const appid of appids) {
    const { cached, data } = await getCachedDeckCompat(env, appid);
    if (cached) {
      result.set(appid, data || DEFAULT_DECK_COMPAT);
    } else {
      idsToFetch.push(appid);
    }
  }

  for (let i = 0; i < idsToFetch.length; i += DECK_BATCH_SIZE) {
    const batch = idsToFetch.slice(i, i + DECK_BATCH_SIZE);
    let items = [];
    let errored = false;
    try {
      items = await fetchDeckCompatBatch(batch);
    } catch {
      errored = true;
    }

    const byAppid = new Map(items.map((item) => [extractAppId(item), item]));
    const ttl = errored ? DECK_CACHE_ERROR_TTL_SECONDS : DECK_CACHE_TTL_SECONDS;
    for (const appid of batch) {
      const storeItem = byAppid.get(appid);
      const compat = storeItem ? parseDeckCompat(storeItem) : DEFAULT_DECK_COMPAT;
      result.set(appid, compat);
      await setCachedDeckCompat(env, appid, compat, ttl);
    }
  }

  return result;
}
