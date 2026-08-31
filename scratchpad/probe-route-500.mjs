// Increment 10 probe 3: Route A sizing. 500 real catalog rows through `claude -p`.
// Same rubric (verbatim), same 25-row batching, same guard. Measures wall-clock,
// per-batch cost, and whether plan limits bite over a sustained run.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const SP = new URL(".", import.meta.url).pathname;
const sample = JSON.parse(fs.readFileSync(SP + "route-sample-500.json", "utf8"));
const outPath = SP + "route-scored-500.json";
const timingPath = SP + "route-timing-500.json";
const scored = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
const timing = fs.existsSync(timingPath) ? JSON.parse(fs.readFileSync(timingPath, "utf8")) : [];

const RUBRIC = `You are scoring video games for a catalogue tool aimed at adults with more
games than hours.

experience_score (0-100): how much great, COMPLETE experience you get per hour you put in.

Punish two things hard:
1. NO ENDING. Infinite skill ladders and live-service treadmills (MOBAs, competitive
   shooters, endless survival) are not experiences. Score them low no matter how fun a
   single match is. Ignore any "hours to beat" figure given for such a game - it is
   meaningless for an endless game.
2. SLOW TO GET GOOD. If it takes tens of hours before the game becomes fun, that is cost.

Reward: authored, finite, high quality, no padding, and short enough that a busy adult
actually finishes it. A long game can still score well if every hour is good and it ends,
but it loses to an equally good short one.

Calibration anchors, match this scale exactly:
Portal 98, Celeste 96, INSIDE 93, Hades 85, Stardew Valley 60,
Red Dead Redemption 2 45, Baldur's Gate 3 40, Rocket League 25,
Team Fortress 2 15, Rust 10.

Also return, judged by you, not copied from the input:
- has_ending: true if the game concludes, false if it is endless.
- hours_to_value: honest hours to get the game's worth. Use null if endless.
- hours_to_good: hours before it becomes fun for a newcomer.
- reason: AT MOST 15 words. Concrete.
- confidence: low if you do not actually recognise the game. Do not bluff.

Score EVERY appid given. Never omit one. Never invent an appid.

Output ONLY a JSON array, no prose, no code fence:
[{"appid":123,"experience_score":0-100,"has_ending":true,"hours_to_value":8,"hours_to_good":1,"reason":"...","confidence":"low|medium|high"}]`;

const BATCH = 25;
const pending = sample.filter((g) => !scored[g.appid]);
const allowed = new Set(sample.map((g) => g.appid));
let failedBatches = 0, ghosts = 0;
const ghostIds = [];

const parseArray = (txt) => {
  const s = txt.indexOf("["), e = txt.lastIndexOf("]");
  if (s === -1 || e === -1) throw new Error("no JSON array in reply");
  return JSON.parse(txt.slice(s, e + 1));
};

// The `claude -p` envelope reports modelUsage for EVERY model the session
// touched, including the small side-task model. The scorer is the entry that
// actually emitted the answer, i.e. the one with the most output tokens.
const scoringModel = (envelope) => {
  const usage = envelope?.modelUsage;
  if (!usage) return null;
  let best = null, bestOut = -1;
  for (const [id, u] of Object.entries(usage)) {
    const out = Number(u?.outputTokens) || 0;
    if (out > bestOut) { bestOut = out; best = id; }
  }
  return best;
};

console.error(`pending: ${pending.length} of ${sample.length}`);
const runStart = Date.now();

for (let i = 0; i < pending.length; i += BATCH) {
  const chunk = pending.slice(i, i + BATCH);
  const lines = chunk.map((g) => {
    const t = Object.keys(JSON.parse(g.tags || "{}")).slice(0, 12).join(", ") || "(no tags)";
    const hrs = g.main_hours === null ? "unknown" : `HLTB says ${g.main_hours}h to beat (may be meaningless)`;
    return `appid ${g.appid} | ${g.name} | ${g.reviews} reviews | quality ${g.wilson} | ${hrs} | tags: ${t}`;
  }).join("\n");

  const n = i / BATCH + 1;
  const t0 = Date.now();
  try {
    const { stdout } = await run("claude", [
      "-p", `${RUBRIC}\n\nScore these ${chunk.length} games:\n\n${lines}`,
      "--output-format", "json", "--model", "opus",
    ], { cwd: SP, maxBuffer: 40 * 1024 * 1024, timeout: 600000 });

    const envelope = JSON.parse(stdout);
    const rows = parseArray(envelope.result);
    let kept = 0;
    for (const r of rows) {
      if (!r || typeof r.appid !== "number") continue;
      if (!allowed.has(r.appid)) { ghosts++; ghostIds.push(r.appid); continue; }
      scored[r.appid] = r;
      kept++;
    }
    const ms = Date.now() - t0;
    timing.push({ batch: n, size: chunk.length, ms, returned: rows.length, kept,
      model: scoringModel(envelope), usd: envelope.total_cost_usd ?? null,
      elapsedMin: +((Date.now() - runStart) / 60000).toFixed(1) });
    fs.writeFileSync(outPath, JSON.stringify(scored, null, 1));
    fs.writeFileSync(timingPath, JSON.stringify(timing, null, 1));
    console.error(`batch ${n}: ${(ms/1000).toFixed(1)}s -> ${Object.keys(scored).length}/${sample.length} (ghosts ${ghosts})`);
  } catch (e) {
    failedBatches++;
    const ms = Date.now() - t0;
    const msg = String(e.stderr || e.message).slice(0, 400);
    timing.push({ batch: n, size: chunk.length, ms, error: msg,
      elapsedMin: +((Date.now() - runStart) / 60000).toFixed(1) });
    fs.writeFileSync(timingPath, JSON.stringify(timing, null, 1));
    console.error(`batch ${n} FAILED after ${(ms/1000).toFixed(1)}s: ${msg}`);
  }
}
console.log(JSON.stringify({ scored: Object.keys(scored).length, of: sample.length, failedBatches,
  ghostsDropped: ghosts, ghostIds, totalMin: +((Date.now()-runStart)/60000).toFixed(1) }));
