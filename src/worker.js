// Steam Sale Scout - Cloudflare Worker.
//
// INCREMENT 14 DELETED FIVE ROUTES: /api/library, /api/deals, /api/recs,
// /api/best-of and GET /api/fpm. They are gone from the router, not disabled,
// and now answer `501 not implemented` from the /api/ catch-all at the bottom
// of this file. The paragraph below is the historical description of what this
// file grew from; the routes it still serves are /api/rank, /api/wishlist,
// /api/settings, /api/dismissals, /api/marks and the /api/fpm/sync trio.
//
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
  BESTOF_PAGE_LIMIT,
  BESTOF_SORT,
  applyHistoricalLow,
  buildOwnedAppIdSet,
  chunk,
  excludeOwned,
  mergeDealPages,
  normalizeDeal,
  parseSteamAppId,
} from "./deals.js";
import { TOP_OWNED_GAMES, buildProfile, selectTopOwnedGames, computeIdf, buildTagVector, applyIdf } from "./profile.js";
import { cosineSimilarity } from "./score.js";
import { getCachedSpy, enqueueSpyFetch } from "./spyQueue.js";
import { resolveDeckCompat, DEFAULT_DECK_COMPAT } from "./deckCompat.js";
import { batteryFriendly } from "./battery.js";
import {
  fetchWishlist,
  parseWishlist,
  qualifiesForWishlistLane,
  sortWishlistLane,
  wishlistWhyLine,
} from "./wishlist.js";
import { FPM_POOL_CAP } from "./hltb.js";
import {
  ensureCatalogSchema,
  experienceFpm,
  getCatalogStats,
  startFpmSync,
  isFpmSyncRunning,
  getLastSyncStats,
  startFpmAutoContinue,
  isFpmAutoContinueActive,
  requestFpmAutoContinueStop,
} from "./catalog.js";
import { ensureSettingsSchema, getAllSettings, putSettings } from "./settings.js";
import { meterEnv } from "./d1meter.js";
import { loadRankCatalogue } from "./catalogCache.js";
import {
  SUPPRESS_LOW_CONFIDENCE_KEY,
  blendRankScore,
  isLowConfidenceSuppressed,
  normaliseSimilarities,
  profileWithoutGame,
  resolveRankWeights,
  summedProfileFromContributions,
} from "./rank.js";
import {
  ensureDismissalsSchema,
  listDismissals,
  getDismissedAppIdSet,
  addDismissal,
  removeDismissal,
} from "./dismissals.js";
import {
  ensureMarksSchema,
  listMarks,
  getMarksByAppid,
  setMark,
  removeMark,
  normaliseMark,
  derivePlayed,
} from "./marks.js";

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

/** A caller-supplied display name on its way into a durable table. Kept only
 * if it is a string, and capped at 200 characters - long enough for the
 * longest name Steam ships, short enough that nothing unbounded is stored
 * forever in a table nothing prunes. */
/**
 * An appid from anywhere untrusted - a JSON body or the tail of a `/:appid`
 * path - as a whole positive number, or NaN, which every caller answers with
 * a 400.
 *
 * WHY NOT `Number(value)` AND `Number.isFinite`, which is what this was.
 * Number() coerces far more than it looks like it does: `""` and `[]` become
 * 0, `true` becomes 1, `"0x10"` becomes 16, and `1.5` stayed finite and
 * reached SQLite, where it threw into the fail-soft catch and reported a
 * failure the caller could do nothing with. Junk appids landing in
 * `game_marks` matter more than anywhere else in this project because that
 * table cannot be re-fetched from anything. This accepts a JSON number that is
 * already a whole positive integer, or an all-digits string (a path tail is
 * always a string), and nothing else.
 */
function toAppid(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : NaN;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return n > 0 ? n : NaN;
  }
  return NaN;
}

const MAX_NAME_LENGTH = 200;
function capName(value) {
  return typeof value === "string" ? value.slice(0, MAX_NAME_LENGTH) : null;
}

/**
 * Guard for the three state-changing JSON routes (POST /api/marks, POST
 * /api/dismissals, PUT /api/settings). Returns a Response to send back, or
 * null when the request may proceed.
 *
 * WHY THIS EXISTS. Increment 12's audit accepted these routes on the reasoning
 * that "a JSON content-type blocks simple-form CSRF". That was never true:
 * `request.json()` is the fetch spec's Body.json() and parses the body
 * whatever the Content-Type claims, and nothing in this file looked at a
 * header. A cross-origin `<form method="POST" enctype="text/plain">` sends a
 * CORS-safelisted content type with no preflight and a body an attacker can
 * shape into valid JSON, so these routes were CSRF-writable from any page open
 * in the browser. The rationale is now enforced in code rather than asserted.
 *
 * TWO CHECKS.
 *   1. Content-Type must be application/json. This is the load-bearing one. A
 *      `<form>` can only ever send the three CORS-safelisted content types,
 *      and a cross-origin fetch() carrying application/json triggers a
 *      preflight this worker never answers with CORS headers, so the real
 *      request never fires.
 *   2. Sec-Fetch-Site, WHEN PRESENT, must be same-origin. Defence in depth:
 *      the browser sets it and page script cannot forge it.
 *
 * A MISSING Sec-Fetch-Site IS ALLOWED, deliberately. The header is absent on
 * every non-browser client - curl, this project's own tools, the tests - and
 * this is a single-user local app those callers legitimately talk to. Failing
 * closed on absence would break them in order to defend against the browsers
 * that omit the header, and those browsers are already stopped by check 1,
 * which does not depend on Sec-Fetch-Site at all.
 */
function rejectUnsafeWrite(request) {
  const type = (request.headers.get("content-type") || "").trim().toLowerCase();
  if (!type.startsWith("application/json")) {
    return jsonError("content-type must be application/json", 415);
  }
  return rejectCrossSite(request);
}

