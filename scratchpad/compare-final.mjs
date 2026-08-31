// Compares the hardened-bridge re-probe against BOTH the slice-0 fixture (gate d)
// and the round-1 probe (isolates the effect of the CLI invocation change).
import fs from "node:fs";
const SP = new URL(".", import.meta.url).pathname;
const REF = "/Users/jamesmilenkovic/Library/Mobile Documents/com~apple~CloudDocs/AI/projects/personal-projects/steam-sale-scout/slice-0-reference/";
const sample = JSON.parse(fs.readFileSync(REF + "sample-300-games.json", "utf8"));
const fixture = JSON.parse(fs.readFileSync(REF + "scored-v2-300-games.json", "utf8"));
const hard = JSON.parse(fs.readFileSync(SP + "final-scored-300.json", "utf8"));
const soft = JSON.parse(fs.readFileSync(SP + "hardened-scored-300.json", "utf8"));
const timing = JSON.parse(fs.readFileSync(SP + "final-timing-300.json", "utf8"));
const byId = Object.fromEntries(sample.map((g) => [g.appid, g]));

function stats(a, b, label) {
  const ids = Object.keys(a).filter((id) => b[id]);
  const rows = ids.map((id) => ({
    appid: +id, name: byId[id]?.name ?? "?",
    old: a[id].experience_score, neu: b[id].experience_score,
    delta: b[id].experience_score - a[id].experience_score,
    oldEnd: a[id].has_ending, newEnd: b[id].has_ending,
    oldReason: a[id].reason, newReason: b[id].reason,
  }));
  const abs = rows.map((r) => Math.abs(r.delta)).sort((x, y) => x - y);
  const p = (q) => abs[Math.min(abs.length - 1, Math.floor(abs.length * q))];
  const rank = (k) => { const s = [...rows].sort((x, y) => y[k] - x[k]); const m = {}; s.forEach((r, i) => m[r.appid] = i + 1); return m; };
  const ro = rank("old"), rn = rank("neu"), n = rows.length;
  const d2 = rows.reduce((s, r) => s + (ro[r.appid] - rn[r.appid]) ** 2, 0);
  return { label, n, rows,
    mean: abs.reduce((s, v) => s + v, 0) / abs.length,
    med: p(0.5), p90: p(0.9), max: abs[abs.length - 1],
    w5: rows.filter((r) => Math.abs(r.delta) <= 5).length,
    w10: rows.filter((r) => Math.abs(r.delta) <= 10).length,
    spearman: 1 - (6 * d2) / (n * (n * n - 1)),
    flips: rows.filter((r) => r.oldEnd !== r.newEnd).length };
}

const vsFixture = stats(fixture, hard, "hardened vs slice-0 fixture (GATE D)");
const vsRound1 = stats(soft, hard, "hardened vs round-1 probe (invocation change only)");

const F = (r) => `| ${r.name} | ${r.old} | ${r.neu} | ${r.delta > 0 ? "+" : ""}${r.delta} | ${r.oldEnd ? "ends" : "endless"} → ${r.newEnd ? "ends" : "endless"} | ${r.oldReason} | ${r.newReason} |`;
const H = "| Game | before | after | Δ | ending | reason before | reason after |\n|---|--:|--:|--:|:-:|---|---|";
const S = (s) => `- Spearman **${s.spearman.toFixed(3)}** · mean |Δ| **${s.mean.toFixed(1)}** · median ${s.med} · p90 ${s.p90} · max ${s.max}
- Within ±5: ${s.w5}/${s.n} (${(100 * s.w5 / s.n).toFixed(0)}%) · within ±10: ${s.w10}/${s.n} (${(100 * s.w10 / s.n).toFixed(0)}%)
- has_ending flips: ${s.flips}`;

const anchorNames = ["Portal", "Portal 2", "INSIDE", "Journey", "Hades", "Baldur's Gate 3", "Red Dead Redemption 2", "Rocket League", "Team Fortress 2", "Rust", "Stardew Valley"];
const anchors = anchorNames.map((n) => vsFixture.rows.find((r) => r.name === n)).filter(Boolean);
const worst = [...vsFixture.rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
const ok = timing.filter((t) => !t.error);

console.log(`# Gate (d) re-proof – drift regression through the HARDENED bridge

Round-2 security fixes changed the CLI invocation to
\`claude -p --output-format json --model opus --tools "" --max-turns 1 -- <prompt>\`
with an explicit cwd and a minimal env. That invalidated the round-1 drift evidence, so
the 300-game regression was re-run **through the real \`tools/claude-bridge.mjs\` over
HTTP**, exactly the path the Worker uses. This is the fill path, not an approximation.

Batches: ${timing.length} (${timing.length - ok.length} failed). Wall-clock ${(ok.reduce((s, t) => s + t.ms, 0) / 60000).toFixed(1)} min, mean ${(ok.reduce((s, t) => s + t.ms, 0) / ok.length / 1000).toFixed(1)}s/batch.
Model: ${ok[0]?.model}. num_turns: ${[...new Set(ok.map((t) => t.numTurns))].join(",")} (confirms \`--max-turns 1\` and no tool loop).

## 1. ${vsFixture.label}
${S(vsFixture)}

### Anchors
${H}
${anchors.map(F).join("\n")}

### 10 biggest disagreements vs the fixture
${H}
${worst.slice(0, 10).map(F).join("\n")}

## 2. ${vsRound1.label}
Same rubric, same tags, same model – only the CLI invocation differs. This isolates
whether hardening moved the scores.
${S(vsRound1)}

### 10 biggest movers caused by the invocation change
${H}
${[...vsRound1.rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10).map(F).join("\n")}
`);
