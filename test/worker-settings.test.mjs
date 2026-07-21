// Tests for src/worker.js — the /api/settings routes (Increment 8):
// GET (whole-blob read) and PUT (partial-key upsert). Drives everything
// through the top-level worker.default.fetch(request, env, ctx), mirroring
// test/worker-deals.test.mjs's style. NEVER makes a real network call.

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

test("GET /api/settings with no FPM_DB binding -> 200 {settings:{}}, never a 500", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://x/api/settings"), env, makeCtx());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { settings: {} });
});

test("PUT /api/settings with no FPM_DB binding -> 200 {saved:false}, never a 500", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    new Request("https://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMonths: 6 }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { saved: false });
});

test("GET /api/settings on a fresh D1 (never PUT) returns an empty blob, not an error", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(new Request("https://x/api/settings"), env, makeCtx());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { settings: {} });
});

test("PUT then GET round-trips arbitrary settings — the falsifiable 'settings persist' claim", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });

  const putRes = await worker.fetch(
    new Request("https://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filters: { minDiscount: 30, includeTags: ["Roguelike"] },
        windowMonths: 6,
        fpmOwnedMode: "hide",
        fpmOnSaleOnly: true,
        fpmFormula: "log",
      }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(putRes.status, 200);
  assert.deepEqual(await putRes.json(), { saved: true });

  const getRes = await worker.fetch(new Request("https://x/api/settings"), env, makeCtx());
  const body = await getRes.json();
  assert.deepEqual(body.settings, {
    filters: { minDiscount: 30, includeTags: ["Roguelike"] },
    windowMonths: 6,
    fpmOwnedMode: "hide",
    fpmOnSaleOnly: true,
    fpmFormula: "log",
  });
});

test("PUT /api/settings is a partial update — a second PUT with fewer keys leaves the others as they were", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });

  await worker.fetch(
    new Request("https://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMonths: 12, fpmFormula: "sqrt" }),
    }),
    env,
    makeCtx(),
  );
  await worker.fetch(
    new Request("https://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMonths: 24 }),
    }),
    env,
    makeCtx(),
  );

  const res = await worker.fetch(new Request("https://x/api/settings"), env, makeCtx());
  const body = await res.json();
  assert.equal(body.settings.windowMonths, 24);
  assert.equal(body.settings.fpmFormula, "sqrt");
});

test("PUT /api/settings with a non-object body (e.g. an array or a string) -> 400, not a silent no-op or a 500", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(
    new Request("https://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 400);
});

test("PUT /api/settings with unparsable JSON -> 400, not a 500", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(
    new Request("https://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 400);
});
