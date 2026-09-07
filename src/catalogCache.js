// Steam Sale Scout - the catalogue snapshot (Increment 13).
//
// THE PROBLEM THIS EXISTS FOR, IN ONE NUMBER. /api/rank cost 36,620 D1 row
// reads per request - TWO full passes over an 18,306-row catalogue, not the
// one the spec assumed, because the second pass returns ZERO rows and was
// therefore invisible to any measurement that counted what came back. Against
// Cloudflare's free tier of 5M row reads a day that is 136 page loads a day
// in total, across every user who will ever exist. That is a COST problem,
// not a speed problem, and the distinction matters:
//
//   THIS MODULE DOES NOT MAKE THE PAGE FASTER, AND MUST NOT BE SAID TO.
//   A warm load was already ~0.9 s. The ~30 s cold load some sessions see is
//   the 24-hour STEAM LIBRARY refresh, which is per-user, lives outside this
//   snapshot by design (SPEC.md §4.1), and is untouched by any of this.
//
// WHAT IS CACHED: the raw catalogue rows, and nothing else. They are
// user-independent by construction (Rev 2's two-layer rule). Everything the
// request joins onto them - the library, dismissals, marks, settings, the ITAD
// deal pool - is per-user and is still loaded per request.
//
// WHAT IS DELIBERATELY NOT CACHED, and this is a refusal rather than an
// oversight (SPEC.md §4.1, §7 item 5): the IDF map, similarity in any form,
// and the /api/rank response. computeIdf runs over the ELIGIBLE pool, and
// eligibility subtracts one user's dismissals - caching it would freeze one
// person's exclusions into everyone else's similarity weights. A tiny change
// to the ranking is still a change to the ranking, and the ranking has been
// frozen since increment 11. That is the door a caching increment turns into
// a ranking increment through, and it stays shut.
//
// FAIL-SOFT IS ABSOLUTE (SPEC.md §9.9). A missing CATALOG_CACHE binding, a KV
// error, a corrupt or half-written snapshot, or a catalog_meta read failure
// all degrade to the direct D1 read and report cacheState "rebuild". The cache
// must never be able to take the page down, and must never serve a row the
// database no longer holds.

import { ensureRankExclusions } from "./rank.js";
import {
  CATALOG_VERSION_KEY,
  bumpCatalogVersion,
  newCatalogVersion,
  readCatalogVersion,
  selectRankCatalogRows,
} from "./catalog.js";

export { CATALOG_VERSION_KEY, bumpCatalogVersion, newCatalogVersion } from "./catalog.js";

/**
 * BUMP THIS BY HAND WHENEVER selectRankCatalogRows' COLUMN LIST CHANGES.
 * A snapshot written before a shape change must not be readable after it -
 * exactly the trap increment 12.5 added a version segment to `libraryCacheKey`
 * for, after a payload written before a shape change silently produced a wrong
 * answer. Copied verbatim as a discipline, not as code.
 *
 * v1 -> v2 (increment 13 review, SEC-3): a chunk's VALUE changed shape, from a
 * bare row array to `{ nonce, rows }`. Same trap, same rule - a v1 value read
 * by v2 code would fail its checks and rebuild, which is safe, but paying a KV
 * read to discover that is pointless when a key segment can just not match.
 */
export const CATALOG_SNAPSHOT_VERSION = "v2";

/** How long a snapshot is considered current. Past this it is still SERVED -
 * immediately, from whatever tier held it - and a rebuild is fired through
 * ctx.waitUntil. Without that, one unlucky visitor every six hours waits for a
 * full catalogue read, which is a worse product than the one we started with.
 * James ruled 6 over 24 at §8 q4: with the version stamp doing the real
 * invalidation, this is only the safety net for a writer that bypasses the
 * bump - a hand-run sqlite3 statement, say - and 6 h costs 1.5% of the daily
 * row-read ceiling. */
export const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60;

/** Rows per KV value. The serialised catalogue measures 16,002,011 bytes -
 * 15.26 MiB, 16.00 MB - which is under KV's 25 MB value ceiling but over the
 * 8 MB threshold SPEC.md §5 sets for chunking, so the rule fires and the
 * snapshot is written as a manifest plus five chunks. Largest chunk 3,670,008
 * bytes. The byte count is given because the two review lanes reported 3.50
 * and 3.67 for the same chunk, in MiB and MB, and a raw number cannot be read
 * two ways. Stated up front in §5 so it would be a decision rather than a
 * surprise at the ceiling. */
