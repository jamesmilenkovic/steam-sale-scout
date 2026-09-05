// Tests for src/worker.js – the /api/marks routes (Increment 12.5):
// GET (list), POST (full-state upsert), DELETE /:appid (clear). Drives
// everything through worker.default.fetch(request, env, ctx), mirroring
// test/worker-dismissals.test.mjs's style exactly, because these two route
// families are deliberately the same shape.
//
// THE ONE THING THIS FILE PROVES THAT THE DISMISSALS FILE CANNOT: there is no
// server-side exclusion here. A dismissal removes a row from every lane's
// pool; a mark never touches a pool. That half is proved in
// test/worker-rank.test.mjs, where the ranking is captured with and without
// marks present.
//
// NEVER makes a real network call.

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

function postMark(env, body) {
  return worker.fetch(
    new Request("https://x/api/marks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    makeCtx(),
  );
}

// ---------------------------------------------------------------------------
// Fail-soft: the same posture as /api/dismissals, never a 500.
// ---------------------------------------------------------------------------

test("GET /api/marks with no FPM_DB binding -> 200 {marks:[]}, never a 500", async () => {
  const res = await worker.fetch(new Request("https://x/api/marks"), makeEnv(), makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { marks: [] });
});

test("POST /api/marks with no FPM_DB binding -> 200 {saved:false}, so the PAGE can say the write failed", async () => {
  // Increment 12's review caught "the action silently did nothing" four ways.
  // The route stays fail-soft, but it reports `saved: false` rather than a
  // cheerful `true`, which is what lets public/index.html revert the toggle
  // and say so instead of leaving James believing a game is marked.
  const res = await postMark(makeEnv(), { appid: 400, name: "Portal", played: 1, finished: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { saved: false, played: 1, finished: 0 });
});

test("DELETE /api/marks/:appid with no FPM_DB binding -> 200 {cleared:false}, never a 500", async () => {
  const res = await worker.fetch(new Request("https://x/api/marks/400", { method: "DELETE" }), makeEnv(), makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cleared: false });
});

test("a D1 throw on any of the three verbs is answered honestly, not with a 500", async () => {
  const exploding = {
    prepare() {
      return { bind() { return this; }, async run() { throw new Error("D1 is having a day"); }, async all() { throw new Error("nope"); } };
    },
  };
  const env = makeEnv({ FPM_DB: exploding });

  assert.deepEqual(await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json(), { marks: [] });
  assert.deepEqual(await (await postMark(env, { appid: 400, played: 1 })).json(), { saved: false, played: 1, finished: 0 });
  assert.deepEqual(
    await (await worker.fetch(new Request("https://x/api/marks/400", { method: "DELETE" }), env, makeCtx())).json(),
    { cleared: false },
  );
});

// ---------------------------------------------------------------------------
// The round trip, and the invariant at the API.
// ---------------------------------------------------------------------------

test("POST then GET round-trips a mark – the falsifiable 'the mark persists' claim", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });

  const postRes = await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 0 });
  assert.equal(postRes.status, 200);
  assert.deepEqual(await postRes.json(), { saved: true, played: 1, finished: 0 });

  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks.length, 1);
  assert.equal(body.marks[0].appid, 400);
  assert.equal(body.marks[0].name, "Portal");
  assert.equal(body.marks[0].played, 1);
  assert.equal(body.marks[0].finished, 0);
  assert.equal(typeof body.marks[0].updated_at, "number");
  assert.deepEqual(Object.keys(body.marks[0]).sort(), ["appid", "finished", "name", "played", "updated_at"]);
});

test("GATE 3: POST {played:0, finished:1} STORES played = 1 – the invariant is the server's job, not the client's", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });

  const res = await postMark(env, { appid: 400, name: "Portal", played: 0, finished: 1 });
  // The response echoes what was STORED, not what was asked for.
  assert.deepEqual(await res.json(), { saved: true, played: 1, finished: 1 });

  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks[0].played, 1, "you cannot finish a game you never played");
  assert.equal(body.marks[0].finished, 1);
});

test("POST is a FULL-STATE UPSERT, not a toggle – a double-click cannot flip the state", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 0 });
  await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 0 });
  await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 0 });

  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks.length, 1);
  assert.equal(body.marks[0].played, 1);
});