/**
 * The `Sec-Fetch-Site` half of the guard, on its own.
 *
 * QA, 2026-09-05. `rejectUnsafeWrite` covered the two POST routes but neither
 * DELETE, so `DELETE /api/marks/400` with `Sec-Fetch-Site: cross-site`
 * returned 200 and cleared the mark. It is not browser-exploitable - the
 * preflight `OPTIONS /api/marks/400` answers 405 with no CORS headers, so a
 * page cannot get there - but that makes the browser the defence rather than
 * the worker, on the one table in this project that cannot be rebuilt from
 * anywhere. The whole reason the GET-deletes blocker was a blocker.
 *
 * Split out rather than reusing `rejectUnsafeWrite` because a DELETE has no
 * body: demanding `application/json` on it would reject `curl -X DELETE` and
 * this project's own tools for nothing.
 *
 * A MISSING header is still allowed, same decision as the POST path: curl,
 * the tools and the tests never send one, and every browser that can reach a
 * cross-origin request sends it.
 */
function rejectCrossSite(request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return jsonError("cross-site write rejected", 403);
  }
  return null;
}

function trimGame(game) {
  return {
    appid: game.appid,
    name: game.name,
    img_icon_url: game.img_icon_url,
    playtime_forever: game.playtime_forever,
    playtime_2weeks: game.playtime_2weeks,
    rtime_last_played: game.rtime_last_played,
    // Increment 12.5. Steam sends this without being asked, same as
    // `rtime_last_played`, and it is a played SIGNAL only – never added into
    // `hoursPlayed` (src/marks.js's derivePlayed explains why). Measured on
    // the live library 2026-09-05: all 42 games carrying it are already inside
    // the 45 that `rtime_last_played` recovers, so it recovers ZERO additional
    // games today. It is carried because it is an independent signal on a
    // request we already make and Steam guarantees nothing about the two
    // always travelling together, not because it found anything.
    playtime_disconnected: game.playtime_disconnected,
  };
}

/**
 * THE SHAPE OF THE CACHED PAYLOAD, AS A NUMBER. Bump this whenever trimGame's
 * key set changes.
 *
 * 2 – increment 12.5 added `playtime_disconnected`.
 *
 * Without it this increment ships a trap with a 24-hour fuse: a library
 * payload cached BEFORE the deploy has no `playtime_disconnected` field, so a
 * game whose only play evidence is that field would silently read "no play
 * recorded" for up to a day – and the symptom looks exactly like the new code
 * not working. One line here removes it. Asking anyone to remember `?refresh=1`
 * does not.
 */
const LIBRARY_CACHE_VERSION = 2;

/** Cache key for the trimmed-library response, stable per steamid and
 * independent of ?refresh= so a refresh both bypasses and repopulates it. */
