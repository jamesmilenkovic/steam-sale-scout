// QA TC-7 (round-2 review) – contract tests for tools/claude-bridge.mjs.
//
// WHY THIS FILE EXISTS. The bridge is the transport for the entire increment
// 10 fill: every one of the ~729 batches goes workerd -> fetch -> 127.0.0.1
// -> `claude -p` -> back. It had zero tests. Everything that was known about
// its behaviour came from live curl checks recorded in the review folder,
// which prove it worked once, on one machine, on one afternoon.
//
// WHAT IS TESTED, AND HOW IT STAYS HERMETIC.
//   * The bridge is started as a REAL child process on an EPHEMERAL port, so
//     these tests never touch 8787/8788/8790/8791 and cannot disturb a fill.
//   * `claude` is SHIMMED: the child is spawned with PATH pointing at a temp
//     directory holding a fake `claude` shell script and nothing else, so the
//     real CLI can never be reached — no plan usage, no network, no cost.
//     The shim records its argv and cwd to a file, which is how the
//     `--tools ""` / `--max-turns 1` / cwd-pinning claims get asserted rather
//     than believed.
//   * Every assertion is on an HTTP status and a JSON envelope, so there is
//     no timing flake beyond process startup, which is awaited on the
//     bridge's own "listening" line rather than slept on.
//
// WHAT IS NOT TESTED HERE. The two things that need the real CLI: that
// `claude` accepts these flags (proved live in
// review/inc-10/07-sec7-tools-disabled-proof.md against CLI 2.1.251) and that
// the model returns usable scores (gate (d)). A shim cannot speak to either.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FPM_EXPERIENCE_MODEL } from "../src/catalog.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(REPO_ROOT, "tools", "claude-bridge.mjs");

/** Ports the live fill and its `wrangler dev` own. A test that bound one of
 * these would kill a six-hour run, so the port picker refuses them outright
 * rather than trusting the ephemeral range to avoid them. */
const FORBIDDEN_PORTS = new Set([8787, 8788, 8790, 8791]);

/** A 48-hex-character token, the same shape the bridge generates for itself.
 * Long enough to clear MIN_PINNED_TOKEN_CHARS with room to spare. */
const GOOD_TOKEN = "a".repeat(48);

/** The `claude -p --output-format json` envelope, trimmed to the fields
 * src/catalog.js actually reads (`is_error`, `result`, `modelUsage`) plus the
 * ones the live capture carries. Deliberately the same shape
 * test/catalog-experience.test.mjs stubs, because the whole point of this
 * file is to check that the stub is not a fiction. */
const FAKE_ENVELOPE = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: '[{"appid":10,"experience_score":70,"has_ending":true,"hours_to_value":8,"hours_to_good":1,"reason":"Tight authored campaign.","confidence":"high"}]',
  total_cost_usd: 0.17,
  modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 900, outputTokens: 12 },
    "claude-opus-4-6": { inputTokens: 4200, outputTokens: 1800 },
  },
};

/** Ask the OS for a free port by binding 0 and letting go. There is a race
 * between release and re-bind, which is why the bridge's own failure to bind
 * would surface as a startup timeout rather than a wrong answer. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => (FORBIDDEN_PORTS.has(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}

/**
 * Write a fake `claude` onto a throwaway PATH.
 *
 * @param {object} opts
 * @param {"ok"|"slow"|"fail"} opts.mode  ok = print the envelope; slow = the
 *   same after ~1.2s, which is what makes a second concurrent POST overlap
 *   the first; fail = exit 1 with stderr, i.e. what a CLI crash looks like.
 * @returns {{binDir: string, recordPath: string, reads: () => Array<{argv: string[], cwd: string}>}}
 */
