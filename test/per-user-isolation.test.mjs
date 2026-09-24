// QA, increment 15 – SPEC.md §13.5: per-user isolation on the three personal
// tables. **THE ONLY PROOF THE COMPOSITE KEY ACTUALLY WORKS.**
//
// WHY THE SECOND HALF OF EACH TEST IS THE IMPORTANT ONE. The test-coverage lane
// reverted src/marks.js to `PRIMARY KEY (appid)` / `ON CONFLICT(appid)` –
// ticket #3 undone entirely – and re-ran the suite: **831 tests, 831 pass, 0
// fail.** A test that only asserts "B reads nothing" does not catch that, and
// here is exactly why: every SELECT still carries `WHERE steam_id = ?`, so B's
// read comes back empty either way. The damage is on the WRITE. With
// `ON CONFLICT(appid)` B's upsert of the same appid matches A's row and
// overwrites its name, played and finished in place – on `game_marks`, which
// DEPLOY-BLOCKERS.md calls the only unrecoverable table in this project.
//
// So each test below has two halves, and the second one is the one that fails
// when the key is wrong:
//
//   1. A writes. B reads. B sees nothing.
//   2. **B then writes the SAME appid/key. A's row is byte-unchanged.**
//
// test/helpers/mockD1.mjs is backed by node:sqlite, so this is a real SQLite
// engine honouring a real composite primary key, not a shim that would agree
// with whatever the SQL said.
//
// NEVER makes a real network call (SPEC.md §13.6).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js"; // UNWRAPPED – each identity brings its own cookie.
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";
import { SESSION_COOKIE, mintSessionToken } from "../src/auth.js";
import { ensureSettingsSchema, getAllSettings, putSettings } from "../src/settings.js";
import {
  ensureDismissalsSchema,
  listDismissals,
  getDismissedAppIdSet,
  addDismissal,
  removeDismissal,
} from "../src/dismissals.js";
import { ensureMarksSchema, listMarks, getMarksByAppid, setMark, removeMark } from "../src/marks.js";

/** Two valid 17-digit SteamID64s, both STRINGS, both precision-losing as
 * JavaScript numbers – so a `Number()` anywhere on the path would collide them
 * onto neighbouring values rather than failing loudly. */
const A = "76561198012345679";
const B = "76561198098765431";

const SECRET = "test-session-secret-not-a-real-one";

function makeEnv() {
  return {
    FPM_DB: makeMockD1(),
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    SESSION_SECRET: SECRET,
    ALLOWED_STEAM_IDS: `${A},${B}`,
    OWNER_STEAM_ID: A,
  };
}

function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), flush: () => Promise.all(pending) };
}

test.beforeEach(() => {
  globalThis.fetch = makeOfflineFetchGuard("per-user-isolation");
});

// ===========================================================================
// settings
// ===========================================================================

test("SETTINGS: A's keys are invisible to B, and B writing the SAME key leaves A's value byte-unchanged", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);

  // 1. A writes.
  await putSettings(env, A, { recencyWindow: 730, sort: "score" }, 1_700_000_000_000);

  // 2. B reads and sees nothing.
  assert.deepEqual(await getAllSettings(env, B), {}, "B must not see A's settings");
  assert.deepEqual(await getAllSettings(env, A), { recencyWindow: 730, sort: "score" });

  // 3. THE HALF THAT CATCHES A BROKEN KEY: B writes the same key.
  await putSettings(env, B, { recencyWindow: 30 }, 1_700_000_999_000);

  assert.deepEqual(
    await getAllSettings(env, A),
    { recencyWindow: 730, sort: "score" },
    "B writing `recencyWindow` MUST NOT touch A's `recencyWindow`",
  );
  assert.deepEqual(await getAllSettings(env, B), { recencyWindow: 30 });

  // And at the row level: two rows for one key, one per identity, with A's
  // updated_at untouched by B's write.
  const rows = env.FPM_DB._db
    .prepare("SELECT steam_id, key, value, updated_at FROM settings WHERE key = 'recencyWindow' ORDER BY steam_id")
    .all();
  assert.equal(rows.length, 2, "the composite key must allow one row PER IDENTITY per key");
  assert.deepEqual(rows.map((r) => r.steam_id), [A, B].sort());
  const aRow = rows.find((r) => r.steam_id === A);
  assert.equal(aRow.value, "730");
  assert.equal(aRow.updated_at, 1_700_000_000_000, "A's row was not re-stamped by B's write");
  // `steam_id` is TEXT, because a SteamID64 does not survive as a number.
  assert.equal(typeof aRow.steam_id, "string");
  assert.equal(aRow.steam_id, A);
});

// ===========================================================================
// dismissals
// ===========================================================================