function libraryCacheKey(env) {
  return new Request(
    `https://steam-sale-scout.cache/api/library?steamid=${env.STEAM_ID}&v=${LIBRARY_CACHE_VERSION}`,
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

/**
 * Per-game marks (Increment 12.5) for /api/rank's row build, keyed by appid.
 *
 * READ ONLY, AND IT MUST STAY THAT WAY. Unlike getDismissedAppIds above,
 * whose result is JOINED AGAINST TO REMOVE ROWS FROM THE POOL, this map is
 * only ever read to ANNOTATE a row that is already in the pool. A mark never
 * filters /api/rank's pool and never enters any score (SPEC.md §2, §7.3) –
 * it rides on the row as data and the browser is the only thing that acts on
 * it. That is what makes gate 5's "the ranking is unmoved by twenty marks"
 * true by construction rather than by testing.
 *
 * Fail-soft exactly like getDismissedAppIds: a missing FPM_DB or a D1 hiccup
 * means no annotations this request, never a broken lane.
 * @returns {Promise<Map<number, {played: number, finished: number}>>}
 */
async function getGameMarks(env) {
  if (!env.FPM_DB) return new Map();
  try {
    await ensureMarksSchema(env);
    return await getMarksByAppid(env);
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// /api/deals (Increment 2) - the ROUTE was deleted at increment 14. The ITAD
// plumbing below it (appid resolution, historical lows, fetchItadJson) was
// never deals-only and survives: /api/wishlist and buildFpmPool both use it.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// /api/best-of (Increment 5) - the ROUTE, its pool loaders and src/hallOfFame.js
// were all deleted at increment 14. Only fetchBestOfPages below survives, because
// buildFpmPool calls it for the sync lane's price/cut lookups. The history is
// kept because it is why that one function sources on a rank-sorted axis.
//
// "Best of Steam": taste-agnostic, unanimously
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
// INCREMENT 14 DELETED GET /api/fpm AND handleFpm. Everything below about the
// GET path - scoring overrides, the enrichment cap, app-type gating, ?owned= -
// is history, not live behaviour. What survives in this section is the pool
// (fpmPoolCacheKey/buildFpmPool/loadFpmPool), which /api/rank and the sync lane
// both call, and the /api/fpm/sync trio in the next section.
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
        // Increment 9: the tag funnel's counters, zeroed – same shape as
        // the real branch below, so a client never has to special-case the
        // no-DB response (0 + 0 + 0 === total 0, the funnel still adds up).
        tagged: 0,
        tagsEmpty: 0,
        tagsPending: 0,
        tagsKvSeeded: 0,
        // Increment 10: the experience funnel's counters, zeroed – same
        // shape as the real branch below and the same reason (0+0+0+0 ===
        // total 0, so the four-way partition still adds up).
        experienceScored: 0,
        experienceUnscored: 0,
        experiencePending: 0,
        experienceNotApplicable: 0,
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
    // so does Increment 9's tag funnel – `tagged`/`tagsEmpty`/`tagsPending`
    // (the catalog-wide picture, which sums to `total` by construction) plus
    // `tagsKvSeeded`, the catalog-wide kv_seeded leg counted off the
    // tags_source column so it survives restarts and the many auto-continue
    // runs one fill takes (round-1 review, blocker 1). SPEC.md §3.5's
    // `skipped` leg stays per-run under lastRun, split across `tagsSkipped`
    // (rows the live pass walked past, round-2 review CR-9) and `tagsGaveUp`
    // (rows abandoned when a whole pass gave up). Neither is a catalog-wide
    // count, because neither kind of row is ever stamped – both are by
    // definition still inside tagsPending.
    //
    // Increment 10's experience funnel comes through the same way:
    // `experienceScored`/`experienceUnscored`/`experiencePending`/
    // `experienceNotApplicable`, a FOUR-way partition that sums to `total`
    // (see getCatalogStats for why the fourth leg exists – the fill gates on
    // app_type = 'game', so "pending" has to mean "the fill will attempt
    // this" or it could never reach 0). SPEC.md §4.5's `ghosts_dropped` and
    // `failed_batches` legs stay per-run under lastRun, as
    // `experienceGhostsDropped` / `experienceFailedBatches` – neither is a
    // catalog-wide count, because a dropped ghost is by definition a row
    // that was never written anywhere.
    //
    // Note lastRun ALSO carries `tagsKvSeeded`/`tagsEmpty` – the same names
    // scoped to the most recent run rather than the catalog. The nesting is
    // what disambiguates them, exactly as it already does for the type/HLTB
    // counters. Read the top-level ones for SPEC.md §7's final funnel;
    // lastRun's answer "what did the run I just watched actually do".
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
// /api/rank (Increment 11) — THE HEADLINE LANE. One ranked list over the
// whole catalogue answering "what do I play next", owned and unowned side by
// side. src/rank.js owns the arithmetic and the prologue classifier; this
// section owns the sourcing, the funnel and the fail-soft HTTP wiring.
//
// SOURCED FROM fpm_catalog, NOT FROM THE DEALS FEED, and that one sentence is
// the whole unlock. Every existing lane ranks over a discount-gated pool that
// EXCLUDES owned games by construction (src/deals.js's excludeOwned), so
// nothing in this app could ever answer "should I play something I already
// own". Reading the catalogue directly puts James's 552 scored owned games in
// the pool without a single ownership special case — SPEC.md §1, and James's
// ruling of 2026-09-02 that owned games have two jobs: they can be the next
// game to PLAY, and they feed the similarity engine.
//
// WHY THE SIX OLD LANES ARE UNTOUCHED. /api/recs and /api/deals keep their
// deals-feed sourcing (open question 1, RULED 2026-09-03: "leave it alone, as
// we could filter out easily on the frontend I think"). Both retire at
// increment 12, so rewriting their sourcing is work thrown away three weeks
// later on top of two zero-diff surfaces that would be lost. Nothing in this
// section is reachable from any of them.
//
// NO UI THIS INCREMENT. public/index.html is not touched; the deliverable is
// this JSON route plus generated markdown in the review folder. The answer
// page is increment 12 (SPEC.md §1, §9).
// ---------------------------------------------------------------------------

/** Fail-soft shape for this lane, matching handleFpm's {available:false}
 * convention exactly rather than inventing a second one — a missing FPM_DB
 * binding or a D1 hiccup must degrade to an honest response, never a 500
 * (SPEC.md §13.5). */
function rankUnavailableResponse(notice = "Ranking unavailable") {
  return new Response(JSON.stringify({ available: false, notice }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** `?sort=` — `experience` (default) or `fpm`. RULING 3, NOT RE-OPENED: the
 * headline stays `experience_score` and fun-per-minute is a SECONDARY sort
 * one query parameter away. Any per-hour metric structurally ranks a 2-hour
 * 92 above a 3-hour 95, which puts Portal 178th; that is arithmetic, not a
 * tuning fault, and no formula escapes it. Anything unrecognised falls back
 * to the headline rather than 500ing, same as parseFpmFormula. */
function parseRankSort(raw) {
  return raw === "fpm" ? "fpm" : "experience";
}

/**
 * The owned library, FAIL-SOFT — deliberately unlike loadLibraryForRecs,
 * which throws so that recs refuses to run rather than risk recommending an
 * owned game it could not exclude. This lane has the opposite risk profile:
 * it does not exclude owned games, it RANKS them, so a Steam outage costs a
 * taste profile (every row scores S = 0 and the list becomes pure experience
 * value) rather than costing correctness. Degrading is the right answer here;
 * refusing would not be.
 */
async function loadLibraryForRank(env, ctx, refresh) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) return [];
  const cache = caches.default;
  const cacheKey = libraryCacheKey(env);

  if (!refresh) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return (await cached.clone().json()).games || [];
    } catch {
      // Fall through to the upstream fetch.
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
    return trimmed;
  } catch {
    return [];
  }
}

/** Parse one catalogue row's stored inc-9 tag blob. A row whose JSON is
 * corrupt or is not a tag object degrades to "no tags" (S = 0, SPEC.md §4.4)
 * rather than throwing — one bad row must never take the lane down. */
function parseCatalogTags(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Assemble the SteamSpy trio for the owned games that build the taste
 * profile, preferring the KV cache and falling back to the catalogue's own
 * stored tags.
 *
 * WHY BOTH SOURCES, stated because the fallback is a real (if small)
 * behaviour difference and should not be discovered later. KV holds the full
 * trio — tags, `median_forever` and reviews — and is what /api/recs already
 * builds its profile from, so preferring it means this lane's taste vector is
 * the SAME vector the existing recommendation engine produces, which is the
 * point (SPEC.md §4.3: profile.js untouched, the library remains the sole
 * input). The catalogue's inc-9 `tags` column covers all 18,306 rows but has
 * no median, and without a median src/profile.js's playtimeNorm falls back to
 * its own documented log2(1+hours) term. So the fallback keeps a cold-KV
 * install working with a slightly differently-weighted profile, instead of
 * silently producing no profile at all. Neither path touches src/profile.js.
 */
async function buildRankSpyData(env, ownedAppids, catalogTagsByAppid, catalogRowByAppid) {
  const spyDataByAppid = new Map();
  await Promise.all(
    ownedAppids.map(async (appid) => {
      let entry;
      try {
        entry = await getCachedSpy(env, appid);
      } catch {
        entry = { cached: false, data: undefined };
      }
      if (entry.cached && entry.data?.tags) {
        spyDataByAppid.set(appid, entry.data);
        return;
      }
      const tags = catalogTagsByAppid.get(appid);
      if (!tags) {
        spyDataByAppid.set(appid, undefined); // not fetched / no usable tags
        return;
      }
      const row = catalogRowByAppid.get(appid);
      spyDataByAppid.set(appid, {
        tags,
        median: null, // triggers profile.js's log2 fallback — see above
        reviews: { positive: row?.positive || 0, negative: row?.negative || 0 },
      });
    }),
  );
  return spyDataByAppid;
}

async function handleRank(request, env, ctx) {
  if (!env.FPM_DB) return rankUnavailableResponse("FPM_DB not configured");

  // THE METER, INSTALLED ONCE, HERE (SPEC.md §4.1, gates 1 and 3). Every D1
  // call this request makes now runs through a counting wrapper, and nothing
  // downstream needs to know: the loaders below still take a plain `env` and
  // still call `env.FPM_DB.prepare(...)`. Reassigning the parameter is the
  // whole installation - that is what keeps the seam one line rather than a
  // change at every call site, and it is why a call site added later cannot
  // forget to be counted.
  const meter = meterEnv(env);
  env = meter.env;

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const ownedMode = parseOwnedMode(url.searchParams.get("owned"));
  const sort = parseRankSort(url.searchParams.get("sort"));
  // Gate 3 (SPEC.md §12b.2): the normaliser is a PROPERTY OF THE PRESET —
  // percentile for `default` and `sale`, min-max for `similarity` — so it is
  // resolved with the weights rather than beside them, and cannot drift away
  // from the preset it belongs to. `?norm=` still overrides either lens.
  const weights = resolveRankWeights(url.searchParams);
  const normaliser = weights.normaliser;
  const windowMonthsParam = Number(url.searchParams.get("windowMonths"));
  const windowMonths = windowMonthsParam > 0 ? windowMonthsParam : 12;

  // The prologue fill runs here, at the top of the rank handler, and
  // deliberately NOT inside the sync pipeline — that is what keeps
  // /api/fpm/sync and /sync/status byte-identical (SPEC.md §10). First call
  // pays a one-time ~18.3k-row pass; every call after is a no-op.
  let catalogRows;
  let exclusionFill;
  let catalogue;
  try {
    await ensureCatalogSchema(env);
    // THE SEAM (SPEC.md §4.1, gate 2). `ensureRankExclusions(env)` +
    // `selectRankCatalogRows(env)` became one call. Both moved for the same
    // reason - they are catalogue-wide, user-independent work that was being
    // repeated on every page load - and they now run together, on the rebuild
    // path, at most a few times a day. Nothing below this line changed: the
    // funnel, the IDF corpus, the profile, similarity, the blend and the sort
    // all still run per request over exactly these rows.
    catalogue = await loadRankCatalogue(env, ctx, refresh);
    catalogRows = catalogue.rows;
    exclusionFill = catalogue.exclusionFill;
  } catch {
    return rankUnavailableResponse();
  }

  // Suppression is DEFAULT ON and turned off by a stored settings key. The
  // key is read through the existing increment-8 lane, so an untouched store
  // yields the default and GET /api/settings stays byte-identical until
  // something writes it (SPEC.md §7, §10).
  let suppressLowConfidence = true;
  try {
    await ensureSettingsSchema(env);
    const settings = await getAllSettings(env);
    if (settings[SUPPRESS_LOW_CONFIDENCE_KEY] === false) suppressLowConfidence = false;
  } catch {
    // Fail-soft to the safe default: suppress. A settings hiccup must not put
    // a bluffed score on the front page.
  }

  const dismissedAppIds = await getDismissedAppIds(env);
  // Increment 12.5. Loaded here, next to the dismissals, so the contrast is
  // visible at the call site: `dismissedAppIds` is consumed by a `continue`
  // in the pool loop below; `marksByAppid` is consumed ONLY in the response
  // row build, never in the loop, never in a score.
  const marksByAppid = await getGameMarks(env);
  const libraryGames = await loadLibraryForRank(env, ctx, refresh);
  const libraryByAppid = new Map(libraryGames.map((game) => [game.appid, game]));

  // WHY THE EMPTY LIBRARY IS REPORTED RATHER THAN ABSORBED (round-2 review,
  // SEC-1). loadLibraryForRank is fail-soft by design and returns [] for
  // three very different situations: no Steam credentials configured, a cache
  // error, or a Steam outage. With no library every cosine is 0, and under
  // `similarity` min-max over an all-equal pool returns all zeros – so the
  // similarity lens silently collapses into pure `wE * E` while still
  // reporting `available: true` and a normal-looking funnel. That is SPEC.md
  // §1's reason 2 ("owned games feed the recommendation engine for SIMILAR
  // games") failing without saying so.
  //
  // Credentials PRESENT + empty library is the outage case and earns a
  // notice. Credentials ABSENT is a configuration state, not a fault, and is
  // already visible in `profileAvailable` / `profileGames`.
  const steamConfigured = Boolean(env.STEAM_API_KEY && env.STEAM_ID);
  const libraryLoadFailed = steamConfigured && libraryGames.length === 0;

  const catalogTagsByAppid = new Map();
  const catalogRowByAppid = new Map();
  for (const row of catalogRows) {
    catalogRowByAppid.set(row.appid, row);
    const tags = parseCatalogTags(row.tags);
    if (tags) catalogTagsByAppid.set(row.appid, tags);
  }

  // ---- The funnel (SPEC.md §8) -------------------------------------------
  // Every subtraction is named, counted, and applied in ONE pass in a fixed
  // order, so the counts partition the catalogue and sum back to its total
  // exactly. Ordering matters: a row is charged to the FIRST reason that
  // excludes it and to no other, which is what makes the arithmetic honest
  // rather than merely plausible.
  const funnel = {
    catalogTotal: catalogRows.length,
    nonGame: 0,
    checkedNoScore: 0,
    unscored: 0,
    rankExcluded: 0,
    dismissed: 0,
    lowConfidenceSuppressed: 0,
    ranked: 0,
    owned: 0,
    // CR-4 (round-2 review): `has_ending` is a TRI-STATE in D1 – 1 ends, 0
    // endless, NULL not yet known – and the row builder below already treats
    // NULL as a distinct third state increment 12 renders differently. The
    // funnel now agrees: `endless` counts 0 only, `endingUnknown` counts NULL.
    // Zero ranked rows are NULL today, so this splits 0 off a count that was
    // numerically right and semantically wrong.
    endless: 0,
    endingUnknown: 0,
    tagless: 0,
    priced: 0,
    pricedOwned: 0,
    lowConfidenceOwnedSpared: 0,
    // Increment 13 (SPEC.md §6). These six MUST partition `ranked` exactly and
    // sum back to it - same discipline as every other funnel line above, and
    // gate 8 asserts it rather than trusting it. `unchecked` is NULL
    // price_state: never evaluated under the GetItems method, which is a
    // different fact from `unknown` (evaluated, and no source could say).
    price: { priced: 0, free: 0, delisted: 0, region: 0, unknown: 0, unchecked: 0 },
  };

  const eligible = [];
  for (const row of catalogRows) {
    // OWNERSHIP, RESOLVED ONCE, AS A UNION — and the direction is deliberate.
    // `source_owned` is D1's stamp from the sync pipeline; the live library
    // join is what handleFpm uses. Taking either as sufficient means the
    // owned exemption below can only ever spare MORE games, never fewer,
    // which is the safe direction for a rule whose failure mode is hiding a
    // game from James's own library (SPEC.md §1, §7). Measured today the two
    // agree exactly: 553 rows, 553 library matches.
    const owned = row.source_owned === 1 || libraryByAppid.has(row.appid);

    // 1. Non-game or unclassified app_type. Increment 7.8's exclude-until-
    //    classified decision, unchanged: an unclassified row fails the same
    //    equality check as an explicitly non-game one.
    if (row.app_type !== "game") {
      funnel.nonGame++;
      continue;
    }
    // 2. Checked, no score. No headline number means no rank — never a
    //    silent drop, which is why it has its own funnel line.
    if (row.experience_score == null) {
      if (row.experience_checked_at != null) funnel.checkedNoScore++;
      else funnel.unscored++;
      continue;
    }
    // 3. Prologues, off the stored column rather than a regex in this hot
    //    path — auditable in one table, per SPEC.md §6.
    if (row.rank_exclude_reason != null) {
      funnel.rankExcluded++;
      continue;
    }
    // 4. Per-user dismissals. Kept as what they are — "not interested" —
    //    and deliberately not conflated with the catalogue-level exclusion
    //    above (Rev 2's two-layer rule).
    if (dismissedAppIds.has(row.appid)) {
      funnel.dismissed++;
      continue;
    }
    // 5. Low-confidence suppression, WITH THE OWNED EXEMPTION. The predicate
    //    carries `source_owned = 0` itself, so the exemption cannot be
    //    forgotten at a call site, and it holds whether the settings key is
    //    on or off — the key only governs whether UNOWNED low-confidence
    //    rows are suppressed at all.
    const suppressible = isLowConfidenceSuppressed({ ...row, source_owned: owned ? 1 : 0 });
    if (suppressible && suppressLowConfidence) {
      funnel.lowConfidenceSuppressed++;
      continue;
    }
    // The proof James asked for, counted rather than asserted: owned rows that
    // WOULD have been suppressed but for the exemption.
    //
    // Computed by asking the REAL predicate what it would have said had this
    // row been unowned, rather than by restating its conditions inline. That
    // matters: an inline restatement hardcoding the review floor drifted the
    // moment §12b.1 moved the floor from 1,000 to 200, and reported 11 rows
    // spared when only 1 actually was. A counter that can disagree with the
    // filter it is counting is worse than no counter.
    if (owned && suppressLowConfidence && isLowConfidenceSuppressed({ ...row, source_owned: 0 })) {
      funnel.lowConfidenceOwnedSpared++;
    }

    eligible.push({ row, owned });
  }

  // ---- The taste profile --------------------------------------------------
  // IDF CORPUS = THE ELIGIBLE POOL'S OWN TAG SETS. Document frequency has to
  // be counted over the corpus being scored or the weights mean nothing: with
  // ~18k documents a tag like "Indie" collapses toward idf 0 and stops
  // contributing to similarity on either side, while a distinctive tag
  // dominates it. This is a much larger corpus than /api/recs computes over
  // (top-200 owned + the deals feed), which is a feature — the same tag gets
  // a more stable weight the more documents it is counted across.
  const corpusTagSets = [];
  for (const { row } of eligible) {
    const tags = catalogTagsByAppid.get(row.appid);
    if (tags) corpusTagSets.push(tags);
  }
  const idfMap = computeIdf(corpusTagSets);

  const profileAppids = selectTopOwnedGames(libraryGames, windowMonths, Date.now(), TOP_OWNED_GAMES).map(
    (game) => game.appid,
  );
  const spyDataByAppid = await buildRankSpyData(env, profileAppids, catalogTagsByAppid, catalogRowByAppid);
  const { profile, contributions } = buildProfile(libraryGames, spyDataByAppid, windowMonths, Date.now(), idfMap);

  // Leave-one-out inputs, built ONCE for the whole request: the summed
  // pre-IDF vector, and each contributing game's own share of it. Scoring an
  // owned candidate then costs one O(tags) subtraction, not a profile
  // rebuild. See src/rank.js for why this is exact without touching
  // src/profile.js.
  const summedProfile = summedProfileFromContributions(contributions);
  const contributionByAppid = new Map(contributions.map((c) => [c.appid, c]));

  // ---- Similarity ---------------------------------------------------------
  // NEVER PERSISTED. Rev 2's binding two-layer rule: similarity is a function
  // of THIS user's library, so it is computed per request and no similarity
  // column exists or may exist. The stored inc-9 tags are the global layer;
  // the profile is the user layer; the cosine between them is derived, every
  // time.
  const scored = [];
  const cosinesForNormalisation = [];
  for (const entry of eligible) {
    const tags = catalogTagsByAppid.get(entry.row.appid);
    const rawVector = tags ? buildTagVector(tags) : {};
    const hasTags = Object.keys(rawVector).length > 0;

    let similarity = 0;
    if (hasTags) {
      const candidateVector = applyIdf(rawVector, idfMap);
      // THE SELF-MATCH TRAP. An owned game's tags helped build this profile,
      // so scoring it against the full profile is circular — under the
      // `similarity` preset the top would fill with games James has already
      // sunk 200 hours into. Only THAT ONE GAME's contribution comes out;
      // every other owned game still contributes in full, to this candidate
      // and to every other one. That is what keeps the library's role as the
      // engine's source intact (SPEC.md §4.3).
      const own = entry.owned ? contributionByAppid.get(entry.row.appid) : undefined;
      const against = own ? profileWithoutGame(summedProfile, own.tagWeights, idfMap) : profile;
      similarity = cosineSimilarity(against, candidateVector);
    }

    entry.similarity = similarity;
    entry.hasTags = hasTags;
    entry.tagNames = Object.keys(rawVector);
    // TAGLESS ROWS ARE NORMALISED SEPARATELY — they are held out of the pool
    // entirely and pinned to S = 0 below. Leaving them in would let the
    // percentile normaliser hand "no tags at all" a rank above the genuinely
    // dissimilar, and SPEC.md §4.4 is explicit that a missing co-pillar
    // scores 0 rather than dropping the game.
    if (hasTags) cosinesForNormalisation.push(similarity);
    scored.push(entry);
  }

  const normalisedPool = normaliseSimilarities(cosinesForNormalisation, normaliser);
  let poolCursor = 0;
  for (const entry of scored) {
    entry.similarityNorm = entry.hasTags ? normalisedPool[poolCursor++] : 0;
    if (!entry.hasTags) funnel.tagless++;
  }

  // ---- Prices, and the blend ---------------------------------------------
  // price/cut come straight off each row's own D1 columns (increment 8.5's
  // backfill). `atHistoricalLow` has no column, so it still comes from the
  // ITAD-backed pool handleFpm already loads, fail-soft to "no historical-low
  // data this request" — which costs at most the 1.15 premium on rows that
  // would have earned it, never a wrong number.
  //
  // NOTE THE DELIBERATE DIFFERENCE FROM handleFpm, which nulls price for
  // owned rows ("an owned game's sale price is irrelevant"). Here it is
  // relevant: the funnel has to report how many priced rows the sale toggle
  // can move AND how many of those are owned (SPEC.md §8 — measured at 1),
  // which is the evidence for §4.2's statement that owned games cannot win
  // the `sale` lens. Nulling it would erase exactly that.
  //
  // GATED ON ITAD_API_KEY, unlike handleFpm which refuses the whole request
  // without one. This lane's answer does not depend on ITAD: price and
  // discount come from D1, and only the 1.15 historical-low premium is lost.
  // "What do I play next" must keep working without a third-party key.
  let dealPool = [];
  if (env.ITAD_API_KEY) {
    try {
      dealPool = await loadFpmPool(env, ctx, refresh);
    } catch {
      dealPool = [];
    }
  }
  const dealByAppid = new Map((dealPool || []).filter((d) => d.appid != null).map((d) => [d.appid, d]));

  const ranked = scored.map((entry) => {
    const row = entry.row;
    const dealEntry = dealByAppid.get(row.appid);
    const atHistoricalLow = dealEntry?.atHistoricalLow ?? false;
    const blend = blendRankScore(
      {
        experienceScore: row.experience_score,
        similarityNorm: entry.similarityNorm,
        cut: row.cut,
        atHistoricalLow,
      },
      weights,
    );

    const reviewCount = (row.positive || 0) + (row.negative || 0);
    const libraryGame = libraryByAppid.get(row.appid);
    // Increment 12.5. Four derived fields, computed by the same pure function
    // the tests exercise, AFTER the blend above has already been computed from
    // `row` and `entry` alone – so there is no path by which a mark can reach
    // `rankScore`.
    const playState = derivePlayed(libraryGame, marksByAppid.get(row.appid));

    funnel.ranked++;
    if (entry.owned) funnel.owned++;
    if (row.has_ending === 0) funnel.endless++;
    else if (row.has_ending == null) funnel.endingUnknown++;
    if (row.price != null) {
      funnel.priced++;
      if (entry.owned) funnel.pricedOwned++;
    }
    const priceState = row.price_state;
    if (priceState == null) funnel.price.unchecked++;
    // `Object.hasOwn`, NOT `in` (increment 13 review - the server-side twin of
    // SEC-7, found while pinning gate 8's partition). `in` walks the prototype
    // chain, so a stored `price_state` of `"constructor"` or `"toString"`
    // answered TRUE and then did `funnel.price["constructor"]++`, which puts a
    // NaN-valued own property on the funnel - a NEW KEY in a response whose key
    // set gate 8 asserts is exhaustive. The vocabulary is closed and this now
    // checks it as closed.
    else if (Object.hasOwn(funnel.price, priceState)) funnel.price[priceState]++;
    // A state outside the closed vocabulary would silently break the
    // partition, so it is charged to `unknown` rather than dropped - the
    // arithmetic stays honest even if a future writer invents a value.
    else funnel.price.unknown++;

    return {
      appid: row.appid,
      title: row.name,
      owned: entry.owned,
      hoursPlayed: libraryGame ? (libraryGame.playtime_forever || 0) / 60 : null,
      // THE FOUR FIELDS THIS INCREMENT ADDS, AND THEY ARE ANNOTATIONS, NOT
      // INPUTS. `played` is true if Steam has ANY evidence or the user said
      // so; `playedSource` names WHICH, so the page can show Steam's number
      // and the user's verdict side by side without ever disguising one as
      // the other. `hoursPlayed` above is untouched – `playtime_disconnected`
      // is deliberately NOT merged into it.
      played: playState.played,
      finished: playState.finished,
      playedSource: playState.playedSource,
      lastPlayedAt: playState.lastPlayedAt,
      experienceScore: row.experience_score,
      gameScore: row.game_score ?? null,
      // hasEnding stays the INTEGER 0/1/null D1 holds rather than a boolean,
      // because null (unknown) is a THIRD state increment 12 has to render
      // differently from "endless", and a boolean cannot carry it.
      hasEnding: row.has_ending ?? null,
      hoursToValue: row.hours_to_value ?? null,
      hoursToGood: row.hours_to_good ?? null,
      confidence: row.experience_confidence ?? null,
      why: row.experience_reason ?? null,
      // BOTH numbers, always. The raw cosine is what the normaliser was fed;
      // similarityNorm is what the blend actually used. Returning only the
      // second would let the normaliser hide what it did (SPEC.md §4.2).
      similarity: entry.similarity,
      similarityNorm: entry.similarityNorm,
      // WHAT THE ENDLESS GAMES ARE OWED (SPEC.md §8): the field is present
      // and explicitly null rather than absent, so increment 12 can render
      // "endless — no ending, so no per-hour figure" instead of a blank cell.
      // 4,822 endless rows stay in the headline ranking and sink on their
      // merits; they are excluded only from this secondary sort, by
      // construction.
      experienceFpm: experienceFpm(row),
      price: row.price ?? null,
      priceCents: row.price_cents ?? null,
      regular: row.regular ?? null,
      cut: row.cut ?? null,
      priceCheckedAt: row.price_checked_at ?? null,
      // Increment 13. The state is what the card renders from now, not the
      // absence of a number: `free` / `delisted` / `region` each have a
      // sentence, `unknown` keeps "Price not known", and NULL - never checked
      // under this method - keeps it too. Always present, null when unfilled.
      priceState: row.price_state ?? null,
      atHistoricalLow,
      reviewCount,
      reviewPercent: reviewCount > 0 ? Math.round((row.positive / reviewCount) * 100) : null,
      tagNames: entry.tagNames,
      base: blend.base,
      rankScore: blend.rankScore,
    };
  });

  // `?sort=fpm` is the secondary lens, never the headline. Nulls sort LAST
  // rather than being filtered out, so an endless game is still in the list
  // and still visibly has no per-hour figure.
  if (sort === "fpm") {
    ranked.sort((a, b) => {
      if (a.experienceFpm == null && b.experienceFpm == null) return b.rankScore - a.rankScore;
      if (a.experienceFpm == null) return 1;
      if (b.experienceFpm == null) return -1;
      return b.experienceFpm - a.experienceFpm;
    });
  } else {
    ranked.sort((a, b) => b.rankScore - a.rankScore);
  }

  // The owned tri-state is a POST-HOC VIEW FILTER applied after the funnel is
  // computed, exactly as handleFpm's is — so the funnel always reports the
  // real catalogue-wide numbers regardless of which view was requested, and
  // `count` (what this view returned) is honestly distinct from
  // `funnel.ranked` (what was ranked).
  let view = ranked;
  if (ownedMode === "hide") view = ranked.filter((r) => !r.owned);
  else if (ownedMode === "only") view = ranked.filter((r) => r.owned);

  return new Response(
    JSON.stringify({
      available: true,
      preset: weights.preset,
      weights: { we: weights.we, ws: weights.ws, wsale: weights.wsale },
      normaliser,
      sort,
      ownedMode,
      // CR-3 (round-2 review): `?windowMonths=` materially changes which owned
      // games build the taste profile, so it is echoed like every other
      // resolved input rather than being the one that is not.
      windowMonths,
      suppressLowConfidence,
      exclusionFill,
      // SEC-1: the taste profile's own health, beside the fill's. `profileGames`
      // is how many owned games actually contributed tag weight – 0 means every
      // similarity term is 0 and the similarity lens has collapsed to `wE * E`.
      profileAvailable: contributions.length > 0,
      profileGames: contributions.length,
      // Always present, null when there is nothing to say, so the exhaustive
      // key set increment 12 builds against cannot change shape between calls.
      notice: libraryLoadFailed
        ? "Steam library unavailable – the taste profile is empty, so similarity is 0 on every row and the similarity lens is showing experience value alone."
        : null,
      funnel,
      // ALWAYS PRESENT, per this project's own convention, so the exhaustive
      // key set cannot change shape between calls - and because a cost number
      // that only appears when you ask for it is a cost number nobody reads.
      // `rowsRead` counts rows SCANNED, which is what Cloudflare bills;
      // `unmetered` counts calls D1 gives no meta for (none on this path).
      d1: {
        queries: meter.stats.queries,
        rowsRead: meter.stats.rowsRead,
        rowsWritten: meter.stats.rowsWritten,
        unmetered: meter.stats.unmetered,
        cacheState: catalogue.cacheState,
        snapshotAgeMs: catalogue.ageMs,
      },
      count: view.length,
      rank: view,
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
  const unsafe = rejectUnsafeWrite(request);
  if (unsafe) return unsafe;
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
  const unsafe = rejectUnsafeWrite(request);
  if (unsafe) return unsafe;
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
  // A whole positive appid only - see toAppid() for what Number() let through.
  const appid = toAppid(body?.appid);
  if (!Number.isInteger(appid) || appid <= 0) {
    return jsonError("appid is required.", 400);
  }
  const name = capName(body?.name);

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
  const unsafe = rejectCrossSite(request);
  if (unsafe) return unsafe;
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ restored: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (!Number.isInteger(appid) || appid <= 0) {
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

// ---------------------------------------------------------------------------
// /api/marks (Increment 12.5) – "I played this / I finished this". The pair
// /api/dismissals already has, with one deliberate difference: THERE IS NO
// SERVER-SIDE EXCLUSION JOIN ANYWHERE. A dismissal removes a row from every
// lane's pool; a mark only ever annotates a row that is already there
// (SPEC.md §2, §7.3). Fail-soft posture identical to the dismissals routes
// above – a missing FPM_DB or a D1 throw answers 200 with an honest
// empty/false body rather than a 500, and the PAGE is responsible for showing
// that a write did not stick (increment 12's review caught "said nothing at
// all" four ways; public/index.html reverts the toggle and says so).
// ---------------------------------------------------------------------------

async function handleGetMarks(request, env, ctx) {
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ marks: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    await ensureMarksSchema(env);
    const marks = await listMarks(env);
    return new Response(JSON.stringify({ marks }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ marks: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * POST /api/marks – a FULL-STATE UPSERT, NOT A TOGGLE. The body carries the
 * state the user wants (`{appid, name, played, finished}`), so a double-click,
 * a retry or a second tab is idempotent and cannot flip the mark to the
 * opposite of what was pressed. The `finished => played` invariant is applied
 * by normaliseMark on the way in, so the impossible row cannot be stored even
 * if something else posts `{played: 0, finished: 1}`.
 */
async function handlePostMark(request, env, ctx) {
  const unsafe = rejectUnsafeWrite(request);
  if (unsafe) return unsafe;
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  // A whole positive appid only. This table is the one thing here that cannot
  // be re-fetched from anywhere, so a junk row in it is permanent - and the
  // client's steamUrl was already validating more strictly than the server.
  const appid = toAppid(body?.appid);
  if (!Number.isInteger(appid) || appid <= 0) {
    return jsonError("appid is required.", 400);
  }
  const name = capName(body?.name);
  const state = normaliseMark(body);

  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ saved: false, ...state }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    await ensureMarksSchema(env);
    const stored = await setMark(env, appid, name, state);
    // The STORED state is echoed, not the requested one, so the page renders
    // what the database actually holds – the invariant is visible to the
    // caller rather than something it has to know about.
    return new Response(JSON.stringify({ saved: true, ...stored }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ saved: false, ...state }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

/** DELETE /api/marks/:appid – clears the mark. This is the toggles' third
 * state and it REMOVES an assertion; it does not assert "never played". A
 * no-op, not an error, if no mark exists. */
async function handleDeleteMark(request, env, ctx, appid) {
  const unsafe = rejectCrossSite(request);
  if (unsafe) return unsafe;
  if (!Number.isInteger(appid) || appid <= 0) {
    return jsonError("appid is required.", 400);
  }
  if (!env.FPM_DB) {
    return new Response(JSON.stringify({ cleared: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    await ensureMarksSchema(env);
    await removeMark(env, appid);
    return new Response(JSON.stringify({ cleared: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ cleared: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/wishlist") {
      return handleWishlist(request, env, ctx);
    }
    if (url.pathname === "/api/rank") {
      return handleRank(request, env, ctx);
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
    // THE VERB IS PART OF THE ROUTE. Both `/:appid` routes below dispatch by
    // path PREFIX, and until increment 12.5's security review they ran the
    // DELETE handler on ANY method - so a plain
    // `<img src="http://localhost:8787/api/marks/440">` on any page open in
    // the browser destroyed a mark, with no JS, no CORS and no preflight.
    // A GET is not allowed to be a write.
    if (url.pathname.startsWith("/api/dismissals/")) {
      if (request.method !== "DELETE") return jsonError("method not allowed", 405);
      const appid = toAppid(url.pathname.slice("/api/dismissals/".length));
      return handleDeleteDismissal(request, env, ctx, appid);
    }
    if (url.pathname === "/api/marks") {
      if (request.method === "POST") return handlePostMark(request, env, ctx);
      return handleGetMarks(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/marks/")) {
      if (request.method !== "DELETE") return jsonError("method not allowed", 405);
      const appid = toAppid(url.pathname.slice("/api/marks/".length));
      return handleDeleteMark(request, env, ctx, appid);
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError("not implemented", 501);
    }
    // Fall back to the static asset handler for everything else.
    return env.ASSETS.fetch(request);
  },
};