function makeFakeClaude({ mode = "ok" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-test-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const recordPath = path.join(dir, "invocations.jsonl");

  // Every external command is absolute or a shell builtin, because PATH is
  // deliberately reduced to binDir when this runs.
  const body =
    mode === "fail"
      ? `printf 'fake claude exploded\\n' >&2\nexit 1\n`
      : `${mode === "slow" ? "/bin/sleep 1.2\n" : ""}printf '%s' '${JSON.stringify(FAKE_ENVELOPE)}'\n`;

  fs.writeFileSync(
    path.join(binDir, "claude"),
    `#!/bin/sh
# QA TC-7 shim. Records argv (one arg per line, so an empty arg is visible as
# an empty line) and the cwd it was invoked in, then answers like the CLI.
{
  printf 'CWD\\t%s\\n' "$PWD"
  for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done
  printf 'END\\n'
} >> ${JSON.stringify(recordPath)}
${body}`,
    { mode: 0o755 },
  );

  return {
    binDir,
    recordPath,
    /** Parse the shim's record into one entry per invocation. */
    reads() {
      if (!fs.existsSync(recordPath)) return [];
      const out = [];
      let current = null;
      for (const line of fs.readFileSync(recordPath, "utf8").split("\n")) {
        if (line.startsWith("CWD\t")) current = { cwd: line.slice(4), argv: [] };
        else if (line.startsWith("ARG\t")) current?.argv.push(line.slice(4));
        else if (line === "END" && current) {
          out.push(current);
          current = null;
        }
      }
      return out;
    },
  };
}

/**
 * Start tools/claude-bridge.mjs as a child process with the shim on PATH.
 * Resolves once the bridge prints its own "listening" line, so nothing here
 * sleeps waiting for a port to come up.
 */
async function startBridge({ token = GOOD_TOKEN, mode = "ok", port } = {}) {
  const fake = makeFakeClaude({ mode });
  const usePort = port ?? (await freePort());
  const proc = spawn(process.execPath, [BRIDGE], {
    cwd: os.tmpdir(), // deliberately NOT the repo root: the bridge pins its own cwd
    env: {
      PATH: fake.binDir, // the real `claude` is unreachable, by construction
      HOME: fake.binDir,
      CLAUDE_BRIDGE_PORT: String(usePort),
      CLAUDE_BRIDGE_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c) => (stdout += c));
  proc.stderr.on("data", (c) => (stderr += c));

  const exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge never listened. stdout=${stdout} stderr=${stderr}`)), 10_000);
    proc.stdout.on("data", () => {
      if (stdout.includes("listening on http://")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited with ${code} before listening. stderr=${stderr}`));
    });
  });

  const handle = {
    port: usePort,
    proc,
    fake,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await exited;
      fs.rmSync(path.dirname(fake.binDir), { recursive: true, force: true });
    },
  };

  try {
    await listening;
  } catch (err) {
    await handle.stop();
    throw err;
  }
  return handle;
}

/**
 * One raw HTTP request. node:http rather than fetch, because `Host` is a
 * forbidden header for fetch and the DNS-rebinding guard is precisely what
 * one of these tests has to poke.
 */
