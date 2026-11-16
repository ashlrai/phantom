# Rollback, DISPATCHD-POSTRUN-PR-1
Instant disable, no reinstall: `touch ~/.ashlr-runs/POSTRUN_PR_OFF` (checked by dispatchd and the child).
Full rollback: reinstall the previous dispatchd.py (re-pin G1-CODE-PIN) and delete `~/.ashlr-runs/bin/postrun_pr.py`.
Leftover per-job files (`queue/run/<job>.postrun`, `<job>.postrun.json`) are inert.
