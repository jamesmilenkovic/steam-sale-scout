// QA TC-4 (increment 14) – the increment's HEADLINE CLAIM, asserted.
//
// Increment 14 deleted five routes: /api/library, /api/deals, /api/recs,
// /api/best-of and /api/fpm. The claim is not "they stopped working", it is
// "they are gone, and the /api/ catch-all at the bottom of src/worker.js
// answers for them". Until this file existed nothing in the suite asserted
// that: a grep for `501` across test/ returned nothing, and the headline rested
// on a manual curl.
//
// WHY THE BODY IS ASSERTED AND NOT JUST THE STATUS. A route that half-survives
// – say a handler that now throws and lands on a generic error – could answer
// with some other non-200 and a "not 200" test would applaud it. The catch-all
// has exactly one shape, `{"error":"not implemented"}` at 501 with a JSON
// content-type, so that is what is pinned. `assert.deepEqual` on the whole
// object, not a substring match, so an extra field is a failure too.
//
// The negative half of the file matters as much as the positive half: if the
// router were broken so that EVERYTHING 501'd, the table below would still pass
// happily. The surviving-routes test is what stops that.
//
// NEVER makes a real network call. The offline guard is installed as
// `globalThis.fetch` and asserted empty afterwards – none of these paths should
// reach an upstream at all, and the guard proves it rather than assuming it.

import test from "node:test";
import assert from "node:assert/strict";
import realWorker from "../src/worker.js";
import { signedWorker } from "./helpers/session.mjs";

// EVERY CALL IN THIS FILE GOES THROUGH THE DEFAULT-DENY GATE (SPEC.md §7), with
// a GENUINELY SIGNED session cookie and the matching secret on the env. Nothing
// is stubbed and the verifier is not bypassed: without this line every
// `worker.fetch` below would answer 401. See test/helpers/session.mjs.
const worker = signedWorker(realWorker);
import { makeOfflineFetchGuard } from "./helpers/offlineFetchGuard.mjs";

const originalCaches = globalThis.caches;
let offlineGuard = makeOfflineFetchGuard("router-deleted-routes");

function restoreGlobals() {
  globalThis.fetch = makeOfflineFetchGuard("router-deleted-routes (between tests)");
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
}

function makeMockCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      return store.get(request.url);
    },
    async put(request, response) {
      store.set(request.url, response);
    },
  };
}

function makeCtx() {
  return { waitUntil() {} };
}

/** Deliberately a FULLY CONFIGURED env – every secret and binding present.
 * A deleted route must 501 because the router has no branch for it, not
 * because some credential happens to be missing. */
function makeEnv(overrides = {}) {
  return {
    STEAM_API_KEY: "test-steam-key",
    // Increment 15, SPEC.md §11.6: renamed from STEAM_ID.
    OWNER_STEAM_ID: "76561198000000000",
    ITAD_API_KEY: "test-itad-key",
    ASSETS: {
      fetch: async () => new Response("static asset", { status: 200 }),
    },
    ...overrides,
  };
}

/** The five, exactly as SPEC.md §1 lists them. */
const DELETED_ROUTES = [
  "/api/library",
  "/api/deals",
  "/api/recs",
  "/api/best-of",
  "/api/fpm",
];

test.beforeEach(() => {
  offlineGuard = makeOfflineFetchGuard("router-deleted-routes");
  globalThis.fetch = offlineGuard;
  globalThis.caches = { default: makeMockCache() };
});

test.afterEach(() => {
  const calls = [...offlineGuard.calls];
  restoreGlobals();
  assert.deepEqual(calls, [], "no test in this file may reach the network");
});

// ---------------------------------------------------------------------------
// The headline: each of the five answers 501 not implemented.
// ---------------------------------------------------------------------------

test("TC-4: each of the five deleted routes answers 501 with the catch-all's exact body", async () => {
  for (const pathname of DELETED_ROUTES) {
    const res = await worker.fetch(new Request(`https://x.test${pathname}`), makeEnv(), makeCtx());

    assert.equal(res.status, 501, `${pathname} answered ${res.status}, expected 501`);
    assert.equal(
      res.headers.get("content-type"),
      "application/json",
      `${pathname} did not answer JSON`,
    );
    // Exhaustive, not a substring check: the catch-all's body is one field and
    // nothing may ride alongside it.
    assert.deepEqual(
      await res.json(),
      { error: "not implemented" },
      `${pathname} did not answer the catch-all body`,
    );
  }
});

