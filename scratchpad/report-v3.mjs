// Increment 10.5 gates d1 / d2 / d3 plus the eye test, from the v3 probe.
import fs from "node:fs";
import { experienceFpm } from "/Users/jamesmilenkovic/code/steam-sale-scout/src/catalog.js";
const SP = new URL(".", import.meta.url).pathname;
const REF = "/Users/jamesmilenkovic/Library/Mobile Documents/com~apple~CloudDocs/AI/projects/personal-projects/steam-sale-scout/slice-0-reference/";
const sample = JSON.parse(fs.readFileSync(REF + "sample-300-games.json", "utf8"));
const fixture = JSON.parse(fs.readFileSync(REF + "scored-v2-300-games.json", "utf8"));
const v3 = JSON.parse(fs.readFileSync(SP + "v3-scored-300.json", "utf8"));
const byId = Object.fromEntries(sample.map((g) => [g.appid, g]));

const rows = Object.values(v3).map((r) => ({
  ...r, name: byId[r.appid]?.name ?? "?", reviews: byId[r.appid]?.reviews,
  fpm: experienceFpm({ has_ending: r.has_ending ? 1 : 0, game_score: r.game_score, hours_to_value: r.hours_to_value }),
}));

// ---- gate d1: non-disturbance of experience_score ----
const paired = rows.filter((r) => fixture[r.appid]);
const rank = (arr, k) => { const s = [...arr].sort((a, b) => b[k] - a[k]); const m = {}; s.forEach((r, i) => m[r.appid] = i + 1); return m; };
const withOld = paired.map((r) => ({ ...r, old: fixture[r.appid].experience_score }));
const rn = rank(withOld, "experience_score"), ro = rank(withOld, "old");
const n = withOld.length;
const d2sum = withOld.reduce((s, r) => s + (ro[r.appid] - rn[r.appid]) ** 2, 0);
const spearman = 1 - (6 * d2sum) / (n * (n * n - 1));
const ANCHORS = { Portal: 98, Celeste: 96, INSIDE: 93, Hades: 85, "Stardew Valley": 60,
  "Red Dead Redemption 2": 45, "Baldur's Gate 3": 40, "Rocket League": 25, "Team Fortress 2": 15, Rust: 10 };
const anchorRows = Object.entries(ANCHORS).map(([nm, want]) => {
  const r = rows.find((x) => x.name === nm); return r ? { nm, want, got: r.experience_score, gs: r.game_score, d: r.experience_score - want } : null;
}).filter(Boolean);
const anchorsOk = anchorRows.every((a) => Math.abs(a.d) <= 5);

// ---- gate d3: range health of game_score ----
const gs = rows.map((r) => r.game_score).filter((v) => typeof v === "number");
const span = Math.max(...gs) - Math.min(...gs);
const bands = {};
for (const v of gs) { const b = Math.floor(v / 10) * 10; bands[b] = (bands[b] || 0) + 1; }
const worstBand = Object.entries(bands).sort((a, b) => b[1] - a[1])[0];
const worstPct = 100 * worstBand[1] / gs.length;

console.log(`# Increment 10.5 – rubric v3 results (300-game probe, production path)

## Gate d1 – non-disturbance of \`experience_score\` (needs Spearman >= 0.95, anchors within +/-5)
- Spearman vs the slice-0 fixture: **${spearman.toFixed(3)}** ${spearman >= 0.95 ? "PASS" : "**FAIL**"}
- Anchors within +/-5: ${anchorsOk ? "**PASS**" : "**FAIL**"}

| anchor | want | got | delta | game_score |
|---|--:|--:|--:|--:|
${anchorRows.map((a) => `| ${a.nm} | ${a.want} | ${a.got} | ${a.d > 0 ? "+" : ""}${a.d} | ${a.gs} |`).join("\n")}

## Gate d3 – \`game_score\` range health (needs span >= 55, no 10-pt band > 40%)
- Span: **${span}** (${Math.min(...gs)}–${Math.max(...gs)}) ${span >= 55 ? "PASS" : "**FAIL**"}
- Densest band: ${worstBand[0]}–${+worstBand[0] + 9} holds ${worstBand[1]}/${gs.length} = **${worstPct.toFixed(0)}%** ${worstPct <= 40 ? "PASS" : "**FAIL**"}
- Distribution: ${Object.keys(bands).sort((a, b) => a - b).map((b) => `${b}s:${bands[b]}`).join("  ")}

## The new ranking – top 30 by FUN PER MINUTE (endless excluded by construction)
| # | FPM | game | quality | exp | hrs | ends? |
|--:|--:|---|--:|--:|--:|:-:|
${rows.filter((r) => r.fpm != null).sort((a, b) => b.fpm - a.fpm).slice(0, 30)
  .map((r, i) => `| ${i + 1} | **${r.fpm.toFixed(1)}** | ${r.name} | ${r.game_score} | ${r.experience_score} | ${r.hours_to_value} | ends |`).join("\n")}

## The games you challenged – where they land now
| game | quality | exp | hrs | FPM | FPM rank |
|---|--:|--:|--:|--:|--:|
${(() => {
  const sorted = rows.filter((r) => r.fpm != null).sort((a, b) => b.fpm - a.fpm);
  const pos = {}; sorted.forEach((r, i) => pos[r.appid] = i + 1);
  return ["Sekiro: Shadows Die Twice - GOTY Edition", "Hollow Knight", "Disco Elysium - The Final Cut", "Outer Wilds", "Portal", "Hades", "Baldur's Gate 3", "Red Dead Redemption 2", "Rocket League"]
    .map((nm) => rows.find((r) => r.name === nm)).filter(Boolean)
    .map((r) => `| ${r.name} | ${r.game_score} | ${r.experience_score} | ${r.hours_to_value ?? "endless"} | ${r.fpm == null ? "– (endless)" : r.fpm.toFixed(1)} | ${pos[r.appid] ?? "–"} |`).join("\n");
})()}

## Highest quality games that FPM correctly demotes
| game | quality | hrs | FPM |
|---|--:|--:|--:|
${rows.filter((r) => r.fpm != null && r.game_score >= 90).sort((a, b) => a.fpm - b.fpm).slice(0, 10)
  .map((r) => `| ${r.name} | ${r.game_score} | ${r.hours_to_value} | ${r.fpm.toFixed(1)} |`).join("\n")}
`);
