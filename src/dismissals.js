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

// INCREMENT 15, SPEC.md §10 – `steam_id` leads a composite primary key here
// too. `appid` stays INTEGER (it is a small number and always was); `steam_id`
// is TEXT because a SteamID64 does not survive as a JavaScript number. See
// src/settings.js's header for the full reasoning and for why James has to run
// one DROP by hand before the first sign-in.
const CREATE_DISMISSALS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS dismissals (
  steam_id TEXT NOT NULL, appid INTEGER NOT NULL, name TEXT, dismissed_at INTEGER,
  PRIMARY KEY (steam_id, appid)
)`;

/** Create the dismissals table if it doesn't exist yet. Safe to call on
 * every request (idempotent, cheap), same convention as ensureSettingsSchema/
 * ensureCatalogSchema. */
export async function ensureDismissalsSchema(env) {
  await env.FPM_DB.prepare(CREATE_DISMISSALS_TABLE_SQL).run();
}

/** Every dismissed row for ONE user, most-recently-dismissed first — backs the
 * "Dismissed (N)" management view's GET /api/dismissals.
 *
 * `steamId` comes from the session and never from `env` (SPEC.md §7.3).
 * @param {object} env - needs env.FPM_DB.
 * @param {string} steamId - the signed-in user's SteamID64, AS A STRING.
 * @returns {Promise<Array<{appid: number, name: string|null, dismissed_at: number}>>}
 */
export async function listDismissals(env, steamId) {
  const result = await env.FPM_DB.prepare(
    "SELECT appid, name, dismissed_at FROM dismissals WHERE steam_id = ? ORDER BY dismissed_at DESC",
  )
    .bind(steamId)
    .all();
  return result.results || [];
}

/** Just ONE user's dismissed appids, as a Set — the shape every lane's
 * server-side exclusion join actually needs (see excludeDismissed below).
 * @param {object} env - needs env.FPM_DB.
 * @param {string} steamId - the signed-in user's SteamID64, AS A STRING.
 * @returns {Promise<Set<number>>}
 */
export async function getDismissedAppIdSet(env, steamId) {
  const result = await env.FPM_DB.prepare("SELECT appid FROM dismissals WHERE steam_id = ?")
    .bind(steamId)
    .all();
  return new Set((result.results || []).map((row) => row.appid));
}

// The CONFLICT TARGET names BOTH key columns. `ON CONFLICT(appid)` would mean
// "one dismissal per game across all users", which is the leak this whole
// section exists to close.
const UPSERT_DISMISSAL_SQL = `INSERT INTO dismissals (steam_id, appid, name, dismissed_at) VALUES (?, ?, ?, ?)
ON CONFLICT(steam_id, appid) DO UPDATE SET name = excluded.name, dismissed_at = excluded.dismissed_at`;

/** Dismiss one appid FOR ONE USER (idempotent — dismissing an already-dismissed
 * appid just refreshes its name/timestamp). `name` is a snapshot for display in
 * the Dismissed view; it may be null if the caller didn't have a title handy. */
export async function addDismissal(env, steamId, appid, name, nowMs = Date.now()) {
  await env.FPM_DB.prepare(UPSERT_DISMISSAL_SQL).bind(steamId, appid, name ?? null, nowMs).run();
}

/** Un-dismiss one appid FOR ONE USER. A no-op (not an error) if it wasn't
 * dismissed. The `steam_id` predicate is what stops one user's restore from
 * deleting another user's row. */
export async function removeDismissal(env, steamId, appid) {
  await env.FPM_DB.prepare("DELETE FROM dismissals WHERE steam_id = ? AND appid = ?")
    .bind(steamId, appid)
    .run();
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
