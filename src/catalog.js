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
import { parseOwnersMidpoint, getCachedSpy, awaitSpySlot } from "./spyQueue.js";
import { quality } from "./score.js";
import { chunk } from "./deals.js";

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

/**
 * Rows to check for a live price/discount per sync run (Increment 8.5).
 * Unlike FPM_SYNC_BATCH (HLTB, gated by src/hltb.js's own ~1 req/sec
 * throttled queue), price checks go straight to ITAD's BATCHED endpoints
 * (<=200 ids/request — see ITAD_PRICE_BATCH_SIZE below), so a much larger
 * per-run batch still costs very few actual ITAD requests: 2 requests per
 * 200 rows (one id-lookup, one price-lookup). Even a cold run against
 * today's whole matched+unowned catalog would cost well under 100 ITAD
 * requests — trivial against the 1,000 req / 5 min budget, even alongside
 * other lanes' concurrent ITAD usage. Deliberately large so a single sync
 * run usually clears the whole due backlog rather than dribbling it out.
 */
export const FPM_PRICE_SYNC_BATCH = 6000;

/** Price/discount changes daily (sales rotate) — a much shorter TTL than
 * FPM_HLTB_TTL_DAYS (lengths are static). SPEC.md requires >=6h; this is
 * exactly that floor — there's no benefit to staying "fresher" than the
 * sale cadence, and every extra check spends ITAD budget for no visible
 * gain. A row ITAD reports NO live deal for is retried on the same cycle
 * (sales end and start all the time), never given up on permanently. */
export const FPM_PRICE_TTL_HOURS = 6;
const FPM_PRICE_TTL_MS = FPM_PRICE_TTL_HOURS * 60 * 60 * 1000;

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
  type_checked_at INTEGER,
  price REAL,
  price_cents INTEGER,
  regular REAL,
  cut INTEGER,
  itad_id TEXT,
  price_checked_at INTEGER,
  tags TEXT,
  tags_checked_at INTEGER,
  tags_source TEXT
)`;

// Increment 7.8: app_type/type_checked_at are also added via ALTER TABLE for
// an EXISTING install (the live D1 already has ~4,700/18,306 rows filled) —
// CREATE TABLE IF NOT EXISTS only helps a brand-new database; it does
// nothing to a table that already exists without these columns. SQLite/D1
// has no `ADD COLUMN IF NOT EXISTS`, so each statement is wrapped in a
// try/catch below and simply ignored once the column already exists — same
// "safe to call on every request" idempotence as CREATE_TABLE_SQL.
//
// Increment 8.5 adds the price-backfill columns the same way, for the same
// reason (an existing live install already has rows without them).
//
// Increment 9 adds the tag-backfill columns (tags/tags_checked_at) for the
// same reason again – the live install already holds 18,306 rows written
// before these columns existed, and only the ALTER entries reach them.
// `tags` stores SteamSpy's `appdetails` tag dict VERBATIM as JSON text
// (`{"Roguelike": 4123, ...}`, tag name → vote count) – no normalised form
// is invented here, because the existing scoring code inc 11 will feed it
// to already understands exactly that shape. `tags_checked_at` is the same
// freshness stamp as hltb_checked_at/type_checked_at/price_checked_at.
//
// DELIBERATE DEVIATION FROM SPEC.md §2 (round-1 review, blocker 1 – needs
// James's sign-off at the diff gate, and is called out in the handoff and in
// the increment's review folder rather than slipped in): §2 names exactly
// TWO columns. `tags_source` is a third, holding 'kv' (the row's tags came
// free from the 30d KV cache, zero SteamSpy requests) or 'live' (we spent a
// request), and NULL only while the row is still unchecked.
//
// It exists because SPEC.md §7 Output 1 requires the FINAL kv_seeded leg of
// the funnel and there is no other way to produce it. lastSyncStats is
// overwritten by every pipeline run, the fill spans many auto-continue
// iterations, and §3.6 forbids re-fetching a stamped row – so a per-run
// counter can only ever report the LAST batch (and since owned rows are
// filled first, that is exactly where KV hits cluster, so it would read near
// zero). A module-scoped cumulative counter is no better: gate (a) requires a
// kill/restart mid-fill, which would zero it. A column makes the split a SQL
// question, answerable forever and immune to restarts.
//
// Additive and reversible: nothing but getCatalogStats' tagsKvSeeded reads
// it, so dropping it later breaks nothing.
const ALTER_TABLE_STATEMENTS = [
  "ALTER TABLE fpm_catalog ADD COLUMN app_type TEXT",
  "ALTER TABLE fpm_catalog ADD COLUMN type_checked_at INTEGER",
  "ALTER TABLE fpm_catalog ADD COLUMN price REAL",
  "ALTER TABLE fpm_catalog ADD COLUMN price_cents INTEGER",
  "ALTER TABLE fpm_catalog ADD COLUMN regular REAL",
  "ALTER TABLE fpm_catalog ADD COLUMN cut INTEGER",
  "ALTER TABLE fpm_catalog ADD COLUMN itad_id TEXT",
  "ALTER TABLE fpm_catalog ADD COLUMN price_checked_at INTEGER",
  "ALTER TABLE fpm_catalog ADD COLUMN tags TEXT",
  "ALTER TABLE fpm_catalog ADD COLUMN tags_checked_at INTEGER",
  "ALTER TABLE fpm_catalog ADD COLUMN tags_source TEXT",
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
 * app-type backfill's own progress.
 *
 * `pricePending` (Increment 8.5) is the price-backfill funnel's own "still
 * to do" count: matched, game-classified, UNOWNED rows never yet checked for
 * a price (price_checked_at IS NULL). Deliberately NOT "price IS NULL" —
 * a row ITAD genuinely has no live deal for is checked-and-done, not
 * pending (see FPM_PRICE_TTL_HOURS's doc comment); it just retries on the
 * normal TTL cycle like every other "checked, no result" row in this file.
 *
 * `tagged`/`tagsEmpty`/`tagsPending` (Increment 9) are the tag-backfill
 * funnel. They partition the catalog EXACTLY – every row is either tagged
 * (stamped, tags NOT NULL), checked-but-empty (stamped, tags NULL), or never
 * checked – so `tagged + tagsEmpty + tagsPending === total` by construction,
 * which is what SPEC.md gate (c) ("the numbers add up to the catalog row
 * count") asks for. Deliberately not gated on app_type/main_hours: unlike
 * pricePending these count the whole table, so the funnel can never appear
 * to be missing rows.
 *
 * `tagged` requires tags_checked_at IS NOT NULL as well as tags IS NOT NULL
 * (round-1 review, minor 11). recordTagsResult always writes both together,
 * so today the extra clause changes nothing – but without it the partition
 * would rest on that convention rather than on the query, and a row with
 * tags but no stamp would be counted in BOTH `tagged` and `tagsPending`,
 * pushing the sum past `total`. Defence in depth for the gate's property.
 *
 * `tagsKvSeeded` (round-1 review, blocker 1) is the funnel's kv_seeded leg,
 * counted catalog-wide off the tags_source column rather than per-run in
 * memory. See the ALTER_TABLE_STATEMENTS comment for why the column exists:
 * the fill spans many auto-continue runs and survives restarts, so the only
 * durable place to record how a row was filled is the row itself.
 *
 * It means exactly what SPEC.md §3.3 means by it – "filled WITHOUT spending a
 * SteamSpy request" – so it is a subset of `tagged + tagsEmpty`, NOT a fourth
 * partition slice. Do not add it to the sum. (It is very nearly a subset of
 * `tagged` alone, since only a non-empty cached dict is ever seeded; the gap
 * is the pathological case where every vote in that dict fails the write
 * boundary's numeric check and nothing survives to store.) */
export async function getCatalogStats(env) {
  const row = await env.FPM_DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN main_hours IS NOT NULL THEN 1 ELSE 0 END) AS matched,
            SUM(CASE WHEN match_method = 'none' THEN 1 ELSE 0 END) AS unmatched,
            SUM(CASE WHEN app_type IS NOT NULL THEN 1 ELSE 0 END) AS classified,
            SUM(CASE WHEN app_type IS NOT NULL AND app_type != 'game' THEN 1 ELSE 0 END) AS nonGame,
            SUM(CASE WHEN main_hours IS NOT NULL AND app_type = 'game' AND source_owned = 0
                          AND price_checked_at IS NULL THEN 1 ELSE 0 END) AS pricePending,
            SUM(CASE WHEN tags_checked_at IS NOT NULL AND tags IS NOT NULL THEN 1 ELSE 0 END) AS tagged,
            SUM(CASE WHEN tags_checked_at IS NOT NULL AND tags IS NULL THEN 1 ELSE 0 END) AS tagsEmpty,
            SUM(CASE WHEN tags_checked_at IS NULL THEN 1 ELSE 0 END) AS tagsPending,
            SUM(CASE WHEN tags_source = 'kv' THEN 1 ELSE 0 END) AS tagsKvSeeded
     FROM fpm_catalog`,
  ).first();
  const total = row?.total || 0;
  const matched = row?.matched || 0;
  const unmatched = row?.unmatched || 0;
  const classified = row?.classified || 0;
  const nonGame = row?.nonGame || 0;
  const pricePending = row?.pricePending || 0;
  const tagged = row?.tagged || 0;
  const tagsEmpty = row?.tagsEmpty || 0;
  const tagsPending = row?.tagsPending || 0;
  const tagsKvSeeded = row?.tagsKvSeeded || 0;
  return {
    total,
    matched,
    unmatched,
    pending: total - matched,
    classified,
    nonGame,
    pricePending,
    tagged,
    tagsEmpty,
    tagsPending,
    tagsKvSeeded,
  };
}

