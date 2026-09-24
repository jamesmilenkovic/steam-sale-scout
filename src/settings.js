// Steam Sale Scout — persisted UI settings (Increment 8).
//
// Single persistence story per the PO's scoping decision: no localStorage
// split-brain, the app's state (filter-bar values, the recency window, the
// FPM-tab-local controls) lives in the same D1 database as the catalog
// (env.FPM_DB), in a `settings` table. This module is a thin, dumb
// key/value store — it has no opinion on WHAT the valid settings keys or
// their defaults are; that's entirely the browser's concern (see
// public/index.html's `persistedSettings` handling), the same way
// public/filters.js's loadFilters() (deleted at increment 14) used to merge
// a possibly-partial
// localStorage value over DEFAULT_FILTERS. Keeping this dumb means a future
// new setting never needs a server-side change here.
//
// Mirrors src/catalog.js's D1 conventions: one explicit SQL string per
// statement (no query builder), CREATE TABLE IF NOT EXISTS on the request
// path (safe/cheap to call every time — single-table, single-environment,
// local-only app, same "Coder's call" precedent as ensureCatalogSchema).

// INCREMENT 15, SPEC.md §10 – `steam_id` LEADS A COMPOSITE PRIMARY KEY.
//
// `TEXT` IS FORCED, NOT PREFERRED. D1 hands rows back to JavaScript as plain
// values, and a SteamID64 does not survive as a JavaScript number
// (`Number("76561198012345679")` is `76561198012345680`). An INTEGER column
// would silently collide two users onto one key. It is the same reason the
// session token's `sub` is a string (SPEC.md §6.1).
//
// NO `migrations/` MECHANISM IS INTRODUCED. The existing
// CREATE TABLE IF NOT EXISTS convention is extended in place, and James drops
// the three old un-keyed tables ONCE, BY HAND, before the first sign-in
// (SPEC.md §10). IF NOT EXISTS will not re-shape a table that already exists,
// so until he runs that command this statement is a no-op and every read below
// hits a table with no `steam_id` column.
const CREATE_SETTINGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS settings (
  steam_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at INTEGER,
  PRIMARY KEY (steam_id, key)
)`;

/** Create the settings table if it doesn't exist yet. Safe to call on every
 * request (idempotent, cheap). */
export async function ensureSettingsSchema(env) {
  await env.FPM_DB.prepare(CREATE_SETTINGS_TABLE_SQL).run();
}

/**
 * Every persisted setting, keyed by name, JSON-decoded. A row whose value
 * fails to JSON.parse (shouldn't happen — putSettings always JSON.stringifys
 * — but a corrupt/hand-edited row must never break a lane) is silently
 * skipped rather than thrown; the caller's own default applies for that key,
 * same fail-soft discipline as everything else in this app.
 *
 * `steamId` IS EXPLICIT AND COMES FROM THE SESSION, NEVER FROM `env`
 * (SPEC.md §7.3): "a builder that reads `env` internally can be called
 * correctly from anywhere and still be wrong."
 * @param {object} env - needs env.FPM_DB.
 * @param {string} steamId - the signed-in user's SteamID64, AS A STRING.
 * @returns {Promise<Object<string, unknown>>}
 */
export async function getAllSettings(env, steamId) {
  const result = await env.FPM_DB.prepare("SELECT key, value FROM settings WHERE steam_id = ?")
    .bind(steamId)
    .all();
  const rows = result.results || [];
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // Corrupt row — skip it, caller's default applies for this key.
    }
  }
  return out;
}

// An INSERT has no WHERE clause, so the composite key's equivalent of
// `WHERE steam_id = ?` is the bound `steam_id` column plus the CONFLICT TARGET
// naming BOTH columns. `ON CONFLICT(key)` would be a syntax error against the
// new table and, worse, would mean "one row per key across all users".
const UPSERT_SETTING_SQL = `INSERT INTO settings (steam_id, key, value, updated_at) VALUES (?, ?, ?, ?)
ON CONFLICT(steam_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

/**
 * Upsert one or more top-level settings keys in a single D1 `.batch()` call.
 * Only the keys present in `entries` are written — this is a partial update
 * (per-key semantics, matching the table's key/value shape), not a
 * replace-everything PUT. A caller that wants "save everything I currently
 * have" (the browser's debounced auto-save) just passes its whole current
 * state object each time, which is simplest and always correct.
 * @param {object} env - needs env.FPM_DB.
 * @param {string} steamId - the signed-in user's SteamID64, AS A STRING.
 * @param {Object<string, unknown>} entries
 * @param {number} [nowMs]
 */
export async function putSettings(env, steamId, entries, nowMs = Date.now()) {
  const keys = Object.keys(entries || {});
  if (keys.length === 0) return;
  const stmt = env.FPM_DB.prepare(UPSERT_SETTING_SQL);
  const statements = keys.map((key) => stmt.bind(steamId, key, JSON.stringify(entries[key]), nowMs));
  await env.FPM_DB.batch(statements);
}
