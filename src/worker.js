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
import { scoreCandidates, cosineSimilarity } from "./score.js";
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
  FPM_FORMULA,
  FPM_QUALITY_EXP,
  FPM_BREADTH_WEIGHT,
  fpmScore,
  funPerHourDisplay,
  qualifiesForFpm,
  sortFpmLane,
  fpmWhyLine,
} from "./hltb.js";
import {
  ensureCatalogSchema,
  getCatalogStats,
  selectMatchedCatalogRows,
  startFpmSync,
  isFpmSyncRunning,
  getLastSyncStats,
  startFpmAutoContinue,
  isFpmAutoContinueActive,
  requestFpmAutoContinueStop,
} from "./catalog.js";
import { ensureSettingsSchema, getAllSettings, putSettings } from "./settings.js";
import {
  ensureDismissalsSchema,
  listDismissals,
  getDismissedAppIdSet,
  addDismissal,
  removeDismissal,
  excludeDismissed,
} from "./dismissals.js";

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
 *
 * `refresh` (default false, added Increment 7.7) mirrors loadLibraryForRecs'
 * own `refresh` param — passing true bypasses the 24h cache read below, same
 * as every other cache-respecting loader in this file. Every PRE-EXISTING
 * call site (buildDealsFeed/buildBestOfPool/buildFpmPool) omits it and keeps
 * its exact prior behaviour (always cache-first); only handleFpm's
 * "Refresh prices/owned" button passes it through, since that's the one
 * place this increment's ?refresh=1 is supposed to reach owned status too.
 */
async function getOwnedAppIds(env, ctx, refresh = false) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) return new Set();

  const cache = caches.default;
  const cacheKey = libraryCacheKey(env);

  const cached = refresh ? undefined : await cache.match(cacheKey);
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

/**
 * Dismissed appids (Increment 8) for the server-side, app-wide exclusion
 * join — Deals/Recs/Best-of/FPM all filter these out before their own
 * ranking/caps (see each handler's excludeDismissed call site below), so a
 * dismissal actually frees a slot rather than just being hidden client-side.
 * Library and Wishlist are deliberately never called with this (PO
 * decision — see src/dismissals.js's header).
 *
 * Fail-soft like getOwnedAppIds above: a missing FPM_DB binding or a D1
 * hiccup here must never break lane rendering (the headline requirement for
 * this increment's persistence work) — it just means nothing gets excluded
 * this request, same as a cold/absent dismissals table.
 * @returns {Promise<Set<number>>}
 */
