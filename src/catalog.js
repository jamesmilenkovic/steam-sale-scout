// Steam Sale Scout — FPM catalog (Increment 7.7): "every Steam game worth
// ranking, by fun density." Pages SteamSpy's bulk `all` feed (owners-
// descending, 1000 rows/page), floor-qualifies each row straight off the
// bulk fields (no per-appid SteamSpy calls needed for qualification), and
// persists every floor-passer into D1 — the lane's own durable database, so
// the multi-run HowLongToBeat fill survives `wrangler dev` restarts instead
// of starting over.
//
// Lives in its own module for the same load-bearing reason as spyQueue.js/
// hltb.js: src/worker.js is wrangler's `main` entry module, and workerd
// treats every named export of the main module as a potential additional
// handler — see spyQueue.js's header comment. This file owns its own
// network fetch (SteamSpy `all`) AND its own D1 read/write helpers AND the
// sync orchestration (mirrors hltb.js's choice to keep handshake+fetch+
// parse+queue together in one file, since — like hltb.js — this adapter
// owns its own upstream network calls, not just pure logic).
//
// LIVE-PROBED (2026-07-15, scratchpad/probe-findings-7.7.md — mandatory
// live probe per project discipline before building against a guessed
// shape):
//   - `GET https://steamspy.com/api.php?request=all&page=N`, 0-indexed,
//     returns a JSON OBJECT keyed by appid (Object.values() to get rows),
//     1000 rows/page (full pages), owners-descending.
//   - `owners` is the SAME range-string format spyQueue.js's
//     parseOwnersMidpoint already parses (`"10,000 .. 20,000"`) — reused
//     as-is below, not forked.
//   - Floor-pass rate does NOT taper to zero by page ~40 like SPEC.md's
//     ~8-12k estimate assumed — still 150-870 passers/page through page 40
//     (~16k cumulative). Real end of catalog is a PARTIAL page (~page 86,
//     544 rows) — `rows.length < CATALOG_PAGE_SIZE` is treated as an
//     end-of-catalog signal in addition to "a full page yields zero
//     floor-passers".
//   - The `all` endpoint's rate limit is real and stricter than
//     `appdetails`': a burst triggers `HTTP 200` with a PLAIN-TEXT body
//     `"Connection failed: Too many connections"` (not JSON, not a clean
//     error status) — detected by body shape, not just status. Interleaved
//     plain `HTTP 500` empty-body responses were also seen. Both are
//     treated as "back off and retry", never as "end of data". A retry
//     after 65s still got throttled once triggered, so the backoff here
//     starts well above a naive 60s and grows on repeated throttles.
//
// INCREMENT 7.8 (2026-07-18) — app-type classification + sync resilience.
// James, watching the 7.7 fill live, found free promotional demos/prologues
// ranking as if they were real games (skewing the fun-per-minute leaderboard
// — see scratchpad/probe-findings-7.8.md). No in-pipeline source classifies
// app type except storefront `appdetails` (`type: "game"|"dlc"|"demo"|...`)
// — this file's "app-type classification" section below adds a second
// D1-persisted resumable-batch job (same shape as the HLTB batch: gentle
// pacing, backoff-and-retry on throttle, write-through per row, never
// re-fetch a classified row). `fpm_catalog` gains `app_type`/
// `type_checked_at`; `selectMatchedCatalogRows`/`selectHltbBatch` both now
// gate on `app_type = 'game'` (unclassified rows are excluded, not shown by
// default — a deliberate exception to this app's usual "unknown ≠ excluded"
// convention, per the PO's scoping decision). KNOWN GAP (accepted,
// documented): `type === 'game'` does not catch every promotional
// demo/prologue (`Stoneshard: Prologue`/`The Riftbreaker: Prologue` both
// classify `game`) — see probe-findings-7.8.md for why a secondary signal
// was investigated and rejected.

import { qualifiesForFpmFloor, hltbInit, enqueueHltbFetch, getCachedHltb, hltbLengthSeconds, FPM_LENGTH_FIELD } from "./hltb.js";
import { parseOwnersMidpoint } from "./spyQueue.js";
import { quality } from "./score.js";

const STEAMSPY_ALL_URL = "https://steamspy.com/api.php";

/** Full page size SteamSpy's `all` request returns — a page with fewer rows
 * than this is the (partial) last page. */
export const CATALOG_PAGE_SIZE = 1000;

/** Gentle pacing between page fetches — probe found a steadily-paced cold
 * crawl may not hit the origin's throttle at all (CDN absorbs re-fetches of
 * already-warm pages); this is deliberately well under 1 req/sec to stay on
 * the safe side of "no burst mode" for a genuinely cold multi-page crawl. */
export const CATALOG_PACING_MS = 1500;

/** Backoff on a throttle/error signal. Probe found a retry 65s after a
 * throttle still got throttled, so this starts well above a naive 60s and
 * doubles (capped) on repeated hits. */
export const CATALOG_BACKOFF_BASE_MS = 120_000;
export const CATALOG_BACKOFF_MAX_MS = 600_000;

/** How many consecutive bad (throttled/error) pages to tolerate before
 * giving up on this crawl run entirely — a safety valve, not a real limit
 * in practice (SteamSpy pages are CDN-cached and cheap to re-fetch, so the
 * NEXT sync run just starts over from page 0 at no real cost). */
export const CATALOG_MAX_CONSECUTIVE_BAD_PAGES = 20;

/** Rows to enqueue against HowLongToBeat per `/api/fpm/sync` run — bounds a
 * single sync to a predictable chunk of work; successive runs extend
 * coverage down the priority-ordered tail until the whole catalog is
 * matched (SPEC.md: "useful after batch one, complete after ~3-4"). */
export const FPM_SYNC_BATCH = 3000;

/** A catalog row's SteamSpy stats (owners/reviews/wilson) are refreshed on
 * sync only once this many days stale — see upsertCatalogRows' WHERE-gated
 * ON CONFLICT clause below. */
