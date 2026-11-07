# Merge batch planner

`phm fleet merge-batch --input snapshot.json --json` reads a JSON array for one
repository and prints an advisory plan. Each entry has a positive integer PR
`number`, a nonempty `files` array of exact repository-relative paths, a positive
estimated `ciMinutes`, and `dependsOn`, an array of PR numbers. Include all
unmerged dependencies; omit dependencies already confirmed merged. Supply current,
complete file lists and CI estimates: the planner does not fetch or verify them.

Example:

```json
[{"number": 12, "files": ["src/a.ts"], "ciMinutes": 4, "dependsOn": []},
 {"number": 13, "files": ["src/a.ts"], "ciMinutes": 2, "dependsOn": [12]}]
```

Each batch contains dependency-ready PRs with disjoint exact file paths. Among
ready candidates, the planner orders by the number of other remaining PRs sharing
a path, then estimated CI minutes, then PR number. It recomputes risk for each
batch. Dependencies always precede dependents in a later batch. Missing or cyclic
dependencies and their dependents remain in `blocked`, with unresolved IDs.
This deterministic greedy heuristic is not an optimal throughput guarantee;
shared paths are only a conflict proxy and disjoint paths can still conflict
semantically. Unknown files or costs must not be invented. Replan from fresh
facts after merges or changes. This command does not enqueue, merge, rebase,
check eligibility, or bypass branch protection and required checks.
