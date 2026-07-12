// Steam Sale Scout — Cloudflare Worker.
// Implements /api/library: GetOwnedGames proxy, trimmed response, 24h cache,
// ?refresh=1 bypass, clear errors. /api/deals (Increment 2): ITAD deals feed,
// filtered/enriched/owned-excluded. /api/recs (Increment 3): taste-profile
// scoring engine over the deals feed, backed by a SteamSpy tag cache (KV)
// and a strict-1req/sec background fetch queue. Non-asset requests reach
// here; static files are served from ./public. Increment 4 adds Wilson-bound
// quality + hard quality floors and IDF tag weighting to the scoring engine.
// Increment 6 adds /api/wishlist: a fail-soft lane over James's own Steam
// wishlist, resolved to current Steam prices/cuts + historical lows and
// ranked by explicit intent rather than taste similarity.

import {
  BATCH_SIZE,
  BESTOF_FETCH_CAP,
  BESTOF_MAX_PAGES,
  BESTOF_MIN_CUT,
  BESTOF_PAGE_LIMIT,
  BESTOF_SORT,
  DEALS_FETCH_CAP,
  DEALS_PAGE_LIMIT,
  applyHistoricalLow,
  buildOwnedAppIdSet,
  chunk,
  clampMinCut,
  excludeOwned,
  filterByMinCut,
  mergeDealPages,
  normalizeDeal,
  parseSteamAppId,
} from "./deals.js";
import { TOP_OWNED_GAMES, buildProfile, selectTopOwnedGames, computeIdf, buildTagVector, applyIdf } from "./profile.js";
import { scoreCandidates, cosineSimilarity, quality } from "./score.js";
import { buildWhy } from "./why.js";
import { getCachedSpy, enqueueSpyFetch } from "./spyQueue.js";
import { resolveDeckCompat, DEFAULT_DECK_COMPAT } from "./deckCompat.js";
import { batteryFriendly } from "./battery.js";
import { buildHallOfFame, qualifiesForHof } from "./hallOfFame.js";
import {
  fetchWishlist,
  parseWishlist,
  qualifiesForWishlistLane,
  sortWishlistLane,
  wishlistWhyLine,
} from "./wishlist.js";
import {
  FPM_POOL_CAP,
  FPM_LENGTH_FIELD,
  hltbInit,
  hltbLengthSeconds,
  getCachedHltb,
  enqueueHltbFetch,
  fpmScore,
  funPerHourDisplay,
  qualifiesForFpm,
  sortFpmLane,
  fpmWhyLine,
} from "./hltb.js";

const STEAM_API_URL =
  "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
const CACHE_TTL_SECONDS = 24 * 60 * 60;

const ITAD_API_BASE = "https://api.isthereanydeal.com";
const ITAD_SHOP_ID_STEAM = 61;
const ITAD_COUNTRY = "AU";
const DEALS_CACHE_TTL_SECONDS = 6 * 60 * 60;
const HISTORYLOW_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const APPID_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // appid mapping is effectively static

function jsonError(message, status, headers = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Build the jsonError() response for an Error thrown by the ITAD-calling
 * helpers below (each throws with a `.status`, and `.retryAfter` for 429s). */
function upstreamErrorResponse(err) {
  const headers = err.retryAfter ? { "retry-after": err.retryAfter } : {};
  return jsonError(err.message, err.status || 502, headers);
}

function trimGame(game) {
  return {
    appid: game.appid,
    name: game.name,
    img_icon_url: game.img_icon_url,
    playtime_forever: game.playtime_forever,
    playtime_2weeks: game.playtime_2weeks,
    rtime_last_played: game.rtime_last_played,
  };
}

/** Cache key for the trimmed-library response, stable per steamid and
 * independent of ?refresh= so a refresh both bypasses and repopulates it. */
function libraryCacheKey(env) {
  return new Request(
    `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}`,
  );
}

/** Fetch + trim the owned-games list from the Steam API (no caching here —
 * callers own the cache read/write). Throws an Error with a `.status` on
 * any failure, using the same messages the pre-refactor inline code used. */
async function fetchOwnedGames(env) {
  const upstreamUrl = new URL(STEAM_API_URL);
  upstreamUrl.searchParams.set("key", env.STEAM_API_KEY);
  upstreamUrl.searchParams.set("steamid", env.STEAM_ID);
  upstreamUrl.searchParams.set("include_appinfo", "1");
  upstreamUrl.searchParams.set("include_played_free_games", "1");

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString());
  } catch (err) {
    const e = new Error(`Failed to reach Steam API: ${err.message}`);
    e.status = 502;
    throw e;
  }

  if (!upstreamResponse.ok) {
    const e = new Error(`Steam API returned ${upstreamResponse.status}`);
    e.status = 502;
    throw e;
  }

  let upstreamBody;
  try {
    upstreamBody = await upstreamResponse.json();
  } catch (err) {
    const e = new Error("Steam API returned an unparsable response.");
    e.status = 502;
    throw e;
  }

  const games = upstreamBody?.response?.games;
  if (!games || games.length === 0) {
    const e = new Error(
      "No games returned — profile or game-details privacy may be blocking playtime. Set them to Public in Steam privacy settings.",
    );
    e.status = 502;
    throw e;
  }

  return games.map(trimGame);
}

