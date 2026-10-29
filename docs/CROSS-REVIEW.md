# Cross-model review

A pull request that a job produced on one Mac pool (pool A) is reviewed by a
model from a different family on a different pool (pool B). A deterministic
step then decides whether the bridge may enable auto-merge. This replaces the
Grok-agent owner reviews for ordinary PRs. Tier-1, CODEOWNERS and other
sensitive changes still go to the box for a Security review.

Source: `src/core/fleet/cross-review.ts` (policy, scan, prompt, verdict,
decision), `src/core/fleet/cross-review-process.ts` (the isolated reviewer
process) and `src/core/fleet/cross-review-run.ts` (log, run, decide). The CLI
is `phm fleet xreview`.

## The split: review vs merge

1. **Review.** `phm fleet xreview run --request <file>` picks the first
   configured reviewer whose pool differs from the producer's and whose model
   family is independent of the producer's (the same rule as
   `reviewer-independence.ts`). The reviewer runs as its own process:
   - argv only and no shell. The prompt (title, body and diff, all untrusted
     job text) is written to stdin. It is never put in argv and never reaches
     a shell.
   - It gets a fresh 0700 scratch root for cwd, HOME, TMPDIR and the XDG dirs.
     The root is empty and is removed afterwards. No two reviews share memory
     or a scratch file, and no `~/.config/gh`, `~/.ssh` or `~/.ashlr` is
     reachable through HOME.
   - Its env is built from nothing: PATH, the scratch dirs, the locale, and
     the model credential its family is allowed (`CLAUDE_CODE_OAUTH_TOKEN` for
     claude, none for local runners). `GH_*`, `GITHUB_*`, `GIT_*`, `SSH_*`,
     cloud and `ASHLR_*` names are refused even when the policy lists them.
   - A claude reviewer must carry the restricted no-tools argv
     (`--restricted --tools "" --disallowedTools mcp__* --strict-mcp-config
     --no-session-persistence`), run `-p` with a stdin prompt, and use
     `--output-format text`. A local reviewer must be a tool-less model
     runner: agentic CLIs, shells, `gh`, `git`, `curl` and similar are
     refused. codex and grok-cli are not reviewer families yet, because codex
     always carries a shell tool.
   - The reviewer may answer only `{"verdict":"approve"|"reject","reasons":[codes]}`
     with codes from a closed list. Free text is rejected, so a
     prompt-injected reviewer has no channel for diff content. Malformed
     output, a non-zero exit, a timeout or output over 64 KiB counts as a
     failed review, and a failed review escalates.
   - The model is not asked at all when the change escalates anyway.
2. **Decide.** `phm fleet xreview decide --request <file> --head <sha>` is the
   step the bridge runs immediately before
   `gh pr merge --auto --match-head-commit <sha>`. It is pure and takes no
   model input. It returns `enable-auto-merge` only when all of these hold:
   - the KILL switch is off and the PAUSE file (`$ASHLR_HOME/PAUSE`, or
     `--pause-file`) is absent;
   - the repo is in `allowedRepos`;
   - the newest recorded review for the PR was taken at exactly `--head`;
   - it reviewed the same diff bytes (sha256);
   - the sensitive scan is clean;
   - the reviewer was pool- and family-independent;
   - the verdict is approve.

   Otherwise the action is `re-review` (the head moved, the diff changed, or
   there is no review), `escalate`, `reject` or `hold`. Only an
   `enable-auto-merge` decision carries `matchHeadCommit`.

This command never runs gh, never merges and never reads a GitHub credential.
Merge rights, the PAT, per-repo rate limits and revert tracking belong to the
supervisor that calls it.

## What always escalates

- protected-paths.ts rules: CI config and `.github/**`, CODEOWNERS,
  manifests and lockfiles, verify config, build files and hooks, release
  tooling, secrets and authority docs. In `ashlrai/phantom` (and any repo in
  `selfRepos`), Tier-1 source and test paths also escalate.
- `build.rs`, `scripts/**`, `bin/**`, `vercel.json`/`vercel.ts`,
  `netlify.toml` and shell scripts.
- Paths owned in the target repo's CODEOWNERS (`codeownersFile` in the
  request).
- Globs on the bridge denylist (`denylist` in the policy).
- Added lines matching the grep heuristics for network calls, env or
  credential reads, process exec, or exec of downloaded content (pipe to
  shell, `eval`, URL imports). Prose files (`.md`, `.txt` and similar) are
  not scanned.
- Binary, unparseable, quoted-path, traversal, empty or oversized diffs.

## Files

`$ASHLR_HOME/cross-review.json` is owner-written. Any invalid entry fails the
whole policy closed:

```json
{
  "schemaVersion": 1,
  "allowedRepos": ["ashlrai/phantom", "ashlrai/lexicon"],
  "selfRepos": [],
  "denylist": ["src/payments/**"],
  "maxDiffBytes": 524288,
  "reviewers": [
    {
      "pool": "mac-b",
      "model": "claude-cli:sonnet",
      "bin": "/opt/homebrew/bin/claude",
      "args": ["-p", "--model", "sonnet", "--output-format", "text",
               "--restricted", "--tools", "", "--disallowedTools", "mcp__*",
               "--strict-mcp-config", "--no-session-persistence"],
      "credentialEnv": ["CLAUDE_CODE_OAUTH_TOKEN"],
      "timeoutMs": 600000
    },
    {
      "pool": "mac-c",
      "model": "llama-server:qwen3-coder",
      "bin": "/usr/local/bin/local-review",
      "args": [],
      "credentialEnv": []
    }
  ]
}
```

The request is written by the bridge. Its `title`, `body` and diff are
untrusted:

```json
{
  "schemaVersion": 1,
  "repo": "ashlrai/phantom",
  "pr": 123,
  "headSha": "<40-hex head the diff was taken at>",
  "producer": { "pool": "mac-a", "model": "codex:gpt-5" },
  "title": "…",
  "body": "…",
  "diffFile": "/abs/path/pr-123.diff",
  "codeownersFile": "/abs/path/CODEOWNERS"
}
```

`$ASHLR_HOME/fleet/cross-review.jsonl` (mode 0600) is both the review store
and the audit log. It holds structured fields only: repo, PR number and URL,
SHAs, the diff's sha256, pools, families, verdict, reason codes, decision
codes and protected-path rule ids. It never holds diff text, job text, model
output, env values or file paths.
