# RQ-DRAIN-PHX-AUTH-01 result

Inspected on 2026-11-24 against master `8d4f039e5a6f276503bb62b0e35b6ce854d440ee`.
All five PRs were checked in the requested order and rechecked after investigation.
All remain open at the supplied heads. No remote mutation succeeded.

The final instruction forbids commits, pushes, tags and publication. It takes
precedence over the earlier publish steps. The GitHub integration additionally
returns 403 for comments, closure and labels; the GitHub CLI cannot read its
configuration. No credentials were inspected or copied. The requested external
handoff directory denied creation, so this workspace file is the fallback.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [#8352](https://github.com/ashlrai/phantom/pull/8352) | blocked | Unchanged: `6f4451a4174066068de4960a1dcbe8535a55d14d` | Existing Merge Gate and authority checks fail; fully superseded, closure denied by integration | Not closed; verified replacement [#8377](https://github.com/ashlrai/phantom/pull/8377) |
| [#8156](https://github.com/ashlrai/phantom/pull/8156) | blocked | Unchanged: `32105f955faeb3c678f3cba996fd0bdabba6d9cc` | Local uncommitted merge: 54/54 tests, backend/web typecheck and targeted lint pass; existing hosted Merge Gate fails | Not closed |
| [#8090](https://github.com/ashlrai/phantom/pull/8090) | blocked | Unchanged: `a316cfb54ce5ea4eb7cdeaca102ee3f1d9833c09` | Local uncommitted merge: documentation links pass, 24/27 tests pass; remaining 3 failures reproduced on untouched master; existing hosted Merge Gate fails | Not closed |
| [#8079](https://github.com/ashlrai/phantom/pull/8079) | blocked | Unchanged: `a182f457a22197e54b3da7a1859a5e5dd5277213` | Existing hosted authority closure and Merge Gate fail; Security review and existing-owner coordination needed | Not closed |
| [#7837](https://github.com/ashlrai/phantom/pull/7837) | blocked | Unchanged: `43fd69d8d750cc4f31fe037a429ba494504f914c` | Existing hosted authority closure and Merge Gate fail; Security review and existing-owner coordination needed | Not closed |

## Per-PR evidence

- **8352:** its complete single-line change is required nullable
  `OrgTreeJob.prUrl`. Merged #8377 (`8a1d3565e85771aaac4bd082de4c5e3c70fa8933`)
  supplies that field, producer propagation and regression tests on master.
  An independent reviewer confirmed no unique hunk remains. The merge-tree
  conflict is comment/context overlap, not missing behavior. Do not rebase it.
- **8156:** merged #8158 (`6608dd37adf40210fe36f5a885ac4df9dc9f34fc`)
  carries host-load history, CLI, pulse and self-tick behavior. Merged #8275
  (`6083369eaa94026b781fbd92aea4eb20f60340fa`) carries the digest observation
  clock. Master has stronger digest and repeated-flag assertions. The original
  temporary-directory cleanup was missing, so complete supersession is not
  claimed. Merged master into an isolated clone of the original branch using
  `git merge --no-commit --no-ff origin/master`, resolved the seven conflicts
  against the individually audited current implementations, retained cleanup,
  and regenerated both CLI documents. The generator also restores the current
  source's missing `phm install` row. Remaining delta: three files, +7/-3.
  The historical closure failure lists host-load helper imports already carried
  on current master; both unmodified authority suites now pass. No new baseline
  or CODEOWNERS edits were needed.
- **8090:** contribution links are already present and merged #8428
  (`6d1435736588b62558daa52cca888692e51d53e9`) retains the optional-companion
  qualifier. The remaining wording correction changes Ashlr MD from Markdown
  review to Markdown editing in the source index and generated index. Merged
  master into an isolated clone of the original branch without committing.
  Regenerated the conflicted version blocks and site bundle from current source,
  preserving current content and advancing generated pins to source version
  3.30.73. This is not a registry/publication claim. Five files, +5/-5.
  The historical authority failure names missing CODEOWNERS protection for
  fleet-merge-status tests, not a documentation import edge. Current master's
  unmodified authority guards pass.
- **8079:** merged #8193 (`0f84be694b40bf5cda85094b48a32411d8ccdb90`)
  covers doctor/parser behavior; open #8488 at
  `cda84e01bad4e9d574e59e48f13c10d68f0f7556` owns the shared-contract/mobile
  slice. All twelve incidental fleet paths are already preserved. Do not
  duplicate those owners or close this PR: its exact 8000/8001-byte tests for
  multiple Unicode characters and lone surrogates without Buffer, all-repo
  rejected-body parity matrix, validator identity and locus composition checks
  are not all present in the replacements. The new runtime import and re-export
  `src/core/fleet/drop-job-writer.ts -> ./drop-job-contract.js` grows the
  authority closure. Hosted job `137065027503` names that exact added module.
  Retain master's family-pause guard and stricter ingest parser in any later
  reconciliation. No source repair was made to this security-sensitive slice.
- **7837:** merged #8033 (`7fb87355462ec18061049076048bcde66af62c05`)
  preserves lane reporting and pause parsing. Open #8482 at
  `51f3bb4709bcb018d814ee8ebda8ddcb00ce39c7` owns the memory-reader slice.
  The fleet formatter and original cross-reader parity assertion are still
  outstanding. `src/core/fleet/memory-state.ts -> ./pause-state.js` grows the
  authority closure; hosted job `136761751400` confirms it. Do not duplicate
  #8482. A coordinated refactor placing shared pause code in the existing memory
  module may avoid a new closure member, but has not been implemented or tested
  here. Preserve master's wording, which does not infer cloud worker liveness
  from PAUSE_LOCAL. No source repair was made to this slice.

## Pending remote actions

The following comments are prepared, not posted. Closure/comment attempts on
8352 and label/comment attempts on 8079 and 7837 returned 403. No repeated CLI
authentication workaround was attempted after its configuration read failed.

- 8352, close: Superseded by https://github.com/ashlrai/phantom/pull/8377,
  which carries the complete nullable OrgTreeJob.prUrl change, its producer,
  and regression coverage on master.
- 8156, leave open: Local master-into-branch merge is ready with retained test
  cleanup and passing focused checks; publication is prohibited in this run.
- 8090, leave open: Local master-into-branch merge preserves the remaining
  wording and regenerated docs; three unrelated documentation assertions fail
  on untouched master, and publication is prohibited in this run.
- 8079, label `needs-security-review`: The runtime import and re-export from
  drop-job-writer.ts to drop-job-contract.js grows the authority closure;
  coordinate with https://github.com/ashlrai/phantom/pull/8488 and retain the
  original Unicode/parity regressions before supersession.
- 7837, label `needs-security-review`: The memory-state.ts import of
  pause-state.js grows the authority closure; coordinate with
  https://github.com/ashlrai/phantom/pull/8482, retaining the formatter/parity work.

## Verification limits

The 8090 candidate's 27 tests had 24 passes and 3 failures. The unchanged master
reproduction had 9 passes and the same 3 failed assertions: docs-sync detects
CODEMAP drift in two assertions, and doc-facts finds undocumented dispatch
support for stray-stop/stray-slots in CLOUD.md. Master additionally had stale
version blocks that the candidate regenerates. These failures were not hidden,
weakened or repaired through unrelated changes. Documentation link checking
passed with 281 local links, 469 source links and zero errors.

Final combined-worktree verification passed: the single verify-changed run
returned 0, including 10/10 authority tests, scoped ESLint, backend typecheck,
documentation checks and lane guards. Backend/web typecheck had also passed
in the 8156 candidate. All five selected generated documentation surfaces
are clean. Full `npm run lint` returned 1 with 16 errors in nine files that
are byte-unchanged from HEAD, plus 265 warnings. Scoped lint passed; no broad
lint success is claimed. The error paths are listed in BRIDGE_NOTES.md.

The combined primary-worktree delta is eight files, +12/-8, net +4 source,
test and generated-document lines, before these reports. Both original-branch
merge candidates remain uncommitted in isolated local clones; their residual
patches are also applied uncommitted to this worktree. Authority files,
CODEOWNERS, closure snapshots, workflows and required check names are unchanged.
No new head SHA, successful remote closure, label, comment, merge or publish is
claimed. See BRIDGE_NOTES.md at the worktree root for commands and final checks.