test("clearing 'played' on a finished game clears both – the invariant, running backwards", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 1 });
  await postMark(env, { appid: 400, name: "Portal", played: 0, finished: 0 });

  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks[0].played, 0);
  assert.equal(body.marks[0].finished, 0);
});

test("POST then DELETE clears it, and the appid no longer appears in GET /api/marks", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 1 });

  const del = await worker.fetch(new Request("https://x/api/marks/400", { method: "DELETE" }), env, makeCtx());
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { cleared: true });

  assert.deepEqual(await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json(), { marks: [] });
});

test("GET /api/marks is newest-updated first – asserted on the UNSORTED appid sequence", async () => {
  // This test used to assert `.map(m => m.name).sort()`, which is alphabetical
  // and therefore cannot fail on ordering at all. The list order is compared
  // raw here, against a known write order.
  //
  // `updated_at` is Date.now() in milliseconds, and three POSTs in a row can
  // land inside one millisecond, which would make the tie-break – and this
  // test – arbitrary. The clock is stubbed to step deterministically instead
  // of sleeping.
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const realNow = Date.now;
  let tick = 1_757_000_000_000;
  Date.now = () => (tick += 1000);
  try {
    await postMark(env, { appid: 400, name: "Portal", played: 1 });
    await postMark(env, { appid: 282140, name: "SOMA", played: 1 });
    await postMark(env, { appid: 620, name: "Portal 2", played: 1 });

    const first = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
    assert.deepEqual(
      first.marks.map((m) => m.appid),
      [620, 282140, 400],
      "newest-updated first means the reverse of the write order, not alphabetical",
    );

    // NEWEST-UPDATED, not newest-marked: re-posting the OLDEST mark moves it to
    // the front. `marked_at` is left alone by the upsert, so a list ordered by
    // marked_at would leave Portal last and fail here.
    await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 1 });
    const second = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
    assert.deepEqual(second.marks.map((m) => m.appid), [400, 620, 282140]);
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// Bad input.
// ---------------------------------------------------------------------------

test("POST /api/marks with a missing or non-numeric appid -> 400, not a silent no-op or a 500", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  assert.equal((await postMark(env, { name: "No appid here", played: 1 })).status, 400);
  assert.equal((await postMark(env, { appid: "portal", played: 1 })).status, 400);

  const res = await worker.fetch(
    new Request("https://x/api/marks", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 400);
});

test("POST /api/marks without a name still marks (name is a display snapshot, not a key)", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  assert.deepEqual(await (await postMark(env, { appid: 400, played: 1 })).json(), { saved: true, played: 1, finished: 0 });
  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks[0].name, null);
});

test("DELETE /api/marks/:appid on a never-marked appid is a safe no-op, still {cleared:true}", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(new Request("https://x/api/marks/999", { method: "DELETE" }), env, makeCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cleared: true });
});

test("DELETE /api/marks/not-a-number -> 400, not a 500", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(new Request("https://x/api/marks/not-a-number", { method: "DELETE" }), env, makeCtx());
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// The three verdicts must not collide.
// ---------------------------------------------------------------------------

test("THE COLLISION CHECK: un-dismissing a game does NOT delete its play history", async () => {
  // The specific accident a shared table would eventually cause, and the
  // reason `game_marks` is its own table rather than two more columns on
  // `dismissals`. Un-dismissing DELETEs the dismissal row by design; a mark
  // is a durable record of personal history and is the only unrecoverable
  // data in this project.
  const env = makeEnv({ FPM_DB: makeMockD1() });

  await postMark(env, { appid: 400, name: "Portal", played: 1, finished: 1 });
  await worker.fetch(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 400, name: "Portal" }),
    }),
    env,
    makeCtx(),
  );
  await worker.fetch(new Request("https://x/api/dismissals/400", { method: "DELETE" }), env, makeCtx());

  const marks = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(marks.marks.length, 1, "the mark survived a dismiss/un-dismiss cycle");
  assert.equal(marks.marks[0].finished, 1);

  // And the reverse: clearing a mark leaves the dismissal alone.
  await worker.fetch(
    new Request("https://x/api/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appid: 400, name: "Portal" }),
    }),
    env,
    makeCtx(),
  );
  await worker.fetch(new Request("https://x/api/marks/400", { method: "DELETE" }), env, makeCtx());
  const dismissals = await (await worker.fetch(new Request("https://x/api/dismissals"), env, makeCtx())).json();
  assert.equal(dismissals.dismissals.length, 1);
});

