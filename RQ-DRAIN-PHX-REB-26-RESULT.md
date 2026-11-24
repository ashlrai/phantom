# RQ-DRAIN-PHX-REB-26 outcomes

Reviewed 2026-11-24, in requested PR order. All six PRs were open at their supplied heads. Baseline: `ae9f5c2e3457202a2a4efe2b0f2676ee06a913ce`, also confirmed by `git ls-remote origin refs/heads/master` after verification.

No PR was closed, merged, committed, pushed or queued. Every action is `blocked`, not `closed-superseded`: the connected GitHub integration rejected both a PR comment and a closure with HTTP 403 (`Resource not accessible by integration`), and the CLI fallback failed to read its configuration with EPERM. The final task instruction also prohibits commits, pushes, tags and publication; it takes precedence over the earlier publishing steps. No credentials were copied or read directly, and no permissions were changed.

The requested host handoff directory could not be created: EPERM. This worktree file is the fallback deliverable; delivery to the requested directory is incomplete.

| PR | Action | New head SHA | Observed head checks | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [#6835](https://github.com/ashlrai/phantom/pull/6835) | blocked | None; unchanged `11c1e34e1ddb93bdf23d601ebc81504f4943ee47` | Merge Gate PASS; Fast gate PASS | None; PR remains open |
| [#6820](https://github.com/ashlrai/phantom/pull/6820) | blocked | None; unchanged `5a79e9207cc025ce1a8af3b4a319f24f74f6c5a8` | Merge Gate FAIL; Fast gate FAIL | None; PR remains open |
| [#6818](https://github.com/ashlrai/phantom/pull/6818) | blocked | None; unchanged `1e9afbaee7456b3636e1c0db4da7fe18e9424a01` | Merge Gate FAIL; Secret scan (diff) FAIL; Fast gate PASS | None; supersession incomplete |
| [#6799](https://github.com/ashlrai/phantom/pull/6799) | blocked | None; unchanged `f78556a8397bf910c8b70eb01b070d632d78e0cf` | Merge Gate PASS; Fast gate PASS | None; PR remains open |
| [#6794](https://github.com/ashlrai/phantom/pull/6794) | blocked | None; unchanged `f9e484e87ec2d01f155cc280e818d2e98519dbe7` | Merge Gate PASS; Fast gate PASS | None; supersession incomplete |
| [#6793](https://github.com/ashlrai/phantom/pull/6793) | blocked | None; unchanged `384494defd97b6d46880ed8a708f11bf8c66fc5b` | Merge Gate FAIL; Fast gate FAIL | None; PR remains open |

These are historical checks at the listed PR heads, not checks of a new merge candidate. All six queried CI runs report `Secret-shape scan`, `Check generated files` and `Check authority drift (hermetic)` successful. A separately named `clean-tree` result was not exposed by those job lists and remains unverified. Required checks and authority controls were not changed.

CI run IDs, in table order: `44222798628`, `44219404931`, `44217993432`, `44204865396`, `44200242441`, `44214756294`.

## Supersession evidence and remaining work

1. **#6835: ready for closure once GitHub writes are available.** Its complete Git tree is exactly the tree of merged [#6466](https://github.com/ashlrai/phantom/pull/6466), commit `36f67072e1139b429555638d5a8859f5f9a0573e`. Both trees are `88b042d15b655167db5de3a3792eceab4e6ece92`; the complete-tree diff exits 0. The initial ancestor check against the baseline also exited 0. Its apparent 48-file payload contains no unique change.
2. **#6820: ready for closure.** Merged [#6940](https://github.com/ashlrai/phantom/pull/6940), commit `46934272c086b106f2920e2dcf3f35196b8c88ca`, explicitly supersedes it. The original 84-line test is retained; the only difference is `includeExpiredReturns: true` in its reopen reader. Every assertion remains. Both the original suite and replacement regression pass on the baseline.
3. **#6818: keep open.** Merged [#6954](https://github.com/ashlrai/phantom/pull/6954) supplies the current host implementation, but does not carry all original intent. The bounded `fleet load-why` ps runner, deleted-worktree orphan detection and process-age reporting remain unique. The old `phantom.host.v1`/HostCard interface conflicts with the current `host.top.v1`/ThisMacCard design. Complete supersession is not established. Publishing a reconciled branch is prohibited by the final task instruction; no partial substitute was created. The historical secret-scan failure also remains unresolved; secret-scan logs were not read.
4. **#6799: ready for closure.** Merged [#7027](https://github.com/ashlrai/phantom/pull/7027), [#8383](https://github.com/ashlrai/phantom/pull/8383) and [#8647](https://github.com/ashlrai/phantom/pull/8647) collectively preserve legacy-withdrawal migration, post-await PR-check deadlines and the synchronized two-process bridge assertion. Current migration coverage strengthens the original cases; the process test preserves all five original assertions with bounded cleanup. The real-I/O membership hunk is comment-only. Replacement commits: `f97847d48636c7de277a1051e3850a2de069974a`, `4c0a1490759ad7c79a7645f7fae2bbb06091de47`, `9c41125eee496df8d383a6738ac7cbfbb8a073be`.
5. **#6794: keep open.** Merged [#7045](https://github.com/ashlrai/phantom/pull/7045) and [#7226](https://github.com/ashlrai/phantom/pull/7226) recover only the outcome reader and pure advisory weight proposals. Persistent weight writes and route/fallback ranking integration remain unique. The PR also carries CODEOWNERS and Tier-1 closure changes. Those protected files were not edited or regenerated to make a candidate pass; complete supersession is not established. Publishing a reconciled branch is prohibited by the final task instruction.
6. **#6793: ready for closure.** Merged [#7003](https://github.com/ashlrai/phantom/pull/7003), commit `37ee500f7215082851c2968ef4c8e9f25e4d0609`, carries the jobs-state help entry. Current help and both generated docs also retain the incidental metrics-impact, library and ideas entries. Current descriptions provide more detail. CLI registry and docs-drift suites pass.

`git merge-tree --write-tree origin/master <head>` was evaluated for all six and reported conflicts. Conflicts alone were not treated as proof of missing work. No merge or rebase was started on a PR branch. The shared repository later became shallow at the same baseline again (one visible commit); this invalidated later ancestry rechecks, not the previously recorded tree comparison, initial ancestry evidence, checked-out content or remote master SHA.

## Ready-to-post comments

These drafts were not delivered. Only the #6835 comment and closure were attempted; both failed with HTTP 403. The remaining mutations were withheld after the integration permission failure and CLI fallback failure.

- #6835: Superseded by https://github.com/ashlrai/phantom/pull/6466: this PR's complete tree exactly matches merged commit 36f67072e1139b429555638d5a8859f5f9a0573e, already carried by master.
- #6820: Superseded by https://github.com/ashlrai/phantom/pull/6940, which preserves every original assertion and fixes expired-return evidence reads.
- #6818: Blocked: bounded load-why sampling and deleted-worktree orphan/age behavior remain unique; reconciling the older host interface is unfinished and this job prohibits commits and publication.
- #6799: Superseded by https://github.com/ashlrai/phantom/pull/7027, https://github.com/ashlrai/phantom/pull/8383 and https://github.com/ashlrai/phantom/pull/8647, which preserve the withdrawal, deadline and concurrent-process changes.
- #6794: Blocked: persisted route-weight tuning remains unrecovered; protected authority metadata was left untouched, and this job prohibits commits and publication.
- #6793: Superseded by https://github.com/ashlrai/phantom/pull/7003, which carries the jobs-state help entry; the remaining generated-doc content is already on master.

## Verification

- Baseline backend TypeScript: PASS, exit 0, no diagnostics, direct tsc fallback because tsgo is absent.
- Focused baseline tests: PASS, 8 suites / 64 tests / 0 failed. This verifies existing replacement behavior, not a newly resolved PR tree.
- Focused ESLint: unable to start, exit 2, installed `eslint/lib/cli.js` missing. No lint success claimed.
- Report verification and final net LOC: recorded in [BRIDGE_NOTES.md](BRIDGE_NOTES.md).
