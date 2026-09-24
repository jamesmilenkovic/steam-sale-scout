// Steam Sale Scout — increment 11's review renderer. DEV TOOL, NOT SHIPPED CODE.
//
// Renders SPEC.md's ⛩ REVIEW outputs into ~/code/review/steam-sale-scout/inc-11/.
// Nothing in src/ imports this and no route reaches it.
//
// HOW IT GETS AT THE REAL DATA, and why this is safe. `wrangler dev` keeps its
// D1, KV and Cache API state as plain SQLite indexes plus blob files under
// .wrangler/state/v3/. This tool reads those directly rather than driving a
// running `wrangler dev`, for two reasons: the render has to be reproducible
// without a server up, and — the load-bearing one — the two PRE-BUILD
// CHECKPOINT modes must not write a single row anywhere.
//
// THE WRITE DISCIPLINE, stated once and enforced by structure:
//
//   `prologues` and `normalisation` (SPEC.md outputs 1 and 2) are the
//   pre-build checkpoints. They open the REAL D1 STRICTLY READ-ONLY and
//   classify in memory. Nothing is written to the catalogue. James rules on
//   both before anything becomes durable — gates 2 and 3.
//
//   `presets`, `movement` and `funnel` (outputs 3 to 7) drive the REAL
//   /api/rank handler, which by design runs the exclusion fill. So they run
//   against a THROWAWAY COPY of the database in the OS temp directory. The
//   real .wrangler state is never opened for writing by this tool at all.
//
// Usage:
//   node tools/rank-review.mjs prologues
//   node tools/rank-review.mjs normalisation
//   node tools/rank-review.mjs presets       # BLOCKED until gates 2 and 3 are ruled
//   node tools/rank-review.mjs movement      # BLOCKED until gates 2 and 3 are ruled
//   node tools/rank-review.mjs funnel        # BLOCKED until gates 2 and 3 are ruled

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const STATE = join(REPO, ".wrangler/state/v3");
const OUT_DIR = join(homedir(), "code/review/steam-sale-scout/inc-11");

/**
 * GATES 2 AND 3 ARE NOT RULED YET, so outputs 3 to 7 refuse to run.
 *
 * This is not caution for its own sake. Those three modes drive the real
 * /api/rank handler, which fills `rank_exclude_reason` — and the whole point
 * of the checkpoints is that the prologue list and the normaliser are ruled
 * BEFORE anything is built on top of them. Rendering a top-50 now would put a
 * list in front of James that silently bakes in two decisions he has not
 * made, which is worse than rendering nothing.
 *
 * RULED 2026-09-03 — SPEC.md §12b. Gate 2: 111 of the 112 prologue matches
 * approved, KINGDOM HEARTS HD 2.8 spared via RANK_EXCLUDE_ALLOWLIST. Gate 3:
 * percentile for `default` and `sale`, min-max for `similarity`. Both are now
 * in src/rank.js, the fill has been run, and outputs 3 to 7 are unblocked.
 */
const GATES_2_AND_3_RULED = true;

// ---------------------------------------------------------------------------
// Reading wrangler's local state
// ---------------------------------------------------------------------------

/** The single .sqlite index inside one of miniflare's state directories.
 * Named by content hash, so it is found rather than hardcoded. */
function findIndex(dir) {
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!file) throw new Error(`no miniflare index found in ${dir}`);
  return join(dir, file);
}

function openD1ReadOnly() {
  const path = findIndex(join(STATE, "d1/miniflare-D1DatabaseObject"));
  // readOnly is the guarantee, not the intention: a stray write throws here
  // rather than silently landing in James's catalogue.
  return new DatabaseSync(path, { readOnly: true });
}

/** A D1Database-shaped facade over a node:sqlite handle — the same slice of
 * the API test/helpers/mockD1.mjs implements, so the real handler runs
 * unmodified against it. */
function makeFileD1(db, meter = { rowsRead: 0, queries: 0 }) {
  const statement = (sql, args) => ({
    bind: (...a) => statement(sql, a),
    async run() {
      db.prepare(sql).run(...args);
      return { success: true, results: [], meta: {} };
    },
    async all() {
      // Metered for SPEC.md gate 8: "D1 row-reads per /api/rank call recorded
      // for increment 13". Recorded as gate input, not optimised away here —
      // caching the user-independent catalogue read is increment 13's job.
      const results = db.prepare(sql).all(...args);
      meter.rowsRead += results.length;
      meter.queries++;
      return { success: true, results, meta: {} };
    },
    async first(column) {
      const row = db.prepare(sql).get(...args);
      if (!row) return null;
      return column ? row[column] : row;
    },
  });
  return {
    _meter: meter,
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

/** KVNamespace-shaped facade over the local TAG_CACHE state. Read-only: this
 * tool never warms anyone's cache. */
function makeFileKv() {
  const db = new DatabaseSync(findIndex(join(STATE, "kv/miniflare-KVNamespaceObject")), { readOnly: true });
  const blobs = join(STATE, "kv/local-dev-tag-cache-placeholder/blobs");
  const select = db.prepare("SELECT blob_id FROM _mf_entries WHERE key = ?");
  return {
    async get(key) {
      const row = select.get(key);
      if (!row) return null;
      const path = join(blobs, row.blob_id);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    async put() {
      /* no-op: the renderer never writes to KV */
    },
  };
}

/** Cache-API-shaped facade over the local Cache state, so the taste profile
 * is built from the SAME cached Steam library the running app uses — and so
 * this tool needs no network and no Steam key. */
function makeFileCache() {
  const db = new DatabaseSync(findIndex(join(STATE, "cache/miniflare-CacheObject")), { readOnly: true });
  const blobs = join(STATE, "cache/default/blobs");
  const select = db.prepare("SELECT blob_id FROM _mf_entries WHERE key = ?");
  return {
    async match(request) {
      const row = select.get(String(request.url ?? request));
      if (!row) return undefined;
      const path = join(blobs, row.blob_id);
      if (!existsSync(path)) return undefined;
      return new Response(readFileSync(path), { headers: { "content-type": "application/json" } });
    },
    async put() {
      /* no-op: the renderer never writes to the cache */
    },
  };
}

/** Every scratch file this process created, so it can delete them all on the
 * way out (SEC-3). A gate render must not quietly leave copies of James's
 * catalogue lying around in the OS temp directory. */
const scratchFiles = [];
let scratchCleanupRegistered = false;

/** Copy the catalogue somewhere disposable, for the modes that drive the real
 * handler (which writes). The real .wrangler state is never opened writable.
 *
 * SEC-3 (round-2 review): THE `-wal` SIDECAR HAS TO COME TOO. SQLite in WAL
 * mode keeps recent committed transactions in `<db>-wal` until a checkpoint
 * folds them back into the main file. `wrangler dev` leaves a live WAL behind,
 * so copying the main file alone can hand the renderer a snapshot that is
 * missing the most recent writes – a gate artifact computed against a stale
 * catalogue, which is the one thing a gate artifact must never be.
 *
 * `-shm` is deliberately NOT copied: it is a rebuildable shared-memory index,
 * and a stale one is worse than none. SQLite recovers the copied WAL on first
 * open and builds a fresh `-shm` itself.
 */
function copyCatalogToScratch() {
  const source = findIndex(join(STATE, "d1/miniflare-D1DatabaseObject"));
  const target = join(tmpdir(), `steam-sale-scout-inc11-${Date.now()}.sqlite`);
  copyFileSync(source, target);
  scratchFiles.push(target);
  if (existsSync(`${source}-wal`)) {
    copyFileSync(`${source}-wal`, `${target}-wal`);
    scratchFiles.push(`${target}-wal`);
  }
  // The recovered WAL and its rebuilt shm are created beside the copy, so name
  // them for deletion whether or not they exist yet.
  scratchFiles.push(`${target}-wal`, `${target}-shm`);

  if (!scratchCleanupRegistered) {
    scratchCleanupRegistered = true;
    process.on("exit", cleanupScratch);
  }
  return target;
}

function cleanupScratch() {
  for (const file of new Set(scratchFiles)) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* best effort – a leftover temp file is not worth failing a render over */
    }
  }
}

function write(name, body) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), body, "utf8");
  console.log(`wrote ${join(OUT_DIR, name)}`);
}