test("TC-4: the query strings the deleted routes used to take change nothing – still 501", async () => {
  // The old routes all had parameters (?refresh=1, ?minCut=, ?formula=,
  // ?owned=). A surviving handler reachable only with its params would be
  // invisible to the bare-path table above.
  const withParams = [
    "/api/library?refresh=1",
    "/api/deals?minCut=60",
    "/api/recs?windowMonths=6",
    "/api/best-of?refresh=1",
    "/api/fpm?formula=headline&owned=only&score=1",
  ];

  for (const target of withParams) {
    const res = await worker.fetch(new Request(`https://x.test${target}`), makeEnv(), makeCtx());
    assert.equal(res.status, 501, `${target} answered ${res.status}, expected 501`);
    assert.deepEqual(await res.json(), { error: "not implemented" }, `${target}`);
  }
});

test("TC-4: a write verb against a deleted route is 501 too, never an accidental write path", async () => {
  // The catch-all is method-agnostic by design. Asserted rather than assumed,
  // because "deleted for GET, alive for POST" is exactly the kind of half-cut
  // this increment claims not to be.
  for (const pathname of DELETED_ROUTES) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await worker.fetch(
        new Request(`https://x.test${pathname}`, { method }),
        makeEnv(),
        makeCtx(),
      );
      assert.equal(res.status, 501, `${method} ${pathname} answered ${res.status}`);
      assert.deepEqual(await res.json(), { error: "not implemented" }, `${method} ${pathname}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The negative half – without this, a router that 501'd EVERYTHING would pass
// every assertion above.
// ---------------------------------------------------------------------------

test("TC-4: the surviving routes are NOT 501 – the table above is not passing because everything 501s", async () => {
  // Deliberately asserted only on "not 501, and not the catch-all body". What
  // each of these routes actually returns is its own suite's job
  // (worker-rank, worker-wishlist, worker-marks, worker-settings,
  // worker-dismissals, worker-fpm); here they are only the control group.
  const survivors = [
    "/api/rank",
    "/api/wishlist",
    "/api/settings",
    "/api/dismissals",
    "/api/marks",
    "/api/fpm/sync/status",
  ];

  // Credentials and bindings deliberately ABSENT here, unlike everywhere else
  // in this file. Every surviving route is fail-soft about a missing secret, so
  // they all still answer; and with no secrets none of them reaches an upstream,
  // which keeps the offline guard's afterEach assertion honest rather than
  // needing a per-route fetch stub that would only obscure the point.
  const env = makeEnv({ STEAM_API_KEY: undefined, OWNER_STEAM_ID: undefined, ITAD_API_KEY: undefined });

  for (const pathname of survivors) {
    const res = await worker.fetch(new Request(`https://x.test${pathname}`), env, makeCtx());
    assert.notEqual(res.status, 501, `${pathname} answered 501 – it is supposed to have survived`);
  }
});

test("TC-4: /api/fpm is gone but /api/fpm/sync, /sync/status and /sync/stop are not – the prefix was not over-cut", async () => {
  // The closest call in the whole deletion: `/api/fpm` and the sync trio share
  // a path prefix, and the router matches the trio BEFORE the catch-all. One
  // reordered branch and the sync lane would 501 as well.
  const gone = await worker.fetch(new Request("https://x.test/api/fpm"), makeEnv(), makeCtx());
  assert.equal(gone.status, 501);
  assert.deepEqual(await gone.json(), { error: "not implemented" });

  // No FPM_DB binding here on purpose: the sync lane's documented fail-soft
  // answer is a 200 with a notice, which is a far more specific signal that
  // the real handler ran than a bare "not 501" would be.
  const status = await worker.fetch(
    new Request("https://x.test/api/fpm/sync/status"),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).dbReady, false);

  const start = await worker.fetch(
    new Request("https://x.test/api/fpm/sync", { method: "POST" }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { started: false, notice: "FPM_DB not configured" });

  const stop = await worker.fetch(
    new Request("https://x.test/api/fpm/sync/stop", { method: "POST" }),
    makeEnv(),
    makeCtx(),
  );
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { stopping: false, notice: "FPM_DB not configured" });
});

test("TC-4: a non-/api path still falls through to the static asset handler, not to the 501", async () => {
  // The catch-all is scoped to `/api/`. If that scope slipped, the front end
  // itself would 501 – and no other test in the suite would notice.
  let assetCalls = 0;
  const env = makeEnv({
    ASSETS: {
      fetch: async () => {
        assetCalls++;
        return new Response("index", { status: 200 });
      },
    },
  });

  const res = await worker.fetch(new Request("https://x.test/"), env, makeCtx());
  assert.equal(res.status, 200);
  assert.equal(assetCalls, 1);
  assert.equal(await res.text(), "index");
});
