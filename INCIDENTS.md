# Incidents

## 2026-11-24 — RQ-GUARDIANCHECKQ8: host inspection blocked; crash reporting fixed

Guardian operation remains unverified. Explicit filesystem checks of
`~/.ashlr-runs/supervisor/status-main-guardian.md`, `guardian/guardian.log`
and `bin/main-guardian.py` returned `EPERM`, as did `launchctl list`. These
are access failures, not evidence of missing files or an unloaded service.
The readable `ai.ashlr.main-guardian.plist` names the existing Python guardian,
with `StartInterval=300` and `RunAtLoad=false`; registration alone does not prove
it is loaded. The `queue/MAIN_GUARDIAN_OFF` check returned `ENOENT`.
Locus reported an expired session; its next-action tool also returned `EPERM`.
No runtime files, service state or repair queues were changed.

Regression fixtures reproduced a separate health-reporting defect: Python
traceback headers and exception labels could yield a clean log verdict.
The existing diagnostic now counts them without exposing log text or enqueueing
fixups. Undated crash evidence stays unknown. This is a reporting repair,
not a diagnosis of the inaccessible host log or proof of runtime recovery.

Recovery handoff: from an authorized host session with an operator-established
Locus pin, run `phm fleet health-age --diagnose --json`. Inspect the existing
service and bounded log before restoring operation; keep protected runtime
changes behind Security review and re-pinning. Verify a fresh status and a
successful guardian cycle before closing this incident.

## 2026-11-08 — RQ-GUARDHEALTHQ10Q8: guardian inspection still blocked

Guardian health and recovery remain unverified. The three requested files are
absent from this worktree and access to their locations under `~/.ashlr-runs`
returned `Operation not permitted`. A launchctl inspection also returned
`Operation not permitted`. No host service or files were changed and no repair
jobs were enqueued. Resume the recovery handoff below with host access; a fresh
status and a successful guardian cycle are still needed to establish recovery.

The read-only service check now identifies negative launchd exit statuses as
errors. This improves diagnosis but does not establish the host's state.

## 2026-11-06 — RQ-GUARDIANHEALTHQ8: guardian inspection blocked

Guardian health is unknown. No runtime failure or recovery has been verified.

The requested `bin/main-guardian.py`, `supervisor/status-main-guardian.md`,
and `guardian/guardian.log` are absent from this worktree. Inspection of those
paths under `/Users/masonwyatt/.ashlr-runs` returned `Operation not permitted`.
No Locus tools are exposed in this session; `locus whoami --json` reports an
expired session. No credentials were read or changed.

No host files were edited, no service was restarted, and no backup was possible
because the source files could not be read. Both incident and bridge documents
were absent before creation. No guardian regression test was added: the runtime
failure has not been diagnosed. Existing switch tests do not establish daemon health.

Recovery handoff: resume with host read access and a valid, operator-established
Locus session. Inspect the three requested files and service registration, back
up files before any edit, diagnose the failure, add and run its regression test,
then verify a fresh status and an error-free guardian cycle. Respect existing
Security pin requirements for any protected runtime file. Do not infer that a
missing worktree file means the host service is unloaded.