/** Every matched (main_hours NOT NULL) catalog row — the lane's actual
 * candidate set. src/worker.js's handleFpm applies the FPM_MIN_LENGTH_HOURS
 * floor, scoring, and owned/deal annotation on top of this.
 *
 * Increment 7.8: also gated on `app_type = 'game'` — this is THE lane-gating
 * choke point. An unclassified row (app_type IS NULL) fails the SQL
 * equality check the same as an explicitly non-game row, so both are
 * excluded by construction (the PO's "exclude-until-classified" decision) —
 * they stay in D1 (data is data) but never render here.
 *
 * Increment 8.5: also carries the price-backfill columns (price/price_cents/
 * regular/cut/price_checked_at) — handleFpm reads price/discount straight
 * off these instead of the old BESTOF_FETCH_CAP-limited loadFpmPool join,
 * since that join only ever covered whichever appids happened to be in
 * ITAD's rank-sorted feed, not every floor-passing catalog row. */
export async function selectMatchedCatalogRows(env) {
  const result = await env.FPM_DB.prepare(
    `SELECT appid, name, owners, positive, negative, wilson, main_hours, match_method,
            price, price_cents, regular, cut, price_checked_at
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
// Tag backfill (Increment 9) – persists each catalog row's SteamSpy tag dict
// into D1. Fourth instance of this file's established resumable-batch shape
// (crawl / app-type / price were the first three): a select-batch + record
// pair, a paced runner with doubling backoff that retries the SAME item on a
// bad response, write-through per row, never throws.
//
// LIVE-PROBED (2026-08-28, scratchpad/probe-findings-9.md):
//   - `GET https://steamspy.com/api.php?request=appdetails&appid=N` returns
//     `tags` as a name → vote-count OBJECT for a populated app (always
//     exactly 20 tags today), and as an empty ARRAY `[]` for an app SteamSpy
//     has nothing for – never `{}`. Both arrive as HTTP 200 with a JSON
//     content-type, so SHAPE is the only signal there is.
//   - "Empty" is a normal outcome, not an error. It was witnessed on appid 5
//     ("Dedicated Server", a real non-game app), on the nonexistent appid
//     999999999, and on the unknown appid 1969360 – i.e. only ever on
//     non-game or unknown appids. CORRECTED in round-1 review (major 3): an
//     earlier version of this comment claimed 1969360 was "A Castle Full of
//     Cats, a genuine floor-passing game with no tags at all". It is not.
//     1969360 returns `name: null` and has no catalog row; A Castle Full of
//     Cats is appid 2070550, it IS in the catalog, and it returns a full
//     20-tag dict. NO catalogued game has been observed returning empty, so
//     no volume prediction for the empty leg of the funnel has a measured
//     basis – the live fill will produce the real number. Behaviour is
//     unaffected either way: fetchSpyTags keys purely on the SHAPE of the
//     response, never on which appid was asked about.
//   - The bulk `all` feed carries no `tags` field at all (re-confirmed), so
//     there is no batched shortcut – this is a per-appid walk.
//   - The throttle could not be reproduced on the probe day (Cloudflare's
//     24h edge cache absorbed the burst), so this codes against the
//     increment-7.7 throttle contract unchanged and REUSES isThrottledBody
//     rather than re-deriving it.
// ---------------------------------------------------------------------------

/** Same api.php base as spyQueue.js's per-request tag cache calls, with
 * `request=appdetails` – deliberately the exact endpoint the app already
 * uses, so this backfill inherits its known behaviour rather than adding a
 * second, differently-behaved SteamSpy integration. */
const STEAMSPY_APPDETAILS_URL = "https://steamspy.com/api.php";

/** Rows to attempt per sync run. Matched to FPM_SYNC_BATCH (3000), NOT to
 * FPM_TYPE_BATCH's 500 (round-1 review, major 4).
 *
 * The instinct was that "one upstream request per row" argues for a small
 * batch, as it does for classification. It does not, because of how
 * auto-continue works: runFpmSyncUntilComplete re-runs the ENTIRE pipeline
 * each iteration, crawlAndUpsertCatalog included, and that crawl is a full
 * ~86-page walk of SteamSpy's `request=all` feed at ~350 KB/page with no
 * "recently crawled" short-circuit. So every extra loop iteration costs a
 * whole re-crawl. At 500/iteration the tag step would need ~37 iterations to
 * cover ~18.3k rows, making it the loop DRIVER where the loop previously
 * terminated in far fewer – roughly 3,200 extra bulk-feed requests, ~1.1 GB
 * and ~79 extra minutes of wall-clock that SPEC.md §3.7's sizing never
 * accounted for, in exactly the burst shape the 7.7 probe found throttles
 * the `all` endpoint.
 *
 * At 3000 the tag step needs ~6 iterations – at or below the pre-existing
 * HLTB-driven baseline, so it stops being the loop driver. The per-run
 * wall-clock is longer (a run is a bigger chunk of work), but the TOTAL is
 * substantially shorter, and nothing here depends on a run being short:
 * every write is write-through, so a kill mid-run loses nothing. */
export const FPM_TAGS_BATCH = 3000;

/** Gentle pacing between tag requests – the ~1 req/sec ceiling spyQueue.js
 * already holds itself to for this same endpoint. Held deliberately despite
 * the probe failing to trigger a throttle at far higher rates: that probe
 * shows what SteamSpy PERMITS behind a warm Cloudflare cache, not what it is
 * willing to serve for a 3-hour unattended walk of the whole catalog.
 *
 * This is the INTERVAL only. The clock it is measured against is
 * spyQueue.js's module-scoped one, shared with /api/recs's background queue
 * via awaitSpySlot – so the two callers cannot each independently run at
 * 1 req/sec and jointly hit 2 (round-1 review, major 5). */
export const FPM_TAGS_PACING_MS = 1000;

/** Backoff on a throttle/error signal. SPEC.md §3.1 sets an explicit >60s
 * cooldown floor for this endpoint's throttle; this starts meaningfully
 * above that floor (the 7.7 lesson: a retry 65s after a throttle was still
 * throttled) and doubles, capped, on repeated hits. */
export const FPM_TAGS_BACKOFF_BASE_MS = 90_000;
export const FPM_TAGS_BACKOFF_MAX_MS = 600_000;

/** Consecutive bad (throttled/error) responses to tolerate before giving up
 * on this run's remaining rows – mirrors FPM_TYPE_MAX_CONSECUTIVE_BAD.
 * Cheap to abandon: nothing in an unattempted row was stamped, so the next
 * run's selection picks the exact same rows right back up. */
export const FPM_TAGS_MAX_CONSECUTIVE_BAD = 20;

/** Attempts to spend on ONE row before advancing past it (round-2 review,
 * major CR-9). The pass-level valve above is not enough on its own: it only
 * ever fires or does not, and the retry loop it guards has no other exit, so
 * a single row whose response is never classifiable as `ok` burns the whole
 * consecutive-bad budget, abandons the rest of the run, is left UNSTAMPED,
 * and is then reselected FIRST next run by selectTagsBatch's deterministic
 * ORDER BY – forever. The fill would look busy and make zero progress, which
 * is exactly what SPEC.md §3.5 forbids ("one stuck item must never zero a
 * batch", the inc-7.8 discipline).
 *
 * The two valves are complementary, not redundant: this one handles ONE
 * poisoned row, FPM_TAGS_MAX_CONSECUTIVE_BAD handles SteamSpy being down.
 * Five clears any plausible transient (four backoff sleeps, ~20 min from a
 * fresh backoff) while bounding the damage one row can do. A skipped row is
 * left unstamped exactly like a given-up one, so nothing is baked in – it is
 * simply retried on a later run instead of blocking this one. */
export const FPM_TAGS_MAX_ROW_ATTEMPTS = 5;

/** Consecutive D1 write failures to tolerate before abandoning the run
 * (round-2 review, minor CR-12). Write failures deliberately do NOT feed
 * consecutiveBad – that counter is about the upstream – so without this a
 * broken D1 would let a run spend a full FPM_TAGS_BATCH of SteamSpy requests
 * (~50 min) storing nothing, and then do it again next iteration. Small and
 * dedicated rather than shared with the upstream valve: a D1 write is local
 * and unthrottled, so five refusals in a row is already a clear verdict. */
export const FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES = 5;

/** How often the tag step's backoff sleep looks up to see whether a stop has
 * been requested (round-2 review, major SEC-7). One second is far below any
 * human's patience threshold and adds at most one extra timer per second of
 * an already-idle wait. */
const FPM_TAGS_STOP_CHECK_INTERVAL_MS = 1000;

let tagsPacingMs = FPM_TAGS_PACING_MS;
let tagsBackoffBaseMs = FPM_TAGS_BACKOFF_BASE_MS;
let tagsBackoffMaxMs = FPM_TAGS_BACKOFF_MAX_MS;

/** TEST-ONLY seam: shrink pacing so tag-backfill tests don't burn real
 * wall-clock time. Never called from production code. */
export function __setTagsPacingMsForTests(ms) {
  tagsPacingMs = ms;
}

/** TEST-ONLY seam: shrink backoff so throttle-retry tests don't burn real
 * wall-clock time. Never called from production code. */
export function __setTagsBackoffMsForTests(baseMs, maxMs) {
  tagsBackoffBaseMs = baseMs;
  tagsBackoffMaxMs = maxMs;
}

/** TEST-ONLY seam: restore production pacing/backoff between tests. */
export function __resetTagsPacingForTests() {
  tagsPacingMs = FPM_TAGS_PACING_MS;
  tagsBackoffBaseMs = FPM_TAGS_BACKOFF_BASE_MS;
  tagsBackoffMaxMs = FPM_TAGS_BACKOFF_MAX_MS;
}

/**
 * Fetch one appid's SteamSpy tag dict. Never throws – mirrors
 * fetchAppType's/fetchSteamSpyAllPage's typed-outcome contract exactly.
 * @param {number} appid
 * @returns {Promise<{status: 'ok'|'throttled'|'error', tags: object|null}>}
 *   status 'ok' with tags:null is the GENUINE empty outcome (the live `[]`
 *   array shape, or `{}`, or a missing/non-object field) – a real answer,
 *   recorded and stamped by the caller, never retried via backoff.
 *
 *   The one deliberate deviation from fetchSteamSpyAllPage: a 200 whose body
 *   does not parse to a plain JSON object CARRYING AN `appid` FIELD is
 *   classified 'throttled', NOT 'error'. Per the probe, a plain-text 200 IS
 *   the throttle signal on this host, so an unrecognisable 200 must back off
 *   rather than be recorded as a real answer – treating it as data would
 *   stamp a transient upstream failure as "this game has no tags"
 *   permanently, and §3.6 never revisits a stamped row.
 */
export async function fetchSpyTags(appid) {
  const url = new URL(STEAMSPY_APPDETAILS_URL);
  url.searchParams.set("request", "appdetails");
  url.searchParams.set("appid", String(appid));

  let res;
  try {
    res = await fetch(url.toString());
  } catch {
    return { status: "error", tags: null };
  }

  let text;
  try {
    text = await res.text();
  } catch {
    return { status: "error", tags: null };
  }

  // A bare 500 (empty body) and the plain-text throttle message are the same
  // "back off and retry" case – the 7.7 contract, reused not re-derived.
  if (res.status === 500 || isThrottledBody(text)) {
    return { status: "throttled", tags: null };
  }
  if (!res.ok) {
    return { status: "error", tags: null };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: "throttled", tags: null };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { status: "throttled", tags: null };
  }

  // Round-1 review, blocker 2: an "empty" answer is IRREVERSIBLE (§3.6 never
  // re-fetches a stamped row), so only a body that actually looks like an
  // appdetails row may produce one. A JSON ERROR ENVELOPE – say
  // `{"error":"db down"}` – is a plain object with no `tags` field, and
  // without this gate it would be read as "this game has no tags" and baked
  // into the catalog permanently for a whole bad SteamSpy hour's worth of
  // rows. `appid` is the safe discriminator: the probe shows SteamSpy
  // SYNTHESISES a full row carrying `appid` even for the nonexistent appid
  // 999999999, so a genuine empty answer always has it and this gate cannot
  // misfire on one. Anything else is classified 'throttled' – retried, not
  // stamped.
  if (!("appid" in json)) {
    return { status: "throttled", tags: null };
  }

  const tags = json.tags;
  // The live empty shape is an EMPTY array. A NON-empty array is a shape
  // nobody has ever observed (round-1 review, minor 10) – speculative, but
  // stamping it would permanently lose real tags, so treat it as 'throttled'
  // and retry rather than assuming it means "nothing".
  if (Array.isArray(tags)) {
    return tags.length === 0 ? { status: "ok", tags: null } : { status: "throttled", tags: null };
  }
  if (!tags || typeof tags !== "object" || Object.keys(tags).length === 0) {
    return { status: "ok", tags: null }; // `{}` / missing – a real answer, same as `[]`
  }
  return { status: "ok", tags };
}

/**
 * Select up to `limit` rows that have never had a tag-fetch attempt
 * concluded, in SPEC.md §3.4's priority order: owned rows first (their tags
 * are inc 11's taste-profile input), then on-sale rows, then the remainder
 * by owners descending.
 *
 * DELIBERATE DEVIATION, not an omission: unlike selectHltbBatch /
 * selectTypeClassificationBatch / selectPriceBatch this takes NO
 * `staleCutoffMs` and has no TTL retry. SPEC.md §3.6 is explicit – tags are
 * near-static, a row with tags_checked_at set is done for this increment
 * (whether it came back tagged or empty), and any refresh TTL is a future
 * decision rather than something to build now.
 * @param {object} env
 * @param {{limit: number}} options
 * @returns {Promise<Array<{appid: number, name: string}>>}
 */
export async function selectTagsBatch(env, { limit }) {
  const result = await env.FPM_DB.prepare(
    `SELECT appid, name FROM fpm_catalog
     WHERE tags_checked_at IS NULL
     ORDER BY source_owned DESC, source_deal DESC, owners DESC, (positive + negative) DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  return result.results || [];
}

/** Maximum tag entries stored per row. SteamSpy returns exactly 20 today
 * (every populated capture in the probe), so this is pure belt-and-braces
 * against an unbounded response rather than a normalisation – it can only
 * bite if SteamSpy doubles what it serves. Kept well above 20 so it is never
 * silently reshaping today's data. */
const TAGS_MAX_ENTRIES = 40;

/**
 * Defensive coercion at the write boundary (round-1 review, minor 9). Keeps
 * only entries with a string key and a positive, finite vote count, stores
 * the vote as a NUMBER, and caps to the top TAGS_MAX_ENTRIES by votes.
 *
 * NOT a normalisation: SPEC.md §2 says store the live shape, and a
 * tag-name → number dict is exactly that. This only guards against a value
 * that is not a number at all. src/profile.js's buildTagVector filters on
 * `Number(votes) > 0` but then sums the RAW value, so a numeric-STRING vote
 * would make its running total a string and turn every inc-11 tag weight
 * into NaN. Every one of the 180 tag values in the live captures is a real
 * number, so this is latent hardening – but this increment is the write
 * boundary, so it is the cheapest possible place to make it impossible.
 * @param {object|null|undefined} tags
 * @returns {Object<string, number>|null} null when nothing usable survives.
 */
function sanitizeTagDict(tags) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
  const entries = [];
  for (const [name, votes] of Object.entries(tags)) {
    if (typeof name !== "string" || name.length === 0) continue;
    const n = Number(votes);
    if (!Number.isFinite(n) || n <= 0) continue;
    entries.push([name, n]);
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, TAGS_MAX_ENTRIES));
}

/** Write back one tag-fetch outcome. `tags` as an object is sanitized (see
 * sanitizeTagDict) and stored as JSON text (D1 binds JSON in a TEXT column
 * as an ordinary string parameter); `tags: null` records a checked-but-empty
 * row – SteamSpy answered and has nothing, the same "checked, no result"
 * convention as recordHltbResult / recordAppType. BOTH stamp
 * tags_checked_at, so neither is ever reselected by selectTagsBatch. Returns
 * the dict actually STORED (or null), so callers can count what D1 holds
 * rather than what the network returned.
 *
 * `source` is 'kv' (tags came free from the 30d KV cache) or 'live' (a
 * SteamSpy request was spent). It is written for BOTH outcomes including
 * empty, so tags_source is non-NULL exactly when tags_checked_at is – see
 * the ALTER_TABLE_STATEMENTS comment for why the column exists at all.
 *
 * DELIBERATE DEVIATION FROM SPEC.md §3.5 (round-1 review, minor 13 –
 * declared here so inc 11's consumer finds it rather than discovers it):
 * §3.5 says record `{}` for the empty outcome. This records SQL NULL
 * instead. Recording `{}` would make `tags IS NOT NULL` true for an empty
 * row, so getCatalogStats' `tagged` would count rows with no tags and the
 * gate (c) partition would stop meaning anything. The stamp in
 * tags_checked_at already carries the "we asked and got nothing" fact, which
 * is the part §3.5 actually needs. Inc 11 must therefore read a NULL `tags`
 * column as "checked, genuinely no tags", not as "not yet fetched" – that
 * distinction lives in tags_checked_at. */
export async function recordTagsResult(env, appid, { tags, checkedAtMs, source }) {
  const clean = sanitizeTagDict(tags);
  const json = clean ? JSON.stringify(clean) : null;
  await env.FPM_DB.prepare("UPDATE fpm_catalog SET tags = ?, tags_checked_at = ?, tags_source = ? WHERE appid = ?")
    .bind(json, checkedAtMs, source ?? null, appid)
    .run();
  return clean;
}

/**
 * Sleep up to `totalMs`, waking early if an auto-continue stop has been
 * requested (round-2 review, major SEC-7). Checks at most
 * FPM_TAGS_STOP_CHECK_INTERVAL_MS apart, so a Stop during the tag step's
 * long backoff is honoured in about a second instead of up to 2h50m.
 * @returns {Promise<boolean>} true if the full interval elapsed, false if a
 *   stop was requested (the caller must then return its counters).
 */
async function sleepUnlessStopRequested(totalMs) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    if (isFpmStopRequested()) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await sleep(Math.min(remaining, FPM_TAGS_STOP_CHECK_INTERVAL_MS));
  }
}

/**
 * Backfill up to FPM_TAGS_BATCH rows' tags. TWO SEQUENTIAL PASSES over the
 * batch, not two stages per row (round-1 review, minor 8):
 *
 *  PASS 1 – KV seed (SPEC.md §3.3). The per-request tag cache (30d) already
 *    holds a usable tag dict for thousands of catalog rows, all free. Seeded
 *    rows are written straight through to D1 and make ZERO SteamSpy
 *    requests. Doing the WHOLE batch's KV pass first matters during a
 *    SteamSpy outage: the old per-row interleaving meant the live-fetch
 *    give-up valve abandoned the rest of the batch INCLUDING rows that would
 *    have cost nothing, so each auto-continue iteration achieved nothing
 *    while burning one of the 200. Now the free wins always land.
 *
 *  PASS 2 – live fetch for whatever pass 1 missed, paced through
 *    spyQueue.js's SHARED slot reservation (awaitSpySlot) so this and
 *    /api/recs's background queue jointly respect ONE ~1 req/sec ceiling on
 *    the SteamSpy host rather than one each (round-1 review, major 5).
 *    Doubling backoff-and-retry on the SAME appid, then THREE valves, each
 *    covering a failure the others cannot (round-2 review, CR-9 / CR-12):
 *      - per ROW, after FPM_TAGS_MAX_ROW_ATTEMPTS bad responses: advance to
 *        the next row, leave this one unstamped, count it in `skipped`. One
 *        permanently unclassifiable response must never stall the fill.
 *      - per PASS, after FPM_TAGS_MAX_CONSECUTIVE_BAD bad responses in a
 *        row: abandon the run's remaining rows (`gaveUp`). SteamSpy is down.
 *      - per PASS, after FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES refused D1
 *        writes in a row: abandon too, so a broken database stops spending
 *        third-party request budget on answers it cannot store.
 *    Writes through per row, so a kill mid-run loses nothing recorded.
 *
 * NEVER THROWS – and that is now true rather than aspirational (round-1
 * review, major 6; round-2 review, CR-13/SEC-9). Every D1 call is
 * individually wrapped, the batch SELECT included: a write failure
 * increments `writeFailed`, logs, and leaves the row unstamped for the next
 * run; a failed SELECT logs and returns a zeroed result. Neither throws all
 * the way out through runFpmSyncPipeline and runFpmSyncUntilComplete into
 * startFpmAutoContinue's silent `.catch(() => {})`, which would leave an
 * operator unable to tell "finished" from "died twenty minutes in".
 *
 * A KV value of `null` is a seed MISS, not an empty (the subtlest decision
 * in this increment, per probe 4): spyQueue.js caches `null` for three
 * different reasons – genuine no-tags, a non-2xx, and a network error – and
 * the cached value cannot tell them apart. Writing one into D1 as a
 * definitive "empty" would permanently bake a transient SteamSpy blip into
 * the catalog, so those rows fall through to the live fetch, where the
 * outcome gets classified honestly.
 * @param {object} env - needs env.FPM_DB and env.TAG_CACHE.
 * @param {{limit?: number, now?: number}} [options]
 * @returns {Promise<{attempted: number, tagged: number, kvSeeded: number, empty: number, kvFailed: number, writeFailed: number, skipped: number, gaveUp: number}>}
 *   `attempted` counts rows that got a real answer from either pass AND were
 *   successfully recorded; `tagged` counts those that stored tags; `kvSeeded`
 *   counts rows filled WITHOUT spending a SteamSpy request (SPEC.md §3.3's
 *   sense), so it overlaps `tagged` rather than being disjoint from it – do
 *   not add it to the other legs; `kvFailed` counts KV reads that threw – normally 0, but a
 *   large number means the cache is effectively unavailable (e.g. TAG_CACHE
 *   unbound) and the run is silently spending hours on live fetches it did
 *   not need to, which is exactly the gate (d) signal that was previously
 *   swallowed (round-1 review, minor 12); `writeFailed` counts rows that got
 *   a good answer D1 then refused to store; `skipped` counts rows the live
 *   pass walked PAST after FPM_TAGS_MAX_ROW_ATTEMPTS bad responses, the
 *   `skipped` leg SPEC.md §3.5's counter set names; `gaveUp` is the rows
 *   abandoned unresolved when a pass-level valve trips. Neither `skipped`
 *   nor `gaveUp` rows are ever stamped, so both are retried next run and
 *   both remain counted in the funnel's `tagsPending`.
 */
export async function backfillCatalogTags(env, options = {}) {
  const limit = options.limit ?? FPM_TAGS_BATCH;
  const nowMs = options.now ?? Date.now();

  // The one D1 call that was still unwrapped (round-2 review, CR-13 +
  // SEC-9). A throw here propagated out of the pipeline into
  // startFpmAutoContinue's silent .catch(), killing a multi-hour unattended
  // run with no counter and no log line – the exact failure the "never
  // throws" contract above exists to prevent.
  let rows;
  try {
    rows = await selectTagsBatch(env, { limit });
  } catch (err) {
    console.log(`[fpm-sync] tags: batch selection failed – nothing attempted this run: ${err?.message ?? err}`);
    return { attempted: 0, tagged: 0, kvSeeded: 0, empty: 0, kvFailed: 0, writeFailed: 0, skipped: 0, gaveUp: 0 };
  }

  let attempted = 0;
  let tagged = 0;
  let kvSeeded = 0;
  let empty = 0;
  let kvFailed = 0;
  let writeFailed = 0;
  let skipped = 0;
  let consecutiveWriteFailed = 0;

  /** One snapshot of every counter, so the live pass's four exits (finished,
   * upstream valve, write valve, stop requested) cannot drift apart. */
  const tally = (gaveUp = 0) => ({ attempted, tagged, kvSeeded, empty, kvFailed, writeFailed, skipped, gaveUp });

  /** Record one outcome, counting it only if D1 actually took it. Counters
   * key off what was STORED (recordTagsResult returns its sanitized dict, or
   * null), not off what was fetched, so `tagged`/`empty` can never drift
   * from the columns getCatalogStats reads back. */
  const record = async (appid, tags, source) => {
    let stored;
    try {
      stored = await recordTagsResult(env, appid, { tags, checkedAtMs: nowMs, source });
    } catch (err) {
      writeFailed++;
      consecutiveWriteFailed++;
      console.log(`[fpm-sync] tags: D1 write failed for appid ${appid} – left unstamped for the next run: ${err?.message ?? err}`);
      return false;
    }
    consecutiveWriteFailed = 0;
    attempted++;
    if (stored) tagged++;
    else empty++;
    return true;
  };

  // --- Pass 1: KV seed the whole batch (free, no SteamSpy traffic) --------
  const kvMisses = [];
  for (const row of rows) {
    let seeded = null;
    try {
      const cached = await getCachedSpy(env, row.appid);
      const cachedTags = cached.cached && cached.data && typeof cached.data === "object" ? cached.data.tags : null;
      if (cachedTags && typeof cachedTags === "object" && !Array.isArray(cachedTags) && Object.keys(cachedTags).length > 0) {
        seeded = cachedTags;
      }
    } catch {
      // A KV read failure is just a missed free win – fall through to the
      // live fetch rather than failing the row. Counted, not swallowed.
      kvFailed++;
    }
    if (!seeded) {
      kvMisses.push(row);
      continue;
    }
    if (await record(row.appid, seeded, "kv")) kvSeeded++;
  }

  // --- Pass 2: live fetch the misses -------------------------------------
  let backoff = tagsBackoffBaseMs;
  let consecutiveBad = 0;

  for (let i = 0; i < kvMisses.length; i++) {
    const row = kvMisses[i];
    let rowAttempts = 0;

    for (;;) {
      await awaitSpySlot(tagsPacingMs);

      rowAttempts++;
      const result = await fetchSpyTags(row.appid);

      if (result.status !== "ok") {
        consecutiveBad++;
        if (consecutiveBad >= FPM_TAGS_MAX_CONSECUTIVE_BAD) {
          return tally(kvMisses.length - i); // upstream is down – abandon the rest
        }
        if (rowAttempts >= FPM_TAGS_MAX_ROW_ATTEMPTS) {
          // Round-2 review, CR-9: the ONLY path that advances past a row
          // which never answers usably. Without it this loop has no exit but
          // success or the pass valve, so one poisoned row stalls the whole
          // fill permanently (it is left unstamped and reselected first next
          // run, by the same deterministic ORDER BY).
          skipped++;
          console.log(`[fpm-sync] tags: appid ${row.appid} skipped after ${rowAttempts} unusable responses – left unstamped, retried on a later run`);
          break;
        }
        // Interruptible (round-2 review, SEC-7): a Stop requested during
        // this backoff is honoured within a second instead of after up to
        // 2h50m of doubling sleeps. Nothing is in flight here, so bailing
        // out mid-batch leaves exactly the same state as the valve above.
        if (!(await sleepUnlessStopRequested(backoff))) return tally(kvMisses.length - i);
        backoff = Math.min(backoff * 2, tagsBackoffMaxMs);
        continue; // retry the same appid – never advance on ONE bad response
      }

      consecutiveBad = 0;
      backoff = tagsBackoffBaseMs;
      const stored = await record(row.appid, result.tags, "live");
      // Round-2 review, CR-12: write failures never touch consecutiveBad
      // (that valve is about the upstream), so a broken D1 would otherwise
      // let this run spend its whole SteamSpy budget storing nothing, then
      // do it again next iteration.
      if (!stored && consecutiveWriteFailed >= FPM_TAGS_MAX_CONSECUTIVE_WRITE_FAILURES) {
        console.log(`[fpm-sync] tags: giving up this run after ${consecutiveWriteFailed} consecutive D1 write failures – not spending further SteamSpy requests`);
        return tally(kvMisses.length - i);
      }
      break;
    }
  }

  return tally();
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
// Price backfill (Increment 8.5) — extends price/discount annotation to
// EVERY floor-passing unowned matched catalog row, not just whichever
// appids happen to be in the small BESTOF_FETCH_CAP-limited rank-sorted
// pool src/worker.js's loadFpmPool sources (the 7.7 "top-300" gap). Mirrors
// the app-type classification section above: D1-persisted, resumable-by-
// construction (selectPriceBatch's WHERE clause below is the whole
// resumability story — no queue, no separate cache layer needed), write-
// through per item so a kill mid-batch loses no progress.
//
// Unlike HLTB/appdetails (one appid per request), ITAD's price endpoints are
// natively BATCHED (<=200 ids/call — the same endpoints/shape src/worker.js's
// resolveWishlistItadIds/fetchWishlistPrices already use for the Wishlist
// lane, confirmed still live/working per the increment's live probe), so
// this fetches by CHUNK of appids, not one at a time — a different rhythm
// than fetchAppType's per-appid loop above, reusing deals.js's chunk().
// ---------------------------------------------------------------------------

const ITAD_API_BASE = "https://api.isthereanydeal.com";
const ITAD_SHOP_ID_STEAM = 61;
const ITAD_COUNTRY = "AU";

/** Max appids/ITAD-ids per price-backfill request — ITAD's documented batch
 * limit, same value already proven live for this exact purpose (see
 * src/worker.js's BATCH_SIZE / resolveWishlistItadIds / fetchWishlistPrices). */
export const ITAD_PRICE_BATCH_SIZE = 200;

/** Gentle pacing between ITAD price-backfill requests. Batched calls are
 * already cheap (<=200 rows/request, ~2 requests per 200 catalog rows), so
 * this just avoids firing a burst of dozens of requests back-to-back; well
 * under the 1,000 req / 5 min budget even stacked on top of other lanes'
 * concurrent ITAD calls. */
export const FPM_PRICE_PACING_MS = 300;

/** Backoff on a throttle (HTTP 429) or error. Same "start well above a
 * naive guess, double, cap" discipline as CATALOG_BACKOFF_BASE_MS/
 * FPM_TYPE_BACKOFF_BASE_MS above — a 429's `retry-after` header (if present)
 * is honored as a floor on top of this. */
export const FPM_PRICE_BACKOFF_BASE_MS = 30_000;
export const FPM_PRICE_BACKOFF_MAX_MS = 300_000;

/** Consecutive bad (throttled/error) ITAD calls to tolerate before giving up
 * on this run's remaining price batch — mirrors FPM_TYPE_MAX_CONSECUTIVE_BAD.
 * Cheap to resume: price_checked_at was never written for anything not yet
 * reached, so the next sync run's batch selection picks it right back up. */
export const FPM_PRICE_MAX_CONSECUTIVE_BAD = 10;

let pricePacingMs = FPM_PRICE_PACING_MS;
let priceBackoffBaseMs = FPM_PRICE_BACKOFF_BASE_MS;
let priceBackoffMaxMs = FPM_PRICE_BACKOFF_MAX_MS;

/** TEST-ONLY seam: shrink pacing so price-backfill tests don't burn real
 * wall-clock time. Never called from production code. */
export function __setPricePacingMsForTests(ms) {
  pricePacingMs = ms;
}

/** TEST-ONLY seam: shrink backoff so throttle-retry tests don't burn real
 * wall-clock time. Never called from production code. */
export function __setPriceBackoffMsForTests(baseMs, maxMs) {
  priceBackoffBaseMs = baseMs;
  priceBackoffMaxMs = maxMs;
}

/** TEST-ONLY seam: restore production pacing/backoff between tests. */
export function __resetPricePacingForTests() {
  pricePacingMs = FPM_PRICE_PACING_MS;
  priceBackoffBaseMs = FPM_PRICE_BACKOFF_BASE_MS;
  priceBackoffMaxMs = FPM_PRICE_BACKOFF_MAX_MS;
}

/**
 * Resolve Steam appids -> ITAD ids for one batch (<=200) via
 * POST /lookup/id/shop/61/v1. Body must be the "app/<appid>" string form —
 * ITAD returns null for bare integers (same live-verified shape
 * src/worker.js's resolveWishlistItadIds already relies on). Never throws.
 * @returns {Promise<{status: 'ok'|'throttled'|'error', idsByAppid?: Map<number, string|null>, retryAfterMs?: number}>}
 */
export async function fetchItadIdsBatch(env, appids) {
  const url = new URL(`${ITAD_API_BASE}/lookup/id/shop/${ITAD_SHOP_ID_STEAM}/v1`);
  url.searchParams.set("key", env.ITAD_API_KEY);

  let res;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(appids.map((appid) => `app/${appid}`)),
    });
  } catch {
    return { status: "error" };
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return { status: "throttled", retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined };
  }
  if (!res.ok) return { status: "error" };

  let json;
  try {
    json = await res.json();
  } catch {
    return { status: "error" };
  }
  if (!json || typeof json !== "object") return { status: "error" };

  const idsByAppid = new Map();
  for (const appid of appids) {
    idsByAppid.set(appid, json[`app/${appid}`] ?? null);
  }
  return { status: "ok", idsByAppid };
}

/**
 * Fetch current Steam price/cut for one batch (<=200) of ITAD ids via
 * POST /games/prices/v2 (country=AU, shops=61) — the exact same endpoint/
 * shape src/worker.js's fetchWishlistPrices already uses. Ids with no live
 * Steam deal are OMITTED from the response (verified live) — that omission
 * IS the "ITAD has no price for this one right now" signal, not an error.
 * Never throws.
 * @returns {Promise<{status: 'ok'|'throttled'|'error', priceByItadId?: Map<string, object>, retryAfterMs?: number}>}
 */
export async function fetchItadPricesBatch(env, itadIds) {
  const url = new URL(`${ITAD_API_BASE}/games/prices/v2`);
  url.searchParams.set("key", env.ITAD_API_KEY);
  url.searchParams.set("country", ITAD_COUNTRY);
  url.searchParams.set("shops", String(ITAD_SHOP_ID_STEAM));

  let res;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(itadIds),
    });
  } catch {
    return { status: "error" };
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return { status: "throttled", retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined };
  }
  if (!res.ok) return { status: "error" };

  let json;
  try {
    json = await res.json();
  } catch {
    return { status: "error" };
  }
  if (!Array.isArray(json)) return { status: "error" };

  const priceByItadId = new Map();
  for (const entry of json) {
    const dealEntry = (entry.deals || []).find((d) => d.shop?.id === ITAD_SHOP_ID_STEAM);
    if (!dealEntry) continue;
    priceByItadId.set(entry.id, {
      price: dealEntry.price?.amount ?? null,
      priceCents: dealEntry.price?.amountInt ?? null,
      regular: dealEntry.regular?.amount ?? null,
      cut: dealEntry.cut ?? null,
    });
  }
  return { status: "ok", priceByItadId };
}

/**
 * Select up to `limit` matched, game-classified, UNOWNED rows due for a
 * price check, in priority order: currently-in-the-deal-pool first (already
 * suspected on sale, per source_deal — same informational flag the HLTB
 * batch prioritizes on), then owners/reviews descending. A row is due if
 * it's never been checked, or was checked more than FPM_PRICE_TTL_HOURS ago
 * — unlike HLTB's "a match is permanent" rule, EVERY price check is
 * eventually retried, including a confirmed "no live deal" one (see
 * FPM_PRICE_TTL_HOURS's doc comment — sales rotate).
 *
 * `source_owned = 0` gate: owned rows never need a price (the Owned badge
 * always wins — see src/worker.js's handleFpm) so backfilling one would
 * just spend ITAD budget for a value that's never displayed. Like every
 * other use of source_owned in this file, this is an informational,
 * priority-time-only flag (set once by markOwned, never cleared) — a game
 * un-owned again later (e.g. a refund) simply stops getting fresh price
 * checks until markOwned's own union logic is revisited; flagged as an
 * accepted edge case, same convention as source_owned's existing use above.
 * @param {object} env
 * @param {{limit: number, staleCutoffMs: number}} options
 * @returns {Promise<Array<{appid: number, name: string}>>}
 */
export async function selectPriceBatch(env, { limit, staleCutoffMs }) {
  const result = await env.FPM_DB.prepare(
    `SELECT appid, name FROM fpm_catalog
     WHERE main_hours IS NOT NULL
       AND app_type = 'game'
       AND source_owned = 0
       AND (price_checked_at IS NULL OR price_checked_at < ?)
     ORDER BY source_deal DESC, owners DESC, (positive + negative) DESC
     LIMIT ?`,
  )
    .bind(staleCutoffMs, limit)
    .all();
  return result.results || [];
}

/** Write back one price-check result. Every field null (with itadId
 * possibly also null) records a checked-but-priceless row — ITAD genuinely
 * has no live Steam deal for it right now (or no ITAD id could even be
 * resolved) — retried on the normal FPM_PRICE_TTL_HOURS cycle, same
 * "checked, no result" convention as recordHltbResult/recordAppType. */
export async function recordPriceResult(env, appid, { price, priceCents, regular, cut, itadId, checkedAtMs }) {
  await env.FPM_DB.prepare(
    "UPDATE fpm_catalog SET price = ?, price_cents = ?, regular = ?, cut = ?, itad_id = ?, price_checked_at = ? WHERE appid = ?",
  )
    .bind(price ?? null, priceCents ?? null, regular ?? null, cut ?? null, itadId ?? null, checkedAtMs, appid)
    .run();
}

/**
 * Price-check a batch of {appid, name} rows against ITAD, chunked into
 * <=ITAD_PRICE_BATCH_SIZE-id calls, and write each result through to D1.
 * For each chunk: resolve appid->itadId, then batch-price whichever ids
 * resolved, then record every item in the chunk (priced or genuinely
 * priceless — both stamp price_checked_at). A throttle/error on either
 * call backs off and retries the SAME chunk (never advances on a bad
 * response), mirroring classifyCatalogTypes/crawlAndUpsertCatalog exactly.
 * Gives up on the run's remaining chunks after FPM_PRICE_MAX_CONSECUTIVE_BAD
 * throttles/errors in a row — cheap to resume, nothing in an unattempted
 * chunk had price_checked_at written, so the next sync run's selection
 * picks the exact same rows right back up. Never throws.
 * @param {object} env - needs env.FPM_DB and env.ITAD_API_KEY.
 * @param {Array<{appid: number, name: string}>} items
 * @param {number} [nowMs]
 * @returns {Promise<{attempted: number, priced: number, noPrice: number, gaveUp: number}>}
 */
export async function resolvePriceBatch(env, items, nowMs = Date.now()) {
  if (!items || items.length === 0) return { attempted: 0, priced: 0, noPrice: 0, gaveUp: 0 };

  let attempted = 0;
  let priced = 0;
  let noPrice = 0;
  let backoff = priceBackoffBaseMs;
  let lastFetchAt = 0;
  let consecutiveBad = 0;

  for (const batchItems of chunk(items, ITAD_PRICE_BATCH_SIZE)) {
    const appids = batchItems.map((item) => item.appid);

    let idResult;
    for (;;) {
      const wait = computeCatalogWaitMs(lastFetchAt, Date.now(), pricePacingMs);
      if (wait > 0) await sleep(wait);
      lastFetchAt = Date.now();

      idResult = await fetchItadIdsBatch(env, appids);
      if (idResult.status === "ok") {
        consecutiveBad = 0;
        backoff = priceBackoffBaseMs;
        break;
      }
      consecutiveBad++;
      if (consecutiveBad >= FPM_PRICE_MAX_CONSECUTIVE_BAD) {
        return { attempted, priced, noPrice, gaveUp: items.length - attempted };
      }
      await sleep(Math.max(backoff, idResult.retryAfterMs || 0));
      backoff = Math.min(backoff * 2, priceBackoffMaxMs);
    }

    const idsToPrice = Array.from(new Set(Array.from(idResult.idsByAppid.values()).filter((id) => id != null)));

    let priceResult = { status: "ok", priceByItadId: new Map() };
    if (idsToPrice.length > 0) {
      for (;;) {
        const wait = computeCatalogWaitMs(lastFetchAt, Date.now(), pricePacingMs);
        if (wait > 0) await sleep(wait);
        lastFetchAt = Date.now();

        priceResult = await fetchItadPricesBatch(env, idsToPrice);
        if (priceResult.status === "ok") {
          consecutiveBad = 0;
          backoff = priceBackoffBaseMs;
          break;
        }
        consecutiveBad++;
        if (consecutiveBad >= FPM_PRICE_MAX_CONSECUTIVE_BAD) {
          return { attempted, priced, noPrice, gaveUp: items.length - attempted };
        }
        await sleep(Math.max(backoff, priceResult.retryAfterMs || 0));
        backoff = Math.min(backoff * 2, priceBackoffMaxMs);
      }
    }

    for (const item of batchItems) {
      const itadId = idResult.idsByAppid.get(item.appid) ?? null;
      const priceEntry = itadId != null ? priceResult.priceByItadId.get(itadId) : undefined;
      attempted++;
      if (priceEntry) {
        await recordPriceResult(env, item.appid, { ...priceEntry, itadId, checkedAtMs: nowMs });
        priced++;
      } else {
        await recordPriceResult(env, item.appid, { price: null, priceCents: null, regular: null, cut: null, itadId, checkedAtMs: nowMs });
        noPrice++;
      }
    }
  }

  return { attempted, priced, noPrice, gaveUp: 0 };
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
 * prioritize the classification/HLTB/price batches below) -> classify up
 * to FPM_TYPE_BATCH unclassified rows against storefront appdetails
 * (Increment 7.8 — matched rows first, so a previously-visible leaderboard
 * reappears as fast as possible) -> backfill up to FPM_TAGS_BATCH rows'
 * SteamSpy tags, KV-seeded where possible (Increment 9 – stored only;
 * nothing reads the tags column yet) -> select up to FPM_SYNC_BATCH NULL-
 * main_hours, app_type='game' rows in priority order -> resolve them
 * against HLTB, writing through to D1 -> select up to FPM_PRICE_SYNC_BATCH
 * matched/game/unowned rows due for a price check and batch-price them
 * against ITAD (Increment 8.5), writing through to D1. Never throws — a
 * failure in any one step just means this run made less progress than
 * hoped; the next sync run picks up from whatever's already in D1
 * (resumable by construction).
 *
 * The price step only runs when env.ITAD_API_KEY is configured (same
 * fail-soft convention as src/worker.js's handleFpm) — without a key there
 * is nothing this step could do, so it's skipped rather than spending a
 * whole run's consecutive-bad budget on calls that can only fail.
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

  // Increment 9: tag backfill runs straight after classification, so the
  // catalog's app-type picture is as complete as possible before this step
  // spends any SteamSpy budget. Every existing step's relative order is
  // untouched. Note the batch selection itself deliberately does NOT gate on
  // app_type: SPEC.md gate (c) wants a funnel that adds up to the whole
  // catalog row count, which an app_type gate would quietly break.
  const tagsResult = await backfillCatalogTags(env);

  const hltbStaleCutoffMs = Date.now() - FPM_HLTB_TTL_MS;
  const batch = await selectHltbBatch(env, { limit: FPM_SYNC_BATCH, staleCutoffMs: hltbStaleCutoffMs });
  const hltbResult = await resolveHltbBatch(env, ctx, batch);

  let priceResult = { attempted: 0, priced: 0, noPrice: 0, gaveUp: 0 };
  if (env.ITAD_API_KEY) {
    const priceStaleCutoffMs = Date.now() - FPM_PRICE_TTL_MS;
    const priceBatch = await selectPriceBatch(env, { limit: FPM_PRICE_SYNC_BATCH, staleCutoffMs: priceStaleCutoffMs });
    priceResult = await resolvePriceBatch(env, priceBatch);
  }

  lastSyncStats = {
    typeAttempted: typeResult.attempted,
    typeClassified: typeResult.classified,
    typeNonGame: typeResult.nonGame,
    tagsAttempted: tagsResult.attempted,
    tagsTagged: tagsResult.tagged,
    tagsKvSeeded: tagsResult.kvSeeded,
    tagsEmpty: tagsResult.empty,
    // Round-2 review, CR-9: SPEC.md §3.5's counter set is
    // tagged / kv_seeded / empty / pending / skipped. `tagsSkipped` is that
    // last leg – rows the live pass walked past after too many unusable
    // responses. Distinct from `tagsGaveUp`, which is the rows abandoned
    // when a whole pass gives up. Both stay in tagsPending (never stamped).
    tagsSkipped: tagsResult.skipped,
    tagsGaveUp: tagsResult.gaveUp,
    // Round-1 review, majors 6 / minor 12: two failure counters that were
    // previously swallowed entirely. A non-zero tagsWriteFailed means D1
    // refused writes (rows left unstamped, retried next run); a large
    // tagsKvFailed means the tag cache is effectively unavailable and the
    // run is spending live requests it did not need to. Both were invisible
    // before, which made "the run died" indistinguishable from "the run
    // finished" from the status endpoint.
    tagsKvFailed: tagsResult.kvFailed,
    tagsWriteFailed: tagsResult.writeFailed,
    cacheHits: hltbResult.cacheHits,
    resolved: hltbResult.resolved,
    gaveUp: hltbResult.gaveUp,
    priceAttempted: priceResult.attempted,
    priced: priceResult.priced,
    noPrice: priceResult.noPrice,
    priceGaveUp: priceResult.gaveUp,
  };
  console.log(
    `[fpm-sync] type: ${typeResult.classified} classified (${typeResult.nonGame} non-game) of ${typeResult.attempted} attempted` +
      ` · tags: ${tagsResult.tagged} tagged (${tagsResult.kvSeeded} kv-seeded), ${tagsResult.empty} empty, ${tagsResult.skipped} skipped, ${tagsResult.gaveUp} gave up,` +
      ` ${tagsResult.kvFailed} kv-read failures, ${tagsResult.writeFailed} d1-write failures` +
      ` · hltb: ${hltbResult.cacheHits} cache hits, ${hltbResult.resolved} resolved, ${hltbResult.gaveUp} gave up` +
      ` · price: ${priceResult.priced} priced, ${priceResult.noPrice} no-price, ${priceResult.gaveUp} gave up`,
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

// ---------------------------------------------------------------------------
// Sync auto-continue (Increment 8, ride-along A) — "one trigger walks
// classification + HLTB batches until pending = 0". runFpmSyncPipeline above
// is ONE batch step (crawl the catalog, classify up to FPM_TYPE_BATCH rows,
// HLTB-resolve up to FPM_SYNC_BATCH rows) — this just calls that SAME,
// UNMODIFIED step repeatedly, checking D1-wide stats after each run, until
// both funnels are empty, a stop is requested, or a safety bound is hit. No
// pacing/backoff/give-up logic changes at all: every throttle/retry/give-up
// decision still happens exactly where it already did, inside the one batch
// step this just calls in a loop.
// ---------------------------------------------------------------------------

/** Safety bound on how many batch-step iterations one auto-continue run will
 * drive before giving up regardless of remaining pending count — generous
 * headroom over the worst case at today's catalog size (FPM_SYNC_BATCH=3000/
 * FPM_TYPE_BATCH=500 per iteration against an ~18k-row catalog is well under
 * 40 iterations for a real completion); a genuinely stuck run (e.g. HLTB
 * down for hours) stops here instead of looping forever. */
export const FPM_AUTO_CONTINUE_MAX_ITERATIONS = 200;

let fpmAutoContinueMaxIterations = FPM_AUTO_CONTINUE_MAX_ITERATIONS;

/** TEST-ONLY seam: shrink the safety-bound iteration count so a "gives up
 * after the bound" test doesn't have to actually drive 200 real pipeline
 * runs. Never called from production code. */
export function __setFpmAutoContinueMaxIterationsForTests(n) {
  fpmAutoContinueMaxIterations = n;
}

/** TEST-ONLY seam: restore the production safety bound between tests. */
export function __resetFpmAutoContinueMaxIterationsForTests() {
  fpmAutoContinueMaxIterations = FPM_AUTO_CONTINUE_MAX_ITERATIONS;
}

let fpmAutoContinueActive = false;
let fpmAutoContinueStopRequested = false;

/** Whether an auto-continue LOOP (as opposed to a single manual sync) is
 * currently driving — lets the frontend show a Stop control and know the
 * "sync running" status line represents a multi-batch run, not a one-shot. */
export function isFpmAutoContinueActive() {
  return fpmAutoContinueActive;
}

/** Ask a running auto-continue loop to stop after its current in-flight
 * batch step finishes — never interrupts mid-batch (that would abandon a
 * partially-classified/resolved batch outside its own resumable-by-D1-write
 * discipline). A no-op if no auto-continue is running.
 *
 * ONE deliberate exception, added in Increment 9 (round-2 review, major
 * SEC-7): the tag step wakes out of its BACKOFF SLEEP when this is set,
 * rather than making the operator wait out up to 2h50m of doubling backoff
 * for a Stop that reported success immediately. That exception is safe
 * precisely because it happens while nothing is in flight – no row is
 * half-written, and every unresolved row is left unstamped and reselected
 * next run, which is the same state a given-up row is already in. */
export function requestFpmAutoContinueStop() {
  fpmAutoContinueStopRequested = true;
}

/** Internal read of the stop flag, for code EARLIER in this file than the
 * flag's declaration – specifically the tag step's interruptible backoff
 * (round-2 review, major SEC-7). A hoisted function declaration, so nothing
 * had to be reordered. Not exported: this is a within-module detail, and the
 * public surface stays requestFpmAutoContinueStop /
 * isFpmAutoContinueActive. */
function isFpmStopRequested() {
  return fpmAutoContinueStopRequested;
}

/** TEST-ONLY seam: reset the module-scoped auto-continue flags between
 * tests. Never called from production code. */
export function __resetFpmAutoContinueStateForTests() {
  fpmAutoContinueActive = false;
  fpmAutoContinueStopRequested = false;
}

/**
 * Repeatedly runs runFpmSyncPipeline (unchanged) until the type
 * classification funnel (classified >= total), the HLTB funnel
 * (pending === 0), the price-backfill funnel (pricePending === 0,
 * Increment 8.5), AND the tag-backfill funnel (tagsPending === 0,
 * Increment 9) are all empty, a stop is requested, or
 * FPM_AUTO_CONTINUE_MAX_ITERATIONS is reached. Never throws — same
 * resumable-by-construction discipline as the pipeline itself: whatever
 * progress got written to D1 this run stands regardless of how the loop
 * ends.
 *
 * priceDone is vacuously true when env.ITAD_API_KEY isn't configured — the
 * price step never runs in that case (see runFpmSyncPipeline), so gating
 * completion on it would loop forever for no reason; same reasoning as
 * runFpmSyncPipeline's own ITAD_API_KEY skip.
 * @param {object} env
 * @param {object} ctx
 * @param {object} deps - same shape runFpmSyncPipeline takes.
 * @returns {Promise<{iterations: number, stoppedEarly: boolean}>}
 */
export async function runFpmSyncUntilComplete(env, ctx, deps) {
  let iterations = 0;
  let stoppedEarly = false;

  while (iterations < fpmAutoContinueMaxIterations) {
    if (fpmAutoContinueStopRequested) {
      stoppedEarly = true;
      break;
    }

    await runFpmSyncPipeline(env, ctx, deps);
    iterations++;

    if (fpmAutoContinueStopRequested) {
      stoppedEarly = true;
      break;
    }

    let stats;
    try {
      stats = await getCatalogStats(env);
    } catch {
      break; // can't read progress — stop rather than loop blind
    }
    const classificationDone = stats.total > 0 && stats.classified >= stats.total;
    const hltbDone = stats.pending === 0;
    const priceDone = !env.ITAD_API_KEY || stats.pricePending === 0;
    // Increment 9: one trigger must walk the tag funnel to pending = 0
    // unattended too (SPEC.md gate (b)). No TTL is involved – a row is done
    // once tags_checked_at is stamped, tagged or empty – so this reaches 0
    // and stays there rather than re-arming on a refresh cycle.
    const tagsDone = stats.tagsPending === 0;
    if (classificationDone && hltbDone && priceDone && tagsDone) break;
  }

  return { iterations, stoppedEarly };
}

/**
 * Kick an auto-continue loop in the background (ctx.waitUntil) unless a sync
 * (single-shot OR auto-continue) is already running — reuses fpmSyncRunning
 * as the single "something is in flight" guard so the two modes can never
 * run concurrently and double-drive the pipeline. Returns immediately, same
 * contract as startFpmSync.
 * @returns {{started: boolean, alreadyRunning?: boolean}}
 */
export function startFpmAutoContinue(env, ctx, deps) {
  if (fpmSyncRunning) return { started: false, alreadyRunning: true };
  fpmSyncRunning = true;
  fpmAutoContinueActive = true;
  fpmAutoContinueStopRequested = false;
  ctx.waitUntil(
    runFpmSyncUntilComplete(env, ctx, deps)
      .catch(() => {})
      .finally(() => {
        fpmSyncRunning = false;
        fpmAutoContinueActive = false;
      }),
  );
  return { started: true };
}