test("DISMISSALS: A's dismissals are invisible to B, and B dismissing the SAME appid leaves A's row byte-unchanged", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);

  // 1. A writes.
  await addDismissal(env, A, 1944430, "Amnesia: The Bunker", 1_700_000_000_000);

  // 2. B reads and sees nothing – both read shapes, because the lanes use the
  //    Set and the management view uses the list.
  assert.deepEqual(await listDismissals(env, B), [], "B must not see A's dismissals");
  assert.equal((await getDismissedAppIdSet(env, B)).size, 0, "and B's lanes must not be filtered by A's dismissal");
  assert.equal((await getDismissedAppIdSet(env, A)).has(1944430), true);

  // 3. THE HALF THAT CATCHES A BROKEN KEY: B dismisses the same game.
  await addDismissal(env, B, 1944430, "B's own name for it", 1_700_000_999_000);

  const aRows = await listDismissals(env, A);
  assert.equal(aRows.length, 1);
  assert.deepEqual({ ...aRows[0] }, {
    appid: 1944430,
    name: "Amnesia: The Bunker",
    dismissed_at: 1_700_000_000_000,
  }, "B dismissing the same appid MUST NOT rewrite A's row");

  const rows = env.FPM_DB._db.prepare("SELECT * FROM dismissals ORDER BY steam_id").all();
  assert.equal(rows.length, 2, "one dismissal PER IDENTITY per appid");
  assert.equal(typeof rows[0].steam_id, "string");

  // 4. And a DELETE is scoped too: B un-dismissing must not delete A's row.
  await removeDismissal(env, B, 1944430);
  assert.equal((await listDismissals(env, A)).length, 1, "B's un-dismiss MUST NOT delete A's dismissal");
  assert.equal((await listDismissals(env, B)).length, 0);
});

// ===========================================================================
// game_marks – THE UNRECOVERABLE TABLE
// ===========================================================================

test("MARKS: A's play history is invisible to B, and B marking the SAME appid leaves A's row byte-unchanged", async () => {
  // `game_marks` holds facts nothing upstream can ever regenerate: which games
  // James played and finished when Steam has no record. Of 659 owned games,
  // 297 have no play record anywhere (src/marks.js). A cross-identity
  // overwrite here is not recoverable from any API.
  const env = makeEnv();
  await ensureMarksSchema(env);

  // 1. A writes: Portal, played AND finished.
  await setMark(env, A, 400, "Portal", { played: 1, finished: 1 }, 1_700_000_000_000);

  // 2. B reads and sees nothing – both read shapes.
  assert.deepEqual(await listMarks(env, B), [], "B must not see A's play history");
  assert.equal((await getMarksByAppid(env, B)).size, 0, "and A's marks must not ride onto B's ranked rows");
  assert.equal((await getMarksByAppid(env, A)).get(400).finished, 1);

  // 3. THE HALF THAT CATCHES A BROKEN KEY: B marks the same game, differently.
  await setMark(env, B, 400, "Portal (B's copy)", { played: 1, finished: 0 }, 1_700_000_999_000);

  const aMarks = await listMarks(env, A);
  assert.equal(aMarks.length, 1, "A still has exactly one mark");
  assert.deepEqual({ ...aMarks[0] }, {
    appid: 400,
    name: "Portal",
    played: 1,
    finished: 1,
    updated_at: 1_700_000_000_000,
  }, "B marking appid 400 MUST NOT overwrite A's 'I finished this' – this table cannot be rebuilt");

  // The full row, including the columns the list query does not return.
  const aRow = env.FPM_DB._db.prepare("SELECT * FROM game_marks WHERE steam_id = ?").get(A);
  assert.deepEqual({ ...aRow }, {
    steam_id: A,
    appid: 400,
    name: "Portal",
    played: 1,
    finished: 1,
    marked_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  });
  assert.equal(typeof aRow.steam_id, "string", "steam_id is TEXT – a SteamID64 loses precision as a number");

  const all = env.FPM_DB._db.prepare("SELECT steam_id FROM game_marks ORDER BY steam_id").all();
  assert.equal(all.length, 2, "one play history PER IDENTITY per game");

  // 4. And a DELETE is scoped too: B clearing their mark must not clear A's.
  await removeMark(env, B, 400);
  assert.equal((await listMarks(env, A)).length, 1, "B clearing appid 400 MUST NOT delete A's mark");
  assert.equal((await listMarks(env, B)).length, 0);
});

// ===========================================================================
// The same three, end to end through the gate, with two real cookies
// ===========================================================================

/** A genuinely signed cookie for one identity. The gate verifies it the same
 * way it verifies James's. */
async function cookieFor(steamId) {
  return { cookie: `${SESSION_COOKIE}=${await mintSessionToken(SECRET, steamId)}` };
}