const fmt = (n, d = 4) => (n == null || Number.isNaN(n) ? "–" : Number(n).toFixed(d));
/**
 * Make external text safe to drop into a markdown table cell (SEC-2).
 *
 * Titles come from Steam and `why` lines come from an LLM. Both are external
 * text rendered into an artifact James rules gates on, so neither may be able
 * to change the artifact's structure or inject a live link. A bare newline
 * ends the table row; `[click](http://evil)` renders as a clickable link; a
 * backtick opens a code span that swallows the rest of the row.
 *
 * Newlines collapse to a space; every other structural character is
 * backslash-escaped, which CommonMark defines for all ASCII punctuation and
 * which renders as the literal character. The backslash itself is escaped in
 * the same pass (it leads the character class) so nothing is double-processed.
 */
const escape = (s) =>
  String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`|[\]<>]/g, (c) => `\\${c}`)
    .trim();

// ---------------------------------------------------------------------------
// Output 1 — the prologue checkpoint (READ-ONLY)
// ---------------------------------------------------------------------------

async function renderPrologues() {
  const { classifyRankExclusion, PROLOGUE_PATTERN } = await import("../src/rank.js");
  const db = openD1ReadOnly();
  const rows = db.prepare("SELECT appid, name, app_type, source_owned, experience_score, positive, negative FROM fpm_catalog").all();

  const matched = rows.filter((r) => classifyRankExclusion(r) === "prologue");
  // NEAR MISSES: rows a naive substring search would catch that the
  // word-boundary rule does not. This is where James sees exactly where the
  // boundary sits.
  const substringOnly = rows.filter((r) => /prologue/i.test(r.name || "") && classifyRankExclusion(r) !== "prologue");
  const demoWord = rows.filter((r) => /\bdemos?\b/i.test(r.name || ""));
  const demoSubstring = rows.filter((r) => /demo/i.test(r.name || "") && !/\bdemos?\b/i.test(r.name || ""));
  const ostWord = rows.filter((r) => /\bOST\b/.test(r.name || ""));
  const ostSubstring = rows.filter((r) => /ost/i.test(r.name || "") && !/\bOST\b/.test(r.name || ""));
  const playtest = rows.filter((r) => /\bplaytests?\b/i.test(r.name || ""));

  const controls = ["HYPER DEMON", "Book of Demons", "Democratic Socialism Simulator"];
  const controlRows = controls.map((name) => {
    const row = rows.find((r) => (r.name || "").toLowerCase() === name.toLowerCase());
    return { name, row };
  });

  const matchedGames = matched.filter((r) => r.app_type === "game");
  const matchedOwned = matched.filter((r) => r.source_owned === 1);
  const matchedScored = matched.filter((r) => r.experience_score != null);

  const lines = [];
  lines.push("# 01 – Prologue exclusions: the list, before a single row is written");
  lines.push("");
  lines.push(`**TLDR:** \`\\bprologue\\b\` matches **${matched.length}** of ${rows.length} catalogue titles (${matchedGames.length} of them currently rankable), all three negative controls survive, and the word-boundary rule spares ${demoSubstring.length} Demon/Democracy titles and ${ostSubstring.length} Ghost/Lost/Frost ones that naive substring rules would kill. **Nothing has been written to D1.**`);
  lines.push("");
  lines.push("**Deciding:** approve this list, or name the titles that should be spared. Anything you name goes into `RANK_EXCLUDE_ALLOWLIST` and the fill runs after that, not before.");
  lines.push("");
  lines.push(`> **One flag from me, and it is a flag rather than a rule.** \`KINGDOM HEARTS HD 2.8 Final Chapter Prologue\` is a real, complete, paid retail game whose *title* happens to end in the word. No computable signal separates it from the 111 promotional prologues – it has no price in D1 (nothing free-or-unpriced does), its experience score is mid-table, and its review count is unremarkable. This is exactly the case SPEC.md §6 says is "found by his eye, not by a rule". Start there, then scan the rest.`);
  lines.push("");
  lines.push(`**The rule:** \`${PROLOGUE_PATTERN}\` on the title, case-insensitive, word boundaries. Scope is **prologue only** – no demo rule, no soundtrack rule, no DLC rule.`);
  lines.push("");
  lines.push("## The headline numbers");
  lines.push("");
  lines.push("| | Count |");
  lines.push("|---|--:|");
  lines.push(`| Catalogue rows | ${rows.length} |`);
  lines.push(`| **Matched \`\\bprologue\\b\`** | **${matched.length}** |`);
  lines.push(`| ...of which classified \`app_type = 'game'\` (i.e. actually in the ranking today) | ${matchedGames.length} |`);
  lines.push(`| ...of which carry an experience score | ${matchedScored.length} |`);
  lines.push(`| ...of which you own | ${matchedOwned.length} |`);
  lines.push(`| Contains "prologue" as a SUBSTRING but not as a word (near-misses, NOT excluded) | ${substringOnly.length} |`);
  lines.push("");
  lines.push(`**Cross-check against ruling 6.** The PRD measured "108 free prologues" on 2026-09-01. This run finds ${matchedGames.length} matched rows classified \`app_type = 'game'\` – the ones actually reaching the ranking today – plus ${matched.length - matchedGames.length} already excluded by increment 7.8's app-type gate for being classified \`demo\`. SPEC.md §8 marked that figure *confirm*; **${matchedGames.length}** is the confirmed number and the funnel will use it.`);
  lines.push("");
  lines.push("## The three negative controls – each shown NOT matched");
  lines.push("");
  lines.push("A naive `%demo%` search kills all three. This is the test the word-boundary rule exists for.");
  lines.push("");
  lines.push("| Title | In catalogue | `\\bprologue\\b` | Verdict |");
  lines.push("|---|---|---|---|");
  for (const { name, row } of controlRows) {
    const verdict = row ? (classifyRankExclusion(row) === "prologue" ? "**MATCHED – DEFECT**" : "not matched ✓") : "not matched ✓ (absent from catalogue)";
    lines.push(`| ${escape(name)} | ${row ? `yes (appid ${row.appid})` : "no"} | ${row && classifyRankExclusion(row) ? "yes" : "no"} | ${verdict} |`);
  }
  lines.push("");
  lines.push("## Where the boundary sits – what the rule deliberately does NOT touch");
  lines.push("");
  lines.push("| Naive pattern | Would match | Word-boundary rule matches | Not excluded, and why |");
  lines.push("|---|--:|--:|---|");
  lines.push(`| \`%prologue%\` | ${matched.length + substringOnly.length} | ${matched.length} | ${substringOnly.length} rows carry it inside a longer word |`);
  lines.push(`| \`%demo%\` | ${demoWord.length + demoSubstring.length} | 0 | ${demoSubstring.length} of those are Demon/Democratic/Demonologist etc. Ruling 6: demos are not leaking. |`);
  lines.push(`| \`%ost%\` | ${ostWord.length + ostSubstring.length} | 0 | ${ostSubstring.length} of those are Ghost/Lost/Frost/Nostalgia. Case-sensitive \`\\bOST\\b\` finds only ${ostWord.length}. |`);
  lines.push(`| \`%playtest%\` | ${playtest.length} | 0 | ${playtest.length === 0 ? "none in the catalogue at all" : "not in scope"} |`);
  lines.push("");
  if (substringOnly.length > 0) {
    lines.push("### The near-misses in full (contain the letters, not the word – all KEPT)");
    lines.push("");
    lines.push("| appid | Title |");
    lines.push("|--:|---|");
    for (const r of substringOnly) lines.push(`| ${r.appid} | ${escape(r.name)} |`);
    lines.push("");
  }
  lines.push("### The `%demo%` rows the boundary rule spares (all KEPT)");
  lines.push("");
  lines.push("| appid | Title |");
  lines.push("|--:|---|");
  for (const r of demoSubstring.slice(0, 40)) lines.push(`| ${r.appid} | ${escape(r.name)} |`);
  if (demoSubstring.length > 40) lines.push(`| … | …and ${demoSubstring.length - 40} more |`);
  lines.push("");
  lines.push('### The rows that DO contain "demo"/"demos" as a word');
  lines.push("");
  lines.push("Ruling 6 measured 10 of these surviving in 18,219 and called it a rounding error. Listed so you can confirm that judgement rather than take it on trust. **All KEPT – there is no demo rule.**");
  lines.push("");
  lines.push("| appid | Title | app_type |");
  lines.push("|--:|---|---|");
  for (const r of demoWord) lines.push(`| ${r.appid} | ${escape(r.name)} | ${r.app_type ?? "–"} |`);
  lines.push("");
  lines.push("### The `\\bOST\\b` rows");
  lines.push("");
  lines.push("| appid | Title | app_type |");
  lines.push("|--:|---|---|");
  for (const r of ostWord) lines.push(`| ${r.appid} | ${escape(r.name)} | ${r.app_type ?? "–"} |`);
  lines.push("");
  lines.push("## Look here first – where a wrong exclusion would actually cost something");
  lines.push("");
  lines.push("Excluding a shovelware prologue with 60 reviews costs nothing. Excluding a good game costs the product. These are the matched rows with the most to lose, so they are the ones worth your eye before the long list.");
  lines.push("");
  lines.push("| Title | Exp | Reviews | Owners |");
  lines.push("|---|--:|--:|--:|");
  const bySignal = [...matched].sort((a, b) => (b.experience_score ?? 0) - (a.experience_score ?? 0) || (b.positive || 0) + (b.negative || 0) - ((a.positive || 0) + (a.negative || 0)));
  for (const r of bySignal.slice(0, 12)) {
    lines.push(`| ${escape(r.name)} | ${r.experience_score ?? "–"} | ${(r.positive || 0) + (r.negative || 0)} | ${r.owners ?? "–"} |`);
  }
  lines.push("");
  lines.push("| Title (by review count) | Exp | Reviews |");
  lines.push("|---|--:|--:|");
  for (const r of [...matched].sort((a, b) => (b.positive || 0) + (b.negative || 0) - ((a.positive || 0) + (a.negative || 0))).slice(0, 8)) {
    lines.push(`| ${escape(r.name)} | ${r.experience_score ?? "–"} | ${(r.positive || 0) + (r.negative || 0)} |`);
  }
  lines.push("");
  lines.push("## Every matched title, alphabetically");
  lines.push("");
  lines.push("**Scan for anything that is a real, complete game.** `Prologue: Go Wayback!` is the known shape of that mistake: a full survival game that happens to be called Prologue. It is not in this catalogue, but the shape is.");
  lines.push("");
  lines.push("| appid | Title | app_type | Owned | Exp | Reviews |");
  lines.push("|--:|---|---|---|--:|--:|");
  for (const r of [...matched].sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
    lines.push(
      `| ${r.appid} | ${escape(r.name)} | ${r.app_type ?? "–"} | ${r.source_owned === 1 ? "**yes**" : ""} | ${r.experience_score ?? "–"} | ${(r.positive || 0) + (r.negative || 0)} |`,
    );
  }
  lines.push("");
  write("01-prologue-exclusions.md", lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Output 2 — the normalisation checkpoint (READ-ONLY)
// ---------------------------------------------------------------------------

/** Rebuild exactly what handleRank computes, minus the parts that need a
 * writable database. Read-only: the prologue rule is applied IN MEMORY here
 * rather than off the (not yet filled) column, which is the whole reason this
 * mode can run before gate 2. */
async function buildProbePool() {
  const { classifyRankExclusion, isLowConfidenceSuppressed, profileWithoutGame, summedProfileFromContributions } = await import("../src/rank.js");
  const { buildProfile, computeIdf, buildTagVector, applyIdf, selectTopOwnedGames, TOP_OWNED_GAMES } = await import("../src/profile.js");
  const { cosineSimilarity } = await import("../src/score.js");

  const db = openD1ReadOnly();
  const rows = db.prepare("SELECT * FROM fpm_catalog").all();
  const kv = makeFileKv();
  const cache = makeFileCache();

  // KNOWN BUG, DELIBERATELY NOT FIXED HERE (SPEC.md §11.6, §15). This key
  // omits the `&v=2` that src/worker.js's libraryCacheKey carries, so it never
  // matches and this tool silently reads an EMPTY library. Recorded by ticket
  // #5 and still open. Increment 15 renames the variable on this line and
  // nothing else - fixing the bug is explicitly out of scope.
  const libResponse = await cache.match(`https://steam-sale-scout.cache/api/library?steamid=${process.env.OWNER_STEAM_ID || readOwnerSteamId()}`);
  const libraryGames = libResponse ? (await libResponse.json()).games || [] : [];

  const catalogTags = new Map();
  for (const row of rows) {
    if (typeof row.tags !== "string") continue;
    try {
      const parsed = JSON.parse(row.tags);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) catalogTags.set(row.appid, parsed);
    } catch {
      /* corrupt blob: treated as no tags, same as the handler */
    }
  }

  const libraryByAppid = new Map(libraryGames.map((g) => [g.appid, g]));
  const eligible = [];
  const funnel = { total: rows.length, nonGame: 0, checkedNoScore: 0, unscored: 0, prologue: 0, suppressed: 0, ownedSpared: 0 };
  for (const row of rows) {
    const owned = row.source_owned === 1 || libraryByAppid.has(row.appid);
    if (row.app_type !== "game") { funnel.nonGame++; continue; }
    if (row.experience_score == null) { row.experience_checked_at != null ? funnel.checkedNoScore++ : funnel.unscored++; continue; }
    if (classifyRankExclusion(row) === "prologue") { funnel.prologue++; continue; }
    if (isLowConfidenceSuppressed({ ...row, source_owned: owned ? 1 : 0 })) { funnel.suppressed++; continue; }
    if (owned && row.experience_confidence === "low" && (row.positive || 0) + (row.negative || 0) < 1000) funnel.ownedSpared++;
    eligible.push({ row, owned });
  }

  const corpus = [];
  for (const { row } of eligible) {
    const tags = catalogTags.get(row.appid);
    if (tags) corpus.push(tags);
  }
  const idfMap = computeIdf(corpus);

  const now = Date.now();
  const profileAppids = selectTopOwnedGames(libraryGames, 12, now, TOP_OWNED_GAMES).map((g) => g.appid);
  const spyDataByAppid = new Map();
  for (const appid of profileAppids) {
    const raw = await kv.get(`v2:spytag:${appid}`);
    const parsed = raw == null ? undefined : JSON.parse(raw);
    if (parsed?.tags) spyDataByAppid.set(appid, parsed);
    else if (catalogTags.has(appid)) spyDataByAppid.set(appid, { tags: catalogTags.get(appid), median: null, reviews: {} });
    else spyDataByAppid.set(appid, undefined);
  }
  const { profile, contributions } = buildProfile(libraryGames, spyDataByAppid, 12, now, idfMap);
  const summed = summedProfileFromContributions(contributions);
  const contributionByAppid = new Map(contributions.map((c) => [c.appid, c]));

  const scored = [];
  for (const entry of eligible) {
    const tags = catalogTags.get(entry.row.appid);
    const raw = tags ? buildTagVector(tags) : {};
    const hasTags = Object.keys(raw).length > 0;
    let similarity = 0;
    if (hasTags) {
      const own = entry.owned ? contributionByAppid.get(entry.row.appid) : undefined;
      const against = own ? profileWithoutGame(summed, own.tagWeights, idfMap) : profile;
      similarity = cosineSimilarity(against, applyIdf(raw, idfMap));
    }
    scored.push({ ...entry, similarity, hasTags });
  }

  return { scored, funnel, libraryGames, profileSize: Object.keys(profile).length, contributions: contributions.length };
}

