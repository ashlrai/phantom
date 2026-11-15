# Ashlr PR conventions

These conventions govern every pull request you produce for AshlrAI. When the
task's own delivery contract gives stricter mechanics (branch names, push
targets, report format), the contract wins there; this playbook governs
everything else.

## Branch and delivery

- Dispatch tasks that run in a prepared worktree leave the change uncommitted:
  the host's `scripts/bridge/publish.sh` publishes it as a fork-branch draft
  pull request, so never commit, push, or open a pull request yourself there.
- When your task instead tells you to commit and push, follow that instruction
  exactly and open at most one pull request.

## Pull request scope

- Deliver one coherent, mergeable pull request per job within its tier budget.
  Frontier briefs may combine related concerns to finish the complete feature,
  with tests and docs, up to 40 files / 600 changed lines. Work stays at
  15 / 200, mid at 8 / 120, and fast at 2 / 80. Explicit narrower task limits
  win. Move unrelated refactors or drive-by fixes into a separate task.
- Never touch `.github/**`, CODEOWNERS, or release/publish configuration.
- Never add, print, commit, or message secrets, API keys, tokens, or
  environment variable dumps.
- Write no em dash characters anywhere: not in code, comments, docs, commit
  messages, or pull request text. Use a colon, a comma, or a period instead.

## Verification

- Acceptance tests are required: add or update the tests that prove the
  acceptance criteria, then run them plus the repository's typecheck, lint,
  and docs checks. Report the exact commands and their pass/fail counts.
- When you remove user-facing behavior, add a `CHANGELOG.md` note describing
  the removal.
