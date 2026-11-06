# Host preflight

From the Phantom source checkout, with its dependencies already available:

```sh
npx tsx examples/upgrade/host-preflight.ts
npx tsx examples/upgrade/host-preflight.ts --help
```

Run it on the host whose installed Phantom you plan to upgrade. This source example uses the current user's default `~/.ashlr-runs` and a local process-table snapshot; it does not inspect the installed binary or verify its version. It uses the same public readers as the desktop. It makes no provider calls and changes nothing. The resource reader's optional personal-session scan is disabled. The report contains no paths, process command lines, jobs, usage amounts, or exception text.

Except for help, stdout is one newline-terminated JSON object. A completed read has schema `host-preflight.v1`, fixed fields and a bounded list of static blocker codes. Dispatch, processes and usage are independent: `usable` applies to each surface, while source health gives more detail. `dispatch.sources` and `usage.sources` are the underlying readers' source states; `rootHealth` includes optional dispatch files, which may be missing even when dispatch status is usable. A thrown reader has `error` or null source fields and does not suppress the other readers.

Dispatch requires a healthy status and a last tick no more than 300 seconds old. Processes require a healthy snapshot no more than 300 seconds old. Missing, invalid, or future timestamps have unknown age. A healthy empty process table is `idle`; unavailable process evidence is `unknown`. `paused` is reported but is not an upgrade blocker. Usage is usable when both the local API activity and jobs sources are healthy, including valid empty files; this verifies source readability, not that every account or usage value is present. The ledger status health and age are separately visible. The last API activity age is the age of the last recorded event, not the age of the file or proof of freshness; null can mean no recorded activity. Usage ages do not imply that a quiet source is broken.

The report blocks verification on unavailable required evidence, active observed workers, leaders or orchestrator agents, and disagreement between the dispatch running total and observed worker count. These are independent snapshots, so a changing host can produce a transient mismatch; inspect and rerun once it is stable. Counts cover only processes recognized by the public reader and do not prove that every possible task on the machine is stopped. This is an advisory host preflight, not authorization to upgrade or a full installation, provider, or desktop health check.

Exit codes:

- `0`: required sources are usable, counts agree, and no recognized fleet processes are active; also help.
- `1`: a reader or required source failed, recognized processes are active, or dispatch and worker counts disagree.
- `2`: invalid arguments; stdout contains a static JSON error.
- `3`: required evidence is missing, stale, or has an unknown timestamp, without a failure or mismatch. A report is still returned.

Codes `1` and `3` normally include the report and its blockers; an invalid clock produces a static error instead. Missing optional dispatch files do not by themselves change the exit code. A missing usage file is insufficient evidence, not a zero usage observation.
