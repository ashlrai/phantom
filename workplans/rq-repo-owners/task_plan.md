# Task plan: RQ-REPO-OWNERS-1

## Goal
Repository owner roles, registration on the existing local bus, and a tested orphan sweep with an honest dry-run report. Leave changes uncommitted.

## Phases
- [x] Inspect onboarding and existing bus contracts; check duplicate work.
- [x] Implement registry, registration-only mode, and the orphan sweep.
- [x] Run regression coverage, static checks, authority checks, and docs checks.
- [x] Produce the JSONL orphan report and BRIDGE_NOTES.md with measured results.

## Decisions
- Responsibility labels never imply a running worker or grant execution authority.
- Existing owners and live claims win. Each assignment receives a short fenced reservation.
- The sweep holds its own lease throughout writes and preserves partial progress.
- Partial captures report candidates and a null confirmed-orphan count; they cannot assign work.
- Keep the checked-in Tier-1 snapshot unchanged. Its regeneration is Mason-only.

## Errors encountered and disposition
- Global npm install failed EPERM; the temporary-prefix install succeeded (3.30.33).
- Installed CLI 3.30.24 lacks coordination; 3.30.33 and current source cannot acquire the live lease.
- Host ready.tsv and the ops-side bus are inaccessible. The durable Phantom bus is readable; its coordination writes are unavailable.
- gh cannot read its host config. Connected GitHub GET tools supplied metadata.
- Default wire status would inspect prohibited client paths; used an explicit temporary Claude config.
- Initial new tests: two timeout failures, then one timeout and a mock recursion error. Reduced integration fixtures, used existing bus-test timeout conventions, and corrected the new mock; final 19/19 pass.
- verify-changed cannot find a merge base in the shared shallow checkout. A read-only deepen fetch did not restore it; final wrapper remains blocked.
- Existing authority checks: 10 pass / 3 fail, all failures in untouched paths. No new Tier-1 roots.
- Full lint: 16 errors / 271 warnings in untouched files. The real-I/O membership guard separately reports three untouched omissions.
- ps is unavailable; lsof confirmed this job's lint process completed. No process was killed.

## Status
Local implementation and reports complete. Live registration remains blocked by unavailable coordination writes. Full-repository qualification is not green because of the recorded baseline failures.
