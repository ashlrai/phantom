# Plan: fleet state map and hygiene

- [x] Read gateway instructions; attempt install and discovery; check overlapping PRs.
- [x] Trace repo-backed states, transitions, ownership and failure modes.
- [x] Prove deletion candidates; keep pinned and live-only machinery.
- [x] Write STATE-MAP.md, follow-ups and BRIDGE_NOTES.md; run required checks.

Constraints: no publishing, live installs, host writes, credentials or .github edits.
Errors: global npm install and live bin enumeration denied with EPERM;
wire status exits 1 (unwired/inaccessible clients). Existing phm is 3.30.31.
Status: complete within readable scope; host-only inventory remains unverified.
Errors: baseline fleet sync suite: 20 passed, 1 failed (manifest/install drift).
New import-closure regression initially failed on queue_gate.py; added to manifest.
Verifier initially lacked merge-base in shallow history; deepen fetch repaired it.
Full lint: 9 unchanged .github errors/272 warnings; prohibited paths untouched.
