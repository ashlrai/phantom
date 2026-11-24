# SELF-APPROVALS-1: Security review request (design only, not live)

Destination: copy `design.md` to `~/.ashlr-runs/staged/SELF-APPROVALS-1/design.md`
and this file to `~/.ashlr-runs/bus/security/SELF-APPROVALS-1-ready.md`. The
authoring lane (claude, RQ-SELF-APPROVALS-1) got EPERM on every path under
`~/.ashlr-runs`, both read and write, with the sandbox on and off. This matches
`contrib/mac/publish.sh:156`: job `*.sb` profiles deny `~/.ashlr-runs`. So the
lane could not place the package there itself.

Nothing in this package is code, installed, scheduled or enabled.

## What is asked

Sign off, change, or reject the design in `design.md` before any
implementation PR is opened. The design is for self-serve approvals: routine
merges and fleet actions auto-approve inside the hard limits and inside Mason's
Touch ID standing grant. Everything else routes to Security, to Mason, or is
refused.

## Contents

| File | Purpose |
| --- | --- |
| `design.md` | Action taxonomy (43 rows, each AUTO / SECURITY / MASON / NEVER), evaluation order, audit log format on the existing hash-chained authority ledger, 19 failure modes, rollout stages, pinned-file touch points, open questions |

## Points Security should check first

1. **No agent decides.** The evaluator is pure code under the existing
   `StandingGrantV1`. That keeps `docs/architecture/teams.md:199` (no agent
   self-approval) intact. See design section 1.
2. **Hard limits run before the grant.** `NEVER` rows are checked before any
   grant lookup, so no grant can lift them (design section 5, step 2). Covered:
   spend, signing and notarization, force-push, `--admin` and ruleset bypass,
   pushes outside the fork, pushes to hollen689 or weyv, secrets, keychain,
   `chat.db`, TCC and app DBs, `~/.codex*`, external sends, wallet plugin, and
   installing `contrib/mac/*` over live files.
3. **Silence never approves.** Routed items wait indefinitely. There is no
   timeout-to-AUTO path (failure mode 10).
4. **Audit log.** New kinds `approval:decided`, `approval:consumed`,
   `approval:expired` and `approval:resolved` go on
   `~/.ashlr/authority/ledger.jsonl`. They are kept out of `LedgerEvidenceKind`
   so they cannot move the rollout ladder (design section 6).
5. **Pinned files.** No diff is cut. `bin/dispatchd.py` (live sha256 prefix
   `d5acb03d`) and `publish.sh` integration points are described in design
   section 9 for Security to cut against the pinned base. Nothing touches
   `bin/launch.sh`, iMessage send scripts, or release-autorun, release-sign or
   standing-authority.

## Open questions for Security

- Q1: Do job profiles deny writes to `~/.ashlr/authority/` and `~/.ashlr/KILL`?
  This is unverified by this lane, and it blocks stage 2 if they do not.
- Q2: Should approval lines also be HMAC-signed, or are the hash chain and
  anchor enough?
- Q5: Is a 15 minute approval TTL acceptable?

Q3 and Q4 are for Mason (phase 1 risk cap `low`; no auto-raise of roster
targets).

## After sign-off

1. The implementing PR lands the evaluator in shadow mode only.
2. A Security-cut dispatchd hunk follows.
3. A Mason grant renewal names the live rows (design section 8).
