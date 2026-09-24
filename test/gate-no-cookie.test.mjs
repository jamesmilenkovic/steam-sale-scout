// QA, increment 15 – SPEC.md §13.3: THIRTEEN NO-COOKIE TESTS, ONE PER
// ROUTE/METHOD PAIR.
//
// WHY THIS FILE EXISTS, AND WHY IT DRIVES THE UNWRAPPED WORKER. Increment 14's
// headline claim rested on a manual `curl`. The test-coverage lane then
// measured what the suite actually proved, by experiment: it replaced the
// gate's denial `if (!session) return unauthorized();` with a synthesized
// anonymous session, and separately made `authenticate()` return a session on
// its first line – no cookie read, no HMAC, no allow-list, ever. **Both
// mutations left 831 of 831 tests passing.** `unauthorized()` had zero
// executions across the whole suite.
//
// The reason is mechanical: `test/helpers/session.mjs`'s `signedWorker()` puts
// a valid cookie on every request, which is right for the ten handler files and
// useless for proving the door is shut. So **every request in this file goes to
// `worker.fetch` directly, with NO cookie**, and `assertNoCookie` asserts that
// before it asserts anything else – a test that quietly grew a cookie would be
// testing the wrong thing and would say nothing about it.
//
// AND IT ASSERTS MORE THAN THE STATUS CODE. A 401 that still wrote the row is a
// worse bug than a 200, because the 401 makes it invisible. Every test below
// snapshots all three personal tables before the request and asserts them
// byte-identical after it, so the three write routes and the two DELETEs are
// proved to have had no effect, not merely to have answered no.
//
// NEVER makes a real network call (SPEC.md §13.6).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js"; // UNWRAPPED. Do not swap this for signedWorker.
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";
import { SESSION_COOKIE } from "../src/auth.js";
import { ensureSettingsSchema, putSettings } from "../src/settings.js";
import { ensureDismissalsSchema, addDismissal } from "../src/dismissals.js";
import { ensureMarksSchema, setMark } from "../src/marks.js";

/** The victim. Someone else's data, already in the tables, that the
 * unauthenticated caller below must neither read nor touch. */
const VICTIM_STEAM_ID = "76561198012345679";

/**
 * An env that would let a SIGNED caller straight through.
 *
 * DELIBERATELY FULLY CONFIGURED. `SESSION_SECRET` and `ALLOWED_STEAM_IDS` are
 * both present and well-formed, so a 401 here can only be caused by the absent
 * cookie. Without them the gate would 401 for a second reason and these tests
 * would pass even if the cookie check were deleted.
 */
async function makeEnv() {
  const FPM_DB = makeMockD1();
  const env = {
    FPM_DB,
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    SESSION_SECRET: "test-session-secret-not-a-real-one",
    ALLOWED_STEAM_IDS: VICTIM_STEAM_ID,
    OWNER_STEAM_ID: VICTIM_STEAM_ID,
    PUBLIC_ORIGIN: "https://x",
  };
  // Seed each table with the victim's row, so the two DELETEs have something
  // real to fail to delete.
  await ensureSettingsSchema(env);
  await putSettings(env, VICTIM_STEAM_ID, { recencyWindow: 730 }, 1_700_000_000_000);
  await ensureDismissalsSchema(env);
  await addDismissal(env, VICTIM_STEAM_ID, 1944430, "Amnesia: The Bunker", 1_700_000_000_000);
  await ensureMarksSchema(env);
  await setMark(env, VICTIM_STEAM_ID, 400, "Portal", { played: 1, finished: 1 }, 1_700_000_000_000);
  return env;
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(promise);
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}

/** Every row of all three personal tables, as one comparable string. Read
 * straight off the underlying SQLite handle rather than through the module
 * functions, so a `WHERE steam_id = ?` that went missing cannot hide a write
 * from this snapshot. */
