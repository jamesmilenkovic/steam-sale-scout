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
import realWorker from "../src/worker.js";
import { signedWorker } from "./helpers/session.mjs";

// EVERY CALL IN THIS FILE GOES THROUGH THE DEFAULT-DENY GATE (SPEC.md §7), with
// a GENUINELY SIGNED session cookie and the matching secret on the env. Nothing
// is stubbed and the verifier is not bypassed: without this line every
// `worker.fetch` below would answer 401. See test/helpers/session.mjs.
const worker = signedWorker(realWorker);
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

// ---------------------------------------------------------------------------
// SECURITY (found in increment 12.5's security review, defect dates from
// increment 8). Lower stakes than the marks equivalents – a dismissal is
// recoverable – but the identical defect, fixed in the same pass.
// ---------------------------------------------------------------------------

function dismiss(env, body, headers = { "content-type": "application/json" }) {
  return worker.fetch(
    new Request("https://x/api/dismissals", { method: "POST", headers, body: JSON.stringify(body) }),
    env,
    makeCtx(),
  );
}

test("SEC-1: a GET to /api/dismissals/:appid does NOT restore/delete the dismissal – it is a 405", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await dismiss(env, { appid: 100, name: "Some Game" });

  const res = await worker.fetch(new Request("https://x/api/dismissals/100"), env, makeCtx());
  assert.equal(res.status, 405, "a GET is not allowed to be a write");

  const body = await (await worker.fetch(new Request("https://x/api/dismissals"), env, makeCtx())).json();
  assert.equal(body.dismissals.length, 1, "the dismissal survived the drive-by GET");
  assert.equal(body.dismissals[0].appid, 100);
});

test("SEC-2: POST /api/dismissals without an application/json content-type -> 415, nothing stored", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await dismiss(env, { appid: 100, name: "Some Game" }, { "content-type": "text/plain;charset=UTF-8" });
  assert.equal(res.status, 415);
  assert.deepEqual(
    await (await worker.fetch(new Request("https://x/api/dismissals"), env, makeCtx())).json(),
    { dismissals: [] },
  );
});

test("SEC-2: POST /api/dismissals from a cross-site fetch -> 403", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await dismiss(env, { appid: 100 }, { "content-type": "application/json", "sec-fetch-site": "cross-site" });
  assert.equal(res.status, 403);
});

test("SEC-4: appid must be a whole positive number on both dismissal verbs", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  for (const appid of ["", [], true, "0x10", 1.5, 0, -100]) {
    assert.equal((await dismiss(env, { appid })).status, 400, `appid ${JSON.stringify(appid)} must be rejected`);
  }
  for (const tail of ["1.5", "0", "-100"]) {
    const res = await worker.fetch(new Request(`https://x/api/dismissals/${tail}`, { method: "DELETE" }), env, makeCtx());
    assert.equal(res.status, 400, `DELETE /api/dismissals/${tail} must be a 400`);
  }
});
