// Steam Sale Scout — HowLongToBeat adapter (Increment 7, Fun-per-minute lane).
//
// Isolated adapter module, mirroring src/wishlist.js's split: pure data
// shaping (parse/match/lane math) plus, since this adapter owns its own
// unofficial-API handshake, the network fetch + throttled background queue
// too (mirroring src/spyQueue.js's queue pattern). ONE parse function
// (parseHltbSearch) is THE single repair surface — if HowLongToBeat's
// response shape drifts again, this is the one place to fix.
//
// LIVE-PROBED SHAPE (2026-07-11, mandatory live probe per project discipline
// — SPEC.md's `/api/s/init` guess is dead, 404). Current scheme:
//   Auth:   GET  https://howlongtobeat.com/api/bleed/init?t=<ms>
//           -> 200 JSON { token, hpKey, hpVal }
//   Search: POST https://howlongtobeat.com/api/bleed
//           headers: x-auth-token, x-hp-key, x-hp-val, content-type: json,
//           browser User-Agent, Referer/Origin: https://howlongtobeat.com.
//           Body additionally carries body[hpKey] = hpVal (an anti-bot echo
//           the site's own JS adds) on top of the search payload.
//           On HTTP 403 (token expired) the caller re-inits once and retries
//           the search once — mirrors what the live site itself does.
//   Response: { count, data: [ entry, ... ] }. Lengths are in SECONDS —
//           e.g. Portal 2's comp_main = 30743 (= 8.54h). mainHours =
//           lengthSeconds / 3600.
//
// `profile_steam` (a Steam appid on the entry) is ABSENT from every live
// response — matching is normalized-title-similarity ONLY. matchMethod is
// therefore always 'name' or 'none'; the 'steam-id' path SPEC.md describes
// never fires (pre-authorised in SPEC.md: "if the probe confirms the field,
// else fallback to title similarity").
//
// DEVIATION NOTE (flagged for the reviewer): matching is done against the
// pool candidate's existing `title` (the ITAD title already attached by
// src/deals.js's normalizeDeal, present on every Best-of pool candidate),
// not a fresh IStoreBrowseService/GetItems `name` call. The pool already
// carries a canonical title, so no new GetItems infra was needed for this
// lane.
//
// FAIL-SOFT, TWO LEVELS (per SPEC.md): (a) source level — a parse/handshake
// failure throws, and src/worker.js's handleFpm catches it and hides the
// whole lane (`{available:false}`), same as /api/wishlist; (b) per-game
// level — fetchAndCacheHltb below never throws out of the queue: a
// search/parse/match failure for one game just caches a negative result and
// the pump moves on to the next game.

/** Cap the Best-of pool at this many (already rank-sorted) candidates before
 * resolving lengths — keeps a cold refresh to a bounded ~5 min of lazy-fill
 * at the queue's ~1 req/sec pace. */
export const FPM_POOL_CAP = 300;

/** Minimum Dice-bigram title-similarity score to accept an HLTB entry as a
 * match. Below this, a candidate is left unmatched rather than risk a
 * wrong-game length (worse than no length at all). */
export const FPM_MATCH_THRESHOLD = 0.75;

/** Minimum main-story hours to qualify for the lane — blocks degenerate
 * sub-hour entries (e.g. a DLC or tech-demo HLTB happens to carry a length
 * for) from dominating the fun/hr ranking. */
export const FPM_MIN_LENGTH_HOURS = 1;

/** Which HLTB length field is the FPM denominator. Config, not hardcoded —
 * switching to 'comp_plus' later is a one-line change here plus in
 * hltbLengthSeconds's field map below. */
export const FPM_LENGTH_FIELD = "comp_main";

/** Length is near-static — cache a resolved match for 30 days, mirroring
 * spyQueue.js's TAG_CACHE_TTL_SECONDS. */
export const HLTB_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A negative result (no match found) is cached for a shorter 7 days —
 * mirrors spyQueue.js's TAG_CACHE_FAIL_TTL_SECONDS rationale (HLTB answered,
 * it just has nothing usable for this title; less reason to expect a
 * same-day retry to help). */
export const HLTB_CACHE_NEGATIVE_TTL_SECONDS = 7 * 24 * 60 * 60;

