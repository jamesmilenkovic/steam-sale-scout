// Increment 9, SPEC.md §7 Output 1 – the Coverage sheet: tags % plus the full funnel,
// read straight from the live D1. Read-only. Mirrors the schema-eyeball workbook's
// Coverage sheet, refreshed for the tag columns.
import { DatabaseSync } from "node:sqlite";

const DB = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/8f3a99cfb0212e3af76d2e201182230de601b1c6bbd989a83ec1df1bf841a86b.sqlite";
const db = new DatabaseSync(DB, { readOnly: true });

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + "%" : "-");

const s = db
  .prepare(
    `SELECT COUNT(*) total,
       SUM(CASE WHEN tags_checked_at IS NOT NULL AND tags IS NOT NULL THEN 1 ELSE 0 END) tagged,
       SUM(CASE WHEN tags_checked_at IS NOT NULL AND tags IS NULL THEN 1 ELSE 0 END) empty,
       SUM(CASE WHEN tags_checked_at IS NULL THEN 1 ELSE 0 END) pending,
       SUM(CASE WHEN tags_source='kv' THEN 1 ELSE 0 END) kv,
       SUM(CASE WHEN tags_source='live' THEN 1 ELSE 0 END) live,
       SUM(CASE WHEN main_hours IS NOT NULL THEN 1 ELSE 0 END) hltbMatched,
       SUM(CASE WHEN app_type IS NOT NULL THEN 1 ELSE 0 END) classified,
       SUM(CASE WHEN app_type='game' THEN 1 ELSE 0 END) games,
       SUM(CASE WHEN price_checked_at IS NOT NULL THEN 1 ELSE 0 END) priceChecked,
       SUM(source_owned) owned, SUM(source_deal) deal
     FROM fpm_catalog`,
  )
  .get();

console.log("## Coverage sheet – tag backfill (Increment 9)\n");
console.log("### The funnel SPEC.md gate (c) asks for\n");
console.log("| leg | count | % of catalog |");
console.log("|---|---|---|");
console.log(`| **tagged** | ${s.tagged} | ${pct(s.tagged, s.total)} |`);
console.log(`| ...of which **kv_seeded** (free, zero SteamSpy requests) | ${s.kv} | ${pct(s.kv, s.total)} |`);
console.log(`| ...of which **live-fetched** | ${s.live} | ${pct(s.live, s.total)} |`);
console.log(`| **empty** (checked, SteamSpy genuinely has no tags) | ${s.empty} | ${pct(s.empty, s.total)} |`);
console.log(`| **pending** (never checked) | ${s.pending} | ${pct(s.pending, s.total)} |`);
console.log(`| **catalog total** | ${s.total} | 100% |`);

const part = s.tagged + s.empty + s.pending;
console.log(`\n**Partition check (gate c):** tagged + empty + pending = ${part} ` + (part === s.total ? `= total. **Adds up.**` : `!= total ${s.total}. **MISMATCH.**`));
const src = s.kv + s.live;
console.log(`**Source check:** kv + live = ${src} vs tagged + empty = ${s.tagged + s.empty}. ` + (src === s.tagged + s.empty ? "**Every concluded row carries a source.**" : "**MISMATCH.**"));

console.log("\n### Tag coverage against the rows that actually matter\n");
const gameStats = db
  .prepare(
    `SELECT COUNT(*) n, SUM(CASE WHEN tags IS NOT NULL THEN 1 ELSE 0 END) t FROM fpm_catalog WHERE app_type='game'`,
  )
  .get();
const ownedStats = db
  .prepare(`SELECT COUNT(*) n, SUM(CASE WHEN tags IS NOT NULL THEN 1 ELSE 0 END) t FROM fpm_catalog WHERE source_owned=1`)
  .get();
const dealStats = db
  .prepare(`SELECT COUNT(*) n, SUM(CASE WHEN tags IS NOT NULL THEN 1 ELSE 0 END) t FROM fpm_catalog WHERE source_deal=1`)
  .get();
console.log("| row class | rows | tagged | coverage |");
console.log("|---|---|---|---|");
console.log(`| whole catalog | ${s.total} | ${s.tagged} | ${pct(s.tagged, s.total)} |`);
console.log(`| app_type='game' | ${gameStats.n} | ${gameStats.t} | ${pct(gameStats.t, gameStats.n)} |`);
console.log(`| owned (source_owned=1) | ${ownedStats.n} | ${ownedStats.t} | ${pct(ownedStats.t, ownedStats.n)} |`);
console.log(`| on sale (source_deal=1) | ${dealStats.n} | ${dealStats.t} | ${pct(dealStats.t, dealStats.n)} |`);

console.log("\n### The other lanes, for context (unchanged by this increment)\n");
console.log("| column | filled | % |");
console.log("|---|---|---|");
console.log(`| main_hours (HLTB) | ${s.hltbMatched} | ${pct(s.hltbMatched, s.total)} |`);
console.log(`| app_type | ${s.classified} | ${pct(s.classified, s.total)} |`);
console.log(`| price_checked_at | ${s.priceChecked} | ${pct(s.priceChecked, s.total)} |`);

const sizes = db.prepare(`SELECT AVG(LENGTH(tags)) avg, MAX(LENGTH(tags)) max, SUM(LENGTH(tags)) total FROM fpm_catalog WHERE tags IS NOT NULL`).get();
console.log(`\n### Storage\n`);
console.log(`Average tags JSON: ${Math.round(sizes.avg || 0)} bytes · largest: ${sizes.max || 0} · total: ${((sizes.total || 0) / 1048576).toFixed(1)} MB`);