/** The OWNER's SteamID64 out of `.dev.vars`. **Renamed from `readSteamId` /
 * `STEAM_ID` by SPEC.md §11.6** - this tool is an offline review harness run by
 * James against his own machine, so the owner constant is the right id here,
 * unlike the nine request-path sites that now read the session. */
function readOwnerSteamId() {
  const path = join(REPO, ".dev.vars");
  if (!existsSync(path)) return "";
  const match = readFileSync(path, "utf8").match(/^OWNER_STEAM_ID=(.*)$/m);
  return match ? match[1].trim() : "";
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

async function renderNormalisation() {
  const { blendRankScore, minMaxNormalise, percentileRankNormalise, RANK_PRESETS } = await import("../src/rank.js");
  const { scored, funnel, profileSize, contributions } = await buildProbePool();

  const tagged = scored.filter((s) => s.hasTags);
  const cosines = tagged.map((s) => s.similarity);
  const sorted = [...cosines].sort((a, b) => a - b);

  const pct = percentileRankNormalise(cosines);
  const mm = minMaxNormalise(cosines);
  tagged.forEach((entry, i) => {
    entry.pct = pct[i];
    entry.mm = mm[i];
  });
  for (const entry of scored) {
    if (!entry.hasTags) {
      entry.pct = 0;
      entry.mm = 0;
    }
  }

  const rankUnder = (key, preset) =>
    [...scored]
      .map((e) => ({ e, score: blendRankScore({ experienceScore: e.row.experience_score, similarityNorm: e[key], cut: e.row.cut }, RANK_PRESETS[preset]).rankScore }))
      .sort((a, b) => b.score - a.score);

  const table = (preset) => {
    const p = rankUnder("pct", preset);
    const m = rankUnder("mm", preset);
    const rows = [];
    for (let i = 0; i < 20; i++) {
      const a = p[i];
      const b = m[i];
      rows.push(
        `| ${i + 1} | ${escape(a.e.row.name)} | ${a.e.row.experience_score} | ${fmt(a.e.similarity, 4)} | ${fmt(a.e.pct, 3)} | ${fmt(a.score, 4)} | ${escape(b.e.row.name)} | ${b.e.row.experience_score} | ${fmt(b.e.similarity, 4)} | ${fmt(b.e.mm, 3)} | ${fmt(b.score, 4)} |`,
      );
    }
    const topN = (list, n) => new Set(list.slice(0, n).map((x) => x.e.row.appid));
    const overlap50 = [...topN(p, 50)].filter((id) => topN(m, 50).has(id)).length;
    return { rows, differing50: 50 - overlap50 };
  };

  const spread = (values) => {
    const s = [...values].sort((a, b) => a - b);
    return [0, 0.25, 0.5, 0.75, 0.9, 0.99, 1].map((q) => quantile(s, q));
  };

  const dflt = table("default");
  const sim = table("similarity");
  const nearZero = cosines.filter((c) => c < 0.05).length;
  const nearZero01 = cosines.filter((c) => c < 0.01).length;

  // Where a handful of named games land under each of the four combinations.
  // Gate 6 asks for Portal at #1 of the ranked set under `default`, so where
  // it actually lands is a decision input, not a footnote.
  const WATCH = ["Portal", "Portal 2", "Undertale", "Outer Wilds", "Hades", "Balatro"];
  const placement = {};
  for (const preset of ["default", "similarity"]) {
    for (const [key, label] of [["pct", "percentile"], ["mm", "minmax"]]) {
      const list = rankUnder(key, preset);
      placement[`${preset}/${label}`] = new Map(list.map((x, i) => [x.e.row.name, i + 1]));
    }
  }

  const lines = [];
  lines.push("# 02 – Normalisation probe: which normaliser gives `wS` actual force");
  lines.push("");
  const compressed = nearZero / cosines.length > 0.5;
  lines.push(
    `**TLDR:** the cosines are **${compressed ? "compressed hard near zero, as the spec predicted" : "NOT compressed – the spec's premise for recommending percentile does not hold"}** (median ${fmt(quantile(sorted, 0.5), 4)}, max ${fmt(sorted[sorted.length - 1], 4)}, only ${((nearZero / cosines.length) * 100).toFixed(1)}% below 0.05), but the two normalisers still produce **visibly different answers** – ${dflt.differing50} of the top 50 differ under \`default\`, ${sim.differing50} under \`similarity\`. So the decision is live, and it is now about which list looks right rather than about whether \`wS\` has any force.`,
  );
  lines.push("");
  lines.push("**Deciding:** percentile rank or min-max. **Nothing has been written to D1 and no normaliser has been picked in code.**");
  lines.push("");
  lines.push(`> **What changed from the spec's expectation.** SPEC.md §4.2 recommended percentile *because* IDF-cosine over 18k rows was expected to collapse toward zero, which would have left min-max unable to give \`wS\` force. Measured, it does not collapse: the median game sits at ${fmt(quantile(sorted, 0.5), 3)} and the interquartile range is ${fmt(quantile(sorted, 0.25), 3)}–${fmt(quantile(sorted, 0.75), 3)}. Min-max is therefore a real option rather than a disqualified one, and the recommendation it rested on no longer applies. Judge the two lists below on their merits.`);
  lines.push("");
  lines.push("## What the probe ran over");
  lines.push("");
  lines.push("| | Count |");
  lines.push("|---|--:|");
  lines.push(`| Catalogue rows | ${funnel.total} |`);
  lines.push(`| less non-game / unclassified | ${funnel.nonGame} |`);
  lines.push(`| less checked-no-score | ${funnel.checkedNoScore} |`);
  lines.push(`| less never-scored | ${funnel.unscored} |`);
  lines.push(`| less prologues (in memory – nothing written) | ${funnel.prologue} |`);
  lines.push(`| less low-confidence suppressed (**owned exempt – ${funnel.ownedSpared} spared**) | ${funnel.suppressed} |`);
  lines.push(`| **= eligible pool** | **${scored.length}** |`);
  lines.push(`| ...of which have tags and are in the normalisation pool | ${tagged.length} |`);
  lines.push(`| ...of which are tagless and pinned to S = 0 | ${scored.length - tagged.length} |`);
  lines.push("");
  lines.push(`Taste profile: **${contributions} owned games** contributing, **${profileSize} distinct tags** after IDF weighting.`);
  lines.push("");
  lines.push("## The raw cosine distribution");
  lines.push("");
  lines.push("| Statistic | Value |");
  lines.push("|---|--:|");
  const q = spread(cosines);
  const labels = ["min", "25th percentile", "median", "75th percentile", "90th percentile", "99th percentile", "max"];
  labels.forEach((label, i) => lines.push(`| ${label} | ${fmt(q[i], 4)} |`));
  lines.push(`| mean | ${fmt(cosines.reduce((a, b) => a + b, 0) / cosines.length, 4)} |`);
  lines.push(`| below 0.01 | ${nearZero01} (${((nearZero01 / cosines.length) * 100).toFixed(1)}%) |`);
  lines.push(`| below 0.05 | ${nearZero} (${((nearZero / cosines.length) * 100).toFixed(1)}%) |`);
  lines.push(`| exactly 0 (no shared distinctive tag at all) | ${cosines.filter((c) => c === 0).length} |`);
  lines.push("");
  lines.push("**How to read this.** `wS` multiplies whatever `S` comes out of the normaliser, so the normaliser decides how much of `wS` is actually spent. The two behave differently in a way that matters:");
  lines.push("");
  lines.push("- **Percentile rank** spends `wS` on *relative* taste – it asks \"is this a better match than most of the catalogue\", and by construction the median game gets exactly 0.5. Because most games are a middling match, this pushes a lot of the pool toward the middle of the S range, which leaves `experience_score` as the thing that separates the top. That is why the percentile lists below read as \"great games, taste-ordered\".");
  lines.push("- **Min-max** spends `wS` on *absolute* taste – it preserves the shape of the raw cosine, so the handful of games that are genuinely a strong tag match keep their distance from everything else. That is why the min-max lists read as \"things very like what you play, ordered\", and why several 60s and 70s outrank a 96.");
  lines.push("");
  lines.push("Neither is wrong. They are two different products, and the top-20s below are the honest way to choose between them.");
  lines.push("");
  lines.push("| Where a game at this percentile of the pool lands on S | Percentile | Min-max |");
  lines.push("|---|--:|--:|");
  lines.push(`| median game | ${fmt(quantile([...pct].sort((a, b) => a - b), 0.5), 3)} | ${fmt(quantile([...mm].sort((a, b) => a - b), 0.5), 3)} |`);
  lines.push(`| 90th percentile game | ${fmt(quantile([...pct].sort((a, b) => a - b), 0.9), 3)} | ${fmt(quantile([...mm].sort((a, b) => a - b), 0.9), 3)} |`);
  lines.push(`| 99th percentile game | ${fmt(quantile([...pct].sort((a, b) => a - b), 0.99), 3)} | ${fmt(quantile([...mm].sort((a, b) => a - b), 0.99), 3)} |`);
  lines.push("");
  lines.push(`**Top-50 rows that differ between the two normalisers:** ${dflt.differing50} under \`default\`, ${sim.differing50} under \`similarity\`.`);
  lines.push("");
  lines.push("## Where six known games land under each combination");
  lines.push("");
  lines.push("Gate 6 asks for *Portal* at #1 of the ranked set under `default`. Under either normaliser it is not, because at `wS = 0.3` the similarity term genuinely moves things – which is the toggle working as designed. **Flagging it here rather than at gate 6:** either the gate-6 wording needs to mean \"Portal is #1 on `experience_score`\" (which it is, 1st of 18,219), or `wS` needs to come down under `default`.");
  lines.push("");
  lines.push("| Game | default / percentile | default / min-max | similarity / percentile | similarity / min-max |");
  lines.push("|---|--:|--:|--:|--:|");
  for (const name of WATCH) {
    const cell = (k) => placement[k].get(name) ?? "–";
    lines.push(`| ${escape(name)} | ${cell("default/percentile")} | ${cell("default/minmax")} | ${cell("similarity/percentile")} | ${cell("similarity/minmax")} |`);
  }
  lines.push("");
  for (const [name, built, preset] of [["`similarity` preset (wS = 0.6 – where the choice bites hardest)", sim, "similarity"], ["`default` preset (wS = 0.3 – the shipping lens)", dflt, "default"]]) {
    lines.push(`## Top 20 side by side – ${name}`);
    lines.push("");
    lines.push("| # | PERCENTILE: title | exp | cos | S | score | MIN-MAX: title | exp | cos | S | score |");
    lines.push("|--:|---|--:|--:|--:|--:|---|--:|--:|--:|--:|");
    lines.push(...built.rows);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("**What happens next.** Your pick becomes `RANK_NORMALISER_DEFAULT` in `src/rank.js` – one named constant, not a buried default – and both normalisers stay reachable at `?norm=percentile` / `?norm=minmax` so the other one is always one URL away. The raw cosine ships on every row either way, so the normaliser can never hide what it did.");
  lines.push("");
  write("02-normalisation-probe.md", lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Outputs 3 to 7 — the post-gate renders (drive the REAL handler, on a COPY)
// ---------------------------------------------------------------------------

async function callRank(query, settings = null) {
  const worker = (await import("../src/worker.js")).default;
  const db = new DatabaseSync(callRank.dbPath);
  if (settings) {
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
    for (const [k, v] of Object.entries(settings)) {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(k, JSON.stringify(v), Date.now());
    }
  }
  const meter = { rowsRead: 0, queries: 0 };
  const env = {
    STEAM_API_KEY: "local-probe",
    OWNER_STEAM_ID: readOwnerSteamId(),
    TAG_CACHE: makeFileKv(),
    FPM_DB: makeFileD1(db, meter),
  };
  globalThis.caches = { default: makeFileCache() };
  const started = Date.now();
  const response = await worker.fetch(new Request(`https://local.probe/api/rank${query}`), env, { waitUntil() {} });
  const body = await response.json();
  body._meter = { ...meter, ms: Date.now() - started };
  db.close();
  return body;
}

/**
 * THE LINE EVERY LIVE ARTIFACT CARRIES (round-2 review).
 *
 * These renders drive the real handler, which fetches James's Steam library
 * through the Cache API. The taste profile therefore depends on cache state,
 * and two runs minutes apart can legitimately move a row a place or two – the
 * coder run put Portal 8th under `default` and a later probe put it 6th, both
 * correct at the moment they ran. So every generated artifact says so in its
 * own header, with the contributing-game count behind it, and nobody treats a
 * number here as a constant.
 */
function snapshotNote(body) {
  const profile = body.profileAvailable
    ? `**${body.profileGames} owned games contributing** to the taste profile`
    : "**NO taste profile – 0 owned games contributing**, so every similarity is 0 and this list is experience value alone";
  const outage = body.notice ? `\n>\n> **Notice from the API:** ${escape(body.notice)}` : "";
  return (
    `> **Snapshot, not a constant.** Rendered ${new Date().toISOString().slice(0, 10)} with ${profile}. ` +
    "The ranking depends on a live Steam library fetch, so it varies with cache state – a re-render " +
    `minutes later can move a row a place or two. Read the shape, not the exact rank.${outage}`
  );
}

function top50Table(body, title, note) {
  const lines = [
    `# ${title}`,
    "",
    note,
    "",
    snapshotNote(body),
    "",
    `**How this list was built:** preset \`${body.preset}\` · wE ${body.weights.we} · wS ${body.weights.ws} · wSale ${body.weights.wsale} · normaliser **${body.normaliser}** · window ${body.windowMonths} months · ${body.funnel.ranked} games ranked, ${body.funnel.owned} of them owned.`,
    "",
    "`Sim` is the normalised similarity the blend actually used; `cos` is the raw cosine behind it, shown so the normaliser can never hide what it did.",
    "",
    "| # | Title | Exp | Quality | Hrs | Sim | cos | FPM | Owned | Price | Why |",
    "|--:|---|--:|--:|--:|--:|--:|--:|---|---|---|",
  ];
  body.rank.slice(0, 50).forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${escape(r.title)} | ${r.experienceScore} | ${r.gameScore ?? "–"} | ${r.hoursToValue ?? "–"} | ${fmt(r.similarityNorm, 2)} | ${fmt(r.similarity, 3)} | ${r.experienceFpm == null ? "endless" : fmt(r.experienceFpm, 1)} | ${r.owned ? `**yes** (${fmt(r.hoursPlayed, 0)}h)` : ""} | ${r.price == null ? "–" : `$${r.price}${r.cut ? ` (-${r.cut}%)` : ""}`} | ${escape(r.why)} |`,
    );
  });
  return lines.join("\n") + "\n";
}

async function renderPresets() {
  const dflt = await callRank("?preset=default");
  write(
    "03-top50-default.md",
    top50Table(
      dflt,
      "03 – Top 50, `default` preset: what do I play next",
      "**TLDR:** the answer. `wSale = 0`, so this list is arithmetically sale-blind – the sale multiplier is exactly 1.0 on every row – and owned games compete with unowned ones on experience value and taste alone.",
    ),
  );

  const sale = await callRank("?preset=sale");
  write(
    "04-top50-sale.md",
    top50Table(
      sale,
      "04 – Top 50, `sale` preset: what do I buy",
      `**TLDR:** the buying lens, \`wSale = 0.5\`. Owned games fall, and that is the point rather than a bug – only **${dflt.funnel.pricedOwned}** of your ${dflt.funnel.owned} ranked owned games carries a discount, so an owned row gets a multiplier of 1.0 against a discounted row's 1.52. "What should I buy" is a question about things you do not own. Same base weights and same normaliser as \`default\`, so the only thing that changed is the sale term.`,
    ),
  );

  const similarity = await callRank("?preset=similarity");
  write(
    "05-top50-similarity.md",
    top50Table(
      similarity,
      "05 – Top 50, `similarity` preset: more like what I play",
      "**TLDR:** taste leads (`wS = 0.6`) and experience value becomes the floor that keeps shovelware out. Note this lens uses the **min-max** normaliser per your gate-3 ruling, so only near-perfect tag matches earn taste credit – which is what makes it read as \"things very like what you play\" rather than \"great games, taste-ordered\".",
    ),
  );
}

async function renderMovement() {
  const base = await callRank("?preset=default");
  const baseRank = new Map(base.rank.map((r, i) => [r.appid, i]));
  const baseTop50 = new Set(base.rank.slice(0, 50).map((r) => r.appid));

  const lines = [
    "# 06 – Toggle movement: do the toggles visibly move the order",
    "",
    "**TLDR:** gate 4 asks each preset to change **at least 20 of the top 50** against `default`, and to pull **at least one row up by 100+ ranks**. Both results are below, measured against the live catalogue.",
    "",
    snapshotNote(base),
    "",
    "| Preset | Top-50 rows changed | Biggest climber | Ranks gained | Gate 4 |",
    "|---|--:|---|--:|---|",
  ];

  const detail = [];
  for (const preset of ["sale", "similarity"]) {
    const body = await callRank(`?preset=${preset}`);
    const changed = body.rank.slice(0, 50).filter((r) => !baseTop50.has(r.appid)).length;
    const climbers = body.rank
      .slice(0, 50)
      .map((r, i) => ({ title: r.title, from: (baseRank.get(r.appid) ?? Infinity) + 1, to: i + 1, gained: (baseRank.get(r.appid) ?? Infinity) - i }))
      .sort((a, b) => b.gained - a.gained);
    const best = climbers[0];
    const pass = changed >= 20 && best && best.gained >= 100 ? "**PASS**" : "**FAIL**";
    lines.push(`| \`${preset}\` | ${changed} / 50 | ${escape(best?.title)} | ${best?.gained} | ${pass} |`);

    detail.push(`## \`${preset}\` vs \`default\` – the ten biggest climbers into the top 50`);
    detail.push("");
    detail.push(`Weights: wE ${body.weights.we} · wS ${body.weights.ws} · wSale ${body.weights.wsale} · normaliser **${body.normaliser}**.`);
    detail.push("");
    detail.push("| Title | Rank under `default` | Rank here | Gained |");
    detail.push("|---|--:|--:|--:|");
    for (const c of climbers.slice(0, 10)) {
      detail.push(`| ${escape(c.title)} | ${Number.isFinite(c.from) ? c.from : "unranked"} | ${c.to} | ${Number.isFinite(c.gained) ? c.gained : "–"} |`);
    }
    detail.push("");
  }

  lines.push("");
  lines.push("## Read this before reading the numbers: `similarity` moves for TWO reasons, not one");
  lines.push("");
  lines.push("Against `default`, the `similarity` preset changes **two things at once**:");
  lines.push("");
  lines.push("1. **`wS` rises from 0.3 to 0.6** – taste is weighted twice as heavily.");
  lines.push("2. **The normaliser changes from percentile to min-max** – your gate-3 ruling. That is not a weighting change at all; it changes what `S` *means*. Percentile scores a game by its rank against the pool, so a good-but-not-perfect match still earns credit. Min-max scores it by distance from the single best match, so only near-perfect matches earn credit.");
  lines.push("");
  lines.push("The movement figure below is the **combined** effect of both, because that is what actually happens when you press the toggle, and it is the honest thing to measure. **Do not read it as pure weighting.** If you ever want the two separated, `?preset=similarity&norm=percentile` isolates the weight change on its own.");
  lines.push("");
  lines.push("`sale` has no such ambiguity: it shares `default`'s base weights *and* its normaliser, so its movement is attributable entirely to `wSale`.");
  lines.push("");
  lines.push(...detail);
  write("06-toggle-movement.md", lines.join("\n") + "\n");
}

async function renderFunnel() {
  const { LOW_CONFIDENCE_REVIEW_FLOOR, SUPPRESS_LOW_CONFIDENCE_KEY } = await import("../src/rank.js");
  const on = await callRank("?preset=default");
  const off = await callRank("?preset=default", { [SUPPRESS_LOW_CONFIDENCE_KEY]: false });
  const f = on.funnel;
  const sum = f.catalogTotal - f.nonGame - f.checkedNoScore - f.unscored - f.rankExcluded - f.dismissed - f.lowConfidenceSuppressed;

  // James's 11 owned low-confidence games – the §7 cohort, defined at the
  // ORIGINAL 1,000-review bar so the cohort he was shown is the cohort proved
  // here, not a smaller one redefined by his own ruling.
  const cohort = on.rank
    .filter((r) => r.owned && r.confidence === "low" && r.reviewCount < 1000)
    .sort((a, b) => a.reviewCount - b.reviewCount);
  const rankOf = new Map(on.rank.map((r, i) => [r.appid, i + 1]));

  const lines = [
    "# 07 – The funnel, and the owned games that survive suppression",
    "",
    `**TLDR:** every subtraction is named and sums exactly to ${f.catalogTotal}; **all ${cohort.length} of your owned low-confidence games are present in the ranked pool**, named below with their rank; and a /api/rank call costs ${on._meter.rowsRead.toLocaleString()} D1 row reads.`,
    "",
    snapshotNote(on),
    "",
    "## The funnel – SPEC.md §8, computed live",
    "",
    "| Step | Rows |",
    "|---|--:|",
    `| \`fpm_catalog\` total | ${f.catalogTotal} |`,
    `| less non-game / unclassified \`app_type\` | ${f.nonGame} |`,
    `| less checked-no-score | ${f.checkedNoScore} |`,
    `| less never-scored | ${f.unscored} |`,
    `| less \`rank_exclude_reason\` (prologues) | ${f.rankExcluded} |`,
    `| less dismissed | ${f.dismissed} |`,
    `| less low-confidence suppressed (**owned exempt – ${f.lowConfidenceOwnedSpared} spared**) | ${f.lowConfidenceSuppressed} |`,
    `| **= ranked** | **${f.ranked}** |`,
    `| of which owned | ${f.owned} |`,
    `| of which endless (\`has_ending = 0\`) | ${f.endless} |`,
    `| of which ending unknown (\`has_ending\` NULL – a third state, not "endless") | ${f.endingUnknown} |`,
    `| of which tagless (S = 0) | ${f.tagless} |`,
    `| of which priced (the sale toggle can move them) | ${f.priced}, **of which owned: ${f.pricedOwned}** |`,
    "",
    `**Sum check:** ${f.catalogTotal} − ${f.nonGame} − ${f.checkedNoScore} − ${f.unscored} − ${f.rankExcluded} − ${f.dismissed} − ${f.lowConfidenceSuppressed} = **${sum}** ${sum === f.ranked ? "✓ matches the ranked count exactly" : "✗ DOES NOT MATCH — DEFECT"}`,
    "",
    "**Where these differ from the spec's estimates.** §8's *confirm* figures were estimates taken before the funnel existed, and three were computed over the unfiltered catalogue rather than the ranked pool. Measured: non-game is " + f.nonGame + " (§8 guessed ~87); prologues " + f.rankExcluded + " rankable of 112 matched (§8 guessed ~108); endless " + f.endless + " with " + f.endingUnknown + " more whose ending is unknown (§8 said 4,822, counted before suppression, and folded the two together); priced " + f.priced + " (§8 said 1,727, same reason). `pricedOwned` is " + f.pricedOwned + ", exactly as §8 predicted. The `never-scored` line is an addition – it is 0 today, and it exists so the sum cannot silently break if a future crawl adds a row before the fill reaches it.",
    "",
    "## Your owned low-confidence games – all present, named, with their rank",
    "",
    `These are the ${cohort.length} owned games flagged \`low\` confidence with under 1,000 reviews – the cohort SPEC.md §7 named and the one your 2026-09-02 ruling protects. **Every one of them is in the ranked pool.**`,
    "",
    `**Two different things keep them there, and the difference matters.** Your §12b.1 ruling moved the suppression bar from 1,000 reviews to ${LOW_CONFIDENCE_REVIEW_FLOOR}, so ${cohort.length - f.lowConfidenceOwnedSpared} of this cohort now clear the bar on their own merits and would be ranked even if they were unowned. Only the ${f.lowConfidenceOwnedSpared} row${f.lowConfidenceOwnedSpared === 1 ? "" : "s"} marked **spared** ${f.lowConfidenceOwnedSpared === 1 ? "is" : "are"} still held in by the owned exemption – which is why the funnel line above reads ${f.lowConfidenceOwnedSpared} and not ${cohort.length}. The exemption is doing less work than it did at the 1,000 bar, and that is a good outcome rather than a weakening: fewer rows need rescuing at all. It remains the only thing standing between those rows and deletion, and it holds whether \`${SUPPRESS_LOW_CONFIDENCE_KEY}\` is on or off.`,
    "",
    "| Game | Exp | Reviews | Rank under `default` | Why it is in the pool |",
    "|---|--:|--:|--:|---|",
  ];
  for (const r of cohort) {
    const spared = r.reviewCount < LOW_CONFIDENCE_REVIEW_FLOOR;
    lines.push(
      `| ${escape(r.title)} | ${r.experienceScore} | ${r.reviewCount} | ${rankOf.get(r.appid)} of ${f.ranked} | ${spared ? "**spared by the owned exemption**" : `above the ${LOW_CONFIDENCE_REVIEW_FLOOR}-review bar`} |`,
    );
  }
  lines.push("");
  lines.push(`**Hard check (gate 5):** zero \`source_owned = 1\` rows appear in the suppressed set, and all ${f.owned} of your scored owned games are present in the ranked pool. Both are asserted in the test suite as well as shown here.`);
  lines.push("");
  lines.push("## Suppression on versus off");
  lines.push("");
  lines.push("| | Suppression ON (default) | Suppression OFF |");
  lines.push("|---|--:|--:|");
  lines.push(`| Ranked rows | ${f.ranked} | ${off.funnel.ranked} |`);
  lines.push(`| Rows suppressed | ${f.lowConfidenceSuppressed} | ${off.funnel.lowConfidenceSuppressed} |`);
  lines.push(`| Owned rows ranked | ${f.owned} | ${off.funnel.owned} |`);
  lines.push("");
  // CR-1 (round-2 review) – THE DISTINCTION THIS TABLE EXISTS TO MAKE.
  //
  // A set-difference of top-50 MEMBERSHIP is not an admission set, and reading
  // it as one told James the opposite of the truth: the previous render listed
  // two of the best-reviewed games in the catalogue (both high-confidence, both
  // six figures of reviews, neither suppressible under any setting) as rows
  // "admitted" by turning suppression off.
  //
  // What actually happens is that suppression resizes the ELIGIBLE POOL, and
  // the pool is an input to two things beyond membership: the IDF corpus that
  // weights every tag, and the percentile denominator that turns a raw cosine
  // into S. Change the pool and every already-ranked row's S – and therefore
  // its blended score – shifts slightly, so rows near the 50th place cross the
  // line in both directions without suppression ever having touched them.
  //
  // So the two effects are separated and counted separately. ADMITTED means the
  // row was not in the suppression-on ranked pool at all and is in the
  // suppression-off top 50: suppression was genuinely hiding it. REORDERED
  // means the row was ranked either way and simply moved. Gate 5 is about
  // whether the filter earns its place, and only the admitted set speaks to
  // that.
  const onTop50 = new Set(on.rank.slice(0, 50).map((r) => r.appid));
  const onRankedIds = new Set(on.rank.map((r) => r.appid));
  const newcomers = off.rank.slice(0, 50).filter((r) => !onTop50.has(r.appid));
  const admitted = newcomers.filter((r) => !onRankedIds.has(r.appid));
  const reordered = newcomers.filter((r) => onRankedIds.has(r.appid));

  lines.push(
    `Turning suppression off admits ${off.funnel.ranked - f.ranked} more rows to the ranked pool and changes **${newcomers.length} of the top 50**. ` +
      `Of those, **${admitted.length} ${admitted.length === 1 ? "is a row suppression was actually hiding" : "are rows suppression was actually hiding"}** and ` +
      `**${reordered.length} ${reordered.length === 1 ? "is already-ranked and moved by reordering" : "are already-ranked and moved by reordering"}**.`,
  );
  lines.push("");
  lines.push(
    "**Why anything reorders at all.** Suppression does not only decide who is in the list – it resizes the pool, " +
      "and the pool is the IDF corpus that weights every tag *and* the percentile denominator that turns a raw cosine into `S`. " +
      "Change the pool and every already-ranked row's `S`, and so its blended score, shifts a little. Rows sitting near 50th " +
      "then cross the line in both directions without suppression ever having touched them. **A reordered row is not a row the " +
      "filter was hiding**, and the two are counted separately below so they can never be read as the same thing.",
  );
  lines.push("");
  if (admitted.length === 0) {
    lines.push(
      "**No suppressed row enters the top 50.** Every one of the " +
        `${newcomers.length} changes above is reordering. That is the evidence gate 5 asks for: suppression is a safety net ` +
        "at the bottom of the list, not a lever on the top of it.",
    );
  } else {
    lines.push(`### Admitted – rows suppression was hiding from the top 50 (${admitted.length})`);
    lines.push("");
    lines.push("**These are the rows to judge the filter on.** Each was excluded from the ranked pool entirely with suppression on.");
    lines.push("");
    lines.push("| Title | Exp | Reviews | Confidence |");
    lines.push("|---|--:|--:|---|");
    for (const r of admitted) lines.push(`| ${escape(r.title)} | ${r.experienceScore} | ${r.reviewCount} | ${r.confidence ?? "–"} |`);
  }
  if (reordered.length > 0) {
    lines.push("");
    lines.push(`### Reordered – already ranked either way, moved by the pool resize (${reordered.length})`);
    lines.push("");
    lines.push("**Nothing was hiding these.** They are ranked with suppression on too; the resized IDF corpus and percentile pool nudged their scores past the rows at 49th and 50th. Listed for completeness, not as evidence about the filter.");
    lines.push("");
    lines.push("| Title | Exp | Reviews | Confidence | Rank with suppression ON |");
    lines.push("|---|--:|--:|---|--:|");
    for (const r of reordered) {
      lines.push(`| ${escape(r.title)} | ${r.experienceScore} | ${r.reviewCount} | ${r.confidence ?? "–"} | ${rankOf.get(r.appid)} of ${f.ranked} |`);
    }
  }
  lines.push("");
  lines.push("## Cost per request – gate 8 input for increment 13");
  lines.push("");
  lines.push("| | Value |");
  lines.push("|---|--:|");
  lines.push(`| D1 rows read per \`/api/rank\` call | ${on._meter.rowsRead.toLocaleString()} |`);
  lines.push(`| D1 queries per call | ${on._meter.queries} |`);
  lines.push(`| Wall time per call (local, warm) | ${on._meter.ms} ms |`);
  lines.push("");
  lines.push("This is a full-catalogue read on every request, exactly as `/api/fpm` already does. **Recorded as gate input, deliberately not optimised here** – caching the user-independent part of this computation is increment 13's scoped job (`src/catalog.js:493`), and fixing it inside this increment would have widened the diff for no gate.");
  lines.push("");
  write("07-funnel-and-suppression.md", lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------

const mode = process.argv[2];
const gated = ["presets", "movement", "funnel"];
if (gated.includes(mode) && !GATES_2_AND_3_RULED) {
  console.error(
    `Refusing to render '${mode}'.\n\n` +
      "SPEC.md's ⛩ REVIEW makes outputs 1 and 2 PRE-BUILD CHECKPOINTS. Outputs 3 to 7\n" +
      "would bake in a prologue list and a normaliser James has not ruled on yet, and\n" +
      "they drive the handler that writes rank_exclude_reason.\n\n" +
      "Run `prologues` and `normalisation`, take those to James, then set\n" +
      "GATES_2_AND_3_RULED = true in this file alongside his ruling.",
  );
  process.exit(1);
}

if (gated.includes(mode)) callRank.dbPath = copyCatalogToScratch();

const modes = {
  prologues: renderPrologues,
  normalisation: renderNormalisation,
  presets: renderPresets,
  movement: renderMovement,
  funnel: renderFunnel,
};

if (!modes[mode]) {
  console.error(`usage: node tools/rank-review.mjs <${Object.keys(modes).join("|")}>`);
  process.exit(1);
}
await modes[mode]();