const HLTB_INIT_URL = "https://howlongtobeat.com/api/bleed/init";
const HLTB_SEARCH_URL = "https://howlongtobeat.com/api/bleed";
const HLTB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HLTB_REFERER = "https://howlongtobeat.com/";
const HLTB_ORIGIN = "https://howlongtobeat.com";

// ---------------------------------------------------------------------------
// Handshake + search fetch. Pure network I/O, no caching (the queue below
// owns caching) — mirrors src/wishlist.js's fetchWishlist split.
// ---------------------------------------------------------------------------

/**
 * GET the HLTB init handshake, returning the tokens needed for a search.
 * Throws an Error with a `.status` on any network/non-2xx/unparsable/
 * unexpected-shape failure, mirroring fetchWishlist's error convention.
 * @returns {Promise<{token: string, hpKey: string, hpVal: string}>}
 */
export async function hltbInit() {
  const url = new URL(HLTB_INIT_URL);
  url.searchParams.set("t", String(Date.now()));

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "User-Agent": HLTB_USER_AGENT,
        Referer: HLTB_REFERER,
        Origin: HLTB_ORIGIN,
      },
    });
  } catch (err) {
    const e = new Error(`Failed to reach HowLongToBeat init: ${err.message}`);
    e.status = 502;
    throw e;
  }

  if (!res.ok) {
    const e = new Error(`HowLongToBeat init returned ${res.status}`);
    e.status = res.status;
    throw e;
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    const e = new Error("HowLongToBeat init returned an unparsable response.");
    e.status = 502;
    throw e;
  }

  if (!body?.token || !body?.hpKey || !body?.hpVal) {
    const e = new Error("HowLongToBeat init returned an unexpected shape — missing token/hpKey/hpVal.");
    e.status = 502;
    throw e;
  }

  return { token: body.token, hpKey: body.hpKey, hpVal: body.hpVal };
}

/** Build the /api/bleed search body — see file header for the shape and the
 * body[hpKey]=hpVal anti-bot echo requirement. */
function buildSearchBody(tokens, query) {
  const body = {
    searchType: "games",
    searchTerms: String(query || "").split(" ").filter(Boolean),
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: "",
        sortCategory: "popular",
        rangeCategory: "main",
        rangeTime: { min: null, max: null },
        gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
        rangeYear: { min: "", max: "" },
        modifier: "",
      },
      users: { sortCategory: "postcount" },
      lists: { sortCategory: "follows" },
      filter: "",
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };
  body[tokens.hpKey] = tokens.hpVal;
  return body;
}

/**
 * POST a title search against HLTB. Returns the raw JSON body — the caller
 * (fetchAndCacheHltb below) is responsible for calling parseHltbSearch on it.
 * Throws an Error with `.status` on any failure; a 403 specifically (token
 * expired) is left for the caller to detect via `.status === 403` and retry
 * after a re-init, mirroring what the live site itself does.
 * @param {{token: string, hpKey: string, hpVal: string}} tokens
 * @param {string} query
 * @returns {Promise<object>}
 */
