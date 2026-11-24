# RQ-DRAIN-PHX-AUTH-06 result

Four source PRs are fully superseded by merged replacements. PR #7113 has a
15-line documentation recovery prepared locally in `llms.txt`. All five source
PRs remain open at their expected heads. Nothing was committed, pushed, tagged,
published, merged or closed. No comment was posted.

The requested external handoff directory refused creation with `EPERM`.
This worktree copy is the available handoff.

## Per-PR outcomes

`blocked` records the actual outcome, not the proposed closure. Head SHAs are
unchanged; no new commit exists. Replacement links identify verified successors,
but none of these source PRs was closed in this job.

| PR | Action | New head SHA | Check status | Verified replacement URL |
| --- | --- | --- | --- | --- |
| [7118](https://github.com/ashlrai/phantom/pull/7118) | blocked | `dda84a86df2b1816ad41ff68d92b7393bd3a1ea2` (unchanged) | Hosted Merge Gate, authority drift and Fast gate fail; superseded, closure unavailable | https://github.com/ashlrai/phantom/pull/7219 |
| [7117](https://github.com/ashlrai/phantom/pull/7117) | blocked | `e3e4beee1b05508cd292e54ae9555bd9f8da95cc` (unchanged) | Hosted Merge Gate, authority drift and Fast gate fail; superseded, closure unavailable | https://github.com/ashlrai/phantom/pull/7190 |
| [7114](https://github.com/ashlrai/phantom/pull/7114) | blocked | `224844c14951c7e5b083fa7bd105e8df38cc0ee4` (unchanged) | Hosted Merge Gate, authority drift and Fast gate fail; superseded, closure unavailable | https://github.com/ashlrai/phantom/pull/7662 |
| [7113](https://github.com/ashlrai/phantom/pull/7113) | blocked | `37cb2bb2e8a3c587af88e39671e5f2528d61d80e` (unchanged) | Hosted Merge Gate, authority drift and Fast gate fail; local recovery tested, publication prohibited | None: only partially superseded |
| [7112](https://github.com/ashlrai/phantom/pull/7112) | blocked | `cd1e03bf030ef81ae731aa7fd943c31322f12362` (unchanged) | Hosted Merge Gate, authority drift and Fast gate fail; superseded, closure unavailable | https://github.com/ashlrai/phantom/pull/7660 |

All five hosted heads have successful Quick typecheck, Secret-shape scan,
Secret scan (diff), and Check generated files results. These are existing-head
checks, not validation of a new merge. No check named `clean-tree` was returned;
its status is unknown. No required check or security control was changed.

## Supersession evidence

- #7118: all five added draft files equal master byte-for-byte. The complete
  documentation paragraph and three pane integration lines remain. Replacement
  #7219 merged as `74da6ea4415863301c06ba73a32686f538748ab2`.
- #7117: #7190 preserves the board component, test, CSS and model tests exactly;
  the three account summary helpers moved to core and are re-exported with the
  same logic. Documentation remains. Later master uses the shared WindowBar.
  Replacement merge: `a4ea09da528db2fd748fada561fbb08e49fd51b6`.
- #7114: #7662 preserves attachment upload, paste/drop, removal, cancellation,
  token checks, limits, pane integration and documentation. It adds restored
  thumbnail readback and coverage for failed reads and absent tokens. Original
  model, model tests and CSS remain exact. Replacement merge:
  `26693d8d25d4d66cc0ab385b48cf06596aa01bf2`.
- #7113: #8116, #8392 and #8420 preserve the broader root index, but eight
  direct links and setup/maintenance explanations were still missing. The local
  patch adds them to master's current structure. Root `llms.txt` is authored;
  the generator writes `docs/llms.txt`, so no generated index was hand-merged.
- #7112: ten of eleven affected paths match #7660 exactly at its merge,
  including both deleted ModelsCard files. The eleventh retains the full Models
  paragraph and CLI block. Later additions preserve the original behavior and
  tests. Replacement merge: `d4a28927b7ce4e4a1d8a1640b2f637e3a530cd48`.

## Verification

- Authority guards: 2 suites, 10 passed, 0 failed.
- Existing root-index tests: 3 suites, 6 passed, 0 failed.
- Draft, attachment, usage-board and Models tests: 9 suites, 85 passed, 0 failed.
- Total focused tests: 14 suites, 101 passed, 0 failed.
- Documentation check: passed. Independent review found every original #7113
  link represented and every local link target present.
- Changed-file verifier: exit 0; conflict-marker and realio/verse-sync-io checks
  passed. It skipped ESLint because the installed package is incomplete, and
  skipped typecheck for the text-only diff. Separate documentation check ran.
- Standard typecheck: could not start because `tsgo` is absent. Standard lint:
  could not start because ESLint lacks `lib/cli`. Backend and web TypeScript
  fallback checks both passed. Isolated full ESLint ran with lockfile-pinned
  tools and found 16 errors and 265 warnings across 14,105 files. The nine error
  files and lint configuration equal HEAD byte-for-byte; details are in
  BRIDGE_NOTES.md. The full lint suite is not green.

## Delivery blockers and prepared comments

The GitHub connector rejected PR closure and comment creation with HTTP 403
`Resource not accessible by integration`. The local GitHub CLI could not read
its protected configuration. Browser discovery returned no available browser.
No credential, account or permission change was attempted.

The final task rule prohibited commits, pushes, tags and publication, so the
#7113 recovery remains uncommitted on the job branch. No original PR branch was
rebased, rewritten, merged or published. No authority import edge was added;
there is no new closure growth to refer to Security.

Prepared one-line comments, not sent:

- #7118: Superseded by https://github.com/ashlrai/phantom/pull/7219; all reply-draft implementation, tests, pane integration and documentation are preserved on master.
- #7117: Superseded by https://github.com/ashlrai/phantom/pull/7190; the Usage board, tests and documentation are preserved with shared account-summary helpers.
- #7114: Superseded by https://github.com/ashlrai/phantom/pull/7662; all attachment behavior is preserved with additional restored-thumbnail coverage.
- #7113: The missing root-index links and setup notes are recovered locally, but this job prohibits commits and publication; leave this PR open until the recovery lands.
- #7112: Superseded by https://github.com/ashlrai/phantom/pull/7660; all Models-pane behavior, tests, documentation and obsolete-card removal are preserved.