export const FPM_SPY_TTL_DAYS = 7;
const FPM_SPY_TTL_MS = FPM_SPY_TTL_DAYS * 24 * 60 * 60 * 1000;

/** An unmatched (checked, no HLTB result) row is retried after this many
 * days — a matched row (main_hours set) is NEVER retried, regardless of
 * age (lengths are near-static). */
export const FPM_HLTB_TTL_DAYS = 30;
const FPM_HLTB_TTL_MS = FPM_HLTB_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Batch size for the app-type classification backfill per sync run
 * (Increment 7.8) — ~500 rows at FPM_TYPE_PACING_MS's ~1 req/sec is ~8-9
 * min/run, per the live probe's own recommendation (scratchpad/
 * probe-findings-7.8.md). Deliberately smaller than FPM_SYNC_BATCH: this is
 * the pipeline's real bottleneck now, since both selectMatchedCatalogRows
 * and selectHltbBatch gate on app_type = 'game'. */
export const FPM_TYPE_BATCH = 500;

/** A failed/missing/throttled classification attempt is retried after this
 * many days — same convention as FPM_HLTB_TTL_DAYS. A SUCCESSFUL
 * classification (app_type set) is never retried, at any age — a Steam
 * app's type does not change. */
export const FPM_TYPE_TTL_DAYS = 30;
const FPM_TYPE_TTL_MS = FPM_TYPE_TTL_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure — bulk-row shaping, floor qualification, throttle detection.
// ---------------------------------------------------------------------------

/**
 * Shape one raw SteamSpy `all` bulk row into the fields the catalog needs.
 * Reuses parseOwnersMidpoint (spyQueue.js) for the owners range string and
 * score.js's quality() (Wilson lower bound) for wilson — both already
 * proven/tested elsewhere, not forked here.
 * @param {object} raw - one value from Object.values(bulk page JSON).
 * @returns {{appid: number, name: string, owners: number, positive: number, negative: number, wilson: number}}
 */
export function catalogRowFromBulk(raw) {
  const positive = Number(raw?.positive) || 0;
  const negative = Number(raw?.negative) || 0;
  return {
    appid: Number(raw?.appid),
    name: typeof raw?.name === "string" ? raw.name : "",
    owners: parseOwnersMidpoint(raw?.owners),
    positive,
    negative,
    wilson: quality(positive, negative),
  };
}

/**
 * Whether one shaped bulk row clears the FPM floor (50 reviews / 0.7 Wilson
 * / 5000 owners) — computable straight from the bulk feed, no per-appid
 * SteamSpy call needed. Thin wrapper over hltb.js's qualifiesForFpmFloor so
 * there is exactly one floor definition in the codebase.
 * @param {{positive: number, negative: number, owners: number}} row
 * @returns {boolean}
 */
export function floorPassesCatalogRow(row) {
  return qualifiesForFpmFloor({
    reviews: { positive: row.positive, negative: row.negative },
    owners: row.owners,
  });
}

/**
 * Detect SteamSpy's `all`-endpoint throttle response by body shape (not just
 * HTTP status) — live-probed shape is a 200 with a PLAIN-TEXT body
 * containing "Too many connections" (also seen: "Connection failed").
 * @param {string} text
 * @returns {boolean}
 */
export function isThrottledBody(text) {
  return typeof text === "string" && (text.includes("Too many connections") || text.includes("Connection failed"));
}

/** Pure: how many ms must still elapse before the next catalog page fetch is
 * allowed — mirrors spyQueue.js's computeSpyWaitMs/hltb.js's computeHltbWaitMs. */
export function computeCatalogWaitMs(lastFetchAt, now, minIntervalMs) {
  if (!lastFetchAt) return 0;
  const elapsed = now - lastFetchAt;
  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Network — one page fetch, typed by outcome (ok/throttled/error) so the
// crawl loop below can retry-vs-advance without re-deriving the throttle
// detection logic at the call site.
// ---------------------------------------------------------------------------

/**
 * Fetch one page of SteamSpy's `all` request. Never throws — network
 * errors, the throttle body, a bare 500, and an unparsable/unexpected body
 * all resolve to a typed `status` the caller backs off and retries on.
 * @param {number} page - 0-indexed.
 * @returns {Promise<{status: 'ok'|'throttled'|'error', rows: object[]}>}
 */
export async function fetchSteamSpyAllPage(page) {
  const url = new URL(STEAMSPY_ALL_URL);
  url.searchParams.set("request", "all");
  url.searchParams.set("page", String(page));

  let res;
  try {
    res = await fetch(url.toString());
  } catch {
    return { status: "error", rows: [] };
  }

  let text;
  try {
    text = await res.text();
  } catch {
    return { status: "error", rows: [] };
  }

  // Probe: a bare 500 (empty body) was seen interleaved with the plain-text
  // throttle message — both are "back off and retry", not "end of data".
  if (res.status === 500 || isThrottledBody(text)) {
    return { status: "throttled", rows: [] };
  }
  if (!res.ok) {
    return { status: "error", rows: [] };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: "error", rows: [] };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { status: "error", rows: [] };
  }

  return { status: "ok", rows: Object.values(json) };
}

