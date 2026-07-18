// Test-only D1 mock, backed by Node's built-in `node:sqlite` (real SQLite,
// not a hand-rolled interpreter) — so src/catalog.js's actual SQL (including
// the `ON CONFLICT ... DO UPDATE SET ... WHERE ...` upsert) runs against a
// genuine SQLite engine under `node --test`, without needing wrangler or a
// real D1 binding. Implements just the slice of the real D1 API
// src/catalog.js uses: `prepare(sql).bind(...).run()/.all()/.first()` and
// `batch(statements)`.
//
// This is intentionally NOT a general-purpose D1 shim — it's scoped to what
// src/catalog.js actually calls, same spirit as this repo's other test
// mocks (makeMockKv/makeMockCache in the worker-*.test.mjs files).

import { DatabaseSync } from "node:sqlite";

function makeStatement(db, sql, boundArgs) {
  return {
    bind(...args) {
      return makeStatement(db, sql, args);
    },
    async run() {
      const stmt = db.prepare(sql);
      stmt.run(...boundArgs);
      return { success: true, results: [], meta: {} };
    },
    async all() {
      const stmt = db.prepare(sql);
      const results = stmt.all(...boundArgs);
      return { success: true, results, meta: {} };
    },
    async first(column) {
      const stmt = db.prepare(sql);
      const row = stmt.get(...boundArgs);
      if (!row) return null;
      return column ? row[column] : row;
    },
  };
}

/**
 * Build a fresh in-memory mock D1 database (one per test — call this in
 * `test.beforeEach` or at the top of each test, never share one across
 * tests).
 * @returns {object} a D1Database-shaped object.
 */
export function makeMockD1() {
  const db = new DatabaseSync(":memory:");
  return {
    _db: db, // exposed for tests that want to assert against raw SQL directly
    prepare(sql) {
      return makeStatement(db, sql, []);
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}
