// Tests for src/marks.js (Increment 12.5) – the D1 CRUD for per-game marks
// and the pure derivePlayed() precedence function.
//
// derivePlayed is the whole increment in one function, so it is tested
// exhaustively and against the REAL measured shapes: Portal's all-zeros row
// (the 297), Tactical Breach Wizards' zero-hours-with-a-date row (the 45), and
// Portal 2's ordinary played row. Every appid, playtime and date below came off
// the live Steam API on 2026-09-05, not out of the air.
//
// NEVER makes a real network call; the D1 half runs against node:sqlite via
// the same mock the rest of the suite uses.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureMarksSchema,
  listMarks,
  getMarksByAppid,
  setMark,
  removeMark,
  normaliseMark,
  derivePlayed,
} from "../src/marks.js";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { TEST_STEAM_ID } from "./helpers/session.mjs";

// Increment 15, SPEC.md §10: the five D1 functions take the identity
// explicitly now, so every call in the D1 half below gains one argument. THE
// ASSERTIONS ARE UNTOUCHED - this is a setup change only. `normaliseMark` and
// `derivePlayed` are pure and their tests are byte-identical.
const STEAM_ID = TEST_STEAM_ID;

// ---------------------------------------------------------------------------
// The real rows, as Steam returns them.
// ---------------------------------------------------------------------------

/** appid 400. THE 297, and the game that triggered this increment. Steam
 * returns zero on every field it has. Portal shipped in 2007; Steam began
 * recording playtime in March 2009. */
const PORTAL = {
  appid: 400,
  name: "Portal",
  playtime_forever: 0,
  playtime_2weeks: undefined,
  rtime_last_played: 0,
  playtime_disconnected: 0,
};

/** appid 1043810. THE 45. Zero recorded minutes, but Steam holds a real
 * last-played date of 23 March 2025 – and 83 disconnected minutes with it. */
const TACTICAL_BREACH_WIZARDS = {
  appid: 1043810,
  name: "Tactical Breach Wizards",
  playtime_forever: 0,
  rtime_last_played: 1742688000,
  playtime_disconnected: 83,
};

/** appid 620. An ordinary played game – Steam has the hours. */
const PORTAL_2 = {
  appid: 620,
  name: "Portal 2",
  playtime_forever: 1014,
  rtime_last_played: 1750000000,
  playtime_disconnected: 0,
};

function makeEnv() {
  return { FPM_DB: makeMockD1() };
}

// ---------------------------------------------------------------------------
// derivePlayed – the four precedence cases, in order (SPEC.md §4.2).
// ---------------------------------------------------------------------------

test("derivePlayed 1/4: playtime_forever > 0 wins, and playedSource says so", () => {
  const state = derivePlayed(PORTAL_2, null);
  assert.deepEqual(state, {
    played: true,
    finished: false,
    playedSource: "steam-playtime",
    lastPlayedAt: 1750000000,
  });
});

test("derivePlayed 2/4: playtime_disconnected > 0 is a played SIGNAL", () => {
  // Measured 2026-09-05: all 42 rows carrying playtime_disconnected are
  // already inside the 45 that rtime_last_played recovers, so this branch
  // recovers ZERO additional games today. It is tested on a synthetic row
  // because the real library has none – and it is kept because Steam
  // guarantees nothing about the two fields always travelling together.
  const state = derivePlayed(
    { playtime_forever: 0, playtime_disconnected: 30, rtime_last_played: 0 },
    null,
  );
  assert.equal(state.played, true);
  assert.equal(state.playedSource, "steam-disconnected");
  assert.equal(state.lastPlayedAt, null);
});

test("derivePlayed 3/4: THE 45 – zero hours and a real last-played date is PLAYED", () => {
  // The bug this closes. rtime_last_played has arrived on every library fetch
  // since increment 1 and nothing read it, so Tactical Breach Wizards sat at
  // rank #5 saying "never played" about a game played on 23 March 2025.
  const state = derivePlayed(TACTICAL_BREACH_WIZARDS, null);
  assert.equal(state.played, true);
  assert.equal(state.finished, false);
  // Disconnected is checked BEFORE last-played, and this row has both, so the
  // source is the higher-precedence one. Either way it is Steam, not the user.
  assert.equal(state.playedSource, "steam-disconnected");
  assert.equal(state.lastPlayedAt, 1742688000);

  // With the disconnected minutes stripped, the last-played date alone still
  // carries it – which is the branch that actually recovers all 45.
  const dateOnly = derivePlayed({ ...TACTICAL_BREACH_WIZARDS, playtime_disconnected: 0 }, null);
  assert.equal(dateOnly.played, true);
  assert.equal(dateOnly.playedSource, "steam-last-played");
});

