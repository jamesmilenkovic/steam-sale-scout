#!/usr/bin/env node
// ---------------------------------------------------------------------------
// claude-bridge – the local `claude -p` helper for Increment 10's experience
// fill. DEV-TIME TOOL, LOCAL ONLY. Not part of the Worker, never deployed.
//
// WHY IT EXISTS (live probe finding 5, scratchpad/inc10-probe-findings.md):
// SPEC.md §4.3 puts the fill in src/catalog.js, wired into
// runFpmSyncPipeline. That code runs inside a Cloudflare Worker under
// `wrangler dev` (workerd), which has no shell and cannot spawn a process –
// so it cannot invoke the `claude` CLI itself. Route A (the chosen route:
// $0, on James's existing plan) therefore needs one small process outside
// the Worker that can. The Worker reaches it by ordinary `fetch` to
// 127.0.0.1.
//
// The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) was checked as the
// alternative before this was written. It does not remove the need for this
// process – it is a Node library that itself spawns the same `claude` CLI,
// so a Worker cannot run it either. It would add a runtime dependency to a
// project that currently has none, and would change the envelope shape that
// the model-attribution logic in src/catalog.js was measured against. So the
// proven probe call (`claude -p --output-format json`) is used, with the
// round-1 review's hardening flags added (see THREAT MODEL below).
//
// WHAT IT IS NOT. It carries a prompt out and the raw JSON envelope back,
// and nothing else. There is deliberately NO rubric here, no batching, no
// parsing of the scores, no ghost guard, no D1. All of that is D1 discipline
// and lives in src/catalog.js where SPEC.md §4.3 requires it. If you find
// yourself wanting to add scoring logic to this file, it belongs in
// backfillExperienceScores instead.
//
// RUN IT:   npm run bridge          (or: node tools/claude-bridge.mjs)
//           It prints a one-run shared token. Put that token in .dev.vars as
//           EXPERIENCE_HELPER_TOKEN and restart `npm run dev`, or pin it
//           ahead of time by starting the bridge with CLAUDE_BRIDGE_TOKEN
//           already set to the same value.
// THEN:     POST /api/fpm/sync?continue=1   in the app
//
// If it is NOT running, that is fine and normal: src/catalog.js health-checks
// it once per sync run and skips the experience step entirely, exactly the
// way the price step is skipped without an ITAD_API_KEY. Nothing else in the
// app is affected.
//
// ROUTES
//   GET  /health   -> {"ok":true,"tool":"claude-bridge"}   (no token: this is
//                     only the "is anything listening" probe, and it says
//                     nothing a port scan would not already say.)
//   POST /prompt   -> body {"prompt":"...","model":"opus"}
//                     header x-bridge-token: <the printed token>
//                     200 with the VERBATIM `claude -p --output-format json`
//                     envelope, or 502 {"error":"..."} if the CLI failed.
//
// THREAT MODEL (round-1 review, SEC-1..SEC-5 / CR-6). This process runs a
// coding agent with James's plan credentials, unattended, for hours. Five
// things bound it:
//   1. It binds 127.0.0.1 only, never 0.0.0.0 – not reachable off-box.
//   2. Every request must carry a `Host` of 127.0.0.1:PORT or
//      localhost:PORT. That is the DNS-rebinding guard: a rebound name
//      resolving to 127.0.0.1 still sends its own hostname in `Host`.
//   3. POST /prompt must be application/json AND carry the shared token.
//      Requiring a non-simple content-type forces a CORS preflight, which
//      this server never answers, so a random web page James has open
//      cannot post here at all; the token covers everything else.
//   4. The CLI is invoked with ALL built-in tools disabled and a one-turn
//      cap, so even a prompt-injecting game name cannot make the agent act.
//   5. `execFile` gets an explicit minimal env and an explicit cwd, so the
//      turn cannot inherit unrelated secrets and cannot pick up a different
//      CLAUDE.md depending on where `npm run bridge` was launched.
// Consistent with SPEC.md §10.1 (local-only, no deploy).
// ---------------------------------------------------------------------------

import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);

const HOST = "127.0.0.1";
const PORT = Number(process.env.CLAUDE_BRIDGE_PORT) || 8788;

/** Minimum length for a PINNED token (round-2 review SEC-9). The generated
 * default is 48 hex characters; a pinned one must be in the same league.
 * Without this, `CLAUDE_BRIDGE_TOKEN=x` was accepted silently and the only
 * guard on a process that runs an agent with James's plan credentials became
 * a one-character secret. Refusing at startup is the right moment: it is
 * loud, it is before anything is listening, and the fix is obvious. */