// ---------------------------------------------------------------------------
// D1 — schema + CRUD. Every statement is a single, explicit SQL string
// (no query builder) so the shape is easy to audit; a matching in-memory
// mock (test/helpers/mockD1.mjs, backed by node:sqlite) exercises the exact
// same SQL under `node --test`.
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS fpm_catalog (
  appid INTEGER PRIMARY KEY,
  name TEXT,
  owners INTEGER NOT NULL DEFAULT 0,
  positive INTEGER NOT NULL DEFAULT 0,
  negative INTEGER NOT NULL DEFAULT 0,
  wilson REAL NOT NULL DEFAULT 0,
  main_hours REAL,
  match_method TEXT,
  source_catalog INTEGER NOT NULL DEFAULT 0,
  source_owned INTEGER NOT NULL DEFAULT 0,
  source_deal INTEGER NOT NULL DEFAULT 0,
  spy_synced_at INTEGER,
  hltb_checked_at INTEGER,
  app_type TEXT,
  type_checked_at INTEGER
)`;

// Increment 7.8: app_type/type_checked_at are also added via ALTER TABLE for
// an EXISTING install (the live D1 already has ~4,700/18,306 rows filled) —
// CREATE TABLE IF NOT EXISTS only helps a brand-new database; it does
// nothing to a table that already exists without these columns. SQLite/D1
// has no `ADD COLUMN IF NOT EXISTS`, so each statement is wrapped in a
// try/catch below and simply ignored once the column already exists — same
// "safe to call on every request" idempotence as CREATE_TABLE_SQL.
const ALTER_TABLE_STATEMENTS = [
  "ALTER TABLE fpm_catalog ADD COLUMN app_type TEXT",
  "ALTER TABLE fpm_catalog ADD COLUMN type_checked_at INTEGER",
];

/** Create the catalog table if it doesn't exist yet, and add any columns a
 * pre-existing install is missing (Increment 7.8's app_type/type_checked_at
 * — see ALTER_TABLE_STATEMENTS above). Coder's call (per SPEC.md, "CREATE
 * TABLE IF NOT EXISTS on the sync path — Coder's call, local-only app") over
 * `wrangler d1 migrations`: this is a single-table, single-environment,
 * local-only app — a migrations directory would be pure ceremony here. Safe
 * to call on every request (idempotent, cheap, never loses existing rows). */
export async function ensureCatalogSchema(env) {
  await env.FPM_DB.prepare(CREATE_TABLE_SQL).run();
  for (const sql of ALTER_TABLE_STATEMENTS) {
    try {
      await env.FPM_DB.prepare(sql).run();
    } catch {
      // Column already exists — expected on every call after the first.
    }
  }
}

// Upsert every floor-passing bulk row. On a brand-new appid: full insert,
// source_owned/source_deal start at 0 (a fresh row can't yet be known to be
// owned/on-sale — that's a separate union step). On an existing appid: the
// SET list deliberately never touches main_hours/match_method/
// hltb_checked_at/source_owned/source_deal — a re-crawl can only refresh
// SteamSpy stats, never reset HLTB progress or previously-set source flags.
// The WHERE clause on the DO UPDATE additionally gates even THAT stats
// refresh behind FPM_SPY_TTL_DAYS staleness, so a same-day re-sync (pages
// are CDN-cached and cheap to re-fetch) doesn't churn D1 writes for rows
// that are already fresh.
const UPSERT_SQL = `INSERT INTO fpm_catalog
  (appid, name, owners, positive, negative, wilson, spy_synced_at, source_catalog, source_owned, source_deal)
VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)
ON CONFLICT(appid) DO UPDATE SET
  name = excluded.name,
  owners = excluded.owners,
  positive = excluded.positive,
  negative = excluded.negative,
  wilson = excluded.wilson,
  spy_synced_at = excluded.spy_synced_at,
  source_catalog = 1
