// Increment 10 probe 1: prompt-drift regression against the slice-0 fixture.
// Rubric copied VERBATIM from slice-0-reference/score-v2.mjs. Do not reword.
// Difference vs slice 0: tags come from D1 (increment 9) instead of a live fetch.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const SP = new URL(".", import.meta.url).pathname;
const REF = "/Users/jamesmilenkovic/Library/Mobile Documents/com~apple~CloudDocs/AI/projects/personal-projects/steam-sale-scout/slice-0-reference/";
const sample = JSON.parse(fs.readFileSync(REF + "sample-300-games.json", "utf8"));
const d1rows = JSON.parse(fs.readFileSync(SP + "d1-tags-300.json", "utf8"));
const tags = Object.fromEntries(d1rows.map((r) => [r.appid, Object.keys(JSON.parse(r.tags || "{}"))]));

const outPath = SP + "probe-scored-300.json";
const timingPath = SP + "probe-timing-300.json";
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

console.error(`pending: ${pending.length} of ${sample.length}`);

for (let i = 0; i < pending.length; i += BATCH) {
  const chunk = pending.slice(i, i + BATCH);
  const lines = chunk.map((g) => {
    const t = (tags[g.appid] || []).slice(0, 12).join(", ") || "(no tags)";
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
      if (!allowed.has(r.appid)) { ghosts++; ghostIds.push(r.appid); continue; }  // guard
      scored[r.appid] = r;
      kept++;
    }
    const ms = Date.now() - t0;
    timing.push({ batch: n, size: chunk.length, ms, returned: rows.length, kept,
      model: envelope.modelUsage ? Object.keys(envelope.modelUsage)[0] : (envelope.model || null),
      usd: envelope.total_cost_usd ?? null });
    fs.writeFileSync(outPath, JSON.stringify(scored, null, 1));
    fs.writeFileSync(timingPath, JSON.stringify(timing, null, 1));
    console.error(`batch ${n}: ${(ms/1000).toFixed(1)}s -> ${Object.keys(scored).length}/${sample.length} (ghosts ${ghosts})`);
  } catch (e) {
    failedBatches++;
    const ms = Date.now() - t0;
    timing.push({ batch: n, size: chunk.length, ms, error: String(e.message).slice(0, 200) });
    fs.writeFileSync(timingPath, JSON.stringify(timing, null, 1));
    console.error(`batch ${n} FAILED after ${(ms/1000).toFixed(1)}s: ${String(e.message).slice(0, 200)}`);
  }
}
console.log(JSON.stringify({ scored: Object.keys(scored).length, of: sample.length, failedBatches, ghostsDropped: ghosts, ghostIds }));