const MIN_PINNED_TOKEN_CHARS = 32;

/** The shared secret the Worker must present on POST /prompt. Generated per
 * run unless CLAUDE_BRIDGE_TOKEN pins it – pinning is what lets .dev.vars
 * hold a stable value across bridge restarts instead of being re-pasted. */
const PINNED_TOKEN = process.env.CLAUDE_BRIDGE_TOKEN;
if (PINNED_TOKEN !== undefined && PINNED_TOKEN.length < MIN_PINNED_TOKEN_CHARS) {
  console.error(
    `[claude-bridge] REFUSING TO START: CLAUDE_BRIDGE_TOKEN is ${PINNED_TOKEN.length} characters,` +
      ` and a pinned token must be at least ${MIN_PINNED_TOKEN_CHARS}. Unset it to get a generated one,` +
      ` or pin something like: node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'`,
  );
  process.exit(1);
}
const TOKEN = PINNED_TOKEN || randomBytes(24).toString("hex");

/** Matches the probe's `timeout: 600000` exactly. Batches measured at ~29s,
 * so ten minutes is ~20x headroom for one 25-row request. */
const CLI_TIMEOUT_MS = 600_000;

/** The probe's `maxBuffer` – a 25-row JSON reply is a few KB, so this is a
 * runaway guard, not a real bound. */
const CLI_MAX_BUFFER = 40 * 1024 * 1024;

/** Bounds one request body. A 25-row prompt is ~4 KB; this is 250x that. */
const MAX_BODY_BYTES = 1024 * 1024;

/** `model` is passed straight into argv. execFile takes an argument ARRAY
 * and no shell, so there is no shell-injection surface – but a value like
 * "--dangerously-skip-permissions" would still be read by the CLI as a FLAG
 * rather than a model name. This allowlist makes that impossible. */
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Hosts a legitimate caller can present. Anything else is a rebinding
 * attempt or a proxy we did not expect, and is refused. */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

/** The cwd the CLI turn runs in. Pinned to the REPO ROOT (this file lives in
 * <repo>/tools/), because without a cwd `claude -p` resolves CLAUDE.md from
 * wherever `npm run bridge` happened to be launched, and the resolved memory
 * set is part of the system prompt the scores were measured under. Both §6
 * probes ran with cwd = <repo>/scratchpad, which contains no CLAUDE.md, so
 * its memory set is <repo>/CLAUDE.md + ~/.claude/CLAUDE.md – identical to the
 * repo root's. The repo root is chosen over scratchpad/ because it always
 * exists in a fresh clone. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One agentic turn, no tools. With `--tools ""` there is no tool-use loop to
 * iterate, so a scoring reply is a single turn by construction; the cap is
 * belt-and-braces against a prompt that tries to start one. Both flags
 * verified against the installed CLI (`claude --version` 2.1.251) and the
 * published CLI reference via context7. */
const CLI_MAX_TURNS = "1";

/** The ONLY environment the CLI turn sees. PATH so it can find its own
 * helpers, HOME so it can find its own credentials and config, and the
 * locale/temp basics. Everything else in this process's env – ITAD keys,
 * Steam keys, anything else a shell profile exported – is withheld. If the
 * CLI ever genuinely needs another variable, add it here by name; do not go
 * back to inheriting `process.env`. */
const CLI_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR"];
const CLI_ENV = Object.fromEntries(
  CLI_ENV_KEYS.filter((k) => typeof process.env[k] === "string").map((k) => [k, process.env[k]]),
);

/** True while a CLI turn is running. The Worker drives batches strictly
 * serially, so refusing a second concurrent call costs the fill nothing and
 * removes the "N parallel agents, each with a 40 MB buffer" failure mode. */
let inFlight = false;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Constant-time compare of the presented token against TOKEN.
 *
 * The length pre-check IS a length oracle, and it is here deliberately
 * (round-2 review SEC-9 corrected an earlier comment that claimed the
 * opposite). `timingSafeEqual` THROWS on buffers of different lengths, so
 * something has to handle that case; returning early is the standard
 * treatment. What is protected is the token's CONTENT, which is the part
 * that is secret – its length is 48 hex characters and is printed to the
 * console at startup anyway. */
