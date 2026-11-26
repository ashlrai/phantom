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
  match to the checkout-known live snapshot or historical candidate proves
  the file-descriptor key boundary; an unknown live launcher produces no
  record. Do not substitute the historical candidate for a different live
  launcher. Pass
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

## Review entry point

`python3 -I contrib/mac/pool_bridge_reservation.py --request REQUEST --state STATE
--evidence EVIDENCE --attestation ATTESTATION` reads an owner-only request and
evidence. The caller must authorize the request before writing it; this is not
a network endpoint. Request keys are `id`, `pool`, `worker`, `lane`, `model`,
`workspace`, `paths`, `mode` (`read` or `write`), `tier`, `maxFiles`,
`maxLines`, `timeoutSeconds`, `evidenceSha256`, `accountDigest`, and `prompt`.
The caller supplies a clean, exclusively leased workspace and a private state
directory outside it. The bridge claims the ID exactly once. Z.ai uses the
existing pacer and refreshes account and evidence before contact. It disables
MCP for reservation runs and charges the full pacing reservation when usage is
unknown. The caller must discard rejected workspaces and retain capacity when
settlement is missing, group exit is unconfirmed, or pacing did not settle.

## Requires Security review and re-pin before contrib/mac/install.sh

The live files and their hashes are recorded in
[`host-integration/launcher-snapshot.json`](host-integration/launcher-snapshot.json).
They are review copies, not installer inputs. The installer previews the
historical `launch.candidate.sh` as `launch.sh`; it does not replace a launcher
without an explicit matching `--launcher-pin`. That pin is not permission to
roll back the live guards. Both the historical candidate and the new bridge
need independent Security review before adoption.

Run a Mac fixture that proves allowed writes succeed, sibling and protected
writes fail, and cancellation drains the provider group. Linux fixtures only
inspect generated profiles and exercise the process supervisor. Devin Flash
remains held until Security supplies and pins `agent.sb` and
`devin-overage-stop.py`. AGY remains held until Security supplies redacted
`/help` and `/usage` fixtures from the pinned binary, profile and isolated HOME.
Do not install or dispatch anything live as part of this review.
