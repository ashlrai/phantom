# Cross-model review

A pull request that a job produced on one Mac pool (pool A) is reviewed by a
model from a different family on a different pool (pool B). A deterministic
step then decides whether the bridge may enable auto-merge. This replaces the
Grok-agent owner reviews for ordinary PRs. With [tier1-verify](#tier1-verify)
on, Tier-1, CODEOWNERS and other sensitive changes are verified by agents too;
only the GATES v3 floor still goes to the box for a Security review.

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
   `gh pr merge --auto --match-head-commit <sha>`. It reads GitHub through host custody and takes no
   model input. It returns `enable-auto-merge` only when all of these hold:
   - the KILL switch is off and the PAUSE file (`$ASHLR_HOME/PAUSE`, or
     `--pause-file`) is absent;
   - the repo is in `allowedRepos`;
   - the newest recorded review for the PR was taken at exactly `--head`;
   - it reviewed the same diff bytes (sha256);
   - the sensitive scan is clean;
   - the reviewer was pool- and family-independent;
   - the verdict is approve;
   - required checks exist and all report success on the exact head SHA, with
     matching App identities and an unchanged PR head after reading checks.

   Missing, pending, stale, failing or unreadable checks produce a logged hold
   reason. API errors fail closed without logging response bodies.

   Audit on 2026-11-15: Phantom's `master` branch metadata and active
   [default-branch ruleset 24051754](https://github.com/ashlrai/phantom/rules/24051754)
   require exactly **`Merge Gate`**, pinned to GitHub Actions App **15368**.
   `Quick typecheck` is non-required and explicitly advisory inside Merge Gate
   on PR, merge-group and master-push events. Cross-review now also holds any
   observed failed check on the exact head, including non-required checks;
   `checkStatus: wait` distinguishes pending work from `hold` for failed or
   missing evidence, and `checkDetail` names failures in CLI/JSON and the
   journal. Skipped/neutral non-required jobs are allowed; required jobs still
   need success. This is a cross-review guard: GitHub can still merge a red
   non-required check when auto-merge is armed outside this path (including
   the direct publisher and other fleet entry points). Later check changes
   and merge-group failures also require server-side protection.

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

## tier1-verify

Article 1 of [AGENTS.md](../AGENTS.md) removes ask-Mason steps, so a sensitive
change no longer parks for a human review. When `tier1.enabled` is set in the
policy, an escalating change goes through a deep verification stage
(`src/core/fleet/tier1-verify.ts`) instead:

1. **GATES v3 floor (unchanged, still escalates).** CI config and
   `.github/**`, secret material, release and signing tooling, the
   action-class registry, comms send policy, the KILL home, edits to
   CODEOWNERS itself (a rename or a broad last-match rule can disable
   ownership without a removed line), Security-pinned
   paths (`publish.sh`, scrub, dispatchd, git-safe), sandbox profiles
   (`*.sb`), the TCC helper and loopback auth, leader wrappers and prompts,
   billing and payments, credential reads or download-exec in added code,
   secret-shaped added values, unreadable, unmeasurable or oversized diffs,
   and the bridge denylist. The model is not asked about these.
2. **Deterministic checks** on the exact diff: a secret-shape scan of added
   lines (hit count only, never the value), authority-fixture impact (rule
   ids, Tier-1 source, test and fixture counts), test tampering, and
   regression risk (`scoreDiffRisk`: oversize, shrinking tests, or source
   changed with no test touched). Paths a CODEOWNERS file owns are verified
   here; editing the CODEOWNERS file itself is floor.
3. **Two model reviews:** the standard review, then a semantic claim-vs-diff
   pass (`tier1-semantic` prompt) by a second seat on another pool or family.
   Both must be producer-independent. Both answer with the closed schema.
4. **Full CI:** every `tier1.fullChecks` entry (exact name, or `prefix*`)
   must have succeeded on the exact head, beyond the required Merge Gate.
   Full suites do not run on `pull_request`, so the decision holds with
   `tier1-full-ci-missing` (`checkStatus: wait`) until the bridge dispatches
   them on the head branch.

Outcomes: `enable-auto-merge` (`tier1-verified`); `reject` with the
assessment as the failure report and a one-line `fixJob`
(`RQ-T1FIX-<repo>-<pr>-<sha7>`, tier frontier) that `--queue <router-queue.md>`
appends once per id; `re-review` or `hold` on review gaps; `escalate` only
for the floor. A failed reviewer holds rather than re-spending a model;
enabling requires two distinct reviewer seats. Enable it with:

```json
"tier1": { "enabled": true, "fullChecks": ["CI (Node 22, *", "Mac exhaustive (isolated)"] }
```

Absent or `enabled: false` keeps the previous escalate behaviour.

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
  "codeownersFile": "/abs/path/CODEOWNERS",
  "headRef": "bridge/RQ-EXAMPLE"
}
```

`$ASHLR_HOME/fleet/cross-review.jsonl` (mode 0600) is both the review store
and the audit log. It holds structured fields only: repo, PR number and URL,
SHAs, the diff's sha256, pools, families, verdict, reason codes, decision
codes, bounded scrubbed check diagnostics and protected-path rule ids. It never holds diff text, job text, model
output, env values or file paths.

For a job already in cross-review, read `decision.evidence` in the existing
`run --json` or `decide --json` output or in its recorded decision. It identifies
the applicable receipt and verdict, the SHA and IDs/contexts of observed
GitHub checks, and remaining gaps (see also `checkDetail` and `fixJob`).
For example, `head-moved` means review the new head; `reviewer-not-independent`
means use a different pool and model family; `checks-not-successful` means
inspect the listed checks at that commit. A bridge can supply a reference to
an existing immutable preview as `preview: { headSha, url }` in the request.
If the reference is absent or not for the observed head, `previewUrl` is null;
the handoff neither opens nor verifies the preview. Evidence is not a new
merge gate or approval.