WHERE fpm_catalog.spy_synced_at IS NULL OR fpm_catalog.spy_synced_at < ?`;

/**
 * Bulk-upsert floor-passing catalog rows via one D1 `.batch()` call (atomic,
 * one round-trip per page rather than one per row).
 * @param {object} env - needs env.FPM_DB.
 * @param {Array<{appid: number, name: string, owners: number, positive: number, negative: number, wilson: number}>} rows
 * @param {number} [nowMs]
 */
export async function upsertCatalogRows(env, rows, nowMs = Date.now()) {
  if (!rows || rows.length === 0) return;
  const staleCutoff = nowMs - FPM_SPY_TTL_MS;
  const stmt = env.FPM_DB.prepare(UPSERT_SQL);
  const statements = rows.map((r) =>
    stmt.bind(r.appid, r.name, r.owners, r.positive, r.negative, r.wilson, nowMs, staleCutoff),
  );
  await env.FPM_DB.batch(statements);
}

/** Flag a set of already-catalogued appids as owned/on-sale (informational —
 * used only to prioritize the HLTB sync batch, never as a live owned/deal
 * annotation; that's a request-time join in src/worker.js's handleFpm, same
 * as every other lane). An appid not already in the catalog (didn't clear
 * the floor) is simply not touched — union is INTO the catalog, not a
 * separate stream. Flags are never cleared once set. */
export async function markOwned(env, appids) {
  await markSourceFlag(env, appids, "source_owned");
}

export async function markDeal(env, appids) {
  await markSourceFlag(env, appids, "source_deal");
}

async function markSourceFlag(env, appids, column) {
  if (!appids || appids.length === 0) return;
  // `column` is always one of the two hardcoded literals above (never
  // caller/request-controlled), so string-building the column name here
  // carries no injection risk.
  const stmt = env.FPM_DB.prepare(`UPDATE fpm_catalog SET ${column} = 1 WHERE appid = ?`);
  await env.FPM_DB.batch(appids.map((appid) => stmt.bind(appid)));
}

/**
 * Select up to `limit` NULL-main_hours rows due for an HLTB lookup, in
 * priority order: owned-or-deal first (James's reference points and buy
 * candidates), then owners/reviews descending. A row is due if it's never
 * been checked, or was checked but unmatched more than FPM_HLTB_TTL_DAYS
 * ago — a MATCHED row (main_hours set) is never selected again, at any
 * age (this WHERE clause alone is what makes sync resumable-by-construction).
 *
 * Increment 7.8: also gates on `app_type = 'game'` — unclassified
 * (app_type IS NULL) and non-game rows are never enqueued for an HLTB
 * lookup, saving HLTB budget for rows that can actually reach the lane. A
 * row already selected in a prior run that later classifies non-game simply
 * stops matching this WHERE clause on the next run — no separate removal
 * step needed.
 * @param {object} env
 * @param {{limit: number, staleCutoffMs: number}} options
 * @returns {Promise<Array<{appid: number, name: string}>>}
 */
export async function selectHltbBatch(env, { limit, staleCutoffMs }) {
  const result = await env.FPM_DB.prepare(
    `SELECT appid, name FROM fpm_catalog
     WHERE main_hours IS NULL
       AND app_type = 'game'
       AND (hltb_checked_at IS NULL OR hltb_checked_at < ?)
     ORDER BY (source_owned + source_deal) DESC, owners DESC, (positive + negative) DESC
     LIMIT ?`,
  )
    .bind(staleCutoffMs, limit)
    .all();
  return result.results || [];
}

/**
 * Write back one HLTB resolution. `mainHours: null` + `matchMethod: 'none'`
 * records a checked-but-unmatched row (retried after FPM_HLTB_TTL_DAYS); any
 * other `mainHours` (including a sub-FPM_MIN_LENGTH_HOURS value — a genuine
 * match that's just too short to qualify) permanently marks the row matched
 * and it is never selected again, mirroring src/hltb.js's "a sub-floor MATCH
 * is not the same as no length data" distinction from Increment 7.5.
 */
export async function recordHltbResult(env, appid, { mainHours, matchMethod, checkedAtMs }) {
  await env.FPM_DB.prepare("UPDATE fpm_catalog SET main_hours = ?, match_method = ?, hltb_checked_at = ? WHERE appid = ?")
    .bind(mainHours, matchMethod, checkedAtMs, appid)
    .run();
}

/** Catalog-wide counts for GET /api/fpm/sync/status and the /api/fpm "ranked
 * X of Y" line. `unmatched` is checked-but-no-result rows only (matches
 * hltb.js's pre-7.7 unmatchedCount semantics); `pending` is everything still
 * without a length at all (never-checked + unmatched combined) — the
 * complement of `matched`. `matched`/`unmatched`/`pending` are intentionally
 * NOT gated on app_type (Increment 7.8) — they track HLTB fill progress
 * exactly as before; `classified`/`nonGame` (new) separately track the
 * app-type backfill's own progress. */
export async function getCatalogStats(env) {
  const row = await env.FPM_DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN main_hours IS NOT NULL THEN 1 ELSE 0 END) AS matched,
            SUM(CASE WHEN match_method = 'none' THEN 1 ELSE 0 END) AS unmatched,
            SUM(CASE WHEN app_type IS NOT NULL THEN 1 ELSE 0 END) AS classified,
            SUM(CASE WHEN app_type IS NOT NULL AND app_type != 'game' THEN 1 ELSE 0 END) AS nonGame
     FROM fpm_catalog`,
  ).first();
  const total = row?.total || 0;
  const matched = row?.matched || 0;
  const unmatched = row?.unmatched || 0;
  const classified = row?.classified || 0;
  const nonGame = row?.nonGame || 0;
  return { total, matched, unmatched, pending: total - matched, classified, nonGame };
}

/** Every matched (main_hours NOT NULL) catalog row — the lane's actual
 * candidate set. src/worker.js's handleFpm applies the FPM_MIN_LENGTH_HOURS
 * floor, scoring, and owned/deal annotation on top of this.
 *
 * Increment 7.8: also gated on `app_type = 'game'` — this is THE lane-gating
 * choke point. An unclassified row (app_type IS NULL) fails the SQL
 * equality check the same as an explicitly non-game row, so both are
 * excluded by construction (the PO's "exclude-until-classified" decision) —
 * they stay in D1 (data is data) but never render here. */
export async function selectMatchedCatalogRows(env) {
  const result = await env.FPM_DB.prepare(
    `SELECT appid, name, owners, positive, negative, wilson, main_hours, match_method
     FROM fpm_catalog WHERE main_hours IS NOT NULL AND app_type = 'game'`,
  ).all();
  return result.results || [];
}

// ---------------------------------------------------------------------------
// Catalog crawl — pages SteamSpy `all` with gentle, backing-off pacing,
// upserting floor-passers incrementally (per page) so a kill mid-crawl loses
// no progress already written to D1.
// ---------------------------------------------------------------------------

let catalogPacingMs = CATALOG_PACING_MS;
let catalogBackoffBaseMs = CATALOG_BACKOFF_BASE_MS;
let catalogBackoffMaxMs = CATALOG_BACKOFF_MAX_MS;

/** TEST-ONLY seam: shrink pacing so crawl tests don't burn real wall-clock
 * time. Never called from production code. */
export function __setCatalogPacingMsForTests(ms) {
  catalogPacingMs = ms;
}

/** TEST-ONLY seam: shrink backoff so throttle-retry tests don't burn real
 * wall-clock time. Never called from production code. */
export function __setCatalogBackoffMsForTests(baseMs, maxMs) {
  catalogBackoffBaseMs = baseMs;
  catalogBackoffMaxMs = maxMs;
}

/** TEST-ONLY seam: restore production pacing/backoff between tests. */
export function __resetCatalogPacingForTests() {
  catalogPacingMs = CATALOG_PACING_MS;
  catalogBackoffBaseMs = CATALOG_BACKOFF_BASE_MS;
  catalogBackoffMaxMs = CATALOG_BACKOFF_MAX_MS;
}

/**
 * Page through SteamSpy `all` from page 0, upserting floor-passers into D1
 * as each page resolves, until a full page yields zero floor-passers OR a
 * partial (< CATALOG_PAGE_SIZE-row) page is reached (the real end-of-catalog
 * signal, per the live probe — the floor-pass rate does not taper to zero
 * anywhere near the true last page). A throttle/error response backs off
 * (starting at catalogBackoffBaseMs, doubling to catalogBackoffMaxMs) and
 * retries the SAME page rather than advancing or giving up immediately;
 * CATALOG_MAX_CONSECUTIVE_BAD_PAGES bad responses in a row abandons this run
 * (the next sync starts over from page 0 — cheap, pages are CDN-cached).
 * @param {object} env - needs env.FPM_DB.
 * @param {{maxPages?: number, now?: number}} [options] - maxPages is a
 *   TEST-ONLY bound on distinct pages crawled (production callers never
 *   pass it — the whole point of this increment is no catalog cap).
 * @returns {Promise<{pagesCrawled: number, totalPassers: number}>}
 */