function request(port, { method = "GET", path: urlPath = "/health", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The request src/catalog.js:2565 actually makes, reproduced exactly. */
function promptRequest(port, { token = GOOD_TOKEN, prompt = "score these games", model = FPM_EXPERIENCE_MODEL, contentType = "application/json", host } = {}) {
  const headers = { "content-type": contentType, "x-bridge-token": token };
  if (host !== undefined) headers.host = host;
  return request(port, { method: "POST", path: "/prompt", headers, body: JSON.stringify({ prompt, model }) });
}

// ---------------------------------------------------------------------------
// The two envelopes src/catalog.js depends on.
// ---------------------------------------------------------------------------

test("GET /health returns exactly {ok:true, tool:'claude-bridge'} — the shape isExperienceHelperAvailable reads", async () => {
  const bridge = await startBridge();
  try {
    const res = await request(bridge.port, { path: "/health" });

    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    const body = JSON.parse(res.text);
    // Exhaustive: catalog.js only reads `ok`, but a stub that promises this
    // envelope and a server that returns a different one is the entire
    // failure mode this file exists to rule out.
    assert.deepEqual(Object.keys(body).sort(), ["ok", "tool"]);
    assert.equal(body.ok, true);
    assert.equal(body.tool, "claude-bridge");
    assert.deepEqual(bridge.fake.reads(), [], "/health must never spawn the CLI");
  } finally {
    await bridge.stop();
  }
});

test("POST /prompt returns the CLI envelope VERBATIM, byte for byte, and never re-serialises it", async () => {
  const bridge = await startBridge();
  try {
    const res = await promptRequest(bridge.port);

    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    // Byte-identical to what the CLI wrote on stdout. This is the property
    // the comment in claude-bridge.mjs claims and the reason
    // scoringModelFromEnvelope can trust `modelUsage` at all.
    assert.equal(res.text, JSON.stringify(FAKE_ENVELOPE));
    assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(res.text));

    const envelope = JSON.parse(res.text);
    assert.deepEqual(
      Object.keys(envelope).sort(),
      ["is_error", "modelUsage", "result", "subtype", "total_cost_usd", "type"],
      "the same envelope shape test/catalog-experience.test.mjs stubs",
    );
    assert.equal(envelope.is_error, false);
    assert.equal(typeof envelope.result, "string");
    assert.equal(typeof envelope.modelUsage, "object");
  } finally {
    await bridge.stop();
  }
});

test("POST /prompt invokes the CLI with tools disabled, one turn, a bare -- and the repo root as cwd", async () => {
  const bridge = await startBridge();
  try {
    await promptRequest(bridge.port, { prompt: "appid 10 | Portal" });

    const invocations = bridge.fake.reads();
    assert.equal(invocations.length, 1);
    assert.deepEqual(
      invocations[0].argv,
      ["-p", "--output-format", "json", "--model", FPM_EXPERIENCE_MODEL, "--tools", "", "--max-turns", "1", "--", "appid 10 | Portal"],
      "SEC-7: --tools '' and --max-turns 1 are what stop an injected game name from acting, " +
        "and the bare -- is what stops a prompt beginning with '-' being read as a flag",
    );
    // CR-6: the cwd is pinned to the repo root, NOT to wherever the bridge
    // was launched from — this child was deliberately spawned in os.tmpdir().
    // The resolved CLAUDE.md memory set is part of the system prompt the
    // gate-(d) scores were measured under.
    assert.equal(fs.realpathSync(invocations[0].cwd), fs.realpathSync(REPO_ROOT));
  } finally {
    await bridge.stop();
  }
});

// ---------------------------------------------------------------------------
// The four rejections. Each one also asserts the CLI was never spawned: a
// guard that refuses AFTER starting an agent turn would be no guard at all.
// ---------------------------------------------------------------------------

test("403 on a Host header that is not loopback — the DNS-rebinding guard, checked before routing", async () => {
  const bridge = await startBridge();
  try {
    const rebound = await promptRequest(bridge.port, { host: "scout.evil.example" });
    assert.equal(rebound.status, 403);
    assert.deepEqual(JSON.parse(rebound.text), { error: "bad host header" });

    // It is checked before ROUTING, not just before the token: even /health,
    // which needs no token, is refused.
    const health = await request(bridge.port, { path: "/health", headers: { host: "scout.evil.example" } });
    assert.equal(health.status, 403);

    // And localhost:PORT, the other legitimate spelling, is still accepted.
    const ok = await request(bridge.port, { path: "/health", headers: { host: `localhost:${bridge.port}` } });
    assert.equal(ok.status, 200);

    assert.deepEqual(bridge.fake.reads(), [], "a refused host must never reach the CLI");
  } finally {
    await bridge.stop();
  }
});

test("415 on a content-type that is not application/json — the CORS-preflight guard", async () => {
  const bridge = await startBridge();
  try {
    // text/plain is a SIMPLE content type: a random page James has open could
    // send this cross-origin with no preflight. Refusing it is what makes the
    // token the only thing left to get past.
    const res = await promptRequest(bridge.port, { contentType: "text/plain" });
    assert.equal(res.status, 415);
    assert.deepEqual(JSON.parse(res.text), { error: "content-type must be application/json" });

    // A charset parameter is still application/json and must be accepted.
    const withCharset = await promptRequest(bridge.port, { contentType: "application/json; charset=utf-8" });
    assert.equal(withCharset.status, 200);

    assert.equal(bridge.fake.reads().length, 1, "only the accepted request reached the CLI");
  } finally {
    await bridge.stop();
  }
});

test("401 on a missing or wrong x-bridge-token, and the check is on content not length", async () => {
  const bridge = await startBridge();
  try {
    const missing = await request(bridge.port, {
      method: "POST",
      path: "/prompt",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(JSON.parse(missing.text), { error: "missing or invalid x-bridge-token" });

    const wrongLength = await promptRequest(bridge.port, { token: "short" });
    assert.equal(wrongLength.status, 401);

    // Same length, one character different — the case timingSafeEqual is
    // there for, and the one a length check alone would let through.
    const sameLength = await promptRequest(bridge.port, { token: "b" + GOOD_TOKEN.slice(1) });
    assert.equal(sameLength.status, 401);

    assert.deepEqual(bridge.fake.reads(), [], "a refused token must never reach the CLI");
  } finally {
    await bridge.stop();
  }
});

test("409 single-flight: a second concurrent POST /prompt is refused, and only ONE agent turn ever runs", async () => {
  // Two `claude` processes on James's plan at once, each with a 40 MB buffer,
  // is the failure this guard exists to prevent. The shim sleeps 1.2s so the
  // two requests genuinely overlap rather than racing to be sequential.
  const bridge = await startBridge({ mode: "slow" });
  try {
    const first = promptRequest(bridge.port, { prompt: "first" });
    // Give the first request time to be accepted and claim the flag, but not
    // to finish — the shim's own sleep is what guarantees the overlap.
    await new Promise((r) => setTimeout(r, 250));
    const second = await promptRequest(bridge.port, { prompt: "second" });

    assert.equal(second.status, 409);
    assert.deepEqual(JSON.parse(second.text), { error: "a prompt is already in flight" });

    const firstRes = await first;
    assert.equal(firstRes.status, 200, "the refusal must not disturb the request already in flight");
    assert.equal(firstRes.text, JSON.stringify(FAKE_ENVELOPE));

    const invocations = bridge.fake.reads();
    assert.equal(invocations.length, 1, "exactly one CLI turn ran, not two");
    assert.ok(invocations[0].argv.includes("first"));

    // And the flag is released, not stuck: the next request succeeds.
    const third = await promptRequest(bridge.port, { prompt: "third" });
    assert.equal(third.status, 200);
    assert.equal(bridge.fake.reads().length, 2);
  } finally {
    await bridge.stop();
  }
});

// ---------------------------------------------------------------------------
// The pinned-token strength floor (round-2 review SEC-9).
// ---------------------------------------------------------------------------

test("a pinned CLAUDE_BRIDGE_TOKEN below 32 characters refuses to start, and nothing is left listening", async () => {
  const port = await freePort();
  const fake = makeFakeClaude({});
  const proc = spawn(process.execPath, [BRIDGE], {
    env: { PATH: fake.binDir, HOME: fake.binDir, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BRIDGE_TOKEN: "z".repeat(31) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  proc.stderr.on("data", (c) => (stderr += c));
  proc.stdout.on("data", (c) => (stdout += c));
  const code = await new Promise((resolve) => proc.on("exit", resolve));

  assert.equal(code, 1, "it must exit non-zero, loudly, before anything is listening");
  assert.match(stderr, /REFUSING TO START/);
  assert.match(stderr, /31 characters/);
  assert.equal(stdout.includes("listening on"), false, "and it must never have listened");

  // Nothing is holding the port: a fresh server can take it.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
  fs.rmSync(path.dirname(fake.binDir), { recursive: true, force: true });
});

test("exactly 32 characters is accepted — the floor is >= 32, not > 32", async () => {
  const bridge = await startBridge({ token: "y".repeat(32) });
  try {
    const res = await request(bridge.port, { path: "/health" });
    assert.equal(res.status, 200);
    const authed = await promptRequest(bridge.port, { token: "y".repeat(32) });
    assert.equal(authed.status, 200);
  } finally {
    await bridge.stop();
  }
});

// ---------------------------------------------------------------------------
// Everything else src/catalog.js's requestExperienceBatch has a branch for.
// ---------------------------------------------------------------------------

test("a CLI failure is a 502 with a JSON error — the non-2xx src/catalog.js counts as a failed batch, not a crash", async () => {
  const bridge = await startBridge({ mode: "fail" });
  try {
    const res = await promptRequest(bridge.port);

    assert.equal(res.status, 502);
    const body = JSON.parse(res.text);
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.match(body.error, /fake claude exploded/);

    // Fail-soft: the bridge is still up and still serving after it.
    const health = await request(bridge.port, { path: "/health" });
    assert.equal(health.status, 200);
  } finally {
    await bridge.stop();
  }
});

test("a `model` outside MODEL_PATTERN is a 400 and never becomes a CLI argument", async () => {
  const bridge = await startBridge();
  try {
    for (const model of ["opus; rm -rf /", "opus $(whoami)", "a".repeat(65), "opus\nmore"]) {
      const res = await promptRequest(bridge.port, { model });
      assert.equal(res.status, 400, `model ${JSON.stringify(model)} should be refused`);
      assert.match(JSON.parse(res.text).error, /`model` must match/);
    }

    const empty = await promptRequest(bridge.port, { prompt: "" });
    assert.equal(empty.status, 400);
    assert.match(JSON.parse(empty.text).error, /`prompt` must be a non-empty string/);

    assert.deepEqual(bridge.fake.reads(), [], "nothing refused reached the CLI");
  } finally {
    await bridge.stop();
  }
});

test("QA FINDING B-1 (bug pin): MODEL_PATTERN allows a LEADING HYPHEN, so a flag-shaped model still reaches argv", async () => {
  // This test pins CURRENT behaviour and is deliberately not an endorsement
  // of it. tools/claude-bridge.mjs's own comment says:
  //
  //   "a value like "--dangerously-skip-permissions" would still be read by
  //    the CLI as a FLAG rather than a model name. This allowlist makes that
  //    impossible."
  //
  // It does not. MODEL_PATTERN is /^[A-Za-z0-9._-]{1,64}$/, and `-` is inside
  // the character class with no anchor forbidding it in first position, so
  // "--dangerously-skip-permissions" matches the allowlist and is passed
  // through as the argument after `--model`. Whether the CLI then reads it as
  // a value or as a flag is the CLI's argument parser's business, which is
  // exactly the uncertainty the comment claims to have removed.
  //
  // Reachability is low: it needs the 48-character token, and anyone holding
  // that can already send an arbitrary prompt. So this is a minor for the
  // coder, not a blocker — but the code and its comment disagree, and one of
  // them has to move. WHEN THE FIX LANDS (a leading `-` rejected, e.g.
  // /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/), THIS TEST MUST FLIP to expecting
  // a 400 and an empty `reads()`.
  const bridge = await startBridge();
  try {
    const res = await promptRequest(bridge.port, { model: "--dangerously-skip-permissions" });
    assert.equal(res.status, 200, "current behaviour: accepted, not refused");
    assert.deepEqual(
      bridge.fake.reads()[0].argv.slice(0, 5),
      ["-p", "--output-format", "json", "--model", "--dangerously-skip-permissions"],
      "and it lands in argv immediately after --model",
    );
  } finally {
    await bridge.stop();
  }
});

test("an unknown route is a 404 and does not spawn anything", async () => {
  const bridge = await startBridge();
  try {
    const get = await request(bridge.port, { path: "/prompt" });
    assert.equal(get.status, 404, "GET /prompt is not a route — only POST is");
    const unknown = await request(bridge.port, { path: "/../.dev.vars" });
    assert.equal(unknown.status, 404);
    assert.deepEqual(bridge.fake.reads(), []);
  } finally {
    await bridge.stop();
  }
});

test("QA FINDING B-2 (bug pin): a port already in use exits 0 after logging 'staying up' — a failed start reports success", async () => {
  // Found while checking that these tests could not disturb the live fill.
  // If the port is taken, `server.listen` raises EADDRINUSE asynchronously,
  // which the process-level uncaughtException handler catches and logs as
  // "(staying up)". It does not stay up: with the listen failed there is
  // nothing left in the event loop, so node exits — with code **0**.
  //
  // Why it matters, in one sentence: `npm run bridge` in a second terminal
  // when one is already running prints a scary-looking line, exits
  // SUCCESSFULLY, and leaves James believing a bridge started that did not.
  // Two `node tools/claude-bridge.mjs` processes were in fact running on this
  // machine during the live fill, which is what prompted the check.
  //
  // Consequences are bounded, which is why this is a minor: the health probe
  // in src/catalog.js then fails, the experience step skips itself, and no
  // rows are lost. Contrast the token-floor path above, which fails the same
  // class of startup error correctly, with exit code 1.
  //
  // WHEN THE FIX LANDS (a `server.on("error")` handler that logs and exits 1)
  // THIS TEST MUST FLIP to expecting code 1.
  const occupied = net.createServer();
  const port = await new Promise((resolve) => occupied.listen(0, "127.0.0.1", () => resolve(occupied.address().port)));
  const fake = makeFakeClaude({});
  const proc = spawn(process.execPath, [BRIDGE], {
    env: { PATH: fake.binDir, HOME: fake.binDir, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BRIDGE_TOKEN: GOOD_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c) => (stdout += c));
  proc.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((resolve) => proc.on("exit", resolve));

  assert.equal(code, 0, "current behaviour: a hard startup failure exits SUCCESSFULLY");
  assert.match(stderr, /uncaught exception \(staying up\)/);
  assert.match(stderr, /EADDRINUSE/);
  assert.equal(stdout, "", "it never printed a listening banner, so it never served anything");

  occupied.close();
  fs.rmSync(path.dirname(fake.binDir), { recursive: true, force: true });
});

test("the bridge binds 127.0.0.1 only, and says so on startup", async () => {
  const bridge = await startBridge();
  try {
    // The banner is several console.log calls after the one startBridge waits
    // for, so poll for the last line rather than assuming one flush.
    const deadline = Date.now() + 5000;
    while (!bridge.stdout.includes("(or start the bridge with CLAUDE_BRIDGE_TOKEN set to pin it)") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(bridge.stdout, /listening on http:\/\/127\.0\.0\.1:\d+ \(127\.0\.0\.1 only\)/);
    assert.match(bridge.stdout, /tools disabled, one turn, minimal env/);
    // The token line it tells you to paste into .dev.vars is the token that
    // actually works — see the 401 test for the negative side of this.
    assert.match(bridge.stdout, new RegExp(`EXPERIENCE_HELPER_TOKEN=${GOOD_TOKEN}`));
    assert.equal(FORBIDDEN_PORTS.has(bridge.port), false, "tests must never bind the live fill's ports");
  } finally {
    await bridge.stop();
  }
});