function snapshotTables(env) {
  const db = env.FPM_DB._db;
  const dump = (sql) => JSON.stringify(db.prepare(sql).all());
  return [
    dump("SELECT * FROM settings ORDER BY steam_id, key"),
    dump("SELECT * FROM dismissals ORDER BY steam_id, appid"),
    dump("SELECT * FROM game_marks ORDER BY steam_id, appid"),
  ].join("\n");
}

/** Proof that the request really carried no cookie of any kind. */
function assertNoCookie(request) {
  assert.equal(
    request.headers.get("cookie"),
    null,
    "this test must send NO cookie – it is the only thing it proves",
  );
  assert.equal(
    request.headers.has(SESSION_COOKIE),
    false,
    "the session cookie name must not appear as a header either",
  );
}

/**
 * Drive one route/method pair with no cookie and hold it to all four claims:
 * 401, the gate's one body, no session cookie handed out, and not one byte
 * changed in any of the three personal tables.
 */
async function denied(request, env) {
  assertNoCookie(request);
  const before = snapshotTables(env);
  const ctx = makeCtx();
  const res = await worker.fetch(request, env, ctx);
  await ctx.flush();

  assert.equal(res.status, 401, `${request.method} ${new URL(request.url).pathname} must be 401`);
  assert.deepEqual(await res.json(), { error: "not signed in" });
  // A denial does not get to mint anything. If the gate ever synthesized a
  // session it would also slide a cookie for it.
  assert.equal(res.headers.get("set-cookie"), null, "a 401 must not set a cookie");
  assert.equal(
    snapshotTables(env),
    before,
    `${request.method} ${new URL(request.url).pathname} answered 401 but CHANGED the database`,
  );
  return res;
}

// Any test that forgets a stub hits this instead of the internet. Nothing in
// this file should ever reach it: the gate denies above every handler.
test.beforeEach(() => {
  globalThis.fetch = makeOfflineFetchGuard("gate-no-cookie");
});

// ---------------------------------------------------------------------------
// The thirteen. DEPLOY-BLOCKERS.md blocker 1's table, in its own order.
// ---------------------------------------------------------------------------

test("1/13  GET /api/rank with no cookie -> 401, and no row moved", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/rank"), env);
});

test("2/13  GET /api/wishlist with no cookie -> 401, and no row moved", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/wishlist"), env);
});

test("3/13  GET /api/settings with no cookie -> 401, and the settings row is not disclosed", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/settings"), env);
});

test("4/13  PUT /api/settings with no cookie -> 401, AND NOTHING IS WRITTEN", async () => {
  const env = await makeEnv();
  await denied(
    new Request("https://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recencyWindow: 1, hijacked: true }),
    }),
    env,
  );
  // Said twice on purpose: the snapshot above proves nothing was added, this
  // proves the victim's own value was not overwritten in place.
  const row = env.FPM_DB._db
    .prepare("SELECT value FROM settings WHERE steam_id = ? AND key = ?")
    .get(VICTIM_STEAM_ID, "recencyWindow");
  assert.equal(row.value, "730");
});

test("5/13  GET /api/dismissals with no cookie -> 401, and no row moved", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/dismissals"), env);
});

test("6/13  POST /api/dismissals with no cookie -> 401, AND NO DISMISSAL IS WRITTEN", async () => {
  const env = await makeEnv();
  await denied(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 620, name: "Portal 2" }),
    }),
    env,
  );
  const count = env.FPM_DB._db.prepare("SELECT COUNT(*) AS n FROM dismissals").get().n;
  assert.equal(count, 1, "the anonymous POST must not have added a row");
});

test("7/13  DELETE /api/dismissals/:appid with no cookie -> 401, AND THE ROW SURVIVES", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/dismissals/1944430", { method: "DELETE" }), env);
  const row = env.FPM_DB._db
    .prepare("SELECT * FROM dismissals WHERE steam_id = ? AND appid = ?")
    .get(VICTIM_STEAM_ID, 1944430);
  assert.ok(row, "the victim's dismissal must still be there after an anonymous DELETE");
});