export async function crawlAndUpsertCatalog(env, options = {}) {
  const maxPages = options.maxPages ?? Infinity;
  const nowMs = options.now ?? Date.now();

  let page = 0;
  let backoff = catalogBackoffBaseMs;
  let lastFetchAt = 0;
  let totalPassers = 0;
  let pagesCrawled = 0;
  let consecutiveBad = 0;

  while (page < maxPages) {
    const wait = computeCatalogWaitMs(lastFetchAt, Date.now(), catalogPacingMs);
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();

    const result = await fetchSteamSpyAllPage(page);

    if (result.status !== "ok") {
      consecutiveBad++;
      if (consecutiveBad >= CATALOG_MAX_CONSECUTIVE_BAD_PAGES) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, catalogBackoffMaxMs);
      continue; // retry the same page — never advance on a bad response
    }

    consecutiveBad = 0;
    backoff = catalogBackoffBaseMs;
    pagesCrawled++;

    const rows = result.rows.map(catalogRowFromBulk);
    const passers = rows.filter(floorPassesCatalogRow);
    if (passers.length > 0) {
      await upsertCatalogRows(env, passers, nowMs);
      totalPassers += passers.length;
    }

    const isPartialPage = result.rows.length < CATALOG_PAGE_SIZE;
    const isZeroPasserFullPage = passers.length === 0 && result.rows.length >= CATALOG_PAGE_SIZE;
    if (isPartialPage || isZeroPasserFullPage) break;

    page++;
  }

  return { pagesCrawled, totalPassers };
}

// ---------------------------------------------------------------------------
// App-type classification (Increment 7.8) — storefront `appdetails`'s `type`
// field is the one reliable classifier for excluding demos/DLC/prologues
// from the FPM lane (SteamSpy bulk has no type field; title heuristics
// false-positive on real games — see scratchpad/probe-findings-7.8.md for
// the live-probed shape and why a secondary signal was investigated and
// rejected). Mirrors the catalog crawl's shape immediately above: D1-
// persisted, resumable-by-construction (a classified row is never
// reselected — see selectTypeClassificationBatch's WHERE clause), gentle
// ~1 req/sec pacing, doubling backoff-and-retry (same appid, never advance)
// on a throttle. Unlike SteamSpy's `all` throttle (a 200 with a fake plain-
// text body), the probe found appdetails' throttle is a genuine, reliable
// HTTP 429 — so the primary throttle signal here is `res.status`, with an
// unexpected/non-keyed body shape treated as the same backoff-and-retry
// case defensively (the probe's 429 sample had a JSON `null` body, not the
// usual `{<appid>: {...}}` object).
// ---------------------------------------------------------------------------

const APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";

/** Gentle pacing between classification requests — the probe found the real
 * throttle threshold is ~4 req/sec; this stays an order of magnitude under
 * that (same order as src/hltb.js's ~1 req/sec queue pacing), matching the
 * probe's own recommendation rather than pushing closer to the edge. */
export const FPM_TYPE_PACING_MS = 1000;

/** Backoff on a throttle (genuine HTTP 429). The probe's extended burst test
 * found recovery took ~155s after a throttle hit; this starts comfortably
 * above that and doubles (capped) on repeated hits — the same "longer than
 * the naive number" discipline as CATALOG_BACKOFF_BASE_MS/MAX_MS above. */
export const FPM_TYPE_BACKOFF_BASE_MS = 170_000;
export const FPM_TYPE_BACKOFF_MAX_MS = 600_000;

/** Consecutive bad (throttled/error) classification attempts to tolerate
 * before giving up on this run's remaining batch — mirrors
 * CATALOG_MAX_CONSECUTIVE_BAD_PAGES. Cheap to abandon: the next sync run's
 * batch selection picks the exact same unclassified rows right back up
 * (type_checked_at was never written for them), so no progress is lost. */
export const FPM_TYPE_MAX_CONSECUTIVE_BAD = 20;

let typePacingMs = FPM_TYPE_PACING_MS;
let typeBackoffBaseMs = FPM_TYPE_BACKOFF_BASE_MS;
let typeBackoffMaxMs = FPM_TYPE_BACKOFF_MAX_MS;

/** TEST-ONLY seam: shrink pacing so classification tests don't burn real
 * wall-clock time. Never called from production code. */
export function __setTypePacingMsForTests(ms) {
  typePacingMs = ms;
}

/** TEST-ONLY seam: shrink backoff so throttle-retry tests don't burn real
 * wall-clock time. Never called from production code. */
export function __setTypeBackoffMsForTests(baseMs, maxMs) {
  typeBackoffBaseMs = baseMs;
  typeBackoffMaxMs = maxMs;
}

/** TEST-ONLY seam: restore production pacing/backoff between tests. */
export function __resetTypePacingForTests() {
  typePacingMs = FPM_TYPE_PACING_MS;
  typeBackoffBaseMs = FPM_TYPE_BACKOFF_BASE_MS;
  typeBackoffMaxMs = FPM_TYPE_BACKOFF_MAX_MS;
}

