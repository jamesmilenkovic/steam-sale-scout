// Increment 9, SPEC.md §7 Output 2 – the 10-row spot-check, read straight from the
// live D1 catalog. Read-only. Run once the tag fill has finished.
//
// The ten games are James's own list from SPEC.md §7. Note A Castle Full of Cats is
// appid 2070550 – the increment-9 probe originally fetched 1969360 by mistake, which
// is an unknown appid, not that game (see 01-probe-findings.md, CORRECTION 2).
import { DatabaseSync } from "node:sqlite";

const DB = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/8f3a99cfb0212e3af76d2e201182230de601b1c6bbd989a83ec1df1bf841a86b.sqlite";

const GAMES = [
  [504230, "Celeste"],
  [1145360, "Hades"],
  [646570, "Slay the Spire"],
  [2379780, "Balatro"],
  [413150, "Stardew Valley"],
  [105600, "Terraria"],
  [292030, "The Witcher 3: Wild Hunt"],
  [1794680, "Vampire Survivors"],
  [2070550, "A Castle Full of Cats"],
  [227300, "Euro Truck Simulator 2"],
];

const db = new DatabaseSync(DB, { readOnly: true });

const stats = db
  .prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN tags_checked_at IS NOT NULL AND tags IS NOT NULL THEN 1 ELSE 0 END) tagged,
            SUM(CASE WHEN tags_checked_at IS NOT NULL AND tags IS NULL THEN 1 ELSE 0 END) empty,
            SUM(CASE WHEN tags_checked_at IS NULL THEN 1 ELSE 0 END) pending,
            SUM(CASE WHEN tags_source = 'kv' THEN 1 ELSE 0 END) kvSeeded,
            SUM(CASE WHEN tags_source = 'live' THEN 1 ELSE 0 END) live
     FROM fpm_catalog`,
  )
  .get();

console.log("## Funnel, straight from D1\n");
console.log(`| leg | count |`);
console.log(`|---|---|`);
for (const [k, v] of Object.entries(stats)) console.log(`| ${k} | ${v} |`);
const sums = stats.tagged + stats.empty + stats.pending;
console.log(`\npartition check: tagged + empty + pending = ${sums} ${sums === stats.total ? "=== total OK" : "!== total " + stats.total + " MISMATCH"}`);
console.log(`source check:    kv + live = ${stats.kvSeeded + stats.live} vs tagged+empty = ${stats.tagged + stats.empty}`);

console.log("\n## Spot-check: top 8 tags by votes, per game\n");
console.log("| appid | game | source | top 8 tags (votes) |");
console.log("|---|---|---|---|");
for (const [appid, label] of GAMES) {
  const row = db.prepare("SELECT name, tags, tags_source, tags_checked_at FROM fpm_catalog WHERE appid = ?").get(appid);
  if (!row) {
    console.log(`| ${appid} | ${label} | **NO CATALOG ROW** | - |`);
    continue;
  }
  if (row.tags_checked_at == null) {
    console.log(`| ${appid} | ${row.name} | not yet checked | - |`);
    continue;
  }
  if (row.tags == null) {
    console.log(`| ${appid} | ${row.name} | ${row.tags_source} | **(checked, genuinely no tags)** |`);
    continue;
  }
  const top = Object.entries(JSON.parse(row.tags))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t, v]) => `${t} ${v}`)
    .join(", ");
  console.log(`| ${appid} | ${row.name} | ${row.tags_source} | ${top} |`);
}