test("8/13  GET /api/marks with no cookie -> 401, and the play history is not disclosed", async () => {
  const env = await makeEnv();
  // `denied` reads the body and asserts it is exactly {error:"not signed in"},
  // which is also the disclosure assertion: a body of that shape cannot be
  // carrying Portal, or any other of the victim's marks.
  await denied(new Request("https://x/api/marks"), env);
});

test("9/13  POST /api/marks with no cookie -> 401, AND NO MARK IS WRITTEN", async () => {
  const env = await makeEnv();
  await denied(
    new Request("https://x/api/marks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 620, name: "Portal 2", played: 1, finished: 1 }),
    }),
    env,
  );
  const count = env.FPM_DB._db.prepare("SELECT COUNT(*) AS n FROM game_marks").get().n;
  assert.equal(count, 1, "the anonymous POST must not have added a row to the unrecoverable table");
});

test("10/13 DELETE /api/marks/:appid with no cookie -> 401, AND THE PLAY HISTORY SURVIVES", async () => {
  // `game_marks` is the only unrecoverable table in this project
  // (DEPLOY-BLOCKERS.md). A 401 that still deleted the row would be the worst
  // single failure available in this increment.
  const env = await makeEnv();
  await denied(new Request("https://x/api/marks/400", { method: "DELETE" }), env);
  const row = env.FPM_DB._db
    .prepare("SELECT * FROM game_marks WHERE steam_id = ? AND appid = ?")
    .get(VICTIM_STEAM_ID, 400);
  assert.ok(row, "Portal's mark must still be there after an anonymous DELETE");
  assert.equal(row.played, 1);
  assert.equal(row.finished, 1);
});

test("11/13 POST /api/fpm/sync with no cookie -> 401, and no sync is started", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/fpm/sync", { method: "POST" }), env);
  // SEC-1's cross-site trigger: the offline guard would have recorded any
  // outbound call the sync tried to make.
  assert.deepEqual(globalThis.fetch.calls, []);
});

test("12/13 POST /api/fpm/sync/stop with no cookie -> 401", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/fpm/sync/stop", { method: "POST" }), env);
});

test("13/13 GET /api/fpm/sync/status with no cookie -> 401", async () => {
  const env = await makeEnv();
  await denied(new Request("https://x/api/fpm/sync/status"), env);
});

// ---------------------------------------------------------------------------
// The gate's edges, which the thirteen above do not reach.
// ---------------------------------------------------------------------------

test("the /api/ 501 catch-all is BELOW the gate: a deleted route answers 401 to a stranger, not 501", async () => {
  // SPEC.md §7.2. "That route is gone" is still an answer about this app's
  // shape, and a stranger is owed nothing. The six tests in
  // test/router-deleted-routes.test.mjs send a cookie and still expect 501;
  // this is the other half of that pair.
  const env = await makeEnv();
  for (const path of ["/api/library", "/api/deals", "/api/recs", "/api/best-of", "/api/fpm"]) {
    const res = await worker.fetch(new Request(`https://x${path}`), env, makeCtx());
    assert.equal(res.status, 401, `${path} must be 401 without a cookie, never 501`);
  }
});

test("a garbage cookie value is denied exactly like no cookie at all", async () => {
  const env = await makeEnv();
  for (const value of ["", "not-a-token", "a.b", "....", "%%%.%%%", "x".repeat(5000)]) {
    const res = await worker.fetch(
      new Request("https://x/api/marks", { headers: { cookie: `${SESSION_COOKIE}=${value}` } }),
      env,
      makeCtx(),
    );
    assert.equal(res.status, 401, `cookie value ${JSON.stringify(value.slice(0, 20))} must be 401`);
    assert.deepEqual(await res.json(), { error: "not signed in" });
  }
});

test("a cookie by some OTHER name does not satisfy the gate", async () => {
  const env = await makeEnv();
  const res = await worker.fetch(
    new Request("https://x/api/marks", { headers: { cookie: "sss_session=anything; session=anything" } }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 401);
});
