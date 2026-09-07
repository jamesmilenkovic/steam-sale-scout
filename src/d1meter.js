// Steam Sale Scout - the D1 row-read meter (Increment 13).
//
// WHY THIS EXISTS AS A PRODUCT MODULE AND NOT A SCRATCH SCRIPT. Increment 13
// is a COST increment: its gate is D1 row reads per page load, and Cloudflare
// bills rows READ, not rows returned. "We measured it once in a script"
// is how a regression ships six weeks later, so the measurement lives in the
// response as an always-present `d1` block and is asserted in the suite.
//
// WHAT IT COUNTS, AND WHY THAT NUMBER CAN BE TRUSTED (SPEC.md gate 1). Local
// `meta.rows_read` counts rows SCANNED, not rows returned. Proved at
// checkpoint 01 by a full scan of an unindexed column that returns ZERO rows
// and still reports 18,306, alongside a primary-key lookup that reports 1. So
// a full table scan is visible here as a count far larger than the rows that
// came back, and no separate "full scans" counter is needed.
//
// THE MEASUREMENT THAT MADE THE CASE: /api/rank cost 36,620 rows read per
// request before this increment - TWO full passes over an 18,306-row
// catalogue, not one. The second pass (`ensureRankExclusions`) returns zero
// rows, which is exactly why every earlier count missed it.
//
// HOW IT WRAPS. A counting proxy around the D1 binding, installed once at the
// top of the handler. Nothing downstream knows it exists: `selectRankCatalogRows`,
// `getAllSettings`, `getGameMarks` and the rest keep taking a plain `env` and
// calling `env.FPM_DB.prepare(...)`. That is deliberate - a meter that needed
// every call site to cooperate would be a meter every new call site could
// forget.

/** One D1 prepared statement, wrapped so its result's meta is counted. The
 * real statement is kept on `_stmt` because `db.batch()` will only accept the
 * genuine article - the wrapper unwraps on the way in. */
class MeteredStatement {
  constructor(stmt, stats) {
    this._stmt = stmt;
    this._stats = stats;
  }

  bind(...args) {
    return new MeteredStatement(this._stmt.bind(...args), this._stats);
  }

  async all() {
    return record(this._stats, await this.__run(() => this._stmt.all()));
  }

  async run() {
    return record(this._stats, await this.__run(() => this._stmt.run()));
  }

  /** A statement that THROWS is still a statement that was sent. Counting it
   * matters here more than it looks: `ensureCatalogSchema` used to fire 23
   * `ALTER TABLE ADD COLUMN` statements per request that all failed as
   * duplicates, and a meter that only counted successes reported the same
   * query count with that work present and absent - which is exactly the
   * flattering number gate 1 exists to refuse. */
  async __run(fn) {
    try {
      return await fn();
    } catch (err) {
      this._stats.queries++;
      this._stats.unmetered++;
      throw err;
    }
  }

  async first(...args) {
    // `.first()` resolves to a ROW (or null), not a result envelope, so there
    // is no meta to read. Counted as a query with unknown rows rather than
    // silently as zero - an uncounted read is worse than a visibly uncountable
    // one. Nothing on the /api/rank path uses it today.
    this._stats.queries++;
    this._stats.unmetered++;
    return this._stmt.first(...args);
  }

  raw(...args) {
    this._stats.queries++;
    this._stats.unmetered++;
    return this._stmt.raw(...args);
  }
}

function record(stats, result) {
  stats.queries++;
  stats.rowsRead += result?.meta?.rows_read ?? 0;
  stats.rowsWritten += result?.meta?.rows_written ?? 0;
  return result;
}

/**
 * Wrap one D1 database in a counting proxy.
 * @param {object} db - the D1 binding (env.FPM_DB).
 * @returns {{db: object, stats: {queries: number, rowsRead: number, rowsWritten: number, unmetered: number}}}
 */
export function meterD1(db) {
  const stats = { queries: 0, rowsRead: 0, rowsWritten: 0, unmetered: 0 };

  const metered = {
    prepare(sql) {
      return new MeteredStatement(db.prepare(sql), stats);
    },
    async batch(statements) {
      const real = (statements || []).map((s) => (s instanceof MeteredStatement ? s._stmt : s));
      const results = await db.batch(real);
      // A batch is ONE round trip but N statements, and every one of them is
      // billed. Counted as N queries so the number in the response matches
      // what D1 charges for rather than what the code happens to look like.
      for (const r of results || []) record(stats, r);
      return results;
    },
    async exec(sql) {
      stats.queries++;
      stats.unmetered++;
      return db.exec(sql);
    },
    // EXACTLY FOUR METHODS ARE FORWARDED: prepare, batch, exec and the escape
    // hatch below. This is a plain object, NOT a Proxy, so anything else on the
    // D1 binding (dump, withSession, ...) is simply ABSENT here - `db.dump()`
    // on a metered env throws "db.dump is not a function". Nothing in this app
    // calls one, and constraint 9 says the meter must never be the reason a
    // lane breaks, so the rule for a future caller is: reach the real binding
    // through `__unmetered` rather than assuming this object is the binding.
    // (Corrected at the round-2 review, CR-19 / TC-17 - this comment used to
    // claim the unused methods still reached the real binding, which they
    // never did. A Proxy would make the claim true and is deliberately NOT
    // added: it widens the diff of a cost increment for no live caller.)
    __unmetered: db,
  };

  return { db: metered, stats };
}

/**
 * Install the meter on a request's `env`, returning a new env whose FPM_DB is
 * counted. The original env is not mutated - handlers that do not want the
 * meter are unaffected, and nothing leaks between requests.
 * @param {object} env
 * @returns {{env: object, stats: object}}
 */
export function meterEnv(env) {
  if (!env?.FPM_DB) return { env, stats: { queries: 0, rowsRead: 0, rowsWritten: 0, unmetered: 0 } };
  const { db, stats } = meterD1(env.FPM_DB);
  return { env: { ...env, FPM_DB: db }, stats };
}
