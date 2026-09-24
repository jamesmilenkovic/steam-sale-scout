// Tests for src/settings.js (Increment 8) — the persisted-UI-settings D1
// store. NEVER makes a real network call; D1 is a real in-memory SQLite
// database (test/helpers/mockD1.mjs), same convention as test/catalog.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { TEST_STEAM_ID } from "./helpers/session.mjs";
import { ensureSettingsSchema, getAllSettings, putSettings } from "../src/settings.js";

function makeEnv() {
  return { FPM_DB: makeMockD1() };
}

// Increment 15, SPEC.md §10: both functions now take the identity explicitly,
// so every call below gains one argument. THE ASSERTIONS ARE UNTOUCHED - this
// is a setup change only. The id is the suite's shared one precisely because
// it loses precision as a JavaScript number, so a TEXT column that quietly
// became an INTEGER one would fail these tests rather than pass them.
const STEAM_ID = TEST_STEAM_ID;

test("ensureSettingsSchema is idempotent — safe to call repeatedly", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);
  await ensureSettingsSchema(env);
  const settings = await getAllSettings(env, STEAM_ID);
  assert.deepEqual(settings, {});
});

test("putSettings + getAllSettings round-trips arbitrary JSON values per key", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);

  await putSettings(env, STEAM_ID, {
    filters: { minDiscount: 25, includeTags: ["roguelike"] },
    windowMonths: 6,
    fpmOwnedMode: "hide",
    fpmOnSaleOnly: true,
    fpmFormula: "log",
  });

  const settings = await getAllSettings(env, STEAM_ID);
  assert.deepEqual(settings, {
    filters: { minDiscount: 25, includeTags: ["roguelike"] },
    windowMonths: 6,
    fpmOwnedMode: "hide",
    fpmOnSaleOnly: true,
    fpmFormula: "log",
  });
});

test("putSettings only touches the keys it's given — a partial update leaves other keys alone", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);

  await putSettings(env, STEAM_ID, { windowMonths: 12, fpmFormula: "sqrt" });
  await putSettings(env, STEAM_ID, { windowMonths: 24 }); // only windowMonths changes

  const settings = await getAllSettings(env, STEAM_ID);
  assert.equal(settings.windowMonths, 24);
  assert.equal(settings.fpmFormula, "sqrt");
});

test("putSettings upserts — writing the same key again replaces its value, not duplicates the row", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);

  await putSettings(env, STEAM_ID, { windowMonths: 12 });
  await putSettings(env, STEAM_ID, { windowMonths: 18 });

  const settings = await getAllSettings(env, STEAM_ID);
  assert.equal(settings.windowMonths, 18);
});

test("putSettings with an empty object is a safe no-op", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);
  await putSettings(env, STEAM_ID, {});
  const settings = await getAllSettings(env, STEAM_ID);
  assert.deepEqual(settings, {});
});

test("getAllSettings skips a corrupt (non-JSON) row rather than throwing — fail-soft per key", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);
  await putSettings(env, STEAM_ID, { windowMonths: 12 });
  // Hand-corrupt one row directly, bypassing putSettings' JSON.stringify.
  await env.FPM_DB.prepare("UPDATE settings SET value = ? WHERE steam_id = ? AND key = ?")
    .bind("{not json", STEAM_ID, "windowMonths")
    .run();
  await putSettings(env, STEAM_ID, { fpmFormula: "linear" });

  const settings = await getAllSettings(env, STEAM_ID);
  assert.equal(settings.windowMonths, undefined); // corrupt row skipped
  assert.equal(settings.fpmFormula, "linear"); // the healthy row is unaffected
});
