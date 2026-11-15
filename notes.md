# Implementation findings

No drive command, driver daemon, metrics command, restock implementation or publish.sh exists in this checkout. Use an explicit versioned local file contract until the driver lands. Reuse fleet CLI dispatch and fleet digest aggregation. Keep transport responsibility with Masbot. Protected paths were inspected read-only.

---

# Routing implementation notes

- Existing src/core/decide/decide.ts provides Jev confidence, accounting, budget and kill controls.
- src/cli/route.ts currently supports route explain only.
- docs/ROUTING.md does not yet exist.
- dispatchd.py writes dispatchd.admission.v2 at end of tick.
- No companion MCP tools called.
# Onboarding findings

- Existing `onboard` first-activation and `setup` authority flows must retain their contracts.
- `phantom status --json` is configuration metadata, not vault health. Names-only
  `phantom list --json` refuses a locked file vault; partial keychain inventories
  carry a warning. Never turn a failed inventory into empty.
- Secrets import requires a trusted-terminal challenge. Offer password-manager,
  provider and other-vault imports without accepting exports or credential values.
- Lexicon supports `lexicon add <term>`; Stack MCP registers its existing CLI,
  not service provisioning. Ashlr MD has no npm/Homebrew package.
- Use existing connector metadata validation and safe-path checks. Register local
  MCP executables only; never copy credential-bearing MCP commands or environments.
- Companion tools called: none. Phantom CLI bootstrap, docs, MCP/wire/authority
  inspections were run as required by docs/AGENT-MCP-CLI.md. No runtime activated.


# RQ-REBASE-PHANTOM-976 findings

- Existing PR: https://github.com/ashlrai/phantom/pull/976, open, mergeable=false.
- Head: masonwyatt23/phantom:codex-bridge/LAND-phantom-941 at 40a7fc0a660444b5464c1d47d0f92d4f625ead4e.
- Base: master. Worktree initial HEAD: 1f4d2ec810ac66a2c7942e0e0e6c5a0dcac7401f.
- Connector reports 81 changed files, 11,283 additions and 14 deletions, including CLI adapters, scheduler, fleet dashboard, tests and docs.
- User final rules prohibit commit/push/publication; clarification requested asynchronously. Until clarified, only prepare uncommitted local work.
- Local contrib/mac/publish.sh normally creates a new job-named PR, so its default mode is unsuitable for this existing-PR-only job. No publisher executed or modified.
- GitHub combined status reports a Vercel failure, which the task explicitly excludes. Required Merge Gate still needs fresh evidence.
- Companion MCP tools called: none. GitHub connector used for PR and status metadata.


# RQ-REBASE-PHANTOM-976 validation follow-up

- Verified merge base via GitHub comparison: b341c07a9fae495dd98d6603ad5d2781c229a0ad. Applied a three-way merge tree locally without moving HEAD, committing or pushing.
- All 16 conflict paths reconciled. Kept current module splits, router rank and learned task-arm behavior, conventional fleet dispatch, phone capabilities, existing PostHog event contract and tests.
- Added regression exercise of router regret through the current public router dispatcher. Restored current coordination executable entry in its integration test.
- The hosted CI run 40633746585 failed its secret-shape job (4 blocked fixtures) and Merge Gate; Dependency Audit passed. The pinned scanner now reports 0 blocked / 4 allowed fixtures locally.
- Three PR-introduced Tier-1 closure members need review: decide/job-shape.ts, routing/backend-roles.ts and routing/billing-class.ts. Last two are new roots. Two Slack members already absent from the master snapshot also fail closure. Do not regenerate the protected snapshot or disguise imports.
- No publish.sh, release machinery, workflow, auth configuration or security control was changed. Only CODEOWNERS gained four test entries.
- First affected-test run overlapped dependency repair and was stopped after missing Vitest preload files; discarded its partial result and reran on the repaired install.
- Process inspection via ps is denied (EPERM); no process-info workaround attempted.