export const SNAPSHOT_CHUNK_ROWS = 4000;

const keyPrefix = (version) => `catalog-snapshot:${CATALOG_SNAPSHOT_VERSION}:${version}`;
const manifestKey = (version) => `${keyPrefix(version)}:manifest`;
const chunkKey = (version, i) => `${keyPrefix(version)}:${i}`;

/**
 * The module-scope memo - tier one, and the reason a warm request costs zero
 * KV reads and zero JSON parses on top of zero D1 row reads. On its own it
 * would not be a bound (it scales with isolate churn x users), which is why it
 * sits OVER the KV snapshot rather than instead of it.
 */
let memo = null; // { db, version, rows, writtenAt }

/** The REAL D1 binding behind whatever wrapper the caller handed us.
 * handleRank installs a counting proxy (src/d1meter.js) and builds a fresh one
 * on every request, so anything keyed on `env.FPM_DB` itself would never match
 * twice. The underlying binding is stable for the isolate's lifetime, and it is
 * the thing that actually identifies "which database is this". */
function rawDb(env) {
  let db = env?.FPM_DB ?? null;
  // LOOP, DO NOT UNWRAP ONCE (increment 13 review, CR-11). One `??` handles
  // exactly one layer of metering. Nothing today wraps twice, but a second
  // wrapper added later would silently make the memo key a fresh object on
  // every request, and the symptom - the memory tier quietly never hitting -
  // is a cost regression no test would fail on. The bound is the chain length,
  // and an unmetered binding is never itself metered, so it terminates.
  for (let depth = 0; db?.__unmetered && depth < 16; depth++) db = db.__unmetered;
  return db;
}

/** What `exclusionFill` reports when the fill did not run this request. It
 * stays an OBJECT rather than becoming null, because /api/rank's key set is
 * exhaustive and increment 12 asserts its shape - "nothing to do this time"
 * and "this field is now a different type" are very different messages. */
const NO_FILL = Object.freeze({ checked: 0, excluded: 0, ok: true });

/** TEST-ONLY seam: forget the in-isolate snapshot. */
export function __resetCatalogMemoForTests() {
  memo = null;
}

async function readSnapshotFromKv(env, version) {
  const kv = env.CATALOG_CACHE;
  if (!kv) return null;
  try {
    const manifestRaw = await kv.get(manifestKey(version));
    if (!manifestRaw) return null;
    const manifest = JSON.parse(manifestRaw);
    if (manifest?.version !== version || !Number.isInteger(manifest.chunks)) return null;

    // A WRITE NONCE, NOT JUST A VERSION (increment 13 review, SEC-3). Two
    // rebuilds can be in flight under the SAME version - a `?refresh=1` next
    // to a TTL-expiry background rebuild is enough - and both write to the
    // same chunk keys. Chunk 0 from one write and chunk 1 from the other
    // assemble into a catalogue that never existed. The nonce makes a mixed
    // read detectable, and a detected mix rebuilds, per §9.9.
    if (typeof manifest.nonce !== "string") return null;

    const rows = [];
    for (let i = 0; i < manifest.chunks; i++) {
      const raw = await kv.get(chunkKey(version, i));
      // A MISSING CHUNK IS A CORRUPT SNAPSHOT, NOT A SMALLER ONE. Returning
      // the rows that did arrive would silently drop games off the page -
      // exactly the "never serve a row the database no longer holds" failure,
      // seen from the other side. Rebuild instead.
      if (raw == null) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.nonce !== manifest.nonce || !Array.isArray(parsed.rows)) return null;
      // AND THE ELEMENTS ARE CHECKED, NOT JUST THE COUNT (SEC-2). Length alone
      // would accept an array of the right size full of nulls, and the first
      // property read on one of those happens in handleRank's funnel, OUTSIDE
      // its try - a 500, against constraint 9. `appid` is the right probe: it
      // is the primary key, every consumer keys on it, and no legitimate row
      // lacks it.
      if (!parsed.rows.every((r) => r && typeof r === "object" && typeof r.appid === "number")) return null;
      rows.push(...parsed.rows);
    }
    if (rows.length !== manifest.rows) return null;
    return { rows, writtenAt: manifest.writtenAt ?? null };
  } catch {
    return null;
  }
}

