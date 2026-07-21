// Tests for src/dismissals.js (Increment 8) — "Not interested" D1 CRUD +
// the pure excludeDismissed() filter every sale-lane handler joins against.
// NEVER makes a real network call; D1 is a real in-memory SQLite database
// (test/helpers/mockD1.mjs), same convention as test/catalog.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import {
  ensureDismissalsSchema,
  listDismissals,
  getDismissedAppIdSet,
  addDismissal,
  removeDismissal,
  excludeDismissed,
} from "../src/dismissals.js";

function makeEnv() {
  return { FPM_DB: makeMockD1() };
}

test("ensureDismissalsSchema is idempotent — safe to call repeatedly", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);
  await ensureDismissalsSchema(env);
  assert.deepEqual(await listDismissals(env), []);
});

test("addDismissal + listDismissals round-trips appid/name/dismissed_at, newest first", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);

  await addDismissal(env, 100, "Old Shovelware", 1000);
  await addDismissal(env, 200, "Newer Shovelware", 2000);

  const list = await listDismissals(env);
  assert.equal(list.length, 2);
  assert.equal(list[0].appid, 200); // most recently dismissed first
  assert.equal(list[0].name, "Newer Shovelware");
  assert.equal(list[0].dismissed_at, 2000);
  assert.equal(list[1].appid, 100);
});

test("addDismissal with no name stores null, not a throw", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);
  await addDismissal(env, 42, null, 1000);
  const list = await listDismissals(env);
  assert.equal(list[0].name, null);
});

test("addDismissal is idempotent — dismissing the same appid twice updates it, not duplicates it", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);
  await addDismissal(env, 42, "First Name", 1000);
  await addDismissal(env, 42, "Renamed", 2000);

  const list = await listDismissals(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Renamed");
  assert.equal(list[0].dismissed_at, 2000);
});

test("removeDismissal un-dismisses — the appid no longer appears in the list or the Set", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);
  await addDismissal(env, 42, "Some Game", 1000);
  await removeDismissal(env, 42);

  assert.deepEqual(await listDismissals(env), []);
  const set = await getDismissedAppIdSet(env);
  assert.equal(set.has(42), false);
});

test("removeDismissal on an appid that was never dismissed is a safe no-op", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);
  await removeDismissal(env, 999); // never dismissed — should not throw
  assert.deepEqual(await listDismissals(env), []);
});

test("getDismissedAppIdSet returns exactly the dismissed appids as a Set", async () => {
  const env = makeEnv();
  await ensureDismissalsSchema(env);
  await addDismissal(env, 1, "A", 1000);
  await addDismissal(env, 2, "B", 1000);

  const set = await getDismissedAppIdSet(env);
  assert.equal(set.size, 2);
  assert.equal(set.has(1), true);
  assert.equal(set.has(2), true);
  assert.equal(set.has(3), false);
});

// --- excludeDismissed (pure) -----------------------------------------------

test("excludeDismissed filters out only items whose appid is in the dismissed set", () => {
  const items = [{ appid: 1, title: "A" }, { appid: 2, title: "B" }, { appid: 3, title: "C" }];
  const result = excludeDismissed(items, new Set([2]));
  assert.deepEqual(result.map((i) => i.appid), [1, 3]);
});

test("excludeDismissed with an empty Set is a no-op (the zero-dismissals regression case)", () => {
  const items = [{ appid: 1 }, { appid: 2 }];
  const result = excludeDismissed(items, new Set());
  assert.deepEqual(result, items);
});

test("excludeDismissed never matches a null appid against a dismissed set (Set.has(null) is always false)", () => {
  const items = [{ appid: null, title: "No-appid deal" }];
  const result = excludeDismissed(items, new Set([1, 2]));
  assert.equal(result.length, 1);
});
