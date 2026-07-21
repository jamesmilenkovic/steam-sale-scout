// Steam Sale Scout — "Not interested" dismissals (Increment 8).
//
// App-wide across the sale lanes (Deals/Recs/Best-of/FPM), applied
// server-side so a dismissal actually frees a slot rather than just being
// hidden client-side — see src/worker.js's getDismissedAppIds/excludeDismissed
// call sites for where each lane joins against this. Library and Wishlist
// are deliberately exempt (PO decision): Library is a factual record of what
// James owns, Wishlist is his own curated list — "not interested" has no
// meaning for either.
//
// No permanent deletes — un-dismissing removes the row (data IS allowed to
// go away here, unlike the FPM catalog's "never delete" convention, since a
// dismissal is a live preference, not a fetched fact). Same D1 database as
// the FPM catalog (env.FPM_DB) — no new binding needed, per the PO's "single
// persistence story" decision.

const CREATE_DISMISSALS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS dismissals (
  appid INTEGER PRIMARY KEY,
  name TEXT,
  dismissed_at INTEGER
)`;

/** Create the dismissals table if it doesn't exist yet. Safe to call on
 * every request (idempotent, cheap), same convention as ensureSettingsSchema/
 * ensureCatalogSchema. */
export async function ensureDismissalsSchema(env) {
  await env.FPM_DB.prepare(CREATE_DISMISSALS_TABLE_SQL).run();
}

/** Every dismissed row, most-recently-dismissed first — backs the
 * "Dismissed (N)" management view's GET /api/dismissals.
 * @returns {Promise<Array<{appid: number, name: string|null, dismissed_at: number}>>}
 */
export async function listDismissals(env) {
  const result = await env.FPM_DB.prepare(
    "SELECT appid, name, dismissed_at FROM dismissals ORDER BY dismissed_at DESC",
  ).all();
  return result.results || [];
}

/** Just the dismissed appids, as a Set — the shape every lane's server-side
 * exclusion join actually needs (see excludeDismissed below).
 * @returns {Promise<Set<number>>}
 */
export async function getDismissedAppIdSet(env) {
  const result = await env.FPM_DB.prepare("SELECT appid FROM dismissals").all();
  return new Set((result.results || []).map((row) => row.appid));
}

const UPSERT_DISMISSAL_SQL = `INSERT INTO dismissals (appid, name, dismissed_at) VALUES (?, ?, ?)
ON CONFLICT(appid) DO UPDATE SET name = excluded.name, dismissed_at = excluded.dismissed_at`;

/** Dismiss one appid (idempotent — dismissing an already-dismissed appid
 * just refreshes its name/timestamp). `name` is a snapshot for display in
 * the Dismissed view; it may be null if the caller didn't have a title handy. */
export async function addDismissal(env, appid, name, nowMs = Date.now()) {
  await env.FPM_DB.prepare(UPSERT_DISMISSAL_SQL).bind(appid, name ?? null, nowMs).run();
}

/** Un-dismiss one appid. A no-op (not an error) if it wasn't dismissed. */
export async function removeDismissal(env, appid) {
  await env.FPM_DB.prepare("DELETE FROM dismissals WHERE appid = ?").bind(appid).run();
}

/**
 * Pure: filter an array of items with an `.appid` field down to those NOT
 * dismissed. Mirrors src/deals.js's excludeOwned exactly (same shape, same
 * "not in the set" semantics) so every lane's call site reads the same way.
 * @param {Array<{appid: number|null}>} items
 * @param {Set<number>} dismissedAppIds
 * @returns {Array}
 */
export function excludeDismissed(items, dismissedAppIds) {
  return items.filter((item) => !dismissedAppIds.has(item.appid));
}