/**
 * Fetch one appid's storefront `type` classification. LIVE-PROBED
 * (scratchpad/probe-findings-7.8.md): per-appid only — comma-separated
 * multi-appid returns HTTP 400, never batch these into one call.
 * `filters=basic` keeps `type`+`name` while cutting payload ~47%. Never
 * throws — a network error, a non-200 status (429 is the confirmed throttle
 * signal), and an unexpected/non-keyed body shape (defensive backstop) all
 * resolve to a typed `status`, mirroring fetchSteamSpyAllPage's contract.
 * @param {number} appid
 * @returns {Promise<{status: 'ok'|'throttled'|'error', type: string|null}>}
 *   status 'ok' with type:null covers a real 200 response with no usable
 *   classification (success:false — e.g. a delisted appid, per the probe) —
 *   a genuine answer, not a failure, so it is NOT retried via backoff; the
 *   caller's TTL-retry convention (recordAppType/FPM_TYPE_TTL_DAYS) handles
 *   it the same as any other unclassified row.
 */
export async function fetchAppType(appid) {
  const url = new URL(APPDETAILS_URL);
  url.searchParams.set("appids", String(appid));
  url.searchParams.set("filters", "basic");

  let res;
  try {
    res = await fetch(url.toString());
  } catch {
    return { status: "error", type: null };
  }

  if (res.status === 429) {
    return { status: "throttled", type: null };
  }
  if (!res.ok) {
    return { status: "error", type: null };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { status: "error", type: null };
  }

  const entry = json && typeof json === "object" ? json[String(appid)] : null;
  if (!entry || typeof entry !== "object") {
    // Defensive backstop (probe: a 429's body was seen as JSON `null`) —
    // don't assume the usual {<appid>: {...}} keyed shape is present just
    // because res.ok was true.
    return { status: "error", type: null };
  }
  if (!entry.success || !entry.data || typeof entry.data.type !== "string") {
    return { status: "ok", type: null };
  }
  return { status: "ok", type: entry.data.type };
}

/**
 * Select up to `limit` unclassified rows (app_type IS NULL) due for a
 * classification attempt, in priority order: already-HLTB-matched rows
 * first (main_hours IS NOT NULL — the only displayable ones, so classifying
 * these first restores the visible leaderboard fastest after this
 * increment ships), then the same owned/deal-first, owners-desc priority
 * selectHltbBatch uses (so classification stays ahead of new HLTB matching
 * from then on). A row is due if it's never been checked, or was checked
 * but came back unclassified more than FPM_TYPE_TTL_DAYS ago — a CLASSIFIED
 * row (app_type set) is never reselected, at any age.
 * @param {object} env
 * @param {{limit: number, staleCutoffMs: number}} options
 * @returns {Promise<Array<{appid: number, name: string}>>}
 */
export async function selectTypeClassificationBatch(env, { limit, staleCutoffMs }) {
  const result = await env.FPM_DB.prepare(
    `SELECT appid, name FROM fpm_catalog
     WHERE app_type IS NULL
       AND (type_checked_at IS NULL OR type_checked_at < ?)
     ORDER BY (main_hours IS NOT NULL) DESC, (source_owned + source_deal) DESC, owners DESC, (positive + negative) DESC
     LIMIT ?`,
  )
    .bind(staleCutoffMs, limit)
    .all();
  return result.results || [];
}

/** Write back one classification result. `appType: null` records a
 * checked-but-unclassified row (retried after FPM_TYPE_TTL_DAYS); any other
 * value permanently sets app_type and the row is never reselected by
 * selectTypeClassificationBatch again. */
export async function recordAppType(env, appid, { appType, checkedAtMs }) {
  await env.FPM_DB.prepare("UPDATE fpm_catalog SET app_type = ?, type_checked_at = ? WHERE appid = ?")
    .bind(appType, checkedAtMs, appid)
    .run();
}

/**
 * Classify up to FPM_TYPE_BATCH unclassified rows against storefront
 * appdetails, gently paced with a doubling backoff-and-retry (same appid,
 * never advance) on a throttle/error — mirrors crawlAndUpsertCatalog's
 * retry discipline exactly. Writes through to D1 per row (not all-at-end)
 * so a kill mid-run loses no progress already classified. Gives up on this
 * run's remaining rows after FPM_TYPE_MAX_CONSECUTIVE_BAD throttles/errors
 * in a row — cheap to resume, the next run's batch selection picks the
 * exact same unclassified rows right back up. Never throws.
 * @param {object} env - needs env.FPM_DB.
 * @param {{limit?: number, now?: number}} [options]
 * @returns {Promise<{attempted: number, classified: number, nonGame: number}>}
 *   `attempted` is rows that got a real answer (classified or genuinely
 *   unclassifiable, e.g. delisted); rows abandoned to a give-up are not
 *   counted (they were never actually resolved this run).
 */
export async function classifyCatalogTypes(env, options = {}) {
  const limit = options.limit ?? FPM_TYPE_BATCH;
  const nowMs = options.now ?? Date.now();
  const staleCutoffMs = nowMs - FPM_TYPE_TTL_MS;

  const rows = await selectTypeClassificationBatch(env, { limit, staleCutoffMs });

  let attempted = 0;
  let classified = 0;
  let nonGame = 0;
  let backoff = typeBackoffBaseMs;
  let lastFetchAt = 0;
  let consecutiveBad = 0;

  for (const row of rows) {
    for (;;) {
      const wait = computeCatalogWaitMs(lastFetchAt, Date.now(), typePacingMs);
      if (wait > 0) await sleep(wait);
      lastFetchAt = Date.now();

      const result = await fetchAppType(row.appid);

      if (result.status !== "ok") {
        consecutiveBad++;
        if (consecutiveBad >= FPM_TYPE_MAX_CONSECUTIVE_BAD) {
          return { attempted, classified, nonGame };
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, typeBackoffMaxMs);
        continue; // retry the same appid — never advance on a bad response
      }

      consecutiveBad = 0;
      backoff = typeBackoffBaseMs;
      attempted++;

      if (result.type) {
        await recordAppType(env, row.appid, { appType: result.type, checkedAtMs: nowMs });
        classified++;
        if (result.type !== "game") nonGame++;
      } else {
        await recordAppType(env, row.appid, { appType: null, checkedAtMs: nowMs });
      }
      break;
    }
  }

  return { attempted, classified, nonGame };
}

