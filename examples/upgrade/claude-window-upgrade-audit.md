# Claude window upgrade fixture audit

From the Phantom source tree whose reader you want to check, with Node and `tsx`
already available, create an empty scratch directory outside your home and run:

```sh
scratch_dir=$(mktemp -d /tmp/phantom-upgrade-audit.XXXXXX)
npx tsx examples/upgrade/claude-window-upgrade-audit.ts --scratch-dir "$scratch_dir"
```

The directory must already exist, be absolute and empty, and be outside the
current and operating-system account homes. The probe leaves a fake `queue/status.json` and an empty fake
personal home there for inspection; remove the scratch directory when finished.
It sends a legacy Claude five-hour-only status, a separate fake API credit lane,
and fake Codex weekly data through this tree's `readResourceLedger`. It checks
that the legacy Claude figures and reset do not become short-window accounting,
while the API credits and Codex weekly figures survive. It uses no credentials,
provider calls, production ledger, or production router.

Stdout is one bounded version 1 JSON object, including for `--help` and errors.
Exit codes: **0** verified (also help), **1** mismatch or failure, **2** invalid
usage or scratch directory, **3** insufficient evidence (missing or degraded
status, or missing/duplicate fixture lanes). Failure messages are static.

This is an offline fixture compatibility check of the reader imported from this
source tree. It does not inspect a separately installed binary, establish that
an installation runs this code, test live behavior, or perform the live
`examples/agents/claude-window-check.ts` workflow. The source example and its
dependencies must be present; packaged installations may omit them. Use an
exclusive scratch directory that no other process can change during the run.
