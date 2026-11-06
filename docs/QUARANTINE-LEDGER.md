# Quarantine ledger

Flaky tests are retired through the ledger, never silently. `npm run gate` runs
[scripts/check-quarantine-ledger.mjs](../scripts/check-quarantine-ledger.mjs) in
Phase A; it fails CI Gate on any untracked skip or a diff that is only
additions. A test may be silenced only when a live row in
[queue/quarantine.tsv](../queue/quarantine.tsv) covers the skip marker.

## Row format

`queue/quarantine.tsv` starts with the header `test repo lead expiry`
(tab-separated, `#` comments and blank lines are ignored) and then holds one
row per skip marker:

| Column | Rule |
|--------|------|
| `test` | `<repo-relative test file>` covers every marker in that file; `<file> > <full name>` covers one marker. Full name is the describe path joined with ` > `, as Vitest reports it. |
| `repo` | `owner/name` the row applies to. Rows for other repos are shape-checked only; they cannot cover skips in this tree. |
| `lead` | Accountable owner: a person or team handle (for example `CI-Efficiency`). |
| `expiry` | `YYYY-MM-DD` (the whole UTC day) or an ISO-8601 datetime with offset. Must be in the future and no more than 7 days out — a quarantine is a short lease, not a permanent exemption. |

## Rules the verifier enforces

- **Tracked skip only.** Adding `.skip`, `.skipIf`, `.todo`, or an `x`-prefixed
  callee (`xit`, `xdescribe`, …) to a *running* test requires a covering row.
  The marker counts as a conversion only when the unskipped call appears in the
  diff's removed lines — keep the title on the call line.
- **Only additions fail.** A skip that is only an addition — a test born
  disabled, including every marker in a new test file — fails even with a row.
  Rows added to the ledger must also cover a live marker; a diff that only
  adds rows covering nothing fails.
- **Expiry is enforced.** A skip covered only by an expired row fails
  (`expired-skip`), and any expired row left in the file fails (`expired-row`).
  To renew, replace the row and keep the marker.
- **Pairs are atomic.** Unskip the test and delete its row in the same change;
  a leftover row covering no live marker is a `stale-row` violation.
- **`.only` is never legal** (`focused-test`), and skip markers need literal
  titles (`dynamic-title`).
- **Security R8.** `secret-shape`, `gitleaks`, `cargo-deny` and `ci-gate` are
  non-quarantinable, enforced in the verifier code
  (`NON_QUARANTINABLE`): a skip inside a matching file, or a ledger row naming
  a protected check, fails the gate. Security lanes can never be silenced
  through the ledger.

## Usage

```sh
node scripts/check-quarantine-ledger.mjs --base <merge-base>   # diff vs a base
node scripts/check-quarantine-ledger.mjs --diff change.diff    # a stored diff
node scripts/check-quarantine-ledger.mjs                       # ledger hygiene only
node scripts/check-quarantine-ledger.mjs --base HEAD~1 --json  # machine-readable
```

`npm run check:quarantine` runs the ledger-only form. `npm run gate` runs the
diff form against the merge-base (untracked files count as fully added) and,
under `gate:full` where no diff exists, the ledger-hygiene form.

## Quarantining a test

1. Convert the running call to a skip marker (`it('x'` → `it.skip('x'`).
2. Add a row: `test/x.test.ts > suite > x`, this repo, your handle, an expiry
   at most 7 days out.
3. Land both together. To un-quarantine, remove the marker and its row in the
   same change; to keep it parked longer, renew the row before it lapses.

Scope note: the verifier is diff-scoped for markers — a skip committed before
this check exists is not retro-flagged, but a row can never make it valid and
removing its marker still requires removing the row. Row liveness is checked
against the whole tree, so stale and foreign rows are always re-validated.