test("END TO END: two signed identities through the gate see two separate sets of marks", async () => {
  // The module-level tests above prove the SQL. This proves the identity
  // actually reaches it from the session, rather than from `env` or from a
  // default – SPEC.md §7.3's safety property, which is the reason the argument
  // is positional and explicit.
  const env = makeEnv();
  const post = async (steamId, body) =>
    worker.fetch(
      new Request("https://x/api/marks", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await cookieFor(steamId)) },
        body: JSON.stringify(body),
      }),
      env,
      makeCtx(),
    );
  const list = async (steamId) =>
    (await (await worker.fetch(new Request("https://x/api/marks", { headers: await cookieFor(steamId) }), env, makeCtx())).json())
      .marks;

  assert.deepEqual(await (await post(A, { appid: 400, name: "Portal", played: 1, finished: 1 })).json(), {
    saved: true,
    played: 1,
    finished: 1,
  });

  assert.deepEqual(await list(B), [], "B's GET /api/marks must be empty while A has a mark");

  await post(B, { appid: 400, name: "Portal", played: 1, finished: 0 });

  const aMarks = await list(A);
  assert.equal(aMarks.length, 1);
  assert.equal(aMarks[0].finished, 1, "A's 'finished' must survive B posting the same appid");
  const bMarks = await list(B);
  assert.equal(bMarks.length, 1);
  assert.equal(bMarks[0].finished, 0);

  // And the row really is keyed by the string, not by a number.
  const ids = env.FPM_DB._db.prepare("SELECT steam_id FROM game_marks ORDER BY steam_id").all().map((r) => r.steam_id);
  assert.deepEqual(ids, [A, B].sort());
  for (const id of ids) assert.equal(typeof id, "string");
});

test("END TO END: A's settings and dismissals do not leak into B's responses", async () => {
  const env = makeEnv();
  const call = async (steamId, path, init = {}) =>
    worker.fetch(
      new Request(`https://x${path}`, { ...init, headers: { ...(init.headers || {}), ...(await cookieFor(steamId)) } }),
      env,
      makeCtx(),
    );

  await call(A, "/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recencyWindow: 730 }),
  });
  await call(A, "/api/dismissals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appid: 1944430, name: "Amnesia: The Bunker" }),
  });

  assert.deepEqual(await (await call(B, "/api/settings")).json(), { settings: {} });
  assert.deepEqual((await (await call(B, "/api/dismissals")).json()).dismissals, []);

  assert.deepEqual(await (await call(A, "/api/settings")).json(), { settings: { recencyWindow: 730 } });
  assert.equal((await (await call(A, "/api/dismissals")).json()).dismissals.length, 1);

  // B writes the same key and the same appid, then A checks their own again.
  await call(B, "/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recencyWindow: 30 }),
  });
  await call(B, "/api/dismissals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appid: 1944430, name: "B's copy" }),
  });

  assert.deepEqual(
    await (await call(A, "/api/settings")).json(),
    { settings: { recencyWindow: 730 } },
    "B's PUT must not reach A's settings row",
  );
  const aDismissals = (await (await call(A, "/api/dismissals")).json()).dismissals;
  assert.equal(aDismissals.length, 1);
  assert.equal(aDismissals[0].name, "Amnesia: The Bunker", "B's POST must not rename A's dismissal");

  // And B deleting theirs leaves A's alone.
  await call(B, "/api/dismissals/1944430", { method: "DELETE" });
  assert.equal((await (await call(A, "/api/dismissals")).json()).dismissals.length, 1);
  assert.equal((await (await call(B, "/api/dismissals")).json()).dismissals.length, 0);
});

test("every statement reaching the three personal tables carries a steam_id predicate or column", async () => {
  // SPEC.md §10: "a statement that reaches D1 without a `steam_id` predicate is
  // the defect this section exists to prevent." Asserted by intercepting the
  // SQL rather than by grepping the source, so a statement built at runtime
  // cannot slip past.
  const env = makeEnv();
  const seen = [];
  const real = env.FPM_DB.prepare.bind(env.FPM_DB);
  env.FPM_DB.prepare = (sql) => {
    seen.push(sql);
    return real(sql);
  };

  await ensureSettingsSchema(env);
  await ensureDismissalsSchema(env);
  await ensureMarksSchema(env);
  await putSettings(env, A, { recencyWindow: 730 });
  await getAllSettings(env, A);
  await addDismissal(env, A, 400, "Portal");
  await listDismissals(env, A);
  await getDismissedAppIdSet(env, A);
  await removeDismissal(env, A, 400);
  await setMark(env, A, 400, "Portal", { played: 1 });
  await listMarks(env, A);
  await getMarksByAppid(env, A);
  await removeMark(env, A, 400);

  const personal = seen.filter((sql) => /settings|dismissals|game_marks/.test(sql));
  assert.ok(personal.length >= 13, `expected every call to be captured, got ${personal.length}`);
  for (const sql of personal) {
    const flat = sql.replace(/\s+/g, " ");
    if (/^CREATE TABLE/i.test(flat)) {
      assert.match(flat, /PRIMARY KEY \(steam_id,/i, `CREATE must lead the composite key with steam_id: ${flat}`);
      assert.match(flat, /steam_id TEXT NOT NULL/i, `steam_id must be TEXT NOT NULL: ${flat}`);
      continue;
    }
    if (/^INSERT/i.test(flat)) {
      assert.match(flat, /\(steam_id,/i, `an INSERT must name steam_id first: ${flat}`);
      assert.match(flat, /ON CONFLICT\(steam_id, ?(key|appid)\)/i, `the CONFLICT TARGET must name BOTH key columns: ${flat}`);
      continue;
    }
    assert.match(flat, /WHERE steam_id = \?/i, `every SELECT and DELETE needs a steam_id predicate: ${flat}`);
  }
});