// ---------------------------------------------------------------------------
// HLTB batch resolution — reuses src/hltb.js's queue/cache machinery AS-IS
// (per the build note: floors + queue + formula config are this increment's
// reuse seam, not a repair surface). enqueueHltbFetch/getCachedHltb write to
// KV exactly as they always have; this just also writes each result through
// to D1 as the durable record, polling the KV cache (which the queue is
// already draining at its own ~1 req/sec pace) rather than modifying
// hltb.js's queue to know about D1 at all.
// ---------------------------------------------------------------------------

const HLTB_POLL_INTERVAL_MS_DEFAULT = 200;
const HLTB_POLL_MAX_ATTEMPTS_DEFAULT = 1500; // ~5 min per item at the default poll interval — a per-item safety valve, not a real production limit (see below)

let hltbPollIntervalMs = HLTB_POLL_INTERVAL_MS_DEFAULT;
let hltbPollMaxAttempts = HLTB_POLL_MAX_ATTEMPTS_DEFAULT;

/** TEST-ONLY seam: shrink the poll interval/attempts so resolveHltbBatch
 * tests don't burn real wall-clock time. Never called from production code. */
export function __setHltbPollingForTests(intervalMs, maxAttempts) {
  hltbPollIntervalMs = intervalMs;
  if (maxAttempts != null) hltbPollMaxAttempts = maxAttempts;
}

export function __resetHltbPollingForTests() {
  hltbPollIntervalMs = HLTB_POLL_INTERVAL_MS_DEFAULT;
  hltbPollMaxAttempts = HLTB_POLL_MAX_ATTEMPTS_DEFAULT;
}

/** Increment 7.8 (7.7 QA advisory 2): a much shorter wall-clock deadline per
 * item than the hltbPollMaxAttempts x hltbPollIntervalMs ~5 min safety valve
 * above. Sequential per-item polling meant one genuinely stuck lookup could
 * cost up to 5 min, and with a 3,000-row batch that could silently cost the
 * whole run. This bounds each item to a much shorter window — generous
 * enough for the queue's own ~1 req/sec backlog pacing (a healthy queue
 * resolves each item in roughly its FIFO position in seconds), tight enough
 * that a genuinely stuck item can't cascade into the rest of the batch. */
const HLTB_ITEM_TIMEOUT_MS_DEFAULT = 30_000;

let hltbItemTimeoutMs = HLTB_ITEM_TIMEOUT_MS_DEFAULT;

/** TEST-ONLY seam: shrink the per-item timeout so give-up tests don't burn
 * real wall-clock time. Never called from production code. */
export function __setHltbItemTimeoutMsForTests(ms) {
  hltbItemTimeoutMs = ms;
}

export function __resetHltbItemTimeoutForTests() {
  hltbItemTimeoutMs = HLTB_ITEM_TIMEOUT_MS_DEFAULT;
}

async function writeHltbResultToD1(env, appid, data, nowMs) {
  if (data == null) {
    await recordHltbResult(env, appid, { mainHours: null, matchMethod: "none", checkedAtMs: nowMs });
    return;
  }
  const lengthSeconds = hltbLengthSeconds(data, FPM_LENGTH_FIELD);
  const mainHours = lengthSeconds / 3600;
  await recordHltbResult(env, appid, { mainHours, matchMethod: data.matchMethod || "name", checkedAtMs: nowMs });
}

/**
 * Resolve a batch of {appid, name} rows against HowLongToBeat and write each
 * result through to D1. Items already cached from 7.5/7.6 usage (or a prior
 * sync run) resolve instantly with zero network traffic — this is the
 * "~600 pre-warmed" hit rate the build note asks to record. Remaining items
 * are enqueued to src/hltb.js's existing throttled background queue
 * (unmodified) and polled in the SAME order they were enqueued — since the
 * queue drains FIFO at its own ~1 req/sec pace, polling in enqueue order
 * tracks that pace naturally rather than adding extra latency.
 *
 * Fails soft per item: if hltbInit() itself can't be reached, every
 * remaining item is simply left pending (hltb_checked_at untouched) for the
 * next sync run to retry — this function never throws.
 *
 * Increment 7.8: each item's poll loop is additionally bounded by
 * hltbItemTimeoutMs (a much shorter wall-clock deadline than the
 * hltbPollMaxAttempts safety valve — see its comment above), so one stuck
 * lookup can't stall every item behind it in the same batch. Unlike the
 * hltbInit()-unreachable give-up above, a per-item poll-timeout give-up DOES
 * record hltb_checked_at (match_method:'none', the existing give-up
 * convention) so it retries on the normal FPM_HLTB_TTL_DAYS cycle instead of
 * being silently stuck forever.
 * @param {object} env - needs env.FPM_DB and env.TAG_CACHE.
 * @param {object} ctx
 * @param {Array<{appid: number, name: string}>} items
 * @returns {Promise<{cacheHits: number, resolved: number, gaveUp: number}>}
 */
