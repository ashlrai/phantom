# Empty jobs

Run `phm jobs empty --json` to see empty outcomes from the last 24 hours. Use
`--since 48h` to choose another window. The report groups jobs by likely cause
and gives each job's lane and a short reason. It reads the local jobs ledger,
worktree `BRIDGE_NOTES.md` files and log tails. Reasons are fixed descriptions;
the report does not copy notes or logs. Missing evidence stays in `other`.
The Fleet page shows the five most common causes, counts, and an example job for each. The JSON report exposes the same ranked causes in `topCauses`. This is a heuristic, not proof
of why a job ended empty.
