// Steam Sale Scout — persisted UI settings (Increment 8).
//
// Single persistence story per the PO's scoping decision: no localStorage
// split-brain, the app's state (filter-bar values, the recency window, the
// FPM-tab-local controls) lives in the same D1 database as the catalog
// (env.FPM_DB), in a `settings` table. This module is a thin, dumb
// key/value store — it has no opinion on WHAT the valid settings keys or
// their defaults are; that's entirely the browser's concern (see
// public/index.html's `persistedSettings` handling), the same way
// public/filters.js's loadFilters() used to merge a possibly-partial
// localStorage value over DEFAULT_FILTERS. Keeping this dumb means a future
// new setting never needs a server-side change here.
//
// Mirrors src/catalog.js's D1 conventions: one explicit SQL string per
// statement (no query builder), CREATE TABLE IF NOT EXISTS on the request
// path (safe/cheap to call every time — single-table, single-environment,
// local-only app, same "Coder's call" precedent as ensureCatalogSchema).

const CREATE_SETTINGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
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
 * @param {object} env - needs env.FPM_DB.
 * @returns {Promise<Object<string, unknown>>}
 */
export async function getAllSettings(env) {
  const result = await env.FPM_DB.prepare("SELECT key, value FROM settings").all();
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

const UPSERT_SETTING_SQL = `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

/**
 * Upsert one or more top-level settings keys in a single D1 `.batch()` call.
 * Only the keys present in `entries` are written — this is a partial update
 * (per-key semantics, matching the table's key/value shape), not a
 * replace-everything PUT. A caller that wants "save everything I currently
 * have" (the browser's debounced auto-save) just passes its whole current
 * state object each time, which is simplest and always correct.
 * @param {object} env - needs env.FPM_DB.
 * @param {Object<string, unknown>} entries
 * @param {number} [nowMs]
 */
export async function putSettings(env, entries, nowMs = Date.now()) {
  const keys = Object.keys(entries || {});
  if (keys.length === 0) return;
  const stmt = env.FPM_DB.prepare(UPSERT_SETTING_SQL);
  const statements = keys.map((key) => stmt.bind(key, JSON.stringify(entries[key]), nowMs));
  await env.FPM_DB.batch(statements);
}
