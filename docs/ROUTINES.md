# Provider agnostic routines

Copy [the YAML example](examples/routines.yaml) to `~/.ashlr/routines/routines.yaml`.
Set capabilities, minimum tier, daily attempt limits and per-attempt USD estimates.
Definitions are trusted executable configuration and must contain no credentials.
Codex uses its existing login and optional absolute `codexHome`. Claude uses its
existing subscription/API auth; models default to haiku/sonnet/opus by routine tier.
oMLX requires an installed `model` at `127.0.0.1:8000/v1/chat/completions`; it cannot
execute tools. Devin delegates to Phantom's authenticated API service and existing
grants/budgets. Its **submitted** outcome means dispatch, not completion; track with
`phm devin list`. Enable paid executors only with owner approval.

```sh
phm routines list
phm routines run ai-tooling-changelog-radar
phm routines status
phm routines migrate dashboard '*/15 * * * * phm dashboard'
phm routines migrate fleet-summary 'Review fleet scorecard and inbox health daily'
node dist/cli/index.js routines launchd --file "$HOME/.ashlr/routines/routines.yaml" > /tmp/phantom-routines-agent.xml
```

Migration imports without executing or enabling executors. Valid five-field cron
prefixes become shell commands; other text becomes daily prompts. Edit imported
tier, schedule and capabilities before activation. Use these patterns for dashboard,
fleet scorecard, release gate, inbox and queue checks; existing gates still apply.
Schedules are UTC cron (lists/ranges/steps, Sunday 0/7, DOM/DOW OR), `@hourly`,
`@daily` or `@weekly`. Cheapest eligible executors run first. Quota/rate-limit/auth
failures cool down for 1 hour/1 minute/5 minutes. Daily limits count attempts, not
live provider balance. Ambiguous failures stop without automatically duplicating work.
`runs.jsonl` records executor, estimate, duration in ms and outcome, without prompts
or diagnostics. Scrubbed results go under `output/`; output paths cannot escape it.
`STATUS.md` regenerates after ticks/runs or `status`. Protect and archive this store.
Inspect generated XML, install as `~/Library/LaunchAgents/ai.ashlr.routines.plist`,
and bootstrap with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.ashlr.routines.plist"`.
One agent ticks every 60 seconds; edit its PATH if CLIs live outside Homebrew/system
paths. Concurrent runs refuse `.lock`; after a crash verify no run is active before
removing it. Durable minute claims prevent replay, including crashes; recover with
`run <id>`. Missed minutes (including long runs) are not caught up. No service is
installed by the CLI. Tests force quota exhaustion with fake CLI executables.