async function writeSnapshotToKv(env, version, rows, nowMs) {
  const kv = env.CATALOG_CACHE;
  if (!kv) return;
  try {
    const chunks = Math.max(1, Math.ceil(rows.length / SNAPSHOT_CHUNK_ROWS));
    // One identity per WRITE, stamped into every chunk and then into the
    // manifest that commits them (SEC-3). Two writers racing under one version
    // therefore cannot have their chunks read as one snapshot.
    const nonce = `${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    for (let i = 0; i < chunks; i++) {
      await kv.put(
        chunkKey(version, i),
        JSON.stringify({ nonce, rows: rows.slice(i * SNAPSHOT_CHUNK_ROWS, (i + 1) * SNAPSHOT_CHUNK_ROWS) }),
        { expirationTtl: SNAPSHOT_TTL_SECONDS },
      );
    }
    // MANIFEST LAST, ALWAYS. It is the commit: a reader that finds it can rely
    // on every chunk it names already being there. Written first, a reader
    // arriving mid-write would see a manifest pointing at chunks that do not
    // exist yet.
    await kv.put(
      manifestKey(version),
      JSON.stringify({ version, nonce, rows: rows.length, chunks, writtenAt: nowMs }),
      { expirationTtl: SNAPSHOT_TTL_SECONDS },
    );
  } catch {
    // A cache that cannot be written is a cache miss next time. Nothing else.
  }
}

/** The full rebuild: the exclusion fill and the catalogue read, together,
 * because they have the same trigger - the catalogue changed. */
async function rebuild(env, version, nowMs) {
  const db = rawDb(env);
  // ensureRankExclusions MOVES HERE (SPEC.md §4.1). It ran on every request,
  // scanning `rank_exclude_checked_at IS NULL` over an unindexed column, and
  // real D1 bills that scan even though it returns zero rows. It only has work
  // to do when the catalogue has changed - which is exactly when the snapshot
  // rebuilds. (Increment 13 also indexes the column, so even this pass is now
  // cheap; both fixes are kept, because the index makes it cheap and moving it
  // makes it rare.)
  const exclusionFill = await ensureRankExclusions(env, { nowMs });
  const rows = await selectRankCatalogRows(env);
  await writeSnapshotToKv(env, version, rows, nowMs);
  memo = { db, version, rows, writtenAt: nowMs };
  return { rows, exclusionFill };
}

/**
 * The catalogue, from the cheapest tier that can honestly supply it.
 *
 * THIS IS THE ONE LINE THAT CHANGED IN handleRank (SPEC.md gate 2).
 * `selectRankCatalogRows(env)` became `loadRankCatalogue(env, ctx, refresh)`.
 * Everything downstream - the funnel, the IDF corpus, the profile, similarity,
 * the blend, the sort - is untouched and still runs per request.
 *
 * Three tiers, and what each costs:
 *   memory  - 0 D1 rows, 0 KV reads
 *   kv      - 1 D1 row (the version stamp), 1 + chunks KV reads
 *   rebuild - a full catalogue read, at most a few times a day
 *
 * SERVE STALE, REBUILD BEHIND IT. If the version stamp has moved on but a
 * snapshot of the previous version is still in hand, that snapshot is returned
 * immediately and the rebuild goes through ctx.waitUntil. Only a genuinely
 * empty cache - first boot, or straight after a restore - pays the cold cost.
 *
 * @param {object} env - needs env.FPM_DB; uses env.CATALOG_CACHE if bound.
 * @param {object} ctx - for waitUntil. Optional; a background rebuild is
 *   simply skipped without it.
 * @param {boolean} [refresh] - `?refresh=1`, which handleRank already parses.
 * @returns {Promise<{rows: object[], cacheState: string, ageMs: number|null, exclusionFill: object|null}>}
 */
export async function loadRankCatalogue(env, ctx, refresh = false) {
  const nowMs = Date.now();

  try {
    const db = rawDb(env);
    let version = await readCatalogVersion(env);

    // A DATABASE THAT HAS NEVER BEEN STAMPED HAS NO TRUSTWORTHY SNAPSHOT.
    // First boot, or straight after a restore. The spec is explicit that this
    // is the one case allowed to pay the cold cost, and the alternative is
    // worse than slow: with nothing to compare against, the "serve stale"
    // branch below would happily hand back whatever was last in memory, which
    // on a different database is the one thing §9.9 forbids outright - serving
    // a row the database does not hold.
    //
    // `justMinted` IS KEPT, AND THE REASON IS THE FALLBACK ON THE NEXT LINE
    // (round-2 review, ruled by James). It is true that after blocker CR-2 the
    // version guard reaches the same answer for a stamp that was successfully
    // written - removing `!justMinted` leaves every test green, which was
    // checked. But `bumpCatalogVersion` can FAIL (D1 unavailable, table
    // missing), and then the version is whatever this line falls back to. That
    // fallback used to be a bare `String(nowMs)`, and a bare timestamp is
    // precisely what newCatalogVersion exists to avoid: two databases can mint
    // the same one, which is the cross-database collision `memo.db === db`
    // guards separately. It is now a real stamp, and `justMinted` states the
    // rule outright rather than resting on the collision never happening.
    const justMinted = version == null;
    if (justMinted) version = (await bumpCatalogVersion(env, nowMs)) ?? newCatalogVersion(nowMs);

    if (!refresh && !justMinted) {
      const age = (writtenAt) => (writtenAt == null ? null : nowMs - writtenAt);
      const fresh = (writtenAt) => writtenAt != null && nowMs - writtenAt < SNAPSHOT_TTL_SECONDS * 1000;

      if (memo && memo.db === db && memo.version === version && fresh(memo.writtenAt)) {
        return { rows: memo.rows, cacheState: "memory", ageMs: age(memo.writtenAt), exclusionFill: NO_FILL };
      }

      const kvSnapshot = await readSnapshotFromKv(env, version);
      if (kvSnapshot && fresh(kvSnapshot.writtenAt)) {
        memo = { db, version, rows: kvSnapshot.rows, writtenAt: kvSnapshot.writtenAt };
        return { rows: kvSnapshot.rows, cacheState: "kv", ageMs: age(kvSnapshot.writtenAt), exclusionFill: NO_FILL };
      }

      // Nothing current. If anything STALE **OF THIS VERSION** is in hand,
      // serve it and rebuild behind the response rather than making this
      // visitor wait.
      //
      // `memo.version === version` IS THE WHOLE GUARD (increment 13 review,
      // blocker CR-2). Stale means PAST ITS TTL, and nothing else. A version
      // MISMATCH is a different fact entirely: the catalogue itself changed -
      // that fires at the end of every sync and on every `npm run restore` -
      // and the rows in hand may describe games the database no longer holds.
      // §4.1's rationale for serving stale at all is the unlucky visitor every
      // six hours, and that visitor is unaffected: their snapshot still
      // matches the current version, it has simply aged out. A version bump
      // rebuilds, in front of the request, every time.
      //
      // `kvSnapshot` needs no such check - readSnapshotFromKv was called with
      // the CURRENT version and verifies the manifest names it, so a non-null
      // kvSnapshot is already of this version by construction.
      const stale = memo?.db === db && memo?.version === version && memo?.rows
        ? memo
        : kvSnapshot
          ? { ...kvSnapshot, version }
          : null;
      if (stale && ctx?.waitUntil) {
        ctx.waitUntil(rebuild(env, version, nowMs).catch(() => {}));
        return { rows: stale.rows, cacheState: "stale", ageMs: age(stale.writtenAt), exclusionFill: NO_FILL };
      }
    }

    const built = await rebuild(env, version, nowMs);
    return { rows: built.rows, cacheState: "rebuild", ageMs: 0, exclusionFill: built.exclusionFill };
  } catch {
    // THE LAST RESORT, AND THE WHOLE POINT OF §9.9: whatever went wrong -
    // no binding, KV down, a corrupt value, catalog_meta missing - the page
    // still gets its rows from the database it always came from.
    const rows = await selectRankCatalogRows(env);
    return { rows, cacheState: "rebuild", ageMs: null, exclusionFill: NO_FILL };
  }
}
