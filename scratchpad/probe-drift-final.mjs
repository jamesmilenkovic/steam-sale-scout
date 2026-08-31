// Increment 10 FINAL gate-(d) proof. Uses the SHIPPED buildExperiencePrompt from
// src/catalog.js (not a probe-local line builder), driven through the real hardened
// tools/claude-bridge.mjs over HTTP. This covers the rows oneLine() changes:
// whitespace collapse (3 of 300) and the `|` escape (1 of 300).
import fs from "node:fs";
import { buildExperiencePrompt, parseExperienceArray } from "/Users/jamesmilenkovic/code/steam-sale-scout/src/catalog.js";

const SP = new URL(".", import.meta.url).pathname;
const REF = "/Users/jamesmilenkovic/Library/Mobile Documents/com~apple~CloudDocs/AI/projects/personal-projects/steam-sale-scout/slice-0-reference/";
const sample = JSON.parse(fs.readFileSync(REF + "sample-300-games.json", "utf8"));
const d1 = JSON.parse(fs.readFileSync(SP + "d1-tags-300.json", "utf8"));
const tagsById = Object.fromEntries(d1.map((r) => [r.appid, r.tags]));

const BRIDGE = process.env.BRIDGE_URL, TOKEN = process.env.BRIDGE_TOKEN;
const outPath = SP + "final-scored-300.json", timingPath = SP + "final-timing-300.json";
const scored = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
const timing = fs.existsSync(timingPath) ? JSON.parse(fs.readFileSync(timingPath, "utf8")) : [];

// Shape the fixture rows the way selectExperienceBatch hands them to the prompt builder.
const rowsFor = (g) => ({
  appid: g.appid, name: g.name, reviews: g.reviews, wilson: g.wilson,
  main_hours: g.main_hours, tags: tagsById[g.appid] ?? "{}",
});

const BATCH = 25;
const pending = sample.filter((g) => !scored[g.appid]);
const allowed = new Set(sample.map((g) => g.appid));
let failedBatches = 0, ghosts = 0; const ghostIds = [];
const scoringModel = (e) => {
  const u = e?.modelUsage; if (!u) return null;
  let b = null, bo = -1;
  for (const [id, v] of Object.entries(u)) { const o = Number(v?.outputTokens) || 0; if (o > bo) { bo = o; b = id; } }
  return b;
};

console.error(`pending ${pending.length} via ${BRIDGE} (shipped buildExperiencePrompt)`);
for (let i = 0; i < pending.length; i += BATCH) {
  const chunk = pending.slice(i, i + BATCH).map(rowsFor);
  const n = i / BATCH + 1, t0 = Date.now();
  try {
    const res = await fetch(`${BRIDGE}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": TOKEN },
      body: JSON.stringify({ prompt: buildExperiencePrompt(chunk), model: "opus" }),
      signal: AbortSignal.timeout(660000),
    });
    if (!res.ok) throw new Error(`bridge ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const env = await res.json();
    const rows = parseExperienceArray(env.result);
    let kept = 0;
    for (const r of rows) {
      if (!r || typeof r.appid !== "number") continue;
      if (!allowed.has(r.appid)) { ghosts++; ghostIds.push(r.appid); continue; }
      scored[r.appid] = r; kept++;
    }
    const ms = Date.now() - t0;
    timing.push({ batch: n, ms, returned: rows.length, kept, model: scoringModel(env), numTurns: env.num_turns ?? null });
    fs.writeFileSync(outPath, JSON.stringify(scored, null, 1));
    fs.writeFileSync(timingPath, JSON.stringify(timing, null, 1));
    console.error(`batch ${n}: ${(ms / 1000).toFixed(1)}s -> ${Object.keys(scored).length}/300 (ghosts ${ghosts})`);
  } catch (e) {
    failedBatches++;
    timing.push({ batch: n, ms: Date.now() - t0, error: String(e.message).slice(0, 300) });
    fs.writeFileSync(timingPath, JSON.stringify(timing, null, 1));
    console.error(`batch ${n} FAILED: ${String(e.message).slice(0, 300)}`);
  }
}
console.log(JSON.stringify({ scored: Object.keys(scored).length, of: 300, failedBatches, ghostsDropped: ghosts, ghostIds }));