test("derivePlayed 4/4: the user's mark, and ONLY when Steam has nothing to say", () => {
  const state = derivePlayed(PORTAL, { played: 1, finished: 0 });
  assert.deepEqual(state, {
    played: true,
    finished: false,
    playedSource: "you",
    lastPlayedAt: null,
  });

  // A mark never DEMOTES Steam's own evidence – Steam still owns the source.
  assert.equal(derivePlayed(PORTAL_2, { played: 1, finished: 0 }).playedSource, "steam-playtime");
});

test("derivePlayed: THE PORTAL CASE – all zeros and no mark is 'no play record', which is not 'never played'", () => {
  assert.deepEqual(derivePlayed(PORTAL, null), {
    played: false,
    finished: false,
    playedSource: null,
    lastPlayedAt: null,
  });
  assert.deepEqual(derivePlayed(PORTAL, undefined), derivePlayed(PORTAL, null));
  // 297 owned games are in exactly this state. The function says "I have no
  // evidence", never "this was not played" – the page's wording depends on it.
});

test("derivePlayed: finished comes from the mark and from nothing else, and implies played", () => {
  assert.equal(derivePlayed(PORTAL, { played: 0, finished: 1 }).finished, true);
  assert.equal(derivePlayed(PORTAL, { played: 0, finished: 1 }).played, true, "finished implies played");
  assert.equal(derivePlayed(PORTAL, { played: 0, finished: 1 }).playedSource, "you");

  // Steam can never set it. Not with hours, not with a date, not ever.
  assert.equal(derivePlayed(PORTAL_2, null).finished, false);
  assert.equal(derivePlayed(TACTICAL_BREACH_WIZARDS, null).finished, false);

  // Both facts survive together: Steam's hours AND the user's verdict.
  const both = derivePlayed(PORTAL_2, { played: 1, finished: 1 });
  assert.equal(both.finished, true);
  assert.equal(both.playedSource, "steam-playtime");
});

test("derivePlayed: no library row at all is honest, not an error", () => {
  // Steam down, or no credentials: every row arrives with no library game.
  assert.deepEqual(derivePlayed(null, null), {
    played: false, finished: false, playedSource: null, lastPlayedAt: null,
  });
  assert.equal(derivePlayed(undefined, { played: 1 }).playedSource, "you");
  // Junk fields degrade to "no evidence" rather than throwing.
  assert.equal(derivePlayed({ playtime_forever: "lots" }, null).played, false);
  assert.equal(derivePlayed({ rtime_last_played: null }, null).played, false);
});

test("derivePlayed: THERE IS NO USER-ASSERTED 'not played' – a mark can never contradict Steam", () => {
  // Named as a refusal in SPEC.md §4.2. The toggle's third state CLEARS the
  // mark; it does not assert a negative. So the only way to make this function
  // return false for a game with Steam playtime would be to lose the playtime.
  assert.equal(derivePlayed(PORTAL_2, { played: 0, finished: 0 }).played, true);
  assert.equal(derivePlayed(TACTICAL_BREACH_WIZARDS, { played: 0, finished: 0 }).played, true);
});

// ---------------------------------------------------------------------------
// normaliseMark – the invariant, provable without a database.
// ---------------------------------------------------------------------------

test("normaliseMark: finished => played, whatever the caller sent", () => {
  assert.deepEqual(normaliseMark({ played: 0, finished: 1 }), { played: 1, finished: 1 });
  assert.deepEqual(normaliseMark({ finished: true }), { played: 1, finished: 1 });
  assert.deepEqual(normaliseMark({ played: 1, finished: 0 }), { played: 1, finished: 0 });
  assert.deepEqual(normaliseMark({ played: 0, finished: 0 }), { played: 0, finished: 0 });
  assert.deepEqual(normaliseMark({}), { played: 0, finished: 0 });
  assert.deepEqual(normaliseMark(null), { played: 0, finished: 0 });
  // Booleans, strings and numbers all collapse to 0/1 – the column is INTEGER.
  assert.deepEqual(normaliseMark({ played: true, finished: false }), { played: 1, finished: 0 });
  assert.deepEqual(normaliseMark({ played: "yes" }), { played: 1, finished: 0 });
});

