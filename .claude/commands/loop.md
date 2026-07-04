---
description: Run coder -> reviewer -> qa against SPEC.md, stop before commit
---

You are orchestrating the build loop for this repo. The current spec is `SPEC.md`.

1. Invoke the **coder** subagent to implement `SPEC.md`. Build only to the acceptance
   criteria - no scope creep.
2. Pass the resulting diff to the **code-reviewer** subagent. It returns APPROVE or
   REQUEST CHANGES with specific issues.
3. If REQUEST CHANGES, pass the issues back to the coder and re-review. Do this at most
   2 rounds. If still not approved, stop and report.
4. Once approved, invoke the **qa** subagent to write/run automated tests for the
   `[auto]` criteria and report pass/fail per criterion.
5. **Do NOT commit.** Stop and show me: the diff, the reviewer verdict, and the QA
   results, so I can review and approve the commit myself.
