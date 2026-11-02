# RQ-SBDENYLSDQ7 — staged precheck.sh (SPEC-AMEND Security 07:55 #1)

Draft only — Masbot installs manually. Nothing here runs until Masbot copies it
to `~/.ashlr-runs/bin/precheck.sh`.

Same change as `staging/RQ-DUPMATCHFIXQ7/` (rev1, `codex-bridge/RQ-DUPMATCHFIXQ7`,
PR #1364, Security's own rev of this amendment): byte-identical `precheck.sh`,
`precheck.sh.diff` and `precheck_dup_match.bats`. Re-staged under this job id so
this PR is self-contained; whichever lands first, the other is a no-op.

## What changed (vs live base `eb0f2b29…`, the `~/.ashlr-runs/bin/precheck.sh` CN1 installed)

- `dup_pr()` verifies every `--search "$id in:title,body"` candidate before it
  counts: title+body is tokenised on every char outside `[A-Za-z0-9-]` and the id
  must appear as a maximal token (`tr -cs 'A-Za-z0-9-' '\n' | grep -Fxq -- "$id"`),
  OR `headRefName` must equal `codex-bridge/<id>` exactly. `grep -w` is not used
  (it treats `-` as a delimiter); the id is never interpolated into a regex —
  fixed-string matching only.
- Fuzzy hits no longer block: `RQ-RELEASE-TRAIN-1` vs `RQ-RELTRAIN-1-RETIRE`,
  `RQ-GEN-2026102703-02` vs `-020`, `codex-bridge/<id>-suffix` heads.
- Fail closed: any `gh` error/non-zero exit/malformed row/missing `gh` or `tr`
  is treated as a possible duplicate — `skip 12 PRECHECK_UNSURE[_reason]`,
  including `gh pr view` failures on an explicit FIXUP target PR (`pr <num>`).

## Install (Masbot)

```
cp -p ~/.ashlr-runs/bin/precheck.sh ~/.ashlr-runs/bin/precheck.sh.bak-amend1-$(date +%s)
want() { [ "$(shasum -a 256 "$1"|cut -c1-64)" = "$2" ] || { echo "PRECOND FAIL $1"; return 1; }; }
want ~/.ashlr-runs/bin/precheck.sh eb0f2b2929ab466dbfaee825ccce860e42ff8354d50c0b3ad0c77823c4c73eb2
cp staging/RQ-SBDENYLSDQ7/precheck.sh ~/.ashlr-runs/bin/.precheck.sh.new
chmod 755 ~/.ashlr-runs/bin/.precheck.sh.new && mv ~/.ashlr-runs/bin/.precheck.sh.new ~/.ashlr-runs/bin/precheck.sh
shasum -a 256 ~/.ashlr-runs/bin/precheck.sh   # expect 338e61bf…
bats staging/RQ-SBDENYLSDQ7/precheck_dup_match.bats   # fixture suite, no live gh
```

Post-install sha256 of `precheck.sh`:
`338e61bf467005b794895904237e4a90af3e54d120fc858e33c4ad75fb1c2c0c`

## Tests

`precheck_dup_match.bats` — 20 tests, all passing (run here from a temp HOME).
Covers every fixture the amendment names:

- tests 1–2: `RQ-RELEASE-TRAIN-1` vs `RQ-RELTRAIN-1-RETIRE` (no match either way)
- tests 10–11: `RQ-GEN-2026102703-02` vs `RQ-GEN-2026102703-020` (no match either way)
- tests 3–6, 8: exact id in title/body/headRefName skips (codes 10/12)
- tests 12–15: `gh` error / malformed row / unreadable FIXUP target → exit 12 `PRECHECK_UNSURE*`
- test 7: `codex-bridge/<id>-suffix` head does not match
- tests 16–20: fall-through, empty lists, usage error

`gh` is stubbed on `PATH` inside the fixtures — no network, no live repo.

## Exit codes (unchanged contract)

`0` go · `2` usage · `9` target repo path missing · `10` merged (or FIXUP target
merged) · `11` FIXUP PR open but clean · `12` duplicate open PR **or**
`PRECHECK_UNSURE` (fail-closed) · `13` pre-satisfied.
