# Resource-pool Mac bridge evidence v1

This is the metadata contract between a trusted Mac bridge evidence emitter and
resource-pool admission. It does not commission or execute a launcher. Only the
operator or a Security-pinned emitter may write records, in a private directory
outside candidate workspaces. A digest is an identity match, not a signature:
an arbitrary file with matching fields is not a trusted attestation. The pool
reads only its owner-only `<pool-root>/bridge-evidence/<worker-id>.json` files,
bounded to 4 KiB, with no links or executable path accepted from a record.

## Envelope

All fields are required and additional fields are refused. Times are integer UTC
Unix milliseconds. Each record binds the exact lane/model and expected account
and executable digests from operator enrollment. `observedAt <= now < expiresAt`;
the maximum record lifetime and maximum observation age are five minutes.
The emitter must withhold evidence on any failure and remove obsolete output.

| Field | Value |
| --- | --- |
| `schema` | `resource-pool-bridge.v1` |
| `lane` | `agy`, `devin-flash`, or `zai` |
| `model` | Exact native ID: AGY `gemini-4-neon-{low,medium,high,xhigh}`; Z.ai `glm-5.3` or `glm-5.3-flash`; Devin `swe-2-flash-max` or a listed Free SWE-2.1 ID |
| `accountDigest` | Lowercase hex: 64 characters for AGY or Devin; first 32 SHA-256 hex characters of the Z.ai key as consumed by the launcher (without its line terminator) |
| `executableSha256` | Lowercase 64-character SHA-256 of the exact executable the guarded lane will use |
| `observedAt`, `expiresAt` | Capture and expiry times |
| `billing`, `quota` | Lane-specific objects below |
| `reservationCap` | Devin only, `{ "maxConcurrent": 1, "maxPerHour": 4 }` shape; integer bounds 1–16 and 1–10,000 |

For AGY, hash the UTF-8 principal reported by the pinned isolated CLI, never
the OAuth credential. For Devin, use the native principal digest encoding:
SHA-256 of compact UTF-8 JSON
`["devin-native-principal-v1",[apiServerOrigin,devinApiOrigin],basis,principal]`
with basis `user-id` or `email`. Use the user ID preferentially, otherwise
lowercase the reported email. Both native auth reads must agree, including team
and origins, around the complete native model catalog read. No identity text,
credential path, key material, or raw CLI stdout belongs in a record.

## Lane evidence

- **AGY:** `billing` is
  `{"kind":"owner-attested-plan","plan":"google-ai-ultra-personal","attestedAt":T,"attestationExpiresAt":T,"useG1Credits":false}`.
  The plan belongs to the matched personal principal; credit overage remains off.
- **Z.ai:** `billing` is
  `{"kind":"owner-attested-plan","plan":"zai-glm-coding-lite","attestedAt":T,"attestationExpiresAt":T,"autoRecharge":false}`.
  The fingerprint must match the key in the guarded lane. This is an owner
  attestation of fixed-price Lite and auto-recharge off, not provider verification.
- **AGY and Z.ai:** `quota` is
  `{"kind":"measured","usedPercent":P,"observedAt":T,"resetsAt":T}`.
  `P` is a measured number from 0 to 100; the quota capture may not be newer
  than the record or older than five minutes. Expiry may not exceed the next
  reset, quota freshness, or attestation expiry. Attestations default to 30
  days from issue and may not exceed 30 days. Exhaustion never grants eligibility.
- **Devin:** `billing` is `{"kind":"verified","plan":"devin-cli-free"}`, from
  an exact, unique, Free native catalog row with no nonzero price. `quota` is
  `{"kind":"unknown"}`. Its separate local reservation cap can only tighten
  the pool concurrency and rolling one-hour reservation bounds; it is not a
  provider allowance.

## Pool qualification

Enroll a worker with the matching provider/lane and an explicit `bridge`
object containing `accountDigest` and `executableSha256` from independent owner
configuration. Give it a `mac-bridge` binding with only `kind`, `workerId`, and
`capacityKey`; aliases of the same lane/account must share a capacity key.
For Devin, set `taskWindowMs` to `3600000`. Neither native CLI commands nor
unknown-quota overrides are permitted for bridge workers. Read-only
qualification exposes the evidence kind and retains the existing quota,
concurrency and operator vetoes. Missing, unsafe, stale, future, malformed,
wrong-account or wrong-executable evidence cannot qualify.

Execution and reservation remain refused with `bridge-not-commissioned` even
when a record qualifies, until a Security-reviewed reservation entry point is
commissioned. The evidence emitter does not provide that entry point. The
pre-existing pilot still holds unsupported or uncommissioned family IDs.
