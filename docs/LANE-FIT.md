# Lane fit

Run `phm lanes fit --lane codex-local --json` to see job kinds to send or avoid. Omit `--json` for plain words. The report reads `~/.ashlr-runs/metrics/jobs.jsonl` and never changes routing. Each kind combines repository, tier and task verb. A kind with at least three measured outcomes is `avoid` below a 0.3 PR rate and `send` otherwise. Missing dimensions or too few measured outcomes give `unknown`.

A published PR or merged outcome counts as a PR; an explicitly empty finish counts as no PR. Other outcomes stay unknown and do not enter the rate. Reused job IDs are excluded because attempts cannot be joined safely. The current dispatcher does not record task verbs on launch, so historical kinds often have an unknown verb. The typed `computeLaneFit` function in `src/core/fleet/lane-fit.ts` provides the same report to router code; it accepts ledger text or null when unavailable.
