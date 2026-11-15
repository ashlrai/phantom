# Fleet proof envelope v1

`fleet.proof.v1` is a bounded local review bundle. The canonical strict schema
is `src/core/fleet/proof-envelope.ts`. No additional dependencies are required.

Fields: `claims` (up to 32 strings), `evidence` (up to 64 entries with `kind`
`diff|test-output|state-diff|log|screenshot-ref`, `ref`, optional SHA-256 and
`capturedBy: tool|agent`), `verification` (up to 32 `{cmd,exitCode,summary}`),
`diffStats: {files,added,removed}`, `riskTier: low|medium|high|unknown` and
`reviewerChecklist` (1–32 strings). Strings are at most 2048 characters;
envelopes are at most 64 KiB. Counts are nonnegative safe integers; exit codes
are integers 0–255. Unknown keys and versions fail validation.

The bridge publisher calls `phm fleet proof capture` after staging and after
its optional test runner completes, before committing or pushing. Capture reads
the actual staged Git tree through the hardened Git adapter, using the trusted
Git directory supplied by the publisher. It measures `--numstat` against the
dispatcher's pinned base and saves a redacted patch plus a receipt binding its digest,
statistics, base and tree. Binary files count toward files with zero text lines.
If the publisher ran tests, it supplies the actual command, exit and bounded
log; a separate receipt binds the command and exit to the output digest.
Missing test execution remains missing. Agent notes are never promoted to tool
proof. `claims` is empty in automatic capture; callers adding assertions must
mark their evidence `capturedBy: agent`.

Artifacts are exclusive mode-0600 sibling files, each capped at 4 MiB. The
envelope is written last; an existing bundle fails capture rather than being
silently replaced. A retry uses a fresh process-specific output name. Failed
capture aborts publication. The `.publish` result includes exactly one line:

```text
PROOF JOB.proof.ATTEMPT.json sha256:<64 lowercase hex characters>
```

`phm fleet proof verify JOB.publish [--json]` validates the marker digest,
envelope, artifact hashes, diff-stat receipt and command/output receipts, and
renders the checklist. Exit 0 means the recorded integrity checks passed;
exit 1 means missing/mismatched evidence, failed commands, unknown risk or
agent assertions need review. Exit 2 is usage error. A standalone proof JSON
can be inspected but is flagged for missing publisher digest binding. Verifier
never executes recorded commands, follows URLs, or reads absolute/traversing
artifact references. Symlink artifact files, devices, FIFOs and oversized files
are refused. Invalid input produces generic diagnostics without echoing content.

Serialization and captured free text redact home paths and secret-shaped text
using the shared scrubber, plus short secret assignments. SHA-256 fields remain
intact; artifact hashes cover the redacted bytes saved for review. Review output
redacts all checklist text. Serialization fails on overflow instead of silently
truncating evidence or fabricating completeness.

Trust boundary: `capturedBy: tool` is the trusted publisher's provenance, not a
signature. Capture's imported test receipt arguments are a publisher-only
interface; running it manually cannot attest a test execution. A party able to
replace both artifacts and the result marker can forge a bundle. Claims, risk
classification and semantic test coverage require review; passing integrity
checks grants no merge, execution or publication authority.

Deployment requires the installed CLI to contain the capture verb before the
publisher is upgraded. The committed tree must still match the captured tree
before push; a mismatch aborts publication. `contrib/mac/publish.sh` is Security-pinned: review and
re-pin its source change before sanctioned installation. No live script is
installed by this change. EMPTY/denied/aborted attempts that exit before artifact
capture carry no proof and must not be counted as proven job results.
