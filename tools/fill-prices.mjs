#!/usr/bin/env node
// Steam Sale Scout - the increment 13 price-state fill.
//
// Runs the SAME production code the app runs (src/catalog.js's
// selectPriceStateBatch / resolvePriceStateBatch and src/storePrices.js's
// classifier) against the local D1 that `wrangler dev` uses, through
// miniflare - so this is not a parallel implementation that could drift from
// the one under test. It is a driver, not a second fill.
//
// STOP `wrangler dev` BEFORE RUNNING. Two processes holding the same local D1
// state directory is asking for a locking problem, and the fill is minutes.
//
// Resumable by construction: the cursor is `price_state IS NULL`, every row is
// written through the moment it is decided, and nothing in a chunk that was
// never fetched has been stamped. Kill it whenever you like and run it again.
//
//   node tools/fill-prices.mjs                # run to completion
//   node tools/fill-prices.mjs --max-rows 500 # stop after ~500 rows
//   node tools/fill-prices.mjs --dry-run      # show what is left, write nothing

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { selectPriceStateBatch, resolvePriceStateBatch, FPM_PRICE_STATE_BATCH } from "../src/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const maxRows = flag("--max-rows", Infinity);
const dryRun = args.includes("--dry-run");

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } };",
  d1Databases: { FPM_DB: "local-dev-fpm-catalog-placeholder" },
  // wrangler's --persist-to points at .wrangler/state; miniflare's own
  // d1Persist points one level deeper, at the d1 store inside it.
  d1Persist: path.join(ROOT, ".wrangler", "state", "v3", "d1"),
});
const env = { FPM_DB: await mf.getD1Database("FPM_DB") };

const remaining = async () =>
  (await env.FPM_DB.prepare("SELECT COUNT(*) AS n FROM fpm_catalog WHERE price_state IS NULL").all())
    .results[0].n;

const startLeft = await remaining();
console.log(`rows with no price_state: ${startLeft.toLocaleString("en-AU")}`);
if (dryRun || startLeft === 0) {
  await mf.dispose();
  process.exit(0);
}

const total = { attempted: 0, priced: 0, free: 0, delisted: 0, region: 0, unknown: 0, gaveUp: 0 };
const startedAt = Date.now();
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\n  interrupt received - finishing the row in flight, then stopping");
});

while (!stopping && total.attempted < maxRows) {
  const batch = await selectPriceStateBatch(env, { limit: FPM_PRICE_STATE_BATCH });
  if (batch.length === 0) break;

  const slice = Number.isFinite(maxRows) ? batch.slice(0, maxRows - total.attempted) : batch;
  const tally = await resolvePriceStateBatch(env, slice);
  for (const k of Object.keys(total)) total[k] += tally[k];

  const secs = (Date.now() - startedAt) / 1000;
  const rate = total.attempted / Math.max(secs, 0.001);
  const left = await remaining();
  console.log(
    `  ${total.attempted.toLocaleString("en-AU")} done · ${left.toLocaleString("en-AU")} left · ` +
      `${rate.toFixed(0)} rows/s · eta ${(left / Math.max(rate, 0.001) / 60).toFixed(1)} min · ` +
      `priced ${total.priced} free ${total.free} delisted ${total.delisted} region ${total.region} unknown ${total.unknown}`,
  );
  if (tally.gaveUp > 0) {
    console.log("  gave up after consecutive bad responses - rerun to resume, nothing is lost");
    break;
  }
}

const elapsed = (Date.now() - startedAt) / 1000;
console.log(`\nfinished ${total.attempted.toLocaleString("en-AU")} rows in ${(elapsed / 60).toFixed(1)} min`);
console.log(JSON.stringify(total, null, 2));
console.log(`rows still with no price_state: ${(await remaining()).toLocaleString("en-AU")}`);
await mf.dispose();
