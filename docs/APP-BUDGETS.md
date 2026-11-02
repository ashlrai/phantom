# Provider budgets
Run `phm app budgets --json` or open Fleet to see the same provider readings.
This replaces the Fleet daily spend chip. The daemon daily safety limit still
controls paid dispatch. Automation caps apply to each automation per month.
Readings come from `~/.ashlr-runs/queue/budget-overrides.json`. Missing,
invalid or more than 24 hours old readings show `unknown` (JSON `null`).
No percentage is inferred from a plan price. Only numeric usage fields and
validated timestamps are exposed. Reset dates are reported, never guessed.
Copy and paste to inspect readings without changing configuration:
```sh
phm app budgets --json
```
The producer can supply `claude-org`, `claude-plan`, `codex` and `grok` objects.
Each needs an ISO `as_of` timestamp. Optional fields are `monthly_credits_usd`,
`usd_remaining`, `used_percent` (0 to 100), ISO `resets_at`, and
`pacing_percent_per_day`. Record Claude org's 200 USD monthly credits and Grok's
approximately 13 percent daily pacing only when verified for that account.
These are allowances and pacing targets, not measured usage percentages.
`GET /api/verse/fleet/control` includes the same allowlisted `budgets` projection.

Related tasks: bc-124196c5 owns desktop mission control; bc-a46f053b remains
separate. This change implements the shared Phantom CLI and web Fleet view.
