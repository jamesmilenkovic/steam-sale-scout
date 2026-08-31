// Increment 10 probe 1 analysis: diff the new run against the slice-0 fixture.
import fs from "node:fs";
const SP = new URL(".", import.meta.url).pathname;
const REF = "/Users/jamesmilenkovic/Library/Mobile Documents/com~apple~CloudDocs/AI/projects/personal-projects/steam-sale-scout/slice-0-reference/";
const sample = JSON.parse(fs.readFileSync(REF + "sample-300-games.json", "utf8"));
const fixture = JSON.parse(fs.readFileSync(REF + "scored-v2-300-games.json", "utf8"));
const fresh = JSON.parse(fs.readFileSync(SP + "probe-scored-300.json", "utf8"));
const timing = JSON.parse(fs.readFileSync(SP + "probe-timing-300.json", "utf8"));
const byId = Object.fromEntries(sample.map((g) => [g.appid, g]));

const ids = Object.keys(fixture).filter((id) => fresh[id]);
const rows = ids.map((id) => {
  const a = fixture[id], b = fresh[id];
  return {
    appid: +id, name: byId[id]?.name ?? "?",
    old: a.experience_score, neu: b.experience_score, delta: b.experience_score - a.experience_score,
    oldEnd: a.has_ending, newEnd: b.has_ending,
    oldReason: a.reason, newReason: b.reason,
    oldConf: a.confidence, newConf: b.confidence,
    oldHtv: a.hours_to_value, newHtv: b.hours_to_value,
  };
});

const abs = rows.map((r) => Math.abs(r.delta)).sort((x, y) => x - y);
const pct = (p) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
const mean = abs.reduce((s, v) => s + v, 0) / abs.length;
const endingFlips = rows.filter((r) => r.oldEnd !== r.newEnd);

// Rank correlation (Spearman) on the shared set.
const rank = (key) => { const s=[...rows].sort((a,b)=>b[key]-a[key]); const m={}; s.forEach((r,i)=>m[r.appid]=i+1); return m; };
const ro = rank("old"), rn = rank("neu");
const n = rows.length;
const d2 = rows.reduce((s, r) => s + (ro[r.appid]-rn[r.appid])**2, 0);
const spearman = 1 - (6*d2)/(n*(n*n-1));

const worst = [...rows].sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
const F = (r) => `| ${r.name} | ${r.old} | ${r.neu} | ${r.delta>0?"+":""}${r.delta} | ${r.oldEnd?"ends":"endless"} → ${r.newEnd?"ends":"endless"} | ${r.oldReason} | ${r.newReason} |`;
const H = "| Game | slice-0 | now | Δ | ending | slice-0 reason | new reason |\n|---|--:|--:|--:|:-:|---|---|";

const anchorNames = ["Portal","Portal 2","Celeste","INSIDE","Journey","Hades","Baldur's Gate 3","Red Dead Redemption 2","Rocket League","Team Fortress 2","Rust","Stardew Valley"];
const anchors = anchorNames.map(nm => rows.find(r=>r.name===nm)).filter(Boolean);

const ok = timing.filter(t=>!t.error);
const wall = ok.reduce((s,t)=>s+t.ms,0);
const usd = ok.reduce((s,t)=>s+(t.usd||0),0);

console.log(`# Probe 1 – prompt-drift regression (300 slice-0 games)

Compared: ${n} of 300. Batches: ${timing.length} (${timing.length-ok.length} failed).
Wall-clock: ${(wall/1000/60).toFixed(1)} min. Mean batch: ${(wall/ok.length/1000).toFixed(1)}s.
CLI-reported list cost: $${usd.toFixed(2)} (plan route: $0 cash).

## Drift summary
- Mean |Δ|: **${mean.toFixed(1)}** points
- Median |Δ|: **${pct(0.5)}** | p90: **${pct(0.9)}** | max: **${abs[abs.length-1]}**
- Within ±5: ${rows.filter(r=>Math.abs(r.delta)<=5).length}/${n} (${(100*rows.filter(r=>Math.abs(r.delta)<=5).length/n).toFixed(0)}%)
- Within ±10: ${rows.filter(r=>Math.abs(r.delta)<=10).length}/${n} (${(100*rows.filter(r=>Math.abs(r.delta)<=10).length/n).toFixed(0)}%)
- Spearman rank correlation: **${spearman.toFixed(3)}**
- has_ending flips: **${endingFlips.length}**
- Endless count: slice-0 ${rows.filter(r=>!r.oldEnd).length} → now ${rows.filter(r=>!r.newEnd).length}
- low confidence: slice-0 ${rows.filter(r=>r.oldConf==="low").length} → now ${rows.filter(r=>r.newConf==="low").length}

## Anchors (the eye test)
${H}
${anchors.map(F).join("\n")}

## 15 biggest disagreements
${H}
${worst.slice(0,15).map(F).join("\n")}

## has_ending flips (${endingFlips.length})
${H}
${endingFlips.map(F).join("\n")}
`);
