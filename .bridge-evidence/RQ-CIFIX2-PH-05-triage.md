# RQ-CIFIX2-PH-05 triage

- 3176 — SUPERSEDED: `/history` endpoint + identical test already on master in evolved form; only failure was tier1-closure drift already blessed on master.
- 3169 — REWORKED: Quick typecheck CODEOWNERS drift for new tier1-test `test/fleet-merge-recover.test.ts`; reapplied on master + regenerated CODEOWNERS.
- 3163 — SUPERSEDED: attempt-budget change + identical test already on master; CODEOWNERS entry present; only delta was an import-path regression.
- 2843 — REWORKED: Secret-shape url_cred false positive on `user:pass@` test URL (now `fake:fake@`) + CODEOWNERS drift for `routing.json` fixture; regenerated CODEOWNERS.
- 1234 — SKIPPED: .github/workflows-only; Secret-shape fails on `${GH_TOKEN}` context false positive; fix needs .github/scrub.pl change outside rework bounds.
- 1064 — SKIPPED: same Secret-shape false positive as 1234 on the same workflow hunk; same bounds.
