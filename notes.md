# Notes: Devin absorption

## Current evidence

- Base commit is 81dddab5d5c8b15b135a8b1c302e01861c72b6f0. It already contains task_plan.md, notes.md and a header-only devin-absorb.tsv from an earlier attempt.
- Node reports v22.22.3. The installed Devin CLI reports 3000.12.32 (1126aba4a596).
- devin list --help explicitly scopes sessions to the current directory, with JSON and CSV formats.
- Current devin list --format json calls returned [] in this worktree and /Users/masonwyatt/Projects/ashlrai/phantom, both exit 0.
- devin --help documents --export as exporting after each turn. It is not a standalone historical export. No new turn was started.
- devin cloud --help offers drs resource management, not session history export. No cloud session was started.
- No account-wide session export or session outputs since November 10 were obtained. Eligible and duplicate totals remain unknown.
- phm devin list --all --json returned 4 locally tracked tasks dated September 28 through October 1. All sessionId fields are null; none provides a session output in the requested window.

## Coordination and deduplication

- stat of ~/.ashlr-runs/queue/ready.tsv and queue/run/RQ-DEVIN-ABSORB-1.line returned PermissionError errno 1.
- stat of queue/run/RQ-DEVIN-ABSORB-1.batched returned FileNotFoundError errno 2. This does not establish an available or held lease.
- append-open of ~/.ashlr-runs/metrics/devin-absorb.tsv with O_NOFOLLOW returned PermissionError errno 1. No acceptance ledger rows were written.
- gh pr list for ashlrai/phantom merged since 2026-11-10 failed on ~/.config/gh/config.yml access, before a GitHub response.
- Zero work items absorbed and zero duplicates confirmed in this attempt. These are action counts, not account inventory totals.

## Access boundaries

- Global npm installation failed with EPERM; installed Phantom docs, help and MCP metadata remained readable.
- Default phm wire status attempted ~/.codex/config.toml and was denied. No config contents returned. Do not repeat the default probe.
- No credential, cookie, Keychain, app internal database or TCC database contents were read. No settings, permissions, pinned files or live machinery were changed.
- No companion MCP tools were called: toolsUsed = [].

## Validation

Current validation results and exact operational commands are recorded in BRIDGE_NOTES.md. Earlier baseline notes reported dependency failures; those are historical, not results of the current check runs.
