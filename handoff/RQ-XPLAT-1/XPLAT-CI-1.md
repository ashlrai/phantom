# XPLAT-CI-1: Security and CI Efficiency handoff

Proposed destination: the Security bus note named `XPLAT-CI-1.md`.
External bus access was denied in this session. Coordination is pending;
this file does not claim that CI Efficiency or Security has acknowledged it.

Prepare a separate workflow-only PR from `install-smoke.patch`, labeled
`needs-security-review`, with auto-merge disabled. Preserve the existing
`install smoke (windows)` check name. Keep this optional and outside Merge Gate.
No workflow was edited in place or dispatched by this job.

The existing install smoke workflow runs Linux and Windows on both PR and push.
The candidate retains one Windows job, removes the hosted Linux build and
duplicate push run, and replaces full builds with focused fixture and native
Task Scheduler tests. The native harness uses disposable, uniquely named tasks
and cleans them up; it does not install the real daemon. Actions remain pinned
to their existing 40-character SHAs and permissions remain `contents: read`.
There are no secrets, OIDC grants, new third-party actions or matrices.

CI Efficiency review: agree the exact path list before applying. The proposed
filters cover the two release installers, service manager/config, Windows
helpers, OS sensors, executable lookup and their focused tests. General daemon
logic, help, documentation and unrelated backend changes do not select this job.
The workflow's own path remains included for self-verification. GitHub evaluates
PR path filters against the PR diff; therefore this must not become a required
check. See [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

Linux evidence uses `linux-e2e.sh` on a Linux box or a local container. Docker
was installed but its daemon was unavailable here. No hosted Linux replacement
is proposed. Reuse existing daily full CI rather than adding another matrix.

Publication order: coordinate and land this workflow reduction separately
before publishing the implementation series if avoiding the old two-job smoke
run is required. Do not dispatch extra runs to gather duplicate evidence.
Windows native acceptance remains pending one run on the final reviewed tree.

Installer execution suites are selected explicitly by native OS in
`vitest.config.ts`. Neither suite contains skipped or no-op tests. The Windows
job runs its installer suite in a separate invocation so missing collection
fails rather than being masked by other passing suites. The Linux box script
runs the POSIX suite. This preserves the quarantine gate unchanged.
