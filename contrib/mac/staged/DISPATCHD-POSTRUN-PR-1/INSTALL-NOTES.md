# DISPATCHD-POSTRUN-PR-1 Security package (NOT installed)
Files: dispatchd.diff (dispatchd.py, install.sh FILES, test_install.py), postrun_pr.py (new), SHA256, test-output.txt, ROLLBACK.md.
Behaviour: in reap_worktrees, a finished job whose .publish says RESULT EMPTY, with commits ahead of origin/master
(read through the pinned git-safe helper; fallback: ahead of the .base sha) and no .postrun.json, spawns one detached
`postrun_pr.py <job>` (marker queue/run/<job>.postrun, max 3 attempts, in-flight guard). The child checks for any PR on
masonwyatt23:codex-bridge/<job> (gh api GET, fails closed), else runs the unchanged bin/publish.sh (fork-only push,
gh pr create, auto-merge per normal path). It records queue/run/<job>.postrun.json and logs to dispatchd.log.
It never pushes or creates PRs itself, adds no sandbox access and copies no credential; the child env is fixed.
Needs install.sh to copy postrun_pr.py (FILES updated) and the G1-CODE-PIN re-pin for the new dispatchd.py.
