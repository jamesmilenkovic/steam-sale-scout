// Tests for src/settings.js (Increment 8) — the persisted-UI-settings D1
// store. NEVER makes a real network call; D1 is a real in-memory SQLite
// database (test/helpers/mockD1.mjs), same convention as test/catalog.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { makeMockD1 } from "./helpers/mockD1.mjs";
import { ensureSettingsSchema, getAllSettings, putSettings } from "../src/settings.js";

function makeEnv() {
  return { FPM_DB: makeMockD1() };
}

test("ensureSettingsSchema is idempotent — safe to call repeatedly", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);
  await ensureSettingsSchema(env);
  const settings = await getAllSettings(env);
  assert.deepEqual(settings, {});
});

test("putSettings + getAllSettings round-trips arbitrary JSON values per key", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);

  await putSettings(env, {
    filters: { minDiscount: 25, includeTags: ["roguelike"] },
    windowMonths: 6,
    fpmOwnedMode: "hide",
    fpmOnSaleOnly: true,
    fpmFormula: "log",
  });

  const settings = await getAllSettings(env);
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

  await putSettings(env, { windowMonths: 12, fpmFormula: "sqrt" });
  await putSettings(env, { windowMonths: 24 }); // only windowMonths changes

  const settings = await getAllSettings(env);
  assert.equal(settings.windowMonths, 24);
  assert.equal(settings.fpmFormula, "sqrt");
});

test("putSettings upserts — writing the same key again replaces its value, not duplicates the row", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);

  await putSettings(env, { windowMonths: 12 });
  await putSettings(env, { windowMonths: 18 });

  const settings = await getAllSettings(env);
  assert.equal(settings.windowMonths, 18);
});

test("putSettings with an empty object is a safe no-op", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);
  await putSettings(env, {});
  const settings = await getAllSettings(env);
  assert.deepEqual(settings, {});
});

test("getAllSettings skips a corrupt (non-JSON) row rather than throwing — fail-soft per key", async () => {
  const env = makeEnv();
  await ensureSettingsSchema(env);
  await putSettings(env, { windowMonths: 12 });
  // Hand-corrupt one row directly, bypassing putSettings' JSON.stringify.
  await env.FPM_DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind("{not json", "windowMonths").run();
  await putSettings(env, { fpmFormula: "linear" });

  const settings = await getAllSettings(env);
  assert.equal(settings.windowMonths, undefined); // corrupt row skipped
  assert.equal(settings.fpmFormula, "linear"); // the healthy row is unaffected
});