async function handleLibrary(request, env, ctx) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) {
    return jsonError(
      "Missing STEAM_API_KEY or STEAM_ID — set them as Worker secrets (see .dev.vars locally).",
      500,
    );
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";

  const cache = caches.default;
  const cacheKey = libraryCacheKey(env);

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let trimmed;
  try {
    trimmed = await fetchOwnedGames(env);
  } catch (err) {
    return jsonError(err.message, err.status || 502);
  }

  const responseBody = JSON.stringify({ games: trimmed });
  const response = new Response(responseBody, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

/**
 * Owned-appid set for /api/deals exclusion, reusing the same library
 * upstream/cache path as /api/library (same cache key, same 24h TTL).
 *
 * Best-effort: if STEAM_API_KEY/STEAM_ID are missing or the Steam API call
 * fails, this returns an empty set rather than failing the whole deals
 * request — a deals feed with no owned-exclusion is still useful, and a
 * library hiccup shouldn't take it down. (Assumption — spec doesn't say;
 * flagged to the PO/reviewer.)
 */
async function getOwnedAppIds(env, ctx) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) return new Set();

  const cache = caches.default;
  const cacheKey = libraryCacheKey(env);

  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      const body = await cached.clone().json();
      return buildOwnedAppIdSet(body.games);
    } catch {
      return new Set();
    }
  }

  try {
    const trimmed = await fetchOwnedGames(env);
    const response = new Response(JSON.stringify({ games: trimmed }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return buildOwnedAppIdSet(trimmed);
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// /api/deals (Increment 2)
// ---------------------------------------------------------------------------

/** Cache key for a fully-assembled /api/deals response, stable per minCut. */
function dealsCacheKey(minCut) {
  return new Request(
    `https://steam-sale-scout.cache/api/deals?minCut=${minCut}`,
  );
}

/** Cache key for one ITAD game id's resolved Steam appid (long-lived — the
 * mapping is effectively static). */
function appIdCacheKey(itadId) {
  return new Request(
    `https://steam-sale-scout.cache/itad/appid?id=${encodeURIComponent(itadId)}`,
  );
}

/** Cache key for one ITAD game id's historical-low record. Bumped to `v2`
 * (mirrors spyQueue.js's `v2:` KV-key convention) because pre-bump cached
 * entries held the OLD, buggy shape (see resolveHistoricalLows below) — the
 * version bump makes old-shape entries simply miss and get refetched under
 * the corrected shape, rather than relying on every caller passing
 * ?refresh=1. */
function historyLowCacheKey(itadId) {
  return new Request(
    `https://steam-sale-scout.cache/itad/historylow/v2?id=${encodeURIComponent(itadId)}&country=${ITAD_COUNTRY}`,
  );
}

/** Fetch + parse an ITAD API call. Throws an Error with a `.status` (and
 * `.retryAfter` for 429s) on any failure, mirroring fetchOwnedGames above. */
async function fetchItadJson(url, { method = "GET", body } = {}) {
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(url.toString(), {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const e = new Error(`Failed to reach ITAD API: ${err.message}`);
    e.status = 502;
    throw e;
  }

  if (upstreamResponse.status === 429) {
    const retryAfter = upstreamResponse.headers.get("retry-after");
    const e = new Error("ITAD API rate limit exceeded — try again shortly.");
    e.status = 429;
    if (retryAfter) e.retryAfter = retryAfter;
    throw e;
  }

  if (!upstreamResponse.ok) {
    const e = new Error(`ITAD API returned ${upstreamResponse.status}`);
    e.status = 502;
    throw e;
  }

  try {
    return await upstreamResponse.json();
  } catch (err) {
    const e = new Error("ITAD API returned an unparsable response.");
    e.status = 502;
    throw e;
  }
}

/**
 * Page through ITAD /deals/v2 (Steam shop, AUD, sorted by cut descending)
 * until exhausted, capped at DEALS_FETCH_CAP. Stops early once a page's
 * last item drops below minCut — since the upstream sort is -cut, every
 * later item would too, so there's no need to keep paginating.
 * @returns {Promise<Array<{list?: Array, hasMore?: boolean}>>} raw pages
 */
async function fetchDealsPages(env, minCut) {
  const pages = [];
  let offset = 0;

  while (offset < DEALS_FETCH_CAP) {
    const url = new URL(`${ITAD_API_BASE}/deals/v2`);
    url.searchParams.set("key", env.ITAD_API_KEY);
    url.searchParams.set("country", ITAD_COUNTRY);
    url.searchParams.set("shops", String(ITAD_SHOP_ID_STEAM));
    url.searchParams.set("sort", "-cut");
    url.searchParams.set("limit", String(DEALS_PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));

    const page = await fetchItadJson(url);
    pages.push(page);

    const list = page.list || [];
    offset += list.length;

    const lastCut = list.length ? (list[list.length - 1].deal?.cut ?? 0) : 0;
    const exhausted = page.hasMore === false || list.length < DEALS_PAGE_LIMIT;
    const belowThreshold = list.length > 0 && lastCut < minCut;
    if (exhausted || belowThreshold) break;
  }

  return pages;
}

/**
 * Resolve Steam appids for a list of ITAD game ids via
 * POST /lookup/shop/61/id/v1, batched ≤200/call, with a 7-day per-id cache.
 * @returns {Promise<Map<string, number|null>>}
 */
async function resolveAppIds(env, ctx, itadIds, refresh) {
  const cache = caches.default;
  const result = new Map();
  const idsToFetch = [];

  for (const id of itadIds) {
    const cached = refresh ? undefined : await cache.match(appIdCacheKey(id));
    if (cached) {
      const body = await cached.json();
      result.set(id, body.appid);
    } else {
      idsToFetch.push(id);
    }
  }

  for (const batch of chunk(idsToFetch, BATCH_SIZE)) {
    const url = new URL(
      `${ITAD_API_BASE}/lookup/shop/${ITAD_SHOP_ID_STEAM}/id/v1`,
    );
    url.searchParams.set("key", env.ITAD_API_KEY);
    const raw = (await fetchItadJson(url, { method: "POST", body: batch })) || {};

    for (const id of batch) {
      const appid = parseSteamAppId(raw[id]);
      result.set(id, appid);
      const cacheResponse = new Response(JSON.stringify({ appid }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${APPID_CACHE_TTL_SECONDS}`,
        },
      });
      ctx.waitUntil(cache.put(appIdCacheKey(id), cacheResponse));
    }
  }

  return result;
}

/**
 * Resolve historical-low records for a list of ITAD game ids via
 * POST /games/historylow/v1, batched ≤200/call, with a 7-day per-id cache.
 *
 * SHAPE FIX (verified live 2026-07-10): /games/historylow/v1 returns
 * `low = {shop, price: {amount, amountInt}, regular, cut, timestamp}` — the
 * comparable price is nested at `low.price`, not `low` itself. Every call
 * site (buildDealsFeed, buildBestOfPool, buildWishlistCandidates) wraps this
 * map's value as `{ price: low }` before handing it to src/deals.js's
 * applyHistoricalLow(), which reads `lowRecord.price.amountInt`. Storing the
 * whole `r.low` object here (the old, buggy behaviour) made that read
 * `r.low.amountInt` — always undefined — so `atHistoricalLow` never fired in
 * production. Storing `r.low.price` (the `{amount, amountInt}` sub-object)
 * instead makes `lowRecord.price` resolve to exactly what applyHistoricalLow
 * expects, with no changes needed at any call site.
 * @returns {Promise<Map<string, {amount: number, amountInt: number}|null>>} id -> `low.price` sub-object or null
 */
async function resolveHistoricalLows(env, ctx, itadIds, refresh) {
  const cache = caches.default;
  const result = new Map();
  const idsToFetch = [];

  for (const id of itadIds) {
    const cached = refresh ? undefined : await cache.match(historyLowCacheKey(id));
    if (cached) {
      const body = await cached.json();
      result.set(id, body.low);
    } else {
      idsToFetch.push(id);
    }
  }

  for (const batch of chunk(idsToFetch, BATCH_SIZE)) {
    const url = new URL(`${ITAD_API_BASE}/games/historylow/v1`);
    url.searchParams.set("key", env.ITAD_API_KEY);
    url.searchParams.set("country", ITAD_COUNTRY);
    const raw = (await fetchItadJson(url, { method: "POST", body: batch })) || [];
    const byId = new Map(raw.map((r) => [r.id, r.low?.price || null]));

    for (const id of batch) {
      const low = byId.get(id) ?? null;
      result.set(id, low);
      const cacheResponse = new Response(JSON.stringify({ low }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${HISTORYLOW_CACHE_TTL_SECONDS}`,
        },
      });
      ctx.waitUntil(cache.put(historyLowCacheKey(id), cacheResponse));
    }
  }

  return result;
}

/** Assemble the post-exclusion deals array: fetch -> filter -> enrich
 * (appid, historical low) -> exclude owned. */
async function buildDealsFeed(env, ctx, minCut, refresh) {
  const pages = await fetchDealsPages(env, minCut);
  const merged = mergeDealPages(pages, DEALS_FETCH_CAP);
  const filtered = filterByMinCut(merged, minCut);

  const itadIds = filtered.map((item) => item.id);
  const appIdMap = await resolveAppIds(env, ctx, itadIds, refresh);
  const lowMap = await resolveHistoricalLows(env, ctx, itadIds, refresh);

  const deals = filtered.map((item) => {
    const deal = normalizeDeal(item, appIdMap.get(item.id) ?? null);
    const low = lowMap.get(item.id);
    return applyHistoricalLow(deal, low ? { price: low } : null);
  });

  const ownedAppIds = await getOwnedAppIds(env, ctx);
  return excludeOwned(deals, ownedAppIds);
}

/**
 * Attach the per-deal signals the Increment 5 filter bar needs (genre/tag
 * chips, Steam Deck badge, battery-friendly badge) to an already-assembled
 * deals array. NOT baked into the 6h dealsCacheKey blob above — SteamSpy tag
 * data is fetched lazily (same partial-cache-is-fine model as /api/recs) and
 * would otherwise freeze an incomplete state into that longer-lived cache.
 *
 * ADDED FETCH SURFACE (flagged for the gate): this is the "how do we enrich
 * Deals" decision SPEC.md's ambiguity list calls out. It reuses the existing
 * SteamSpy tag cache read-only (a KV read per appid, no new network calls —
 * misses just get enqueued to the same background queue /api/recs already
 * drives) plus one new live call: resolveDeckCompat's batched GetItems fetch,
 * which is awaited inline so /api/deals always returns deck data rather than
 * "pending" for it. That fetch is itself KV-cached for 30 days, so only a
 * cold cache pays this cost.
 * @param {object} env
 * @param {object} ctx
 * @param {Array<object>} deals
 * @returns {Promise<Array<object>>}
 */
async function enrichDeals(env, ctx, deals) {
  const appids = Array.from(new Set(deals.filter((d) => d.appid != null).map((d) => d.appid)));

  const spyByAppid = new Map();
  await Promise.all(
    appids.map(async (appid) => {
      spyByAppid.set(appid, await getCachedSpy(env, appid));
    }),
  );
  const missingSpy = appids.filter((appid) => !spyByAppid.get(appid).cached);
  if (missingSpy.length > 0) enqueueSpyFetch(env, ctx, missingSpy);

  const deckByAppid = await resolveDeckCompat(env, appids);

  return deals.map((deal) => {
    if (deal.appid == null) {
      return { ...deal, tagNames: [], batteryFriendly: false, deck: DEFAULT_DECK_COMPAT };
    }
    const spyEntry = spyByAppid.get(deal.appid);
    const tags = spyEntry?.cached ? spyEntry.data?.tags || {} : {};
    return {
      ...deal,
      tagNames: Object.keys(tags),
      batteryFriendly: batteryFriendly(tags),
      deck: deckByAppid.get(deal.appid) || DEFAULT_DECK_COMPAT,
    };
  });
}

async function handleDeals(request, env, ctx) {
  if (!env.ITAD_API_KEY) {
    return jsonError(
      "Missing ITAD_API_KEY — set it as a Worker secret (see .dev.vars locally).",
      500,
    );
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const minCut = clampMinCut(url.searchParams.get("minCut"));

  const cache = caches.default;
  const cacheKey = dealsCacheKey(minCut);

  let deals;
  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.clone().json();
      deals = body.deals;
    }
  }

  if (!deals) {
    try {
      deals = await buildDealsFeed(env, ctx, minCut, refresh);
    } catch (err) {
      return upstreamErrorResponse(err);
    }

    const response = new Response(JSON.stringify({ deals, minCut }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${DEALS_CACHE_TTL_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  const enriched = await enrichDeals(env, ctx, deals);

  return new Response(JSON.stringify({ deals: enriched, minCut }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${DEALS_CACHE_TTL_SECONDS}`,
    },
  });
}

// ---------------------------------------------------------------------------
// /api/recs (Increment 3)
// ---------------------------------------------------------------------------

/** Load the trimmed library for /api/recs, reusing /api/library's cache key
 * and TTL. Throws (with `.status`) on upstream failure — recs must refuse to
 * run rather than risk recommending an owned game it couldn't exclude. */
async function loadLibraryForRecs(env, ctx, refresh) {
  const cache = caches.default;
  const cacheKey = libraryCacheKey(env);

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.clone().json();
      return body.games;
    }
  }

  const trimmed = await fetchOwnedGames(env);
  const response = new Response(JSON.stringify({ games: trimmed }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  // Await (not waitUntil) so the library is in cache before loadDealsForRecs ->
  // buildDealsFeed -> getOwnedAppIds reads the same key below; otherwise a
  // cold-cold cache re-fetches the Steam library a second time for exclusion.
  await cache.put(cacheKey, response.clone());
  return trimmed;
}

/** Load the assembled deals feed for /api/recs, reusing /api/deals' own
 * cache key/TTL for the given minCut so the two routes share one fetch. */
async function loadDealsForRecs(env, ctx, minCut, refresh) {
  const cache = caches.default;
  const cacheKey = dealsCacheKey(minCut);

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.clone().json();
      return body.deals;
    }
  }

  const deals = await buildDealsFeed(env, ctx, minCut, refresh);
  const response = new Response(JSON.stringify({ deals, minCut }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${DEALS_CACHE_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return deals;
}

/**
 * Build the shared candidate pool both /api/recs (scoreCandidates) and
 * /api/best-of (buildHallOfFame) rank over: the taste profile, its IDF map,
 * and every deal candidate with whatever SteamSpy tag/review/owners data is
 * currently cached attached (pending candidates held back, same as before
 * Increment 5's split into this helper). Extracted out of handleRecs
 * unchanged in behaviour — Increment 5 needs the SAME pool for two
 * different rankings (taste-similarity vs. taste-agnostic Hall of Fame)
 * rather than two independent, divergent tag-fetch passes.
 * @param {object} env
 * @param {object} ctx
 * @param {Array<object>} libraryGames
 * @param {Array<object>} deals
 * @param {number} windowMonths
 * @returns {Promise<{candidates: Array<object>, profile: object, contributions: Array<object>, idfMap: object, pendingCount: number, fetched: number, total: number, ready: boolean}>}
 */
async function buildCandidatePool(env, ctx, libraryGames, deals, windowMonths) {
  const now = Date.now();
  const ownedAppids = selectTopOwnedGames(libraryGames, windowMonths, now, TOP_OWNED_GAMES).map(
    (g) => g.appid,
  );
  const dealAppids = deals.filter((d) => d.appid != null).map((d) => d.appid);
  const neededAppids = Array.from(new Set([...ownedAppids, ...dealAppids]));

  const tagByAppid = new Map();
  await Promise.all(
    neededAppids.map(async (appid) => {
      tagByAppid.set(appid, await getCachedSpy(env, appid));
    }),
  );

  const missing = neededAppids.filter((appid) => !tagByAppid.get(appid).cached);
  if (missing.length > 0) enqueueSpyFetch(env, ctx, missing);

  const spyDataByAppid = new Map(
    neededAppids.map((appid) => {
      const entry = tagByAppid.get(appid);
      return [appid, entry.cached ? entry.data : undefined];
    }),
  );

  // IDF corpus (Increment 4): the raw SteamSpy tag sets of every appid in
  // play (top-200 owned + deal candidates) that's actually been fetched and
  // has usable tags — pending/tagless entries contribute nothing to
  // document frequency. Recomputed fresh each request; cheap, it's just a
  // count over already-cached data.
  // ASSUMPTION (flagged for the gate): document frequency is counted over the
  // RAW tag sets, not the post-stoplist/top-15 buildTagVector output. This is
  // the more literal reading of "cached tag sets"; idf values are then only
  // ever consulted for tags that survive into a vector, so the broader corpus
  // scope is harmless. Revisit at the Phase-1 gate if generic tags don't
  // collapse toward zero weight as expected.
  const corpusTagSets = neededAppids.map((appid) => spyDataByAppid.get(appid)?.tags).filter(Boolean);
  const idfMap = computeIdf(corpusTagSets);

  const { profile, contributions } = buildProfile(libraryGames, spyDataByAppid, windowMonths, now, idfMap);

  // Split "not yet fetched" (pendingCount) from "fetched but permanently
  // tagless / null-appid" (excludedCount, computed inside scoreCandidates —
  // it only sees cache state, not fetch status). Pending deals are held
  // back from scoring entirely so they don't inflate excludedCount.
  let pendingCount = 0;
  const candidates = [];
  for (const deal of deals) {
    if (deal.appid != null && !tagByAppid.get(deal.appid).cached) {
      pendingCount++;
      continue;
    }
    const spy = deal.appid != null ? spyDataByAppid.get(deal.appid) : undefined;
    candidates.push({
      ...deal,
      tags: spy?.tags || {},
      reviews: spy?.reviews || {},
      owners: spy?.owners ?? 0,
    });
  }

  const fetched = neededAppids.length - missing.length;

  return {
    candidates,
    profile,
    contributions,
    idfMap,
    pendingCount,
    fetched,
    total: neededAppids.length,
    ready: fetched >= neededAppids.length,
  };
}

async function handleRecs(request, env, ctx) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) {
    return jsonError(
      "Recommendations need your Steam library to exclude owned games — missing STEAM_API_KEY or STEAM_ID (see .dev.vars locally). Refusing to run rather than risk recommending something you already own.",
      500,
    );
  }
  if (!env.ITAD_API_KEY) {
    return jsonError(
      "Missing ITAD_API_KEY — recs are computed over the deals feed, which needs it (see .dev.vars locally).",
      500,
    );
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const minCut = clampMinCut(url.searchParams.get("minCut"));
  const windowMonthsParam = Number(url.searchParams.get("windowMonths"));
  const windowMonths = windowMonthsParam > 0 ? windowMonthsParam : 12;

  let libraryGames;
  try {
    libraryGames = await loadLibraryForRecs(env, ctx, refresh);
  } catch (err) {
    return jsonError(
      `Recommendations need your Steam library to exclude owned games, but the Steam fetch failed (${err.message}). Refusing to run rather than risk recommending something you already own.`,
      err.status || 502,
    );
  }

  let deals;
  try {
    deals = await loadDealsForRecs(env, ctx, minCut, refresh);
  } catch (err) {
    return upstreamErrorResponse(err);
  }

  const pool = await buildCandidatePool(env, ctx, libraryGames, deals, windowMonths);

  const {
    recs: scoredRecs,
    excludedCount,
    qualityExcludedCount,
  } = scoreCandidates(pool.profile, pool.candidates, pool.idfMap);

  // Deck compat (Increment 5): only for the appids that actually made it
  // into recs, not the whole candidate pool — cheaper, and matches spec §2
  // ("batch-fetch for candidates only").
  const recAppids = scoredRecs.filter((rec) => rec.appid != null).map((rec) => rec.appid);
  const deckByAppid = await resolveDeckCompat(env, recAppids);

  const recs = scoredRecs.map((rec) => {
    const why = buildWhy(pool.profile, rec.tagVector, pool.contributions);
    const { tags, tagVector, reviews, owners, ...rest } = rec;
    const totalReviews = (reviews?.positive || 0) + (reviews?.negative || 0);
    const reviewPercent = totalReviews > 0 ? Math.round((reviews.positive / totalReviews) * 100) : null;
    return {
      ...rest,
      why,
      reviewPercent,
      reviewCount: totalReviews,
      owners,
      tagNames: Object.keys(tags || {}),
      batteryFriendly: batteryFriendly(tags),
      deck: rec.appid != null ? deckByAppid.get(rec.appid) || DEFAULT_DECK_COMPAT : DEFAULT_DECK_COMPAT,
    };
  });

  return new Response(
    JSON.stringify({
      ready: pool.ready,
      fetched: pool.fetched,
      total: pool.total,
      pendingCount: pool.pendingCount,
      excludedCount,
      qualityExcludedCount,
      recs,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// /api/best-of (Increment 5) — "Best of Steam": taste-agnostic, unanimously
// excellent games at deep discount. Shares buildCandidatePool with /api/recs
// (same library/deals loading, same lazily-fetched SteamSpy trio) but ranks
// with src/hallOfFame.js instead of src/score.js — qualification is on
// review volume/ratio alone, never on similarity to James's taste profile.
// Similarity IS computed here too, but only as a secondary display field
// (spec §4: "show similarity % as a secondary column ... without ranking on
// it") — this reuses the same profile/idfMap buildCandidatePool already
// built, so it's the same number /api/recs would show for the same game.
//
// INCREMENT 5.5 FIX: Best-of's candidate pool used to reuse the Deals feed
// (buildDealsFeed, sorted -cut, capped at DEALS_FETCH_CAP=1000). During a
// sale that cap saturates at 92-95% off (pure shovelware), so famous
// all-timers on a real-but-shallower discount (Portal 2 at 80%, Hades at
// 75%...) never made it into the pool at all — Best-of qualified ~0 games by
// construction. fetchBestOfPages/buildBestOfPool/loadBestOfPool below are a
// dedicated sourcing path with its own sort axis, cap, and cache key; the
// Deals path above (fetchDealsPages/buildDealsFeed/loadDealsForRecs) is
// untouched and still backs /api/deals and /api/recs exactly as before.
// ---------------------------------------------------------------------------

/** Cache key for the Best-of candidate pool — its own dedicated key, entirely
 * separate from dealsCacheKey() above, so building/refreshing this pool never
 * reads or writes the Deals pool. SPEC.md's prose says "KV cache"; this
 * mirrors loadDealsForRecs's Cache-API pattern instead (own key, same 6h TTL)
 * for consistency with the rest of this file and lower risk — a distinct key
 * still keeps the two pools fully independent, which is the actual
 * requirement. Flagging the deviation here per the build note. */
function bestOfPoolCacheKey() {
  return new Request("https://steam-sale-scout.cache/api/best-of/pool");
}

/**
 * Page through ITAD /deals/v2 (Steam shop, AUD) sorted by BESTOF_SORT
 * (ascending popularity rank — most popular first), capped at
 * BESTOF_FETCH_CAP and BESTOF_MAX_PAGES. Unlike fetchDealsPages, this does
 * NOT stop early on a low-cut item: the rank order isn't cut-sorted, so a
 * shallow discount mid-page doesn't mean every later item is also shallow.
 * @returns {Promise<Array<{list?: Array, hasMore?: boolean}>>} raw pages
 */
async function fetchBestOfPages(env) {
  const pages = [];
  let offset = 0;
  let pageCount = 0;

  while (offset < BESTOF_FETCH_CAP && pageCount < BESTOF_MAX_PAGES) {
    const url = new URL(`${ITAD_API_BASE}/deals/v2`);
    url.searchParams.set("key", env.ITAD_API_KEY);
    url.searchParams.set("country", ITAD_COUNTRY);
    url.searchParams.set("shops", String(ITAD_SHOP_ID_STEAM));
    url.searchParams.set("sort", BESTOF_SORT);
    url.searchParams.set("limit", String(BESTOF_PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));

    const page = await fetchItadJson(url);
    pages.push(page);
    pageCount++;

    const list = page.list || [];
    offset += list.length;

    const exhausted = page.hasMore === false || list.length < BESTOF_PAGE_LIMIT;
    if (exhausted) break;
  }

  return pages;
}

/** Assemble the Best-of candidate pool: fetch (rank-sorted) -> merge/cap ->
 * floor at BESTOF_MIN_CUT -> enrich (appid, historical low) -> exclude owned.
 * Same deals-shaped output buildDealsFeed produces, so buildCandidatePool and
 * everything downstream (scoring, response shape) needs no changes. */
async function buildBestOfPool(env, ctx, refresh) {
  const pages = await fetchBestOfPages(env);
  const merged = mergeDealPages(pages, BESTOF_FETCH_CAP);
  const filtered = filterByMinCut(merged, BESTOF_MIN_CUT);

  const itadIds = filtered.map((item) => item.id);
  const appIdMap = await resolveAppIds(env, ctx, itadIds, refresh);
  const lowMap = await resolveHistoricalLows(env, ctx, itadIds, refresh);

  const deals = filtered.map((item) => {
    const deal = normalizeDeal(item, appIdMap.get(item.id) ?? null);
    const low = lowMap.get(item.id);
    return applyHistoricalLow(deal, low ? { price: low } : null);
  });

  const ownedAppIds = await getOwnedAppIds(env, ctx);
  return excludeOwned(deals, ownedAppIds);
}

/** Load the Best-of candidate pool, cached under its own key (6h TTL, same
 * cadence as the Deals pool). ?refresh=1 bypasses and repopulates. */
async function loadBestOfPool(env, ctx, refresh) {
  const cache = caches.default;
  const cacheKey = bestOfPoolCacheKey();

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.clone().json();
      return body.deals;
    }
  }

  const deals = await buildBestOfPool(env, ctx, refresh);
  const response = new Response(JSON.stringify({ deals }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${DEALS_CACHE_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return deals;
}

async function handleHof(request, env, ctx) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) {
    return jsonError(
      "Best of Steam needs your Steam library to exclude owned games — missing STEAM_API_KEY or STEAM_ID (see .dev.vars locally). Refusing to run rather than risk recommending something you already own.",
      500,
    );
  }
  if (!env.ITAD_API_KEY) {
    return jsonError(
      "Missing ITAD_API_KEY — Best of Steam is computed over the deals feed, which needs it (see .dev.vars locally).",
      500,
    );
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const windowMonthsParam = Number(url.searchParams.get("windowMonths"));
  const windowMonths = windowMonthsParam > 0 ? windowMonthsParam : 12;

  let libraryGames;
  try {
    libraryGames = await loadLibraryForRecs(env, ctx, refresh);
  } catch (err) {
    return jsonError(
      `Best of Steam needs your Steam library to exclude owned games, but the Steam fetch failed (${err.message}). Refusing to run rather than risk recommending something you already own.`,
      err.status || 502,
    );
  }

  // Increment 5.5: Best-of no longer shares the Deals feed (loadDealsForRecs)
  // — it sources its own pool (see loadBestOfPool above). No minCut param:
  // the pool's floor is the BESTOF_MIN_CUT config, not a query param.
  let deals;
  try {
    deals = await loadBestOfPool(env, ctx, refresh);
  } catch (err) {
    return upstreamErrorResponse(err);
  }

  const pool = await buildCandidatePool(env, ctx, libraryGames, deals, windowMonths);
  const hofCandidates = buildHallOfFame(pool.candidates);

  const hofAppids = hofCandidates.filter((c) => c.appid != null).map((c) => c.appid);
  const deckByAppid = await resolveDeckCompat(env, hofAppids);

  const hof = hofCandidates.map((candidate) => {
    const rawTagVector = buildTagVector(candidate.tags);
    const tagVector = pool.idfMap ? applyIdf(rawTagVector, pool.idfMap) : rawTagVector;
    const similarity = cosineSimilarity(pool.profile, tagVector);

    const { tags, reviews, owners, ...rest } = candidate;
    const totalReviews = (reviews?.positive || 0) + (reviews?.negative || 0);
    const reviewPercent = totalReviews > 0 ? Math.round((reviews.positive / totalReviews) * 100) : null;

    return {
      ...rest,
      similarity,
      reviewPercent,
      reviewCount: totalReviews,
      owners,
      tagNames: Object.keys(tags || {}),
      batteryFriendly: batteryFriendly(tags),
      deck: candidate.appid != null ? deckByAppid.get(candidate.appid) || DEFAULT_DECK_COMPAT : DEFAULT_DECK_COMPAT,
    };
  });

  return new Response(
    JSON.stringify({
      ready: pool.ready,
      fetched: pool.fetched,
      total: pool.total,
      pendingCount: pool.pendingCount,
      hof,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// /api/wishlist (Increment 6) — "explicit intent" lane: wishlist games on
// sale or at a historical low, top-billed above Recs. src/wishlist.js owns
// the parse/qualify/sort/why-line logic (its own repair surface, per
// SPEC.md); this section owns the fetch/cache/price-resolution wiring,
// mirroring the Deals pipeline above (fetchDealsPages/buildDealsFeed).
//
// FAIL-SOFT IS THE HEADLINE REQUIREMENT HERE: unlike every other route in
// this file, handleWishlist below never 500s or throws out — missing
// secrets, a wishlist fetch/parse failure, or a price-resolution failure all
// land on the same `{available: false}` 200 response, so a Valve/ITAD
// hiccup only hides this one lane rather than taking the app down.
// ---------------------------------------------------------------------------

const WISHLIST_RAW_CACHE_TTL_SECONDS = 24 * 60 * 60; // same cadence as /api/library
const WISHLIST_PRICES_CACHE_TTL_SECONDS = 6 * 60 * 60; // same cadence as /api/deals
const WISHLIST_TITLE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // titles are static, mirrors deckCompat's 30d
const WISHLIST_TITLE_ERROR_TTL_SECONDS = 60 * 60;
const WISHLIST_TITLE_BATCH_SIZE = 100; // mirrors deckCompat.js's DECK_BATCH_SIZE

/** GetItems is also used by src/deckCompat.js, but this fetch/cache is kept
 * deliberately separate (own URL constant, own cache key/shape) rather than
 * reusing that module's internals — the build note calls out not touching
 * resolveDeckCompat's shared cached shape, which other lanes depend on. */
const STORE_BROWSE_GETITEMS_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";

/** Cache key for the raw parsed wishlist (appid/priority/dateAdded only,
 * pre price-resolution) — its own key, 24h TTL, mirroring libraryCacheKey. */
function wishlistCacheKey(env) {
  return new Request(
    `https://steam-sale-scout.cache/api/wishlist/raw?steamid=${env.STEAM_ID}`,
  );
}

/** Cache key for the price-resolved wishlist candidates (post price/history
 * lookup, pre qualify/sort/enrich) — its own key, 6h TTL, mirroring
 * dealsCacheKey's cadence. Qualify/sort/enrich are recomputed fresh on every
 * request on top of this, same relationship enrichDeals has to dealsCacheKey
 * above (see that function's header comment for why). */
function wishlistPricesCacheKey(env) {
  return new Request(
    `https://steam-sale-scout.cache/api/wishlist/resolved?steamid=${env.STEAM_ID}`,
  );
}

/** Cache key for one Steam appid's reverse-resolved ITAD id — the mirror of
 * appIdCacheKey above (that one resolves ITAD id -> appid via
 * /lookup/shop/61/id/v1; this resolves appid -> ITAD id via
 * /lookup/id/shop/61/v1). Long-lived like appIdCacheKey — the mapping is
 * effectively static. */
function wishlistItadIdCacheKey(appid) {
  return new Request(
    `https://steam-sale-scout.cache/wishlist/itadid?appid=${appid}`,
  );
}

/** Cache key for one appid's wishlist title, sourced from GetItems `name` —
 * an isolated cache, deliberately separate from src/deckCompat.js's own
 * GetItems cache/shape (see the build note above STORE_BROWSE_GETITEMS_URL). */
function wishlistTitleCacheKey(appid) {
  return new Request(
    `https://steam-sale-scout.cache/wishlist/title?appid=${appid}`,
  );
}

/**
 * Resolve ITAD ids for a list of Steam appids via POST /lookup/id/shop/61/v1
 * (the reverse of resolveAppIds above), batched ≤200/call, with a 7-day
 * per-appid cache. Body must be the "app/<appid>" string form — ITAD returns
 * null for bare integers (verified live, see probe-findings.md).
 * @returns {Promise<Map<number, string|null>>}
 */
async function resolveWishlistItadIds(env, ctx, appids, refresh) {
  const cache = caches.default;
  const result = new Map();
  const idsToFetch = [];

  for (const appid of appids) {
    const cached = refresh ? undefined : await cache.match(wishlistItadIdCacheKey(appid));
    if (cached) {
      const body = await cached.json();
      result.set(appid, body.itadId);
    } else {
      idsToFetch.push(appid);
    }
  }

  for (const batch of chunk(idsToFetch, BATCH_SIZE)) {
    const url = new URL(`${ITAD_API_BASE}/lookup/id/shop/${ITAD_SHOP_ID_STEAM}/v1`);
    url.searchParams.set("key", env.ITAD_API_KEY);
    const body = batch.map((appid) => `app/${appid}`);
    const raw = (await fetchItadJson(url, { method: "POST", body })) || {};

    for (const appid of batch) {
      const itadId = raw[`app/${appid}`] ?? null;
      result.set(appid, itadId);
      const cacheResponse = new Response(JSON.stringify({ itadId }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${APPID_CACHE_TTL_SECONDS}`,
        },
      });
      ctx.waitUntil(cache.put(wishlistItadIdCacheKey(appid), cacheResponse));
    }
  }

  return result;
}

/**
 * Fetch current Steam price/cut for a batch of ITAD ids via
 * POST /games/prices/v2 (country=AU, shops=61). Ids with no live Steam deal
 * are OMITTED from the response (verified live) — that omission IS the "has
 * a price" filter: such wishlist games can't be priced and simply don't
 * qualify for the lane. Not cached here directly — it feeds the 6h
 * wishlistPricesCacheKey blob built around it in loadWishlistCandidates.
 * @returns {Promise<Map<string, {price: number|null, priceCents: number|null, regular: number|null, cut: number|null, expiry: string|null}>>}
 */
async function fetchWishlistPrices(env, itadIds) {
  const result = new Map();
  for (const batch of chunk(itadIds, BATCH_SIZE)) {
    if (batch.length === 0) continue;
    const url = new URL(`${ITAD_API_BASE}/games/prices/v2`);
    url.searchParams.set("key", env.ITAD_API_KEY);
    url.searchParams.set("country", ITAD_COUNTRY);
    url.searchParams.set("shops", String(ITAD_SHOP_ID_STEAM));
    const raw = (await fetchItadJson(url, { method: "POST", body: batch })) || [];

    for (const entry of raw) {
      const dealEntry = (entry.deals || []).find((d) => d.shop?.id === ITAD_SHOP_ID_STEAM);
      if (!dealEntry) continue;
      result.set(entry.id, {
        price: dealEntry.price?.amount ?? null,
        priceCents: dealEntry.price?.amountInt ?? null,
        regular: dealEntry.regular?.amount ?? null,
        cut: dealEntry.cut ?? null,
        expiry: dealEntry.expiry ?? null,
      });
    }
  }
  return result;
}

/**
 * Assemble the price-resolved wishlist candidates (before qualify/sort/
 * enrich): parsed wishlist items -> reverse ITAD id lookup -> current
 * price/cut (ids with no live Steam deal are dropped) -> historical low,
 * reusing resolveHistoricalLows + applyHistoricalLow exactly as
 * buildDealsFeed does above, so the 7-day low cache and atHistoricalLow
 * tolerance are shared/identical across lanes -> wishlist fields
 * (priority, dateAdded, why) attached.
 * @returns {Promise<Array<object>>}
 */
async function buildWishlistCandidates(env, ctx, wishlistItems, refresh) {
  const appids = wishlistItems.map((item) => item.appid);
  const itadIdByAppid = await resolveWishlistItadIds(env, ctx, appids, refresh);

  const itadIds = Array.from(
    new Set(appids.map((appid) => itadIdByAppid.get(appid)).filter((id) => id != null)),
  );
  const priceByItadId = await fetchWishlistPrices(env, itadIds);
  const pricedItadIds = itadIds.filter((id) => priceByItadId.has(id));
  const lowMap = await resolveHistoricalLows(env, ctx, pricedItadIds, refresh);

  const candidates = [];
  for (const item of wishlistItems) {
    const itadId = itadIdByAppid.get(item.appid);
    if (itadId == null) continue; // no ITAD id resolved — can't be priced

    const priced = priceByItadId.get(itadId);
    if (!priced) continue; // no live Steam deal — can't be priced, doesn't qualify

    let deal = {
      itadId,
      appid: item.appid,
      title: null, // filled in by enrichWishlist below (GetItems name)
      price: priced.price,
      priceCents: priced.priceCents,
      regular: priced.regular,
      cut: priced.cut,
      expiry: priced.expiry,
      atHistoricalLow: false,
      historicalLow: null,
    };
    const low = lowMap.get(itadId);
    deal = applyHistoricalLow(deal, low ? { price: low } : null);

    candidates.push({
      ...deal,
      priority: item.priority,
      dateAdded: item.dateAdded,
      why: wishlistWhyLine(item.dateAdded),
    });
  }
  return candidates;
}

/** Load the raw parsed wishlist, cached under its own key (24h TTL,
 * ?refresh=1 bypass), mirroring handleLibrary's cache pattern exactly. */
async function loadWishlistRaw(env, ctx, refresh) {
  const cache = caches.default;
  const cacheKey = wishlistCacheKey(env);

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.clone().json();
      return body.items;
    }
  }

  const json = await fetchWishlist(env);
  const items = parseWishlist(json);
  const response = new Response(JSON.stringify({ items }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${WISHLIST_RAW_CACHE_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return items;
}

/** Load the price-resolved wishlist candidates, cached under their own key
 * (6h TTL, ?refresh=1 bypass), mirroring loadDealsForRecs/dealsCacheKey's
 * cadence. */
async function loadWishlistCandidates(env, ctx, refresh) {
  const cache = caches.default;
  const cacheKey = wishlistPricesCacheKey(env);

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.clone().json();
      return body.candidates;
    }
  }

  const items = await loadWishlistRaw(env, ctx, refresh);
  const candidates = await buildWishlistCandidates(env, ctx, items, refresh);
  const response = new Response(JSON.stringify({ candidates }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${WISHLIST_PRICES_CACHE_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return candidates;
}

async function fetchWishlistTitlesBatch(appids) {
  const url = new URL(STORE_BROWSE_GETITEMS_URL);
  url.searchParams.set(
    "input_json",
    JSON.stringify({
      ids: appids.map((appid) => ({ appid })),
      context: { language: "english", country_code: ITAD_COUNTRY, steam_realm: 1 },
      data_request: {},
    }),
  );
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`GetItems returned ${res.status}`);
  }
  const body = await res.json();
  return body?.response?.store_items || [];
}

/**
 * Resolve wishlist titles for a set of appids via a batched GetItems call
 * (≤100/call), KV-cached 30 days (titles are static) under an isolated key —
 * see the build note above STORE_BROWSE_GETITEMS_URL for why this doesn't
 * reuse src/deckCompat.js's own cache. A cold-cache upstream error caches
 * `null` for a short 1h retry window, same rationale as spyQueue.js/
 * deckCompat.js's error TTLs; the front end renders a null title as
 * "(untitled)", same convention as Deals/Recs.
 * @returns {Promise<Map<number, string|null>>}
 */
async function resolveWishlistTitles(env, ctx, appids, refresh) {
  const cache = caches.default;
  const result = new Map();
  const idsToFetch = [];

  for (const appid of appids) {
    const cached = refresh ? undefined : await cache.match(wishlistTitleCacheKey(appid));
    if (cached) {
      const body = await cached.json();
      result.set(appid, body.title);
    } else {
      idsToFetch.push(appid);
    }
  }

  for (const batch of chunk(idsToFetch, WISHLIST_TITLE_BATCH_SIZE)) {
    let items = [];
    let errored = false;
    try {
      items = await fetchWishlistTitlesBatch(batch);
    } catch {
      errored = true;
    }

    const byAppid = new Map(items.map((item) => [item.appid, item.name]));
    const ttl = errored ? WISHLIST_TITLE_ERROR_TTL_SECONDS : WISHLIST_TITLE_CACHE_TTL_SECONDS;
    for (const appid of batch) {
      const title = byAppid.get(appid) ?? null;
      result.set(appid, title);
      const cacheResponse = new Response(JSON.stringify({ title }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttl}`,
        },
      });
      ctx.waitUntil(cache.put(wishlistTitleCacheKey(appid), cacheResponse));
    }
  }

  return result;
}

/**
 * Attach the display fields the wishlist lane needs to already-qualified/
 * sorted candidates: title (GetItems name), Steam Deck badge
 * (resolveDeckCompat, same shared pipeline the other lanes use), and
 * tagNames/batteryFriendly (SteamSpy lazy-fill, same pattern as enrichDeals
 * above). Runs only over qualifying candidates, not the whole wishlist —
 * cheaper, and matches the "candidates only" cost-minimisation convention
 * buildCandidatePool/resolveDeckCompat already use elsewhere in this file.
 * @returns {Promise<Array<object>>}
 */
async function enrichWishlist(env, ctx, candidates, refresh) {
  const appids = Array.from(new Set(candidates.map((c) => c.appid)));

  const spyByAppid = new Map();
  await Promise.all(
    appids.map(async (appid) => {
      spyByAppid.set(appid, await getCachedSpy(env, appid));
    }),
  );
  const missingSpy = appids.filter((appid) => !spyByAppid.get(appid).cached);
  if (missingSpy.length > 0) enqueueSpyFetch(env, ctx, missingSpy);

  const deckByAppid = await resolveDeckCompat(env, appids);
  const titleByAppid = await resolveWishlistTitles(env, ctx, appids, refresh);

  return candidates.map((item) => {
    const spyEntry = spyByAppid.get(item.appid);
    const tags = spyEntry?.cached ? spyEntry.data?.tags || {} : {};
    return {
      ...item,
      title: titleByAppid.get(item.appid) || null,
      tagNames: Object.keys(tags),
      batteryFriendly: batteryFriendly(tags),
      deck: deckByAppid.get(item.appid) || DEFAULT_DECK_COMPAT,
    };
  });
}

function wishlistUnavailableResponse() {
  return new Response(
    JSON.stringify({ available: false, notice: "Wishlist unavailable" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * ASSUMPTION (flagged for the gate): unlike every other route in this file,
 * missing secrets (STEAM_ID/ITAD_API_KEY) here return the SAME fail-soft 200
 * `{available: false}` shape as an upstream failure, not a 500 — the spec's
 * headline requirement for this lane is that it never breaks the rest of
 * the app, and a missing-secret 500 would be indistinguishable from any
 * other route's hard failure to the front end. The other routes' 500s are
 * deliberately left untouched.
 */
async function handleWishlist(request, env, ctx) {
  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";

  if (!env.STEAM_ID || !env.ITAD_API_KEY) {
    return wishlistUnavailableResponse();
  }

  let candidates;
  try {
    candidates = await loadWishlistCandidates(env, ctx, refresh);
  } catch {
    return wishlistUnavailableResponse();
  }

  const qualifying = candidates.filter((c) => qualifiesForWishlistLane(c));
  const sorted = sortWishlistLane(qualifying);

  let enriched;
  try {
    enriched = await enrichWishlist(env, ctx, sorted, refresh);
  } catch {
    return wishlistUnavailableResponse();
  }

  return new Response(
    JSON.stringify({ available: true, count: enriched.length, wishlist: enriched }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// /api/fpm (Increment 7) — "Fun per minute": Wilson quality ÷ HowLongToBeat
// main-story hours, for players who'd rather have a quick, excellent game
// than a long good one. Sources the top FPM_POOL_CAP entries of the SAME
// rank-sorted Best-of pool as /api/best-of (loadBestOfPool, untouched) and
// requires the SAME Hall-of-Fame quality floor (qualifiesForHof) so the
// "quality" half of the ratio is trustworthy — no new sourcing, no changes
// to that pool. Main-story length is resolved per-candidate from
// HowLongToBeat via src/hltb.js's own throttled background queue, mirroring
// src/spyQueue.js's progressive-fill pattern. src/hltb.js owns the
// HLTB handshake/parse/match (its own repair surface, documented there) —
// this section only owns the fetch/cache/pool wiring, the same split
// /api/wishlist has with src/wishlist.js.
//
// FAIL-SOFT, SOURCE LEVEL (headline requirement, same as /api/wishlist):
// missing secrets OR a failed hltbInit() handshake both return the same
// {available:false} 200 the UI treats as "hide this tab" — a HowLongToBeat
// outage or unofficial-endpoint drift must never take down the rest of the
// app. The handshake itself is only attempted when there's fresh work to
// resolve (toResolve.length > 0) — a fully-cached/warm lane is served
// straight from KV and never calls hltbInit, so it stays available even if
// HLTB is down (the UI polls this route every 2s while filling; calling
// hltbInit unconditionally would fire needless handshakes on every poll and
// let one transient blip wipe an already-resolved lane). Per-game fail-soft
// (a search/parse/match failure for one candidate) is handled inside
// src/hltb.js's queue and simply shows up here as a negative cached result
// (counted in unmatchedCount).
// ---------------------------------------------------------------------------

function fpmUnavailableResponse() {
  return new Response(
    JSON.stringify({ available: false, notice: "Fun-per-minute unavailable" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleFpm(request, env, ctx) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID || !env.ITAD_API_KEY) {
    return fpmUnavailableResponse();
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const windowMonthsParam = Number(url.searchParams.get("windowMonths"));
  const windowMonths = windowMonthsParam > 0 ? windowMonthsParam : 12;

  let libraryGames;
  try {
    libraryGames = await loadLibraryForRecs(env, ctx, refresh);
  } catch {
    return fpmUnavailableResponse();
  }

  let bestOfPool;
  try {
    bestOfPool = await loadBestOfPool(env, ctx, refresh);
  } catch {
    return fpmUnavailableResponse();
  }

  // The pool is already rank-sorted (most-popular-first) by loadBestOfPool —
  // cap here, never reorder or otherwise touch it (build note: "no changes
  // to the Best-of pool itself").
  const capped = bestOfPool.slice(0, FPM_POOL_CAP);

  const pool = await buildCandidatePool(env, ctx, libraryGames, capped, windowMonths);
  const eligible = pool.candidates.filter((c) => c.appid != null && qualifiesForHof(c));

  // ?refresh=1 bypasses the HLTB cache too (per build note) — every eligible
  // candidate is treated as unresolved and re-queued rather than reading
  // getCachedHltb at all.
  const hltbByAppid = new Map();
  const toResolve = [];
  for (const candidate of eligible) {
    if (!refresh) {
      const { cached, data } = await getCachedHltb(env, candidate.appid);
      if (cached) {
        hltbByAppid.set(candidate.appid, data);
        continue;
      }
    }
    toResolve.push({ appid: candidate.appid, title: candidate.title });
  }
  // The HLTB handshake is only performed when there's genuinely fresh work
  // to resolve — polling a warm/fully-cached lane must never touch HLTB, so
  // a transient HLTB blip can't wipe already-resolved rows (see build note
  // above the toResolve loop). A cold cache that can't reach HLTB genuinely
  // can't build the lane, so that case still fails soft to {available:false}.
  if (toResolve.length > 0) {
    let tokens;
    try {
      tokens = await hltbInit();
    } catch {
      return fpmUnavailableResponse();
    }
    enqueueHltbFetch(env, ctx, toResolve, tokens);
  }

  const total = eligible.length;
  const hltbPending = toResolve.length;
  const fetched = total - hltbPending;
  const ready = pool.ready && hltbPending === 0;

  // unmatchedCount is ONLY resolved-but-negative candidates (matchMethod
  // 'none') — the "n games had no length data" footer number. A resolved
  // match that fails the FPM_MIN_LENGTH_HOURS floor is excluded silently
  // (degenerate short entry, not "no length data").
  let unmatchedCount = 0;
  const rows = [];
  for (const candidate of eligible) {
    const record = hltbByAppid.get(candidate.appid);
    if (record === undefined) continue; // still pending resolution
    if (record === null) {
      unmatchedCount++;
      continue;
    }

    const lengthSeconds = hltbLengthSeconds(record, FPM_LENGTH_FIELD);
    const mainHours = lengthSeconds / 3600;
    if (!qualifiesForFpm({ compMain: lengthSeconds, mainHours })) continue;

    const wilsonQuality = quality(candidate.reviews?.positive, candidate.reviews?.negative);
    const funPerHour = funPerHourDisplay(wilsonQuality, mainHours);
    const qualityPercent = Math.round(wilsonQuality * 100);

    rows.push({
      ...candidate,
      fpm: fpmScore(wilsonQuality, mainHours),
      funPerHour,
      mainHours,
      matchMethod: record.matchMethod,
      quality: wilsonQuality,
      why: fpmWhyLine(qualityPercent, mainHours, funPerHour),
    });
  }

  const sorted = sortFpmLane(rows);

  // Deck compat only for candidates that actually made it into the lane —
  // cheaper, matches /api/recs's "candidates only" convention.
  const fpmAppids = sorted.map((row) => row.appid);
  const deckByAppid = await resolveDeckCompat(env, fpmAppids);

  const fpm = sorted.map((row) => {
    const { tags, reviews, owners, ...rest } = row;
    const totalReviews = (reviews?.positive || 0) + (reviews?.negative || 0);
    const reviewPercent = totalReviews > 0 ? Math.round((reviews.positive / totalReviews) * 100) : null;
    return {
      ...rest,
      reviewPercent,
      reviewCount: totalReviews,
      owners,
      tagNames: Object.keys(tags || {}),
      batteryFriendly: batteryFriendly(tags),
      deck: deckByAppid.get(rest.appid) || DEFAULT_DECK_COMPAT,
    };
  });

  return new Response(
    JSON.stringify({
      available: true,
      ready,
      fetched,
      total,
      unmatchedCount,
      count: fpm.length,
      fpm,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/library") {
      return handleLibrary(request, env, ctx);
    }
    if (url.pathname === "/api/deals") {
      return handleDeals(request, env, ctx);
    }
    if (url.pathname === "/api/recs") {
      return handleRecs(request, env, ctx);
    }
    if (url.pathname === "/api/best-of") {
      return handleHof(request, env, ctx);
    }
    if (url.pathname === "/api/wishlist") {
      return handleWishlist(request, env, ctx);
    }
    if (url.pathname === "/api/fpm") {
      return handleFpm(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError("not implemented", 501);
    }
    // Fall back to the static asset handler for everything else.
    return env.ASSETS.fetch(request);
  },
};