// ---------------------------------------------------------------------------
// The D1 half.
// ---------------------------------------------------------------------------

test("the schema is idempotent and a fresh table lists nothing", async () => {
  const env = makeEnv();
  await ensureMarksSchema(env);
  await ensureMarksSchema(env);
  assert.deepEqual(await listMarks(env, STEAM_ID), []);
  assert.deepEqual([...(await getMarksByAppid(env, STEAM_ID)).keys()], []);
});

test("setMark is a FULL-STATE UPSERT, not a toggle – pressing twice is idempotent", async () => {
  const env = makeEnv();
  await ensureMarksSchema(env);

  await setMark(env, STEAM_ID, 400, "Portal", { played: 1, finished: 0 }, 1000);
  await setMark(env, STEAM_ID, 400, "Portal", { played: 1, finished: 0 }, 2000);
  const marks = await listMarks(env, STEAM_ID);
  assert.equal(marks.length, 1, "a second press must not create a second row");
  assert.deepEqual(
    { appid: marks[0].appid, name: marks[0].name, played: marks[0].played, finished: marks[0].finished },
    { appid: 400, name: "Portal", played: 1, finished: 0 },
    "and must not flip the state",
  );
  assert.equal(marks[0].updated_at, 2000);
});

test("the finished => played invariant is enforced ON WRITE, so the impossible row cannot exist", async () => {
  const env = makeEnv();
  await ensureMarksSchema(env);
  const stored = await setMark(env, STEAM_ID, 400, "Portal", { played: 0, finished: 1 }, 1000);
  assert.deepEqual(stored, { played: 1, finished: 1 });
  const row = (await listMarks(env, STEAM_ID))[0];
  assert.equal(row.played, 1, "stored played must be 1 even though the caller sent 0");
  assert.equal(row.finished, 1);
});

test("marked_at is set once; updated_at moves on every write", async () => {
  const env = makeEnv();
  await ensureMarksSchema(env);
  await setMark(env, STEAM_ID, 400, "Portal", { played: 1 }, 1000);
  await setMark(env, STEAM_ID, 400, "Portal", { played: 1, finished: 1 }, 5000);
  const row = await env.FPM_DB.prepare("SELECT * FROM game_marks WHERE steam_id = ? AND appid = 400")
    .bind(STEAM_ID)
    .first();
  assert.equal(row.marked_at, 1000, "when you first said something about this game");
  assert.equal(row.updated_at, 5000);
  assert.equal(row.finished, 1);
});

test("listMarks is newest-updated first; getMarksByAppid is the join shape /api/rank needs", async () => {
  const env = makeEnv();
  await ensureMarksSchema(env);
  await setMark(env, STEAM_ID, 400, "Portal", { played: 1 }, 1000);
  await setMark(env, STEAM_ID, 620, "Portal 2", { played: 1, finished: 1 }, 3000);
  await setMark(env, STEAM_ID, 282140, "SOMA", { played: 1 }, 2000);

  assert.deepEqual((await listMarks(env, STEAM_ID)).map((m) => m.appid), [620, 282140, 400]);

  const byAppid = await getMarksByAppid(env, STEAM_ID);
  assert.equal(byAppid.size, 3);
  assert.deepEqual({ ...byAppid.get(620) }, { appid: 620, played: 1, finished: 1 });
  assert.equal(byAppid.has(1), false);
});

test("removeMark clears the assertion and is a no-op, not an error, when there is nothing to clear", async () => {
  const env = makeEnv();
  await ensureMarksSchema(env);
  await setMark(env, STEAM_ID, 400, "Portal", { played: 1, finished: 1 }, 1000);
  await removeMark(env, STEAM_ID, 400);
  assert.deepEqual(await listMarks(env, STEAM_ID), []);
  await removeMark(env, STEAM_ID, 400);
  await removeMark(env, STEAM_ID, 999999);
  assert.deepEqual(await listMarks(env, STEAM_ID), []);

  // And clearing is NOT asserting "never played" – the derived answer for a
  // cleared Portal is "no evidence", identical to a game never marked at all.
  assert.deepEqual(derivePlayed(PORTAL, undefined), derivePlayed(PORTAL, null));
});

test("a mark is a name snapshot, and a nameless mark is allowed", async () => {
  const env = makeEnv();
  await ensureMarksSchema(env);
  await setMark(env, STEAM_ID, 400, null, { played: 1 }, 1000);
  assert.equal((await listMarks(env, STEAM_ID))[0].name, null);
});