async function getDismissedAppIds(env) {
  if (!env.FPM_DB) return new Set();
  try {
    await ensureDismissalsSchema(env);
    return await getDismissedAppIdSet(env);
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

  // Increment 8: dismissal exclusion is a request-time join, never baked
  // into the 6h dealsCacheKey blob above — a dismissal must take effect in
  // the same session, not wait out the cache TTL (same reasoning as owned
  // status being joined at request time elsewhere in this file).
  //
  // AWARENESS NOTE (code review, non-blocking): this join runs AFTER
  // mergeDealPages' DEALS_FETCH_CAP=1000 truncation inside buildDealsFeed
  // above — a dismissed appid doesn't free a slot in that upstream fetch
  // cap, only in whatever's downstream of it (nothing, for Deals; there's
  // no further cap on this response). In practice DEALS_FETCH_CAP is never
  // reached at real ITAD volumes (minCut=60 typically returns well under
  // 1000 items), so this is a theoretical gap, not a live one. The exact
  // same caveat applies to handleRecs/handleHof below — they share this
  // same buildDealsFeed/buildBestOfPool cap-then-filter shape.
  const dismissedAppIds = await getDismissedAppIds(env);
  const undismissed = excludeDismissed(deals, dismissedAppIds);
  const enriched = await enrichDeals(env, ctx, undismissed);

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

  // Increment 8: dismissed appids are excluded before the candidate pool is
  // even built — same request-time-join reasoning as handleDeals above, and
  // it means a dismissed game's tag data is never even fetched, not just
  // hidden from the final list. There's no count-cap anywhere downstream of
  // this point (scoreCandidates has no top-N slice), so a dismissal here
  // always promotes the next-best-ranked candidate into recs[0] if the
  // dismissed one would have outranked it — see handleDeals' AWARENESS NOTE
  // above for the one upstream cap (DEALS_FETCH_CAP, inside
  // loadDealsForRecs) this join runs after, same as Deals.
  const dismissedAppIds = await getDismissedAppIds(env);
  deals = excludeDismissed(deals, dismissedAppIds);

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

  // Increment 8: same dismissal join as handleDeals/handleRecs — excluded
  // before the candidate pool is built, not just filtered out of the final
  // list. buildHallOfFame has no count-cap either (a qualification filter,
  // not a top-N slice), so a dismissal here always promotes the next
  // qualifying candidate into hof[0] if the dismissed one outranked it —
  // same upstream-cap caveat (BESTOF_FETCH_CAP, inside loadBestOfPool) as
  // handleDeals' AWARENESS NOTE above.
  const dismissedAppIds = await getDismissedAppIds(env);
  deals = excludeDismissed(deals, dismissedAppIds);

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
// /api/fpm (Increment 7, tuned in 7.5, given its own pool + owned games in
// 7.6, re-sourced from a catalog-wide D1 store in 7.7) — "Fun per minute":
// Wilson quality (raised to a configurable exponent) ÷ a configurable
// function of HowLongToBeat main-story hours, for players who'd rather have
// a quick, excellent game than a long good one.
//
// INCREMENT 7.7 — FPM catalog: every floor-passing Steam game, not just
// deal-pool/owned candidates. James's 7.6 eye test found Celeste missing —
// root cause (see SPEC.md): every pool in this app used to page ITAD's
// deals/v2 RANK feed, which is deal-activity popularity; a full-price,
// unowned, non-promoted evergreen title can never enter any lane at any cap.
// src/catalog.js now owns a standalone crawl of SteamSpy's bulk `all` feed
// (floor-qualified straight from the bulk fields, no per-appid SteamSpy call
// needed) persisted in D1 (env.FPM_DB) — the lane's own database, so the
// multi-run HowLongToBeat fill survives `wrangler dev` restarts instead of
// starting over. `POST /api/fpm/sync` (handleFpmSync, manual trigger, no
// cron) drives the crawl + a priority-ordered HLTB batch each run;
// `GET /api/fpm/sync/status` (handleFpmSyncStatus) reports D1-wide counts so
// the frontend can show an honest "ranked X of Y" line and stop polling once
// idle — this REPLACES the old per-request progressive-fill polling this
// route used to do itself (7.5/7.6's `ready`/`fetched`/`total` fields tracked
// ONE request's own toResolve queue; now the catalog's HLTB fill happens
// only during an explicit sync, and this route is a fast, static read).
//
// handleFpm below no longer sources or enqueues anything — it reads already-
// matched, floor-passing rows straight from D1 (selectMatchedCatalogRows)
// and scores them with the EXACT SAME formula machinery as before
// (fpmScore/FPM_FORMULA/FPM_QUALITY_EXP/FPM_BREADTH_WEIGHT, the
// ?formula=/?qexp=/?breadth= overrides) — this increment changes what feeds
// the formula, never the formula itself. Owned/deal status are ANNOTATIONS
// joined at request time (getOwnedAppIds + loadFpmPool — the exact same
// helpers/caches every other lane already uses), not sourcing decisions:
// loadFpmPool/buildFpmPool/fetchBestOfPages below are KEPT UNCHANGED but
// demoted from "the candidate source" to "a price/cut/historical-low
// lookup for whichever catalog appids happen to be in it right now".
// 7.6's ownedFpmCandidate dual-stream merge and FPM_POOL_CAP-as-candidate-cap
// are retired entirely — SPEC.md is explicit that there is NO catalog cap,
// only the quality floor bounds membership.
//
// `?owned=all|hide|only` (default `all`, bad values -> default, never a
// 500) replaces the old boolean `?owned=0|1` — it's now a pure post-hoc
// filter on the live-joined `owned` annotation, not a sourcing toggle (there
// is no separate owned candidate stream left to gate). Badge precedence:
// Owned wins over discount (an owned game's sale price is irrelevant).
//
// FAIL-SOFT (headline requirement, same as /api/wishlist): missing secrets
// OR a missing/unconfigured FPM_DB binding both return {available:false} —
// a HowLongToBeat drift or a not-yet-synced-anything-at-all catalog must
// never take down the rest of the app. Per-game fail-soft (a search/parse/
// match failure for one candidate) is handled inside src/catalog.js's
// resolveHltbBatch (during sync, not during a GET) and simply shows up here
// as a `match_method: 'none'` row (counted in unmatchedCount).
//
// SCORING OVERRIDES (Increment 7.5, unchanged): ?formula=/?qexp=/?breadth=
// re-rank already-matched D1 rows for live A/B comparison, with zero HLTB
// traffic (there is no HLTB call left in the GET path AT ALL now — only
// POST /api/fpm/sync ever talks to HowLongToBeat). Bad values never throw;
// they fall back to the hltb.js config defaults (parseFpmFormula/
// parseFpmScoreParam below, unchanged from 7.5).
//
// ENRICHMENT CAP (Coder's call, flagged for the gate): Deck-compat/SteamSpy-
// tag enrichment (for the Deck/battery/tag filter bar to work on catalog
// rows) is read straight from whatever's already cached for every returned
// row (cheap KV reads), but NEW fetches (SteamSpy queue enqueues, GetItems
// batches) are only triggered for the top FPM_ENRICH_CAP rows of the
// current sorted+filtered response — with an eventual 8-20k+ row catalog,
// eagerly enriching every row on every request would mean hundreds of
// GetItems batch calls per poll, and could starve the shared SteamSpy queue
// the Deals/Recs/Best-of lanes also depend on. Rows beyond the cap that
// aren't yet cached show as "unknown" (no badge/tags) rather than being
// excluded — same fail-soft convention every other lane already uses for a
// cold cache.
//
// APP-TYPE GATING (Increment 7.8, deliberate exception to the cold-cache
// fail-soft convention above): src/catalog.js's selectMatchedCatalogRows now
// gates on app_type = 'game' — an unclassified or non-game row is EXCLUDED
// from this lane, not shown as "unknown". This is the fix for demos/DLC
// (e.g. free promotional prologues) skewing the leaderboard; PO's explicit
// "exclude-until-classified" scoping decision (probe-findings-7.8.md). The
// row still exists in D1 either way — nothing is ever deleted, only hidden.
// ---------------------------------------------------------------------------

/** Cache key for FPM's deal-side price/cut lookup pool — entirely separate
 * from bestOfPoolCacheKey() above, so building/refreshing this pool never
 * reads or writes the Best-of pool (or vice versa). Increment 7.7: this pool
 * is no longer a candidate SOURCE (see the section comment above) — it's
 * consulted only to attach price/cut/historicalLow to whichever catalog
 * appids happen to appear in it. */
function fpmPoolCacheKey() {
  return new Request("https://steam-sale-scout.cache/api/fpm/pool");
}

/**
 * Assemble FPM's own deal-side candidate pool: fetch (same rank-sorted axis
 * as Best-of, via fetchBestOfPages — no new pagination) -> merge/cap at
 * BESTOF_FETCH_CAP -> enrich (appid, historical low) -> exclude owned (owned
 * games enter separately via ownedFpmCandidate below, so no dupes by
 * construction). Deliberately NO filterByMinCut call anywhere in this path —
 * that omission is the entire point of this pool existing separately from
 * buildBestOfPool's BESTOF_MIN_CUT floor.
 */
async function buildFpmPool(env, ctx, refresh) {
  const pages = await fetchBestOfPages(env);
  const merged = mergeDealPages(pages, BESTOF_FETCH_CAP);

  const itadIds = merged.map((item) => item.id);
  const appIdMap = await resolveAppIds(env, ctx, itadIds, refresh);
  const lowMap = await resolveHistoricalLows(env, ctx, itadIds, refresh);

  const deals = merged.map((item) => {
    const deal = normalizeDeal(item, appIdMap.get(item.id) ?? null);
    const low = lowMap.get(item.id);
    return applyHistoricalLow(deal, low ? { price: low } : null);
  });

  const ownedAppIds = await getOwnedAppIds(env, ctx);
  return excludeOwned(deals, ownedAppIds);
}

/** Load FPM's deal-side candidate pool, cached under its own key (6h TTL,
 * same cadence as the Best-of pool). ?refresh=1 bypasses and repopulates. */
async function loadFpmPool(env, ctx, refresh) {
  const cache = caches.default;
  const cacheKey = fpmPoolCacheKey();

  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.clone().json();
      return body.deals;
    }
  }

  const deals = await buildFpmPool(env, ctx, refresh);
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

/** `?owned=` tri-state (Increment 7.7): "all" (default), "hide", or "only" —
 * a pure post-hoc filter on the live-joined `owned` annotation (there is no
 * separate owned candidate stream left to gate, see the section comment
 * above). Any value other than the two recognized filter modes defaults to
 * "all" — bad values never 500, mirroring parseFpmFormula/parseFpmScoreParam. */
function parseOwnedMode(raw) {
  return raw === "hide" || raw === "only" ? raw : "all";
}

function fpmUnavailableResponse() {
  return new Response(
    JSON.stringify({ available: false, notice: "Fun-per-minute unavailable" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const FPM_VALID_FORMULAS = new Set(["linear", "sqrt", "log"]);
// Sane bounds for the ?qexp=/?breadth= overrides — generous enough for James
// to A/B freely, tight enough to keep Math.pow from producing something
// silly (Infinity/NaN-adjacent) off a garbage query value. Not asserted by
// SPEC.md as "the" right numbers, just a guardrail; flagged to the PO.
const FPM_QEXP_MIN = 0;
const FPM_QEXP_MAX = 10;
const FPM_BREADTH_MIN = 0;
const FPM_BREADTH_MAX = 5;

/** `?formula=` override: falls back to FPM_FORMULA on anything not exactly
 * 'linear'/'sqrt'/'log' (missing, typo'd, or otherwise malformed). */
function parseFpmFormula(raw) {
  return FPM_VALID_FORMULAS.has(raw) ? raw : FPM_FORMULA;
}

/** `?qexp=`/`?breadth=` override: falls back to `fallback` on missing,
 * non-numeric, or out-of-[min,max]-range input. Never throws. */
function parseFpmScoreParam(raw, fallback, min, max) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** Bound how many catalog rows trigger NEW SteamSpy-queue/GetItems fetches
 * per /api/fpm request — see the section comment's "ENRICHMENT CAP" note. */
const FPM_ENRICH_CAP = 500;

/** Read-only cache peek for one appid's Deck compat, using the exact same
 * `deck:<appid>` KV key src/deckCompat.js's resolveDeckCompat owns — used
 * (only) for catalog rows beyond FPM_ENRICH_CAP, where we want "already
 * cached data shows up" without triggering a new GetItems fetch. A small,
 * deliberate duplication of that key format rather than adding a new
 * read-only export to deckCompat.js (Coder's call, flagged for the gate). */
async function peekCachedDeckCompat(env, appid) {
  const raw = await env.TAG_CACHE.get(`deck:${appid}`);
  return raw == null ? null : JSON.parse(raw);
}

/**
 * Attach tagNames/batteryFriendly/deck to already-scored+sorted FPM rows.
 * Tags are a free read (getCachedSpy never fetches) for every row; only the
 * top FPM_ENRICH_CAP rows trigger a NEW SteamSpy-queue enqueue or GetItems
 * batch fetch for a cold appid — see the section comment above.
 */
async function enrichFpmRows(env, ctx, rows) {
  const appids = rows.map((r) => r.appid);
  const enrichTargets = appids.slice(0, FPM_ENRICH_CAP);

  const spyByAppid = new Map();
  await Promise.all(
    appids.map(async (appid) => {
      spyByAppid.set(appid, await getCachedSpy(env, appid));
    }),
  );
  const missingSpy = enrichTargets.filter((appid) => !spyByAppid.get(appid).cached);
  if (missingSpy.length > 0) enqueueSpyFetch(env, ctx, missingSpy);

  const deckByAppid = await resolveDeckCompat(env, enrichTargets);
  const restAppids = appids.slice(FPM_ENRICH_CAP);
  await Promise.all(
    restAppids.map(async (appid) => {
      const cached = await peekCachedDeckCompat(env, appid);
      if (cached) deckByAppid.set(appid, cached);
    }),
  );

  return rows.map((row) => {
    const spyEntry = spyByAppid.get(row.appid);
    const tags = spyEntry?.cached ? spyEntry.data?.tags || {} : {};
    return {
      ...row,
      tagNames: Object.keys(tags),
      batteryFriendly: batteryFriendly(tags),
      deck: deckByAppid.get(row.appid) || DEFAULT_DECK_COMPAT,
    };
  });
}

async function handleFpm(request, env, ctx) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID || !env.ITAD_API_KEY || !env.FPM_DB) {
    return fpmUnavailableResponse();
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const ownedMode = parseOwnedMode(url.searchParams.get("owned"));

  // Scoring overrides (Increment 7.5, unchanged) — parsed up front, only
  // read at the final per-row score/why-line step below. There is no HLTB
  // traffic anywhere in this GET path anymore (see the section comment) —
  // these can never trigger new network activity, only re-rank already-
  // matched D1 rows.
  const formula = parseFpmFormula(url.searchParams.get("formula"));
  const qualityExp = parseFpmScoreParam(url.searchParams.get("qexp"), FPM_QUALITY_EXP, FPM_QEXP_MIN, FPM_QEXP_MAX);
  const breadthWeight = parseFpmScoreParam(url.searchParams.get("breadth"), FPM_BREADTH_WEIGHT, FPM_BREADTH_MIN, FPM_BREADTH_MAX);

  let catalogRows;
  let stats;
  try {
    await ensureCatalogSchema(env);
    stats = await getCatalogStats(env);
    catalogRows = await selectMatchedCatalogRows(env);
  } catch {
    return fpmUnavailableResponse();
  }

  // unmatchedCount mirrors pre-7.7 semantics exactly: checked-but-negative
  // rows only (match_method='none'), never "not yet checked at all".
  const rows = [];
  for (const row of catalogRows) {
    const mainHours = row.main_hours;
    // A resolved match below FPM_MIN_LENGTH_HOURS is excluded silently here
    // (same as before) — it's still "matched" in D1 (see src/catalog.js),
    // just not shown in this lane.
    if (!qualifiesForFpm({ compMain: mainHours * 3600, mainHours })) continue;

    const wilsonQuality = row.wilson;
    const funPerHour = funPerHourDisplay(wilsonQuality, mainHours);
    const qualityPercent = Math.round(wilsonQuality * 100);
    const reviewCount = (row.positive || 0) + (row.negative || 0);
    const reviewPercent = reviewCount > 0 ? Math.round((row.positive / reviewCount) * 100) : null;

    rows.push({
      appid: row.appid,
      title: row.name,
      owners: row.owners,
      reviewCount,
      reviewPercent,
      quality: wilsonQuality,
      mainHours,
      matchMethod: row.match_method,
      fpm: fpmScore(wilsonQuality, mainHours, { reviewCount, formula, qualityExp, breadthWeight }),
      funPerHour,
      why: fpmWhyLine(qualityPercent, mainHours, funPerHour, formula),
    });
  }

  // Increment 8: dismissal exclusion, applied before annotation/sort/the
  // FPM_ENRICH_CAP enrichment-fetch cap below (enrichFpmRows) — this is the
  // one lane where "frees a slot" is server-side-verifiable: a dismissed row
  // that would have ranked inside the top FPM_ENRICH_CAP now lets the
  // next-best row take its place, triggering a fresh SteamSpy/GetItems fetch
  // for it that it wouldn't otherwise have gotten this request. (There's no
  // FPM_DISPLAY_CAP here — that's a client-side-only lazy-render constant in
  // public/index.html; this route returns every matched, qualifying row.)
  const dismissedAppIds = await getDismissedAppIds(env);
  const undismissedRows = excludeDismissed(rows, dismissedAppIds);

  // Annotation joins at request time (Increment 7.7) — owned/deal status are
  // never a sourcing decision here, just a live join against the exact same
  // helpers/caches every other lane already uses. getOwnedAppIds is already
  // best-effort (never throws — empty Set on any failure); loadFpmPool is
  // now consulted purely as a price/cut/historicalLow lookup. `refresh` is
  // threaded through to BOTH (bug fix, flagged by review): the "Refresh
  // prices/owned" button's label promises fresh owned status too, not just
  // fresh deal prices — without this, ?refresh=1 silently left owned status
  // up to 24h stale despite the button claiming otherwise.
  const ownedAppIds = await getOwnedAppIds(env, ctx, refresh);
  let dealPool;
  try {
    dealPool = await loadFpmPool(env, ctx, refresh);
  } catch {
    dealPool = [];
  }
  const dealByAppid = new Map(dealPool.filter((d) => d.appid != null).map((d) => [d.appid, d]));

  let annotated = undismissedRows.map((row) => {
    const owned = ownedAppIds.has(row.appid);
    // Badge precedence: Owned wins over discount — an owned game's sale
    // price is irrelevant, so we don't even look it up in that case.
    const dealEntry = owned ? undefined : dealByAppid.get(row.appid);
    return {
      ...row,
      owned,
      price: dealEntry?.price ?? null,
      priceCents: dealEntry?.priceCents ?? null,
      regular: dealEntry?.regular ?? null,
      cut: dealEntry?.cut ?? null,
      atHistoricalLow: dealEntry?.atHistoricalLow ?? false,
      historicalLow: dealEntry?.historicalLow ?? null,
    };
  });

  if (ownedMode === "hide") annotated = annotated.filter((r) => !r.owned);
  else if (ownedMode === "only") annotated = annotated.filter((r) => r.owned);

  const sorted = sortFpmLane(annotated);
  const fpm = await enrichFpmRows(env, ctx, sorted);

  return new Response(
    JSON.stringify({
      available: true,
      ready: stats.pending === 0,
      total: stats.total,
      matched: stats.matched,
      pending: stats.pending,
      unmatchedCount: stats.unmatched,
      count: fpm.length,
      fpm,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// /api/fpm/sync + /api/fpm/sync/status (Increment 7.7) — the manual trigger
// that fills the D1 catalog. See src/catalog.js for the actual crawl/D1/
// HLTB-batch pipeline (runFpmSyncPipeline); this section only wires it up
// with the two worker.js-private helpers (getOwnedAppIds, loadFpmPool) that
// can't be imported the other way around (src/worker.js is wrangler's `main`
// module and exports nothing but `default { fetch }` — see the recurring
// gotcha this project always flags).
// ---------------------------------------------------------------------------

/** Both endpoints below fail soft the same way as the rest of this lane: a
 * missing/unconfigured FPM_DB binding never 500s, it just reports "nothing
 * to sync yet" — consistent with handleFpm's own {available:false} pattern. */
function fpmDbUnavailableResponse() {
  return new Response(JSON.stringify({ started: false, notice: "FPM_DB not configured" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Both sync-trigger routes below share the same deps builder — extracted so
 * the `?continue=1` auto-continue path (Increment 8) and the original
 * single-batch path drive the identical owned/deal loaders. */
function fpmSyncDeps(env, ctx) {
  return {
    loadOwnedAppIds: () => getOwnedAppIds(env, ctx),
    // Top-300 of the rank-sorted deal pool, mirroring the old FPM_POOL_CAP
    // candidate-cap's value — reused here purely as SPEC.md's "current
    // deal-pool floor-passers (loadFpmPool top-300)" union bound, not as a
    // candidate cap (there is no candidate cap anymore).
    loadDealAppIds: async () => {
      const pool = await loadFpmPool(env, ctx, false);
      return pool
        .filter((d) => d.appid != null)
        .slice(0, FPM_POOL_CAP)
        .map((d) => d.appid);
    },
  };
}

/**
 * `?continue=1` (Increment 8, ride-along A): drives startFpmAutoContinue
 * (repeats the same batch step until both funnels are empty) instead of a
 * single startFpmSync batch — see src/catalog.js's section comment for why
 * this needs no new pacing/backoff/give-up logic of its own. Response shape
 * is the same `{started, alreadyRunning?}` either way; the frontend tells
 * the two apart via GET /api/fpm/sync/status's `autoContinue` flag, not this
 * response.
 */
async function handleFpmSync(request, env, ctx) {
  if (!env.FPM_DB) return fpmDbUnavailableResponse();

  const url = new URL(request.url);
  const continueToCompletion = url.searchParams.get("continue") === "1";
  const deps = fpmSyncDeps(env, ctx);
  const result = continueToCompletion ? startFpmAutoContinue(env, ctx, deps) : startFpmSync(env, ctx, deps);

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** POST /api/fpm/sync/stop (Increment 8, ride-along A's stop control) — asks
 * a running auto-continue loop to stop after its current batch step
 * finishes. A no-op (not an error) if nothing is auto-continuing; same
 * fpmDbUnavailableResponse fail-soft as the other sync routes. */
async function handleFpmSyncStop(request, env, ctx) {
  // Dedicated fail-soft shape (not fpmDbUnavailableResponse's {started:false}
  // — that's the /api/fpm/sync trigger's own vocabulary, not this route's)
  // so the response body stays honest about which endpoint you're on even
  // though the frontend never reads it.
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ stopping: false, notice: "FPM_DB not configured" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  requestFpmAutoContinueStop();
  return new Response(JSON.stringify({ stopping: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleFpmSyncStatus(request, env, ctx) {
  if (!env.FPM_DB) {
    return new Response(
      JSON.stringify({
        total: 0,
        matched: 0,
        unmatched: 0,
        pending: 0,
        classified: 0,
        nonGame: 0,
        running: false,
        autoContinue: false,
        dbReady: false,
        lastRun: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  await ensureCatalogSchema(env);
  const stats = await getCatalogStats(env);
  return new Response(
    // classified/nonGame (Increment 7.8) come straight through from stats;
    // lastRun surfaces the most recent sync run's HLTB/type-classification
    // funnel counters (cacheHits/resolved/gaveUp, classified/nonGame/
    // attempted) — null until the first sync run completes. autoContinue
    // (Increment 8) lets the frontend show a Stop control and an honest
    // "auto-continuing" label without any new polling semantics — the
    // existing `running`-driven poll loop already covers the whole
    // auto-continue run, since fpmSyncRunning stays true for its entire
    // duration (see src/catalog.js's startFpmAutoContinue).
    JSON.stringify({
      ...stats,
      running: isFpmSyncRunning(),
      autoContinue: isFpmAutoContinueActive(),
      dbReady: true,
      lastRun: getLastSyncStats(),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// /api/settings (Increment 8) — persisted UI state (filter-bar values, the
// recency window, FPM-tab-local controls), replacing the old localStorage
// story so state survives a browser restart the same way the catalog does
// (PO's "no split-brain" decision). src/settings.js is a dumb key/value
// store; this section owns the fail-soft HTTP wiring, same discipline as
// every other route here — a missing FPM_DB binding or a D1 hiccup never
// breaks anything, it just means nothing was persisted/restored this time.
// ---------------------------------------------------------------------------

async function handleGetSettings(request, env, ctx) {
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ settings: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    await ensureSettingsSchema(env);
    const settings = await getAllSettings(env);
    return new Response(JSON.stringify({ settings }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ settings: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

/** Partial-update PUT (Coder's call — see the handoff notes): the body's
 * top-level keys are upserted as-is (src/settings.js's putSettings), any
 * keys not present are left untouched. The frontend's debounced auto-save
 * always sends its whole current state, so in practice this behaves like a
 * whole-blob PUT without requiring one — a future caller that only wants to
 * change one key can do that too. A malformed body (not an object) is a
 * genuine caller error (400), distinct from the fail-soft "D1 hiccup"
 * case below, which reports {saved:false} rather than breaking the caller's
 * flow (the frontend's save is already fire-and-forget/best-effort). */
async function handlePutSettings(request, env, ctx) {
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ saved: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Settings body must be a JSON object.", 400);
  }

  try {
    await ensureSettingsSchema(env);
    await putSettings(env, body);
    return new Response(JSON.stringify({ saved: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ saved: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

// ---------------------------------------------------------------------------
// /api/dismissals (Increment 8) — "Not interested", app-wide across the sale
// lanes. src/dismissals.js owns the D1 CRUD/pure exclusion helper; this
// section owns the fail-soft HTTP wiring (GET list / POST dismiss /
// DELETE :appid restore), mirroring /api/settings' discipline above. The
// actual server-side exclusion join lives in handleDeals/handleRecs/
// handleHof/handleFpm (getDismissedAppIds + excludeDismissed), not here —
// this is just the management surface.
// ---------------------------------------------------------------------------

async function handleGetDismissals(request, env, ctx) {
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ dismissals: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    await ensureDismissalsSchema(env);
    const dismissals = await listDismissals(env);
    return new Response(JSON.stringify({ dismissals }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ dismissals: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

async function handlePostDismissal(request, env, ctx) {
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ dismissed: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const appid = Number(body?.appid);
  if (!Number.isFinite(appid)) {
    return jsonError("appid is required.", 400);
  }
  const name = typeof body?.name === "string" ? body.name : null;

  try {
    await ensureDismissalsSchema(env);
    await addDismissal(env, appid, name);
    return new Response(JSON.stringify({ dismissed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ dismissed: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

/** DELETE /api/dismissals/:appid — the un-dismiss/restore path. `appid` is
 * parsed off the tail of the URL path (this route is dispatched by prefix,
 * see the fetch() router below). */
async function handleDeleteDismissal(request, env, ctx, appid) {
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ restored: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (!Number.isFinite(appid)) {
    return jsonError("appid is required.", 400);
  }

  try {
    await ensureDismissalsSchema(env);
    await removeDismissal(env, appid);
    return new Response(JSON.stringify({ restored: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ restored: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
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
    if (url.pathname === "/api/fpm/sync/status") {
      return handleFpmSyncStatus(request, env, ctx);
    }
    if (url.pathname === "/api/fpm/sync/stop") {
      return handleFpmSyncStop(request, env, ctx);
    }
    if (url.pathname === "/api/fpm/sync") {
      return handleFpmSync(request, env, ctx);
    }
    if (url.pathname === "/api/settings") {
      if (request.method === "PUT") return handlePutSettings(request, env, ctx);
      return handleGetSettings(request, env, ctx);
    }
    if (url.pathname === "/api/dismissals") {
      if (request.method === "POST") return handlePostDismissal(request, env, ctx);
      return handleGetDismissals(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/dismissals/")) {
      const appid = Number(url.pathname.slice("/api/dismissals/".length));
      return handleDeleteDismissal(request, env, ctx, appid);
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError("not implemented", 501);
    }
    // Fall back to the static asset handler for everything else.
    return env.ASSETS.fetch(request);
  },
};
