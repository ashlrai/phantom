# RQ-DUPMATCHFIXQ7 (SPEC-AMEND Security #1): exact-id matching for the dup-PR precheck

Install (Masbot, after Security pins SHA256SUMS): take a .bak of the live
~/.ashlr-runs/bin/precheck.sh, confirm its sha256 is the base below (eb0f2b29,
the RQ-EMPTY-SHAPE result), then under dispatchd.lock copy precheck.sh into
~/.ashlr-runs/bin/ (chmod 755). No dispatchd.py change: PRECHECK_UNSURE exits 12,
which dispatchd already treats as a DONE-NOOP skip — a gh outage stalls jobs as
logged UNSURE rows in precheck-skips.tsv instead of launching blind runs.

Before installing, run the fixture suite on the staged file:

  bats staging/RQ-DUPMATCHFIXQ7/precheck_dup_match.bats      # 20 tests
  # or against the live file: PRECHECK=$HOME/.ashlr-runs/bin/precheck.sh bats ...

Rules (still no model call; gh stays read-only):

- `gh --search "$id in:title,body"` only nominates CANDIDATES. A PR now counts
  iff title or body contains the id as a whole [A-Za-z0-9-] token — a '-' never
  delimits, so RQ-RELEASE-TRAIN-1 matches neither RQ-RELTRAIN-1-RETIRE nor
  RQ-RELEASE-TRAIN-1-RETIRE, and RQ-GEN-2026102703-02 never matches -020 — or
  headRefName is exactly codex-bridge/<id> (also probed directly via --head,
  since the search index never sees headRefName). grep -F only; the id is
  never expanded into a regex.
- Any gh non-zero exit, missing gh/tr, grep/tr error, or malformed output row
  fails CLOSED: exit 12 with reason=PRECHECK_UNSURE_{merged,open,pr_<N>,no_<tool>}
  so the DONE-NOOP log and precheck-skips.tsv show UNSURE rather than a false
  duplicate. dispatchd needs no new code.
- `gh -q '.[0].number'` prints `null` on an empty list; the --head probe uses
  `// empty` and numeric validation so an empty result can no longer read as
  a hit (latent false-skip in the old code path, masked because fuzzy searches
  almost never returned empty).
- The FIXUP/LAND `gh pr view` probe fails closed too: an unreadable named
  target is UNSURE (retried next tick), never a blind launch. [ -z "$pr" ]
  still gates the open-PR dup check exactly as before.