function tokenOk(presented) {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // A socket-level error on the response must not reject this handler –
  // see the process-level handlers below for why that matters.
  res.on("error", (err) => console.error(`[claude-bridge] response socket error: ${err?.message ?? err}`));

  if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) {
    json(res, 403, { error: "bad host header" });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true, tool: "claude-bridge" });
    return;
  }

  if (req.method !== "POST" || req.url !== "/prompt") {
    json(res, 404, { error: "not found" });
    return;
  }

  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    json(res, 415, { error: "content-type must be application/json" });
    return;
  }

  if (!tokenOk(req.headers["x-bridge-token"])) {
    console.error("[claude-bridge] refused a POST /prompt with a missing or wrong x-bridge-token");
    json(res, 401, { error: "missing or invalid x-bridge-token" });
    return;
  }

  // ROUND-2 REVIEW SEC-6. The claim and the CLAIMING must happen on the same
  // synchronous tick. Node runs this handler on one thread, but every
  // `await` below yields, so a check here and an `inFlight = true` after
  // `await readBody(req)` would let two concurrent POSTs both pass the check
  // and both spawn a CLI – two agents on James's plan, each with a 40 MB
  // buffer. Everything from this line to the `finally` is inside the claim.
  if (inFlight) {
    json(res, 409, { error: "a prompt is already in flight" });
    return;
  }
  inFlight = true;

  const startedAt = Date.now();
  try {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      // The oversized-body path destroys the request; writing to it then
      // would throw inside this async handler and take the whole bridge down.
      if (req.destroyed) return;
      json(res, 400, { error: `bad request body: ${err?.message ?? err}` });
      return;
    }

    const prompt = payload?.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      json(res, 400, { error: "`prompt` must be a non-empty string" });
      return;
    }
    const model = typeof payload?.model === "string" ? payload.model : "opus";
    if (!MODEL_PATTERN.test(model)) {
      json(res, 400, { error: "`model` must match /^[A-Za-z0-9._-]{1,64}$/" });
      return;
    }

    // The probe's call plus the round-1 hardening. `--output-format json` is
    // what carries the `modelUsage` map src/catalog.js reads the real scoring
    // model out of. `--tools ""` disables every built-in tool and
    // `--max-turns 1` caps the turn, so an injected instruction inside a
    // SteamSpy game name has nothing to act with. The bare `--` makes the
    // prompt positional: without it a prompt beginning with "-" would be
    // parsed as an option, the same hole MODEL_PATTERN closes for `model`.
    const { stdout } = await run(
      "claude",
      ["-p", "--output-format", "json", "--model", model, "--tools", "", "--max-turns", CLI_MAX_TURNS, "--", prompt],
      { cwd: REPO_ROOT, env: CLI_ENV, maxBuffer: CLI_MAX_BUFFER, timeout: CLI_TIMEOUT_MS },
    );
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    // Passed through as raw text, NOT re-serialised: whatever the CLI
    // returned is what src/catalog.js parses, so this process can never
    // reshape an envelope in a way the caller has not seen in a probe.
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(stdout) });
    res.end(stdout);
    console.log(`[claude-bridge] ok in ${seconds}s (${prompt.length} chars in, ${stdout.length} out)`);
  } catch (err) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const message = String(err?.stderr || err?.message || err).slice(0, 500);
    console.error(`[claude-bridge] FAILED after ${seconds}s: ${message}`);
    // 502, not 500: the failure is upstream of this process. src/catalog.js
    // treats any non-2xx as a failed batch and backs off.
    json(res, 502, { error: message });
  } finally {
    inFlight = false;
  }
});

// A six-hour unattended fill must not be ended by one stray socket error or
// one unhandled rejection. Log loudly and keep listening – the Worker's own
// retry/backoff handles whatever request was in flight.
process.on("unhandledRejection", (err) => {
  console.error(`[claude-bridge] unhandled rejection (staying up): ${err?.stack || err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[claude-bridge] uncaught exception (staying up): ${err?.stack || err}`);
});

server.listen(PORT, HOST, () => {
  console.log(`[claude-bridge] listening on http://${HOST}:${PORT} (127.0.0.1 only)`);
  console.log(`[claude-bridge] cwd for the CLI turn: ${REPO_ROOT}`);
  console.log("[claude-bridge] tools disabled, one turn, minimal env");
  console.log("[claude-bridge] ---------------------------------------------------------------");
  console.log("[claude-bridge] Put this line in .dev.vars, then restart `npm run dev`:");
  console.log(`[claude-bridge]     EXPERIENCE_HELPER_TOKEN=${TOKEN}`);
  console.log("[claude-bridge] (or start the bridge with CLAUDE_BRIDGE_TOKEN set to pin it)");
  console.log("[claude-bridge] ---------------------------------------------------------------");
});
