# Independent Tier-1 import closure review

Reviewed current uncommitted integration over HEAD cd22d72c6 on 2026-11-05. Review scope is the eight new runtime closure members and their five MCP entrypoints, not release approval or installed runtime acceptance. No files edited by reviewer.

Result: reviewed and sound for the sanctioned closure snapshot regeneration. No new Tier-1 roots, credential resolver, network request, app launch/quit capability, workflow permission or authority override is introduced by these paths. Existing security tests and controls must remain intact.

## Per-member rationale

- `src/cli/fleet-apps-follow.ts`: MCP invokes only closed duration/cursor/invocation/filter/interval/event-count flags, plus host-configured root and a supplied in-memory emitter. No `--checkpoint` or `--stop-file` can be provided via MCP. Therefore filesystem checkpoint writes, stop-file reads and stdout delivery are unreachable from this read-classified adapter. It polls validated retained history under the deadline; bounded event collection, output scrubbing and oversize refusal live in MCP wrapper. CLI-only options remain separately explicit.
- `src/cli/fleet-apps-recovery-batch.ts`: MCP constructs explicit UUID list, safe numeric limits, host-configured root and JSON emitter. The closed MCP schema cannot supply `--bus`, `--stream`, `--stop-file` or arbitrary flags. Default `bus=false` leaves publisher undefined, so no durable bus append occurs in this read tool. It reads one retained projection per cycle and distinguishes incomplete outcomes. Process signal listeners are added only for the call and removed in finally. It never probes or launches apps.
- `src/core/fleet/apps-follow-checkpoint.ts`: Transitive static import from follow. Definitions only at module scope; no import-time IO. Read/write helpers require explicit checkpoint path; MCP follow never supplies one. Existing CLI explicit checkpoint writes use exclusive random temporary files with 0600 mode, close, atomic rename and cleanup. Generic errors avoid filesystem path disclosure.
- `src/core/fleet/apps-recovery-batch-bus.ts`: Transitive static import from batch. Definitions only; publisher creation is gated behind explicit CLI `--bus`, absent and disallowed in MCP. If explicitly used in existing CLI, publishes only selected verdict metadata through the existing validated envelope/append path; no private message text or credentials.
- `src/core/fleet/apps-recovery-history.ts`: Bounded retained bus reader. Requires apps-watch sender/leaders recipient and projects only recognized observation/summary metadata after validating UUID, allowlisted apps, counts and consistent health state. Arbitrary text, environment fields and stderr are dropped. Current case-insensitive filter includes type guard before `.toLowerCase()`; malformed invocation identifiers are safely discarded. No app execution or writes.
- `src/core/fleet/apps-recovery-invocations.ts`: Bounded retained projection, capped at 1024 events/100 groups. Case-folded UUID identity prevents split history; preserves output spelling and terminal outcome, propagates truncation/unavailability rather than health success. No IO beyond validated history reader; no credentials/app control.
- `src/core/fleet/apps-recovery-verdict.ts`: Pure projection-to-verdict function. Healthy requires fresh, complete retained evidence and consistent positive app/diagnostic state; missing/unavailable/truncated inputs remain unknown, terminals remain terminal. No IO, credentials or execution.
- `src/core/fleet/apps-recovery-wait.ts`: Shared retained-evidence polling service. No process signal listeners, app probes or writes. Uses host-selected root, deadline, safe caller-validated numeric options and AbortSignal cleanup. Checks cancellation/stop and deadline again after synchronous read before reporting healthy/terminal. Generic unavailable result hides paths.

## MCP entrypoint checks

Five new entrypoints (`history`, `follow`, `recovery_check`, `recovery_wait`, `recovery_batch`) have `safety: read`, reject unknown keys before handler/import use, enforce safe integers and UUIDs and expose no user-specified root/path/bus-write flags. Config and handler failures are generic for all new tools. Existing write kill-switch remains unchanged and continues classifying ensure as append. History/wait reuse parseable scrubbed observation serialization; follow scrubs strings and refuses oversized structured results; bounded check/batch results use standard scrubbed tool serialization. No credential reads or values occur in reviewed sources.

## Defect found and corrected before approval

The first case-fold history filter dereferenced unvalidated `body.invocationId`. Root added a `typeof ... === string` guard before lowering; reviewer re-read the corrected filter. Current reviewed history SHA-256: 4d43dbe8878d9df2dc5144f0435298d51ec530729e6407a4ca9d63c6b93da55e.

## Remaining validation

Run unchanged Tier-1 closure/CODEOWNERS/security tests after sanctioned regeneration and affected behavior/type/lint checks. This review does not substitute for them.
