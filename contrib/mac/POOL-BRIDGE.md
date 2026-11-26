# Resource-pool reservation bridge: Security implementation spec

The standalone `pool_bridge_evidence.py` emits metadata only. It is not a
launcher, reservation endpoint, installer or permission to spend. Its output
follows the companion Phantom-side `docs/POOL-BRIDGE-EVIDENCE.md` contract
(`resource-pool-bridge.v1`); there are no imports between the two trees.

## Evidence refresh

Run the emitter only as the owner from a trusted checkout, with an explicit
absolute HOME, executable and private
`<pool-root>/bridge-evidence/<worker-id>.json` output. Serialize refreshes per
worker. A failed refresh removes the previous record; successful refreshes
publish atomically with mode 0600. Never pass credentials in arguments.

- **Devin Flash:** Set `--data-home` if the guarded CLI uses a non-default
  XDG data home. Pass the exact `--model`, `--max-concurrent` and
  `--max-per-hour`. The only commands run are `auth status`, `models list`,
  and `auth status`, with the same executable and auth state. No catalog
  fallback, paid fallback or inferred provider quota.
- **Z.ai:** Supply `--launcher` pointing to the actual guarded launcher and
  `--executable` to its resolved Claude binary. Today only a byte-for-byte
  match to the checkout-known candidate proves the specific file-descriptor
  key boundary; an unknown live launcher produces no record. Do not use the
  historical candidate as a substitute for an unknown live launcher. Pass
  `--resources` pointing to the same guarded lane's published
  `<runs-dir>/queue/resources.json`. After any key/account rotation, refresh
  pacing state before publishing that account's quota; a reading older than
  the key is refused.
- **AGY:** It checks attestation and measured quota shape, then holds with
  `agy-identity-unverified`. The parser hook has no production input or
  synthetic identity fallback.

For Z.ai or AGY, `--attestation` is owner-written mode-0600 JSON with
`accountDigest`, `plan`, `attestedAt`, `attestationExpiresAt` and,
respectively, `autoRecharge: false` or `useG1Credits: false`. Set expiry to
no more than 30 days (the default owner validity period). No account name,
credentials, or raw CLI output goes into an evidence record.

## Required reservation entry point

1. Accept only a trusted Phantom reservation, with unique reservation ID,
   pool/worker and account identity, exact lane and native model, absolute
   canonical workspace, explicit allowed paths and read/write mode, file and
   line bounds, tier, timeout/cancellation, and expected evidence digest.
   Reject replay, model substitution, path escape, linked workspace aliases,
   and any unsupported tier or scope before contact. Enforce the reservation's
   workspace and writes with the pinned sandbox and check output scope before
   accepting completion. Prompt text is not enforcement.
2. Read the latest private evidence and recheck freshness and exact
   account/executable/model association at contact. Preserve the isolated
   provider home and OAuth/key boundary, sandbox/profile pins, provider
   pacing gate and allocation, Google `useG1Credits:false`, Z.ai Lite with
   auto-recharge off, and Devin's native Free-only verdict and separate local
   account cap. No fallback, bypass, alternate endpoint, or implicit spend.
3. Launch within a dedicated process group under the caller's reservation,
   not an untracked background job. On cancellation or timeout, terminate
   the whole group, escalate as needed, and confirm group exit before releasing
   capacity. If exit cannot be confirmed, report uncertainty and retain custody.
4. Return a bounded settlement with reservation ID, lane/model, evidence digest,
   executable and profile digest, start/end timestamps, exit status, group
   settlement state, and available usage metadata. Distinguish no-contact
   refusal from execution, and unknown usage from zero. Never include raw
   provider output, auth material or key values in the settlement.

## Requires Security review and re-pin

Supply the credential-free live launcher, pinned profiles and pacing interface
snapshot, and redacted AGY `/help` and `/usage` fixtures captured under the
actual pinned binary, sandbox and isolated HOME. The identity fixture must
preserve parser-relevant account and personal-plan fields without personal data.
Confirm runtime executable resolution, the exact Z.ai key boundary and quota
association, and the launcher-side settlement and cancellation integration.
The historical `launch.candidate.sh` is not installed by `install.sh`; this
spec does not change either file or any pin. Do not install anything live
until Security implements and re-pins the reservation entry point.
