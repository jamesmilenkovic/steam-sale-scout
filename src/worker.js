// Steam Sale Scout — Cloudflare Worker.
// Implements /api/library: GetOwnedGames proxy, trimmed response, 24h cache,
// ?refresh=1 bypass, clear errors. /api/deals (Increment 2): ITAD deals feed,
// filtered/enriched/owned-excluded. /api/recs (Increment 3): taste-profile
// scoring engine over the deals feed, backed by a SteamSpy tag cache (KV)
// and a strict-1req/sec background fetch queue. Non-asset requests reach
// here; static files are served from ./public. Increment 4 adds Wilson-bound
// quality + hard quality floors and IDF tag weighting to the scoring engine.

import {
  BATCH_SIZE,
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
import { scoreCandidates, cosineSimilarity } from "./score.js";
import { buildWhy } from "./why.js";
import { getCachedSpy, enqueueSpyFetch } from "./spyQueue.js";
import { resolveDeckCompat, DEFAULT_DECK_COMPAT } from "./deckCompat.js";
import { batteryFriendly } from "./battery.js";
import { buildHallOfFame } from "./hallOfFame.js";

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

/** Cache key for one ITAD game id's historical-low record. */
function historyLowCacheKey(itadId) {
  return new Request(
    `https://steam-sale-scout.cache/itad/historylow?id=${encodeURIComponent(itadId)}&country=${ITAD_COUNTRY}`,
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
 * @returns {Promise<Map<string, object|null>>} id -> raw `low` record or null
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
    const byId = new Map(raw.map((r) => [r.id, r.low || null]));

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
// ---------------------------------------------------------------------------

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
  const minCut = clampMinCut(url.searchParams.get("minCut"));
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

  let deals;
  try {
    deals = await loadDealsForRecs(env, ctx, minCut, refresh);
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
    if (url.pathname.startsWith("/api/")) {
      return jsonError("not implemented", 501);
    }
    // Fall back to the static asset handler for everything else.
    return env.ASSETS.fetch(request);
  },
};
