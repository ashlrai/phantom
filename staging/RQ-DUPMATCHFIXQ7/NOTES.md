# Router precheck handoff (RQ-DUPMATCHFIXQ7 / RQ-PRECHECK13Q8)

The dispatcher is external to this repository. Do not install the shell script
alone: its consumer must adopt `scripts/bridge/precheck.py:apply_precheck` under
the queue lock and atomically persist the returned row before acting on `launch`.
Recheck precheck-owned BLOCKED rows on subsequent ticks; preserve other holds.
Normal dispatch checks still apply. No live installation was performed here.

| Exit | Meaning | Queue action |
| --- | --- | --- |
| 0 + matching GO | Eligible | Normal dispatch |
| 10 + matching receipt | Merged/closed | DONE |
| 11 | Open, green target | BLOCKED, recheck |
| 12 + exact open-PR receipt | Duplicate | BLOCKED, recheck |
| 64 + invalid-job receipt | Permanent invalid input | FAILED, retain row |
| 75, legacy 13, unknown/error/malformed receipt | Uncertain | READY, retry next tick |

Exit 13 previously inferred acceptance from files/tests or symbol definitions.
Those probes are deleted: existing implementation is often the subject of a fix.
Lookup errors previously shared exit 12 with duplicates; old DONE-NOOP handling
silently consumed uncertain work. They now return 75. The classifier also safely
handles old UNSURE/13 receipts during migration. Receipts must match the job ID;
raw tool output is never stored in diagnostics. Duplicate receipts are idempotent.
Exact token/head matching still rejects fuzzy GitHub search hits.

Run offline with temporary HOME:

```sh
HOME=$(mktemp -d) bats staging/RQ-DUPMATCHFIXQ7/precheck_dup_match.bats
HOME=$(mktemp -d) python3 -m unittest discover -s scripts/bridge -p test_precheck.py -v
```

`precheck.sh.diff` is the incremental patch from the checked-in pre-fix script.
`SHA256SUMS` pins this bundle. Supervisor installation and external dispatcher
integration require their own review; these local tests do not prove deployment.