export async function hltbSearch(tokens, query) {
  let res;
  try {
    res = await fetch(HLTB_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-token": tokens.token,
        "x-hp-key": tokens.hpKey,
        "x-hp-val": tokens.hpVal,
        "User-Agent": HLTB_USER_AGENT,
        Referer: HLTB_REFERER,
        Origin: HLTB_ORIGIN,
      },
      body: JSON.stringify(buildSearchBody(tokens, query)),
    });
  } catch (err) {
    const e = new Error(`Failed to reach HowLongToBeat search: ${err.message}`);
    e.status = 502;
    throw e;
  }

  if (!res.ok) {
    const e = new Error(`HowLongToBeat search returned ${res.status}`);
    e.status = res.status;
    throw e;
  }

  try {
    return await res.json();
  } catch (err) {
    const e = new Error("HowLongToBeat search returned an unparsable response.");
    e.status = 502;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Parse — THE single repair surface.
// ---------------------------------------------------------------------------

/**
 * Parse a raw /api/bleed search response into normalized entries. Validates
 * `{data: [...]}` is present and an array; throws a clear Error on anything
 * else (drift/missing fields), so a HowLongToBeat-side change hides the lane
 * (src/worker.js's handleFpm catches this) rather than corrupting FPM scores
 * with garbage lengths.
 * @param {object} json - raw /api/bleed response body.
 * @returns {Array<{hltbId: number, name: string, alias: string, compMain: number, compPlus: number, comp100: number}>}
 */
export function parseHltbSearch(json) {
  const data = json?.data;
  if (!Array.isArray(data)) {
    throw new Error("Unexpected HLTB search response shape — missing data array.");
  }
  return data.map((entry) => {
    if (typeof entry?.game_id !== "number" || typeof entry?.game_name !== "string") {
      throw new Error("Unexpected HLTB entry shape — missing game_id or game_name.");
    }
    return {
      hltbId: entry.game_id,
      name: entry.game_name,
      alias: typeof entry.game_alias === "string" ? entry.game_alias : "",
      compMain: typeof entry.comp_main === "number" ? entry.comp_main : 0,
      compPlus: typeof entry.comp_plus === "number" ? entry.comp_plus : 0,
      comp100: typeof entry.comp_100 === "number" ? entry.comp_100 : 0,
    };
  });
}

/** Maps FPM_LENGTH_FIELD's HLTB-API-style name to parseHltbSearch's camelCase
 * output field, so the lane can read "whichever length field is configured"
 * generically instead of hardcoding `.compMain` everywhere. */
const LENGTH_FIELD_MAP = {
  comp_main: "compMain",
  comp_plus: "compPlus",
  comp_100: "comp100",
};

/**
 * Read the configured length field (FPM_LENGTH_FIELD by default) off a
 * parsed HLTB entry or cached resolved record, in seconds.
 * @param {{compMain?: number, compPlus?: number, comp100?: number}} record
 * @param {string} field - one of 'comp_main' | 'comp_plus' | 'comp_100'.
 * @returns {number}
 */
export function hltbLengthSeconds(record, field = FPM_LENGTH_FIELD) {
  const key = LENGTH_FIELD_MAP[field] || LENGTH_FIELD_MAP[FPM_LENGTH_FIELD];
  return record?.[key] ?? 0;
}

// ---------------------------------------------------------------------------
// Title matching — normalized-title similarity only (see file header: HLTB
// carries no Steam appid on its entries).
// ---------------------------------------------------------------------------

const EDITION_NOISE = /\b(goty|edition)\b/g;

/**
 * Lowercase, strip ®/™ and punctuation, drop minimal edition/"goty" noise,
 * collapse whitespace. Deterministic and pure.
 * @param {string} s
 * @returns {string}
 */
export function normalizeTitle(s) {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/['’]/g, "") // drop apostrophes without splitting the word (baldur's -> baldurs)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(EDITION_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/**
 * Sørensen–Dice bigram coefficient between two titles, after normalizeTitle.
 * Deterministic, 0 (no shared bigrams / either empty) to 1 (identical after
 * normalization).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const bigramsA = bigrams(na);
  const bigramsB = bigrams(nb);
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;

  const counts = new Map();
  for (const g of bigramsA) counts.set(g, (counts.get(g) || 0) + 1);

  let matches = 0;
  for (const g of bigramsB) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      matches++;
      counts.set(g, c - 1);
    }
  }

  return (2 * matches) / (bigramsA.length + bigramsB.length);
}

/**
 * Find the best-matching HLTB entry for a candidate's title, checking both
 * `name` and `alias` and taking the max score. Returns the matched entry
 * (plus `matchScore`/`matchMethod: 'name'`) only if the best score clears
 * `threshold` — a below-threshold "best guess" is never returned, since a
 * wrong-game length is worse than no length at all.
 * @param {string} candidateTitle
 * @param {Array<{name: string, alias: string}>} parsedEntries
 * @param {number} threshold
 * @returns {(object & {matchScore: number, matchMethod: 'name'})|null}
 */
export function matchHltbEntry(candidateTitle, parsedEntries, threshold = FPM_MATCH_THRESHOLD) {
  let best = null;
  let bestScore = 0;

  for (const entry of parsedEntries || []) {
    const nameScore = titleSimilarity(candidateTitle, entry.name);
    const aliasScore = entry.alias ? titleSimilarity(candidateTitle, entry.alias) : 0;
    const score = Math.max(nameScore, aliasScore);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (best && bestScore >= threshold) {
    return { ...best, matchScore: bestScore, matchMethod: "name" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lane math — pure, testable.
// ---------------------------------------------------------------------------

/** fpm = Wilson quality ÷ main-story hours. 0 if mainHours is missing/≤0
 * (never divide by zero / return Infinity). */
export function fpmScore(wilsonQuality, mainHours) {
  if (!(mainHours > 0)) return 0;
  return wilsonQuality / mainHours;
}

/** Display value: fun/hr = round(quality% ÷ hours, 1dp). */
export function funPerHourDisplay(wilsonQuality, mainHours) {
  if (!(mainHours > 0)) return 0;
  return Math.round(((wilsonQuality * 100) / mainHours) * 10) / 10;
}

/**
 * Lane-qualification predicate: a resolved length (compMain > 0, read via
 * the configured FPM_LENGTH_FIELD) AND at least FPM_MIN_LENGTH_HOURS of
 * main-story. The existing Best-of quality floor (qualifiesForHof) is a
 * separate, worker-level concern — this predicate is only about the length
 * signal being present and non-degenerate.
 * @param {{compMain?: number, mainHours?: number}} params
 * @returns {boolean}
 */
export function qualifiesForFpm({ compMain, mainHours } = {}) {
  return typeof compMain === "number" && compMain > 0 && typeof mainHours === "number" && mainHours >= FPM_MIN_LENGTH_HOURS;
}

/**
 * Stable sort for the FPM lane: fpm score descending, atHistoricalLow as
 * tiebreak (mirrors sortWishlistLane's style). Does not mutate the input.
 * @param {Array<{fpm?: number, atHistoricalLow?: boolean}>} items
 * @returns {Array<object>}
 */
export function sortFpmLane(items) {
  return [...items].sort((a, b) => {
    const fpmDiff = (b.fpm ?? 0) - (a.fpm ?? 0);
    if (fpmDiff !== 0) return fpmDiff;
    const aLow = a.atHistoricalLow === true ? 1 : 0;
    const bLow = b.atHistoricalLow === true ? 1 : 0;
    return bLow - aLow;
  });
}

/**
 * Deterministic why-line, e.g. "94% quality ÷ 6.5h main story — 14.5 fun/hr".
 * @param {number} qualityPercent - 0-100, already rounded by the caller.
 * @param {number} mainHours
 * @param {number} funPerHour
 * @returns {string}
 */
export function fpmWhyLine(qualityPercent, mainHours, funPerHour) {
  return `${qualityPercent}% quality ÷ ${mainHours.toFixed(1)}h main story — ${funPerHour.toFixed(1)} fun/hr`;
}

// ---------------------------------------------------------------------------
// Cache (KV) — own key, `hltb:<appid>`, distinct from spyQueue's `v2:spytag:`
// and deckCompat's `deck:` keys.
// ---------------------------------------------------------------------------

function hltbCacheKey(appid) {
  return `hltb:${appid}`;
}

/**
 * Read one appid's cached HLTB resolution. Same "cached vs. not fetched yet"
 * convention as getCachedSpy: a real KV miss returns `{cached:false}`; a
 * cached negative result (no match found) returns `{cached:true, data:null}`.
 * @returns {Promise<{cached: boolean, data: object|null|undefined}>}
 */
export async function getCachedHltb(env, appid) {
  const raw = await env.TAG_CACHE.get(hltbCacheKey(appid));
  if (raw == null) return { cached: false, data: undefined };
  return { cached: true, data: JSON.parse(raw) };
}

async function setCachedHltb(env, appid, data, ttlSeconds) {
  await env.TAG_CACHE.put(hltbCacheKey(appid), JSON.stringify(data), {
    expirationTtl: ttlSeconds,
  });
}

// ---------------------------------------------------------------------------
// Throttled background queue — mirrors src/spyQueue.js's module-scoped
// pattern (own queue, own pacing, own test seams). Lives here (not
// src/worker.js) because src/worker.js is wrangler's `main` module — see
// spyQueue.js's header comment for why that matters.
// ---------------------------------------------------------------------------

let hltbTokens = null;
let hltbLastFetchAt = 0;
let hltbMinIntervalMs = 1000;
const hltbQueue = [];
const hltbQueued = new Set();
let hltbQueueRunning = false;

/** TEST-ONLY seam: shrink the ~1 req/sec pacing so queue tests don't burn
 * real wall-clock seconds. Never called from production code. */
export function __setHltbMinIntervalMsForTests(ms) {
  hltbMinIntervalMs = ms;
}

/** TEST-ONLY seam: clear the module-scoped queue bookkeeping (and cached
 * tokens) between tests. Never called from production code. */
export function __resetHltbQueueForTests() {
  hltbQueue.length = 0;
  hltbQueued.clear();
  hltbQueueRunning = false;
  hltbLastFetchAt = 0;
  hltbTokens = null;
}

/** Pure: how many ms must still elapse before the next HLTB call is allowed. */
export function computeHltbWaitMs(lastFetchAt, now, minIntervalMs) {
  if (!lastFetchAt) return 0;
  const elapsed = now - lastFetchAt;
  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve + cache one {appid, title} item: search HLTB for `title`, parse,
 * match, cache the result (positive 30d, negative 7d). Fail-soft per game —
 * ANY failure along the way (no tokens, network error, parse throw, no
 * match) lands on a cached negative result rather than throwing out of the
 * pump, per SPEC.md's per-game fail-soft requirement.
 *
 * Shares ONE token pair (the module-scoped `hltbTokens`) across a whole pump
 * run; on a 403 (token expired) it re-inits once and retries that one search
 * once, mirroring the live site's own behaviour, and keeps the refreshed
 * tokens for subsequent items in the queue.
 */
async function fetchAndCacheHltb(env, item) {
  const wait = computeHltbWaitMs(hltbLastFetchAt, Date.now(), hltbMinIntervalMs);
  if (wait > 0) await sleep(wait);
  hltbLastFetchAt = Date.now();

  let result = null;
  try {
    if (!hltbTokens) throw new Error("no HLTB tokens available");

    let json;
    try {
      json = await hltbSearch(hltbTokens, item.title);
    } catch (err) {
      if (err.status === 403) {
        hltbTokens = await hltbInit();
        json = await hltbSearch(hltbTokens, item.title);
      } else {
        throw err;
      }
    }

    const entries = parseHltbSearch(json);
    const match = matchHltbEntry(item.title, entries);
    if (match) {
      result = {
        hltbId: match.hltbId,
        compMain: match.compMain,
        compPlus: match.compPlus,
        comp100: match.comp100,
        matchMethod: match.matchMethod,
      };
    }
  } catch {
    result = null;
  }

  const ttl = result ? HLTB_CACHE_TTL_SECONDS : HLTB_CACHE_NEGATIVE_TTL_SECONDS;
  await setCachedHltb(env, item.appid, result, ttl);
}

async function pumpHltbQueue(env) {
  if (hltbQueueRunning) return;
  hltbQueueRunning = true;
  try {
    while (hltbQueue.length > 0) {
      const item = hltbQueue.shift();
      hltbQueued.delete(item.appid);
      await fetchAndCacheHltb(env, item);
    }
  } finally {
    hltbQueueRunning = false;
  }
}

/**
 * Kick or continue the background HLTB fetch queue for the given
 * {appid, title} items, deduping against whatever's already queued/
 * in-flight. `tokens` (from a fresh hltbInit() call) becomes the shared
 * token pair the whole pump uses; never awaited by the caller —
 * /api/fpm must return before this finishes.
 * @param {object} env
 * @param {object} ctx
 * @param {Array<{appid: number, title: string}>} items
 * @param {{token: string, hpKey: string, hpVal: string}} tokens
 */
export function enqueueHltbFetch(env, ctx, items, tokens) {
  if (tokens) hltbTokens = tokens;
  let added = false;
  for (const item of items) {
    if (hltbQueued.has(item.appid)) continue;
    hltbQueued.add(item.appid);
    hltbQueue.push(item);
    added = true;
  }
  if (added) ctx.waitUntil(pumpHltbQueue(env));
}
