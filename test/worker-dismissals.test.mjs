// Tests for src/worker.js — the /api/dismissals routes (Increment 8):
// GET (list), POST (dismiss), DELETE /:appid (restore). Drives everything
// through the top-level worker.default.fetch(request, env, ctx), mirroring
// test/worker-settings.test.mjs's style. NEVER makes a real network call.
//
// The server-side EXCLUSION join (dismissed games disappearing from Deals/
// Recs/Best-of/FPM) is covered per-lane in each of those routes' own test
// files (worker-deals/worker-recs/worker-hof/worker-fpm.test.mjs) — this
// file only covers the management surface (GET/POST/DELETE) itself.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeMockD1 } from "./helpers/mockD1.mjs";

function makeEnv(overrides = {}) {
  return {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    ...overrides,
  };
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

test("GET /api/dismissals with no FPM_DB binding -> 200 {dismissals:[]}, never a 500", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://x/api/dismissals"), env, makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { dismissals: [] });
});

test("POST /api/dismissals with no FPM_DB binding -> 200 {dismissed:false}, never a 500", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 100, name: "Some Game" }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { dismissed: false });
});

test("DELETE /api/dismissals/:appid with no FPM_DB binding -> 200 {restored:false}, never a 500", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://x/api/dismissals/100", { method: "DELETE" }), env, makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { restored: false });
});

test("POST then GET round-trips a dismissal — the falsifiable 'dismiss persists' claim", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });

  const postRes = await worker.fetch(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 100, name: "Shovelware Prologue" }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(postRes.status, 200);
  assert.deepEqual(await postRes.json(), { dismissed: true });

  const getRes = await worker.fetch(new Request("https://x/api/dismissals"), env, makeCtx());
  const body = await getRes.json();
  assert.equal(body.dismissals.length, 1);
  assert.equal(body.dismissals[0].appid, 100);
  assert.equal(body.dismissals[0].name, "Shovelware Prologue");
});

test("POST then DELETE restores — the appid no longer appears in GET /api/dismissals", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });

  await worker.fetch(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 100, name: "Some Game" }),
    }),
    env,
    makeCtx(),
  );
  const deleteRes = await worker.fetch(new Request("https://x/api/dismissals/100", { method: "DELETE" }), env, makeCtx());
  assert.equal(deleteRes.status, 200);
  assert.deepEqual(await deleteRes.json(), { restored: true });

  const getRes = await worker.fetch(new Request("https://x/api/dismissals"), env, makeCtx());
  assert.deepEqual(await getRes.json(), { dismissals: [] });
});

test("POST /api/dismissals with a missing/non-numeric appid -> 400, not a silent no-op or a 500", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No appid here" }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 400);
});

test("POST /api/dismissals without a name still dismisses (name is optional)", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 100 }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { dismissed: true });

  const getRes = await worker.fetch(new Request("https://x/api/dismissals"), env, makeCtx());
  const body = await getRes.json();
  assert.equal(body.dismissals[0].name, null);
});

test("DELETE /api/dismissals/:appid on a never-dismissed appid is a safe no-op, still {restored:true}", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(new Request("https://x/api/dismissals/999", { method: "DELETE" }), env, makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { restored: true });
});

test("DELETE /api/dismissals/not-a-number -> 400, not a 500", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(new Request("https://x/api/dismissals/not-a-number", { method: "DELETE" }), env, makeCtx());
  assert.equal(res.status, 400);
});