// ---------------------------------------------------------------------------
// SECURITY (increment 12.5's security review). These are regressions that must
// never come back: this table is the only data in the project that cannot be
// re-fetched from anywhere, so a write reachable by accident is permanent.
// ---------------------------------------------------------------------------

test("SEC-1: a GET to /api/marks/:appid does NOT delete the mark – it is a 405", async () => {
  // The blocker as reproduced against the running worker: the prefix route ran
  // the DELETE handler on ANY method, so `<img src="http://localhost:8787/api/
  // marks/440">` on any page in the browser destroyed a mark, with no JS, no
  // CORS and no preflight.
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await postMark(env, { appid: 440, name: "Team Fortress 2", played: 1, finished: 1 });

  const res = await worker.fetch(new Request("https://x/api/marks/440"), env, makeCtx());
  assert.equal(res.status, 405, "a GET is not allowed to be a write");

  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks.length, 1, "the mark survived the drive-by GET");
  assert.equal(body.marks[0].appid, 440);
  assert.equal(body.marks[0].finished, 1);
});

test("SEC-1: HEAD, POST and PUT to /api/marks/:appid are 405 too, and leave the mark alone", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await postMark(env, { appid: 440, name: "Team Fortress 2", played: 1, finished: 0 });

  for (const method of ["HEAD", "POST", "PUT", "PATCH"]) {
    const res = await worker.fetch(new Request("https://x/api/marks/440", { method }), env, makeCtx());
    assert.equal(res.status, 405, `${method} must not reach the delete handler`);
  }
  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks.length, 1);
});

test("SEC-2: POST /api/marks without an application/json content-type -> 415, nothing stored", async () => {
  // The CSRF shape that increment 12's audit wrongly assumed was impossible:
  // a cross-origin <form enctype="text/plain"> sends a CORS-safelisted content
  // type with no preflight and a body craftable into valid JSON, and
  // request.json() parses it regardless of what Content-Type says.
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await worker.fetch(
    new Request("https://x/api/marks", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ appid: 440, name: "Team Fortress 2", played: 1, finished: 1 }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(res.status, 415);
  assert.deepEqual(await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json(), { marks: [] });
});

test("SEC-2: POST /api/marks with Sec-Fetch-Site: cross-site -> 403, and same-origin is allowed", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const blocked = await worker.fetch(
    new Request("https://x/api/marks", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ appid: 440, played: 1 }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(blocked.status, 403);
  assert.deepEqual(await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json(), { marks: [] });

  const allowed = await worker.fetch(
    new Request("https://x/api/marks", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ appid: 440, played: 1 }),
    }),
    env,
    makeCtx(),
  );
  assert.deepEqual(await allowed.json(), { saved: true, played: 1, finished: 0 });
});

test("SEC-2: an ABSENT Sec-Fetch-Site is allowed – curl and this project's tools send no such header", async () => {
  // Documented decision: the content-type check is the load-bearing one and
  // does not depend on this header, so failing closed on absence would only
  // break non-browser callers.
  const env = makeEnv({ FPM_DB: makeMockD1() });
  const res = await postMark(env, { appid: 440, played: 1 });
  assert.deepEqual(await res.json(), { saved: true, played: 1, finished: 0 });
});

test("SEC-4: appid must be a whole positive number – '', [], true, '0x10' and 1.5 are all 400", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  for (const appid of ["", [], true, "0x10", 1.5, 0, -400, null, {}]) {
    const res = await postMark(env, { appid, name: "junk", played: 1 });
    assert.equal(res.status, 400, `appid ${JSON.stringify(appid)} must not reach the table`);
  }
  assert.deepEqual(await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json(), { marks: [] });

  // And on the delete side, where the appid comes off the path.
  for (const tail of ["1.5", "0", "-400", "0x10", ""]) {
    const res = await worker.fetch(new Request(`https://x/api/marks/${tail}`, { method: "DELETE" }), env, makeCtx());
    assert.equal(res.status, 400, `DELETE /api/marks/${tail} must be a 400`);
  }
});

test("SEC-5: a name longer than 200 characters is stored capped, not verbatim", async () => {
  const env = makeEnv({ FPM_DB: makeMockD1() });
  await postMark(env, { appid: 440, name: "A".repeat(5000), played: 1 });
  const body = await (await worker.fetch(new Request("https://x/api/marks"), env, makeCtx())).json();
  assert.equal(body.marks[0].name.length, 200);
});
