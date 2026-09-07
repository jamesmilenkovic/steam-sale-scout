// TC-15 - gate 10, which until now was asserted by nothing.
//
// SPEC.md §2 and §9.1: `npm run deploy` stays a HARD-FAIL STUB, and its message
// names auth as the blocker and points at DEPLOY-BLOCKERS.md. That is the whole
// of what stands between this app and being served, unauthenticated, to the
// internet - and it is a one-line string in package.json, which is exactly the
// kind of thing that drifts. Its previous wording ("Deploy deferred to Phase 3")
// was two revs stale and named the wrong reason, and nothing failed.
//
// NO NETWORK, NO SERVICES. The stub is `echo ... && exit 1`; it is run through
// `sh` so the EXIT CODE is proved rather than assumed from reading the string.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

test("GATE 10: `npm run deploy` REFUSES, non-zero, naming auth and DEPLOY-BLOCKERS.md", () => {
  const script = pkg.scripts?.deploy;
  assert.ok(script, "there must still be a deploy script - deleting it is not the same as refusing");

  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  assert.notEqual(result.status, 0, "a deploy must FAIL, not print a warning and succeed");

  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /auth/i, "the message must name the blocker, not just refuse");
  assert.match(output, /DEPLOY-BLOCKERS/, "and point at the file that lists what has to exist first");
});

test("GATE 10: DEPLOY-BLOCKERS.md exists and lists the routes it says it lists", () => {
  const doc = fs.readFileSync(path.join(REPO, "DEPLOY-BLOCKERS.md"), "utf8");
  assert.match(doc, /\/api\/rank/, "the headline route is named");
  assert.match(doc, /game_marks|play history/i, "including 12.5's play history, which is the unrecoverable data");
});