export async function resolveHltbBatch(env, ctx, items) {
  if (!items || items.length === 0) return { cacheHits: 0, resolved: 0, gaveUp: 0 };

  const toResolve = [];
  let cacheHits = 0;
  for (const item of items) {
    const { cached, data } = await getCachedHltb(env, item.appid);
    if (cached) {
      await writeHltbResultToD1(env, item.appid, data, Date.now());
      cacheHits++;
    } else {
      toResolve.push(item);
    }
  }

  if (toResolve.length === 0) {
    return { cacheHits, resolved: 0, gaveUp: 0 };
  }

  let tokens;
  try {
    tokens = await hltbInit();
  } catch {
    // Can't reach HLTB right now — leave every remaining row pending
    // (hltb_checked_at untouched); the next sync run retries them.
    return { cacheHits, resolved: 0, gaveUp: toResolve.length };
  }

  enqueueHltbFetch(
    env,
    ctx,
    toResolve.map((item) => ({ appid: item.appid, title: item.name })),
    tokens,
  );

  let gaveUp = 0;
  let resolved = 0;
  for (const item of toResolve) {
    let found = false;
    const deadline = Date.now() + hltbItemTimeoutMs;
    for (let attempt = 0; attempt < hltbPollMaxAttempts && Date.now() < deadline; attempt++) {
      const { cached, data } = await getCachedHltb(env, item.appid);
      if (cached) {
        await writeHltbResultToD1(env, item.appid, data, Date.now());
        found = true;
        break;
      }
      await sleep(hltbPollIntervalMs);
    }
    if (found) {
      resolved++;
    } else {
      gaveUp++;
      // Poll-timeout give-up (not the hltbInit()-unreachable case above) —
      // record the check so this item retries on the normal TTL cycle
      // rather than being silently stuck forever (7.7 QA advisory 2).
      await recordHltbResult(env, item.appid, { mainHours: null, matchMethod: "none", checkedAtMs: Date.now() });
    }
  }

  return { cacheHits, resolved, gaveUp };
}

// ---------------------------------------------------------------------------
// Sync orchestration — the whole POST /api/fpm/sync pipeline. Takes the
// owned-appid-set/deal-pool loaders as injected callbacks rather than
// importing them from src/worker.js: worker.js is the `main` module and
// exports nothing but `default { fetch }` (see the file-header gotcha this
// project always flags), so this module can't import worker.js's private
// getOwnedAppIds/loadFpmPool helpers — src/worker.js instead passes them in
// when it calls startFpmSync. This also makes the whole pipeline unit-
// testable here with fake loaders, no worker.js/wrangler involved at all.
// ---------------------------------------------------------------------------

let fpmSyncRunning = false;

export function isFpmSyncRunning() {
  return fpmSyncRunning;
}

/** TEST-ONLY seam: reset the module-scoped "sync in progress" flag between
 * tests. Never called from production code. */
export function __resetFpmSyncStateForTests() {
  fpmSyncRunning = false;
}

/** Increment 7.8: the most recent sync run's HLTB queue counters
 * (cacheHits/resolved/gaveUp, already returned by resolveHltbBatch but
 * previously not surfaced anywhere) plus the type-classification funnel
 * counts, so a stalled vs healthy run is visible from GET
 * /api/fpm/sync/status without spelunking scratchpad logs. `null` until the
 * first sync run completes. */
let lastSyncStats = null;

export function getLastSyncStats() {
  return lastSyncStats;
}

/** TEST-ONLY seam: reset the module-scoped last-run stats between tests.
 * Never called from production code. */
export function __resetLastSyncStatsForTests() {
  lastSyncStats = null;
}

/**
 * The full sync pipeline: ensure schema -> crawl+upsert the whole catalog ->
 * union owned/deal floor-passers (informational source flags, used to
 * prioritize both the classification and HLTB batches below) -> classify up
 * to FPM_TYPE_BATCH unclassified rows against storefront appdetails
 * (Increment 7.8 — matched rows first, so a previously-visible leaderboard
 * reappears as fast as possible) -> select up to FPM_SYNC_BATCH NULL-
 * main_hours, app_type='game' rows in priority order -> resolve them
 * against HLTB, writing through to D1. Never throws — a failure in any one
 * step just means this run made less progress than hoped; the next sync run
 * picks up from whatever's already in D1 (resumable by construction).
 * @param {object} env
 * @param {object} ctx
 * @param {{loadOwnedAppIds: () => Promise<Set<number>>, loadDealAppIds: () => Promise<number[]>}} deps
 */
export async function runFpmSyncPipeline(env, ctx, deps) {
  await ensureCatalogSchema(env);
  await crawlAndUpsertCatalog(env);

  try {
    const ownedAppIds = await deps.loadOwnedAppIds();
    await markOwned(env, Array.from(ownedAppIds));
  } catch {
    // Best-effort — a failed owned-games lookup just means this run's
    // priority ordering is slightly less informed, not a sync failure.
  }

  try {
    const dealAppIds = await deps.loadDealAppIds();
    await markDeal(env, dealAppIds);
  } catch {
    // Same rationale as above.
  }

  const typeResult = await classifyCatalogTypes(env);

  const staleCutoffMs = Date.now() - FPM_HLTB_TTL_MS;
  const batch = await selectHltbBatch(env, { limit: FPM_SYNC_BATCH, staleCutoffMs });
  const hltbResult = await resolveHltbBatch(env, ctx, batch);

  lastSyncStats = {
    typeAttempted: typeResult.attempted,
    typeClassified: typeResult.classified,
    typeNonGame: typeResult.nonGame,
    cacheHits: hltbResult.cacheHits,
    resolved: hltbResult.resolved,
    gaveUp: hltbResult.gaveUp,
  };
  console.log(
    `[fpm-sync] type: ${typeResult.classified} classified (${typeResult.nonGame} non-game) of ${typeResult.attempted} attempted` +
      ` · hltb: ${hltbResult.cacheHits} cache hits, ${hltbResult.resolved} resolved, ${hltbResult.gaveUp} gave up`,
  );
}

/**
 * Kick a sync run in the background (ctx.waitUntil) unless one is already
 * running. Returns immediately either way — the caller (src/worker.js's
 * POST /api/fpm/sync) never blocks on the pipeline finishing.
 * @returns {{started: boolean, alreadyRunning?: boolean}}
 */
export function startFpmSync(env, ctx, deps) {
  if (fpmSyncRunning) return { started: false, alreadyRunning: true };
  fpmSyncRunning = true;
  ctx.waitUntil(
    runFpmSyncPipeline(env, ctx, deps)
      .catch(() => {})
      .finally(() => {
        fpmSyncRunning = false;
      }),
  );
  return { started: true };
}
