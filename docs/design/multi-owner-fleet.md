# Multi-owner fleet

Status: proposed design. The identity and grant model section is **pending Security review** and is not an approved contract until that review lands.

## Goal

Several human owners each run their own Phantom agents, often across more than one account and more than one machine. They should be able to:

- connect their fleets in a few steps,
- see each other's work in one roster,
- talk over the Phantom bus and share tools,
- copy an agent or a tool from someone else as easily as copying a template from a share link,

while each owner keeps full control of their own agents, accounts, usage and secrets. The design has to work for a small team today and for many more owners later, including outside contributors.

## What already exists

This design builds on surfaces that are already on the default branch. It adds no second bus, roster or secret store.

| Surface | What it gives us | Gap for multiple owners |
| --- | --- | --- |
| [Agent bus](../AGENT-BUS.md) | One durable append-only store, six-field envelopes, v2 participants, claims, channels | `from`, `to` and `participantId` are routing labels, not authenticated identities |
| [Bus transports](../AGENT-BUS.md#transports-and-routing) | `BusTransport` interface, file transport, external adapter shape, router, dead letters | No external transport ships; egress is off unless `ownerApproved: true` |
| Agent identity registry (`src/core/agents/bus-identity.ts`) | Stable handle per agent across providers and models | Handles are global; there is no owner namespace |
| [Agent roster](../AGENT-ROSTER.md) | One live session view across Phantom, Claude, Codex, Devin, Cursor, Grok and local models | Local machine only; no owner field |
| [Team org](../AGENT-NETWORK.md#team-org) | `org.toml` members, machines, agents, lane shares, opt-in join records | Join records are unsigned files copied by hand |
| [Execution Identity V1](../EXECUTION-IDENTITY-V1.md) | Opaque `eid_` account references, shadow only | Not tied to a human owner |
| [Agent profiles](../AGENT-PROFILES.md) and bot templates | Profile TOML, doctrine, memory seed, disabled crons, drafts-only policy | Templates are built in; there is no portable export or import |
| [Connectors](../CONNECTORS.md) | MCP and CLI tool profiles; credentials bound by Phantom Secrets **names** | No portable tool manifest |
| [A2A config schema](../AGENT-TO-AGENT.md) | Default-off counterpart opt-in with consent evidence | Schema only, no runtime |

## Options

### Option A: federated owner nodes with signed grants

Each owner runs their own Phantom node (one or more machines). Every owner has a signing key. Cross-owner traffic travels as ordinary bus envelopes through a new external `BusTransport` that carries a signed grant reference. Each node checks grants locally before it stores, shows or acts on anything from another owner. Agents and tools move between owners as signed, portable bundles.

### Option B: one shared org hub

One node (or a hosted relay) holds a single shared bus and roster, partitioned by owner namespace. Owners connect their machines to the hub. Grants and roster live in the hub, and the hub enforces them.

### Option C: git-native exchange

Owners share a registry repository. Bundles, grants, revocations and roster snapshots are signed files committed there. Bus traffic between owners is batched into the repository or into issue and PR comments. Every change is a reviewed commit.

### Comparison

| | A: federated nodes | B: shared hub | C: git-native |
| --- | --- | --- | --- |
| Security | Strong. No shared trust root; each owner enforces its own grants; a compromised node exposes only what was granted to it | Weakest. The hub sees all traffic and is a single point of compromise and outage; the hub operator effectively controls every owner | Strong integrity and audit through signed commits; confidentiality depends on repository access; secrets can leak through history if a mistake is committed |
| UX | One join link per owner, live roster, near real-time messages; offline nodes show as offline | Simplest to start; one place to look | Slow; minutes of latency; awkward for chat-style coordination |
| Effort | Medium to large: signing, grant checks, one external transport, bundle format | Medium: tenancy inside one store plus a hosted service to operate and pay for | Small to medium: signing and bundle format, reuse of git and review |
| Agent-native | High. Every step is a CLI or MCP verb with JSON output; agents can export, import and request grants | Medium. Agents depend on a central service being up | High for copying and review, low for live coordination |
| Owner control | Full; every decision is made on the owner's own node | Shared; the hub decides | Full for content; repository admins can merge |
| Spend | None | Hosting cost for a relay | None |

### Recommendation

**Option A**, with the bundle and grant formats designed so they can also be published to a git registry later (Option C as a distribution channel, not as the bus). Option B is rejected: it concentrates trust and cost and conflicts with per-owner control.

Delivery order:

1. **M2 (first implementation PR):** portable agent and tool bundles with `phm` export, inspect and import; a multi-owner roster with an owner principal and per-owner views; a grant check that denies every cross-owner input. No network, no keys, no signing and no cross-owner sends.
2. **M3:** owner and device keys behind the custody signer interface, signed grants and envelopes, signed revocation lists and a signed audit chain head, after Security reviews the M3 PR.
3. **M4:** one external bus transport for cross-owner channels between owner nodes over a private network, behind the existing `ownerApproved` egress gate.
4. **M5:** desktop app surfaces: an owner switcher, a shared roster, an Import from link flow and a grants panel.

## External agents and machines as roster members

Some agents are not Phantom processes at all. Two already have a bus identity: an OpenAI Dot (`agent:imsg-dot`) and an independent agent called Instinct (`agent:imsg-instinct`) that has its own GitHub access and takes PR rebase and triage work. Both are reached only by iMessage, through the existing [teammate task transport](../IMESSAGE.md#fleet-teammate-tasks-and-evidence). This design keeps that path and adds no new sender.

Bridge, inbound and outbound:

- **Bus to teammate.** Only an envelope whose origin is the local owner, addressed to `agent:imsg-dot` or `agent:imsg-instinct` with a v2 `task` body, becomes a teammate task preview (`phm fleet imessage-tasks enqueue`). A foreign-origin task body is stored as data and is never previewed or enqueued. Nothing is sent until the owner-approved dispatch runs, and that dispatch keeps every current gate: the local allowlist, the send policy, the kill switch, the communications pause and the hourly cap.
- **Teammate to bus.** A matching task result from the expected peer will be posted back to the bus (new in M2) as a `result` envelope that cites the task's envelope id. It is marked `peer-reported`; it is evidence, never proof and never authority. Free-form texts from these peers are never turned into work.
- **Presence.** The mesh publisher already writes `imsg-dot` and `imsg-instinct` observations from the task store. The multi-owner roster shows them with `kind: "external"`, their transport, their last result time and their open task ids.

Ownership:

- An external agent belongs to the owner whose account hosts it. That owner's grants decide who may address it.
- When the hosting owner is not verified, the roster records `principal: null` with the reason `unverified`. Such an agent can receive tasks only from the local owner, and only through the existing approved transport.
- No raw handle, phone number or address ever appears in the roster, a bundle or this repository; only the existing hashed sender ids and routing labels do.

Machines:

- Each machine is a device of exactly one owner, enrolled from the existing node registry. The roster groups agents by owner, then by device, and shows offline devices as offline rather than dropping them.

## Identity and grant model (pending Security review)

Security has reviewed this design twice. Its signer conditions (S-1 to S-9), its required changes M3-1 to M3-13 and its answer on key storage are adopted below. Its recommendations on revocation windows and cross-owner tools are recorded as recommendations, with the owner decisions still open. This section stays **pending Security review** until Security clears the M3 PR; a relay of approval does not count.

### Principals

- **Owner.** A human who controls a set of agents. Identified by an opaque `own_<32 hex>` id minted on first setup and an owner root key. Display names are local metadata and never part of an id.
- **Account.** One provider account the owner uses (for example a model subscription). Represented by the existing opaque `eid_` reference from Execution Identity V1 and attached to exactly one owner. One owner may have many accounts. Account credentials never leave the machine that signed in.
- **Device.** A machine enrolled by its owner. Each device has its own non-exportable signing key and an owner-root-signed device record with `owner`, `kid`, public key, `nbf`, `exp` (at most one year) and a domain tag. A device can act for only one owner.
- **Agent.** A handle in the owner's namespace. The qualified form is the structured pair `{ "handle": "reviewer", "owner": "own_..." }`, never a free-form label. `@` and the `own_` prefix are refused in handles and aliases, and alias or lowercase fallback never resolves a qualified name. Existing single-owner handles map to the local owner, so nothing changes for a one-person fleet.
- **Owner handles are local petnames.** A petname is bound at join to the peer's `own_` id and owner key fingerprint, which the two owners compare out of band. A handle or key offered by the remote side is never accepted on its own. A key change for a known owner is a hard stop that needs a re-pin.

### Keys and the signer interface

No private key ever exists in Phantom Secrets, in an environment variable, in a file or in any process an agent can start. Phantom Secrets keeps only public keys and signed records, by name. All signing goes through one pluggable signer interface; no backend requires a particular operating system.

| Backend | Platforms | Key | Presence and verification per signature | Helper |
| --- | --- | --- | --- | --- |
| Secure Enclave | macOS | Non-exportable P-256 generated in the enclave | Touch ID or the device passcode | The existing custody helper, with a new `sign-fleet-grant` verb |
| TPM 2.0 with Windows Hello | Windows | Non-exportable P-256 from the Platform Crypto Provider, with TPM key attestation | Windows Hello PIN or biometric on every use | Runs as the user, never as a SYSTEM service; reached only over a named pipe with a protected DACL for the owner's user SID, remote clients rejected, first-instance creation, and server and client process identity checks. Never TCP |
| TPM 2.0 | Linux | Non-exportable P-256 under the owner hierarchy (`fixedTPM`, `fixedParent`, `sensitiveDataOrigin`) | A PolicyAuthValue PIN per signature under TPM dictionary-attack lockout. This proves the PIN, not physical presence, so the device record says `uv: "pin-only"` | A system unit running as a dedicated `phantom-signer` user in group `tss`, hardened (`NoNewPrivileges`, `ProtectHome`, `ProtectSystem=strict`, `PrivateTmp`, `MemoryDenyWriteExecute`) |
| FIDO2 or WebAuthn | Any OS, hardware security keys and platform passkeys | Non-exportable credential on the authenticator | Both the UP and UV flags on every assertion | On Linux a user unit; on other systems the platform API. Linux helpers listen only on a Unix socket checked with `SO_PEERCRED` for the owner's uid, never an abstract socket or TCP, and require Yama `ptrace_scope` of 1 or higher |

Rules every backend meets:

- **S-1 Hardware key.** Generated inside hardware and never exportable. Software keys are never allowed, including an encrypted file, an OS keychain or credential store, a desktop secret service or Phantom Secrets.
- **S-2 Presence and verification on every signature.** An agent can request a signature but can never complete one. The prompt is shown by the OS or the helper, never through an agent's terminal. No cached unlock, session or batch signing.
- **S-3 Attestation where available.** Secure Enclave key generation, TPM key attestation on Windows, TPM2_Certify against the endorsement key chain on Linux, and a packed or TPM attestation statement for FIDO2 with the AAGUID checked against a declared allowlist. The signer always requests attestation. When none is available, for example a platform passkey that returns `none`, the device is accepted only after the owner compares its key fingerprint out of band, its record says `attested: false`, and peers may refuse such devices by policy.
- **S-4 One byte encoding.** The message to sign is `SHA-256("phantom.fleet.sig.v1\x00" || canonical bytes)` everywhere. Secure Enclave and TPM backends sign that digest. The FIDO2 backend uses it as the WebAuthn challenge, and the verifier rebuilds it and checks the client data type, challenge and origin, the relying party id hash, the UP and UV flags, and that the signature counter never goes backwards. Every backend's output is normalized to one record: `{ alg, kid, backend, sig, webauthn? }`.
- **S-5 Algorithms.** Version 1 is ES256 only: P-256 ECDSA with an IEEE P1363 `r||s` signature, low-S normalized, on every backend; verifiers refuse high-S encodings. The owner record declares its accepted set, and a verifier accepts only an `alg` that is in both that set and its own compiled-in set. `alg` sits inside the signed bytes, so there is no negotiation or downgrade, and `none` is never accepted. Ed25519 is not in version 1, because the Secure Enclave and most TPMs cannot hold it.
- **S-6 Signer bound to the owner.** The owner root record lists each device `kid`, signed by an owner root key, with the key's `backend`, `alg`, `attested` and `uv` level, the SHA-256 of its public key, `nbf` and `exp` (at most one year). A signature verifies only if its `kid` is a currently valid device under the issuer's root.
- **S-7 Replay fields.** Every signed grant and envelope includes `aud`, `nbf`, `exp`, a 128-bit `nonce`, `kid` and `ctx`; envelopes also carry a per-device `seq`.
- **S-8 No hardware means receive-only.** A node without a qualifying hardware backend can join only as receive-only. It cannot issue grants or enroll devices, and it never falls back to a software key, an environment variable, a vault entry or a passphrase. A test proves there is no software fallback.
- **S-9 What you see is what you sign.** The helper builds the prompt from the validated payload: purpose, grantee, verbs, expiry and a 12-hex digest of the message. Windows passes that text as the Hello or key UI policy description; FIDO2 and Linux helpers show it in a helper-owned window before the touch. Off macOS a same-user process could draw a look-alike window, so the protection there is the per-signature hardware gesture plus the owner's audit view, which shows every issued grant again after the fact.

Grant issue, revoke and device enrollment are reachable only through the signer helper with a hardware gesture, started by the human. They are never reachable through the web API, the MCP server or a bus envelope. Fleet nodes set `PHANTOM_REQUIRE_KEYCHAIN=1`, and no fleet trust material is ever stored in Phantom Secrets or a desktop secret service.

### Tenancy

- Every roster row, bus participant, claim, bundle and grant carries the owner principal. The field is named `principal`, because claims already use `owner` for a lane label.
- Each node stores only its own owner's state, plus foreign envelopes it accepted under a grant. There is no shared store between owners.
- Labels remain routing data only. Authority comes from a grant check, never from a label, a display name or a claim that another person approved.
- Messages from another owner are untrusted data that is stored and displayed only. They can never be claimed, dispatched, enqueued to any teammate or lane, or turned into a job, through any configuration.

### Grants

A grant is a JSON document signed by one of the issuing owner's devices through the signer interface. Every field except `signature` is inside the signed bytes:

```json
{
  "v": 1,
  "ctx": "phantom.fleet.grant.v1",
  "kind": "fleet.grant",
  "id": "grt_0123456789abcdef0123456789abcdef",
  "issuer": "own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "aud": "own_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "kid": "kid_cccccccccccccccccccccccccccccccc",
  "nonce": "<128-bit random, base64url>",
  "grantee": { "owner": "own_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "agents": ["reviewer"] },
  "scope": [
    { "verb": "bus.read", "channel": "group:shared-review" },
    { "verb": "bus.post", "channel": "group:shared-review" },
    { "verb": "roster.view" }
  ],
  "limits": { "maxMessagesPerHour": 120, "spend": "none", "egress": "none" },
  "issuedAt": 1795478400,
  "nbf": 1795478400,
  "exp": 1798070400,
  "alg": "ES256",
  "signature": { "alg": "ES256", "kid": "kid_cccccccccccccccccccccccccccccccc", "backend": "tpm", "sig": "<base64url P1363 r||s, low-S>" }
}
```

Rules:

- Deny by default. No grant means no cross-owner read, post, roster view or bundle pull.
- The verifier rejects a grant whose `aud` is not itself, whose `kid` is not a currently valid device of `issuer`, whose `alg` is not valid under the issuer root, whose time is outside `nbf` and `exp`, or whose `id` or `nonce` it has already seen with a different body.
- A grant is trust in the grantee **owner**. The agent list is advisory and is enforced only by the grantee's node.
- A cross-owner channel needs a grant from **every** owner whose agents take part. One owner cannot pull another owner's agents into a channel.
- Every grant expires; the default is 30 days, and there are no permanent grants.
- M3 verbs are a closed list: `bus.read`, `bus.post` (store and display only), `roster.view` (reduced view) and `bundle.pull` (signature required; import stays a dry run and drafts-only). Unknown verbs fail closed.
- Cross-owner `tool.use` does not ship in M3 (M3-7). Security recommends that, after the M4 transport review, it be allowed only for tools that use no credentials or only credentials the calling owner binds, are read-only, validate a declared argument schema strictly, scrub outputs for secret-shaped values, have per-grant call and byte caps, and are audit-logged on both nodes. Whether and when it is ever allowed is an open owner decision.
- Grants never authorize spend, outside messages, merges, releases or changes to pinned files. Those keep their existing approvals.
- **Strict canonical parsing.** Verification uses a strict parser that rejects duplicate keys, lone surrogates, non-integer times and unknown fields. It re-canonicalizes (RFC 8785) and compares bytes before checking the signature. Ids and handles are ASCII only.

### Signed envelopes

Every cross-owner envelope is signed by the sending device through the signer interface, with `ctx` `phantom.fleet.envelope.v1`. The signed bytes include `aud`, `nbf`, `exp`, a 128-bit `nonce`, `alg`, the grant id, the sender device `kid`, the recipient owner, the channel, a per-device monotonic `seq` and a timestamp. The receiver allows a skew of 5 minutes, keeps a high-water mark per sending device, and rejects duplicates, out-of-order sequence numbers and out-of-window envelopes.

### Revocation

- Each owner publishes a signed revocation list with `seq`, `issuedAt`, `nextUpdate`, the issuer's current device `kid` set with each key's `backend` and `alg`, and the issuer's audit chain head.
- **Revocation windows (Security recommendation, owner decision open).** Own-issued grants: 0 seconds. The issuing node checks its own grants at every use against its local revocation state, with no network involved.
- Foreign lists: 15 minutes. `nextUpdate` is at most 15 minutes after `issuedAt`. A list past `nextUpdate` is stale, and stale means revoked.
- **Offline fails closed.** Stored foreign envelopes stay readable locally as data, but no new cross-owner action is taken until a fresh list arrives. A node that has never fetched a list from an issuer treats all of that issuer's grants as revoked. A list with a lower `seq` than one already seen is a rollback: it is refused and raises an audit alert.
- Owners can revoke one grant, every grant to one owner, or everything for one device or agent. Revoking a device `kid` makes every grant and envelope signed by it fail on the next check.
- **Kill switch invariant.** No cross-owner verb or envelope kind can write the kill switch, the communications pause, local policy, grants, the roster configuration or pinned files. KILL on any node, on every OS, stops all of that node's cross-owner traffic at once. Each owner's node enforces its own stop and hard limits.

### Rotation and recovery

- **Recovery root.** Security recommends a second owner root on separate hardware, such as a FIDO2 security key, pinned by peers at join together with the primary. Who holds it, and in what form, is an open owner decision.
- **Rotation.** A new root is announced by a statement signed by both the old and new roots (`supersedes`, effective time), each with user presence. Device records are re-signed under the new root. Moving between backends, for example from macOS to Windows, is an ordinary rotation. Grants are short-lived and are re-issued, not re-signed; grants signed by a superseded `kid` stop verifying at the cutover. Peers accept a rotation only through the pinned old root or the pinned recovery root.
- **Lost device.** From any remaining device or the recovery root, the owner publishes a revocation of that device `kid` with a higher `seq`. The owner revokes the lost device's provider sessions with each provider directly; agents never do.
- **Key compromise.** The recovery root signs a statement that the compromised root is replaced, and revokes every `kid` under it. Peers drop all grants from the old root and re-pin out of band.
- **All keys lost.** The owner starts over with a new `own_` id and each peer re-pins out of band. A peer can always drop an owner unilaterally.

### What a copied agent or tool carries

A bundle (`phantom.bundle.v1`) is one JSON file with a manifest and content-addressed parts.

Carries:

- agent profile fields (role, resource class preference, drafts-only send policy),
- doctrine and prompt text,
- an optional memory seed the exporting owner explicitly chose to include,
- tool manifests and connector profile entries (kind, command name or HTTPS URL, scopes),
- credential **references** by Phantom Secrets name only, for example `{ "credential": "GH_TOKEN", "secret": "github-access" }`,
- automation definitions, which import disabled,
- origin metadata: exporting owner id, bundle version and the SHA-256 digest of each part. A bundle pulled from another owner must carry a valid owner signature.

Never carries:

- secret values, tokens, cookies, keys or environment values,
- provider sign-in state, session stores or transcripts,
- anything read from provider auth or session stores, keychains, `.env` files or token files; export refuses such a part,
- account ids, device ids, machine names or local paths,
- private memory the owner did not select,
- grants. A copy gets no authority from its source.

Import rules:

- Import is a dry run by default and prints what the bundle would create, which tools it references and which secret names it needs.
- Every part is checked against its digest, and the whole bundle goes through the existing secret-shape scrub, unchanged. Any secret-shaped value refuses the import.
- Import writes only inside the new agent's own profile directory and refuses any part that targets a pinned file, such as leader prompts, wrappers or pinned scripts.
- Imported connectors start disabled. HTTPS URLs that resolve to loopback, link-local or private ranges are refused. A command-name connector needs an explicit enable by the owner, outside any agent.
- Imported agents start drafts-only with automations disabled, the same as bot templates today.
- Secret references stay unbound until the importing owner binds them; they never auto-bind by name match.
- The imported agent belongs to the importing owner. The bundle's origin is kept as provenance, not as ownership.

### Roster views

- The local view is unchanged for the local owner.
- The all-owners and `roster.view` projection is reduced to qualified handle, kind, coarse status and coarse last-seen. It never contains provider session ids, free-text titles, URLs, organization names, `eid_` references, device ids, machine names, load or usage.

### Audit trail

- Each node keeps an append-only, hash-chained audit log of grant issue, grant use, revocation, export, import and every denied cross-owner action.
- Entries hold ids, verbs, digests, decisions and times only, never message bodies or secret values.
- The signer signs the chain head at every grant issue and revoke and at least daily, and each signed revocation list carries the issuer's chain head, so a peer can detect a rewritten log.
- Cross-owner envelopes carry the grant id they rely on, so both owners can match an action to its grant from their own logs.

### Required changes before M3 turns on

1. **M3-1.** No private key in Phantom Secrets or in any process an agent can start. Every signature goes through the signer interface (S-1 to S-9), with one `sign-fleet-grant` verb per backend under the same strict contract and domain tag. Owner root keys may sit on any backend that meets S-1 to S-3.
2. **M3-2.** Grants carry `aud`, `nbf`, `exp`, `nonce`, `kid`, `alg` and `ctx: "phantom.fleet.grant.v1"` inside the signed bytes, and are rejected as described under Grants.
3. **M3-3.** Envelopes are device-signed with `ctx`, grant id, `kid`, recipient owner, channel, a per-device monotonic `seq` and a time within 5 minutes, with a high-water mark per device.
4. **M3-4.** Foreign envelopes are never claimed, dispatched, enqueued or turned into jobs, through any configuration.
5. **M3-5.** Owner handles are local petnames bound at join to the `own_` id and root key fingerprint, compared out of band. A key change for a known owner is a hard stop.
6. **M3-6.** Grant issue, revoke and device enrollment go only through the signer helper with a hardware gesture, never through the web API, MCP or the bus. The existing approval endpoint is fixed separately so that an approval proves a human action, not only possession of the web token.
7. **M3-7.** Cross-owner `tool.use` does not ship in M3.
8. **M3-8.** Strict verify-side parsing: duplicate keys, lone surrogates, non-integer times and unknown fields are rejected; bytes are re-canonicalized and compared; ids are ASCII only. The same vectors pass in TypeScript, Swift and every backend helper's language.
9. **M3-9.** Revocation lists carry `seq`, `issuedAt`, `nextUpdate` and the current `kid` set with each key's backend and `alg`.
10. **M3-10.** The signer signs the audit chain head at each issue and revoke and at least daily, and revocation lists carry that head.
11. **M3-11.** A test proves that no cross-owner verb or envelope writes the kill switch, the pause, policy, grants, roster configuration or pinned files, and that KILL stops all of a node's cross-owner traffic on every OS.
12. **M3-12.** A grant is trust in the grantee owner; agent lists are advisory.
13. **M3-13.** A cross-OS signer test proves that the same vector produces byte-identical signed messages on macOS, Windows and Linux, that a missing backend refuses, and that software-key and `alg` downgrade attempts fail verification. It is path-gated: it runs only when signer or authority paths change, and it is never part of the default matrix or a required check. Three conditions apply:
    - **Enable needs a proof on the exact commit.** The M3 enable step requires a passing signer-proof run on macOS, Windows and Linux for the exact commit being enabled. For an authority release, a path filter can never be the only reason the run is skipped.
    - **Filter coverage.** The path filter covers the signer, the authority surface, the canonical encoder and verifier, and the workflow file of the signer-proof job itself. The CI owners maintain the filter, and Security reviews each change to it.
    - **Recorded evidence.** Evidence from a container, a local run or another owner's machine is recorded in the audit ledger with the commit sha, the backend and the result.

Before M3 turns on, each participating owner has also, on their own device, enrolled a hardware signer with attestation or an out-of-band fingerprint check, and compared pairwise key fingerprints out of band. Agents cannot do these steps. The signer ships first with the backends the first participants need, batched into one authority release so routine releases do not re-trip existing standing grants.

### Security findings recorded for M3

- **F19.** The only existing signing oracle is macOS-only: it uses a fixed install path and a host binding to the platform UUID (`src/core/authority/custody-client.ts` lines 49 and 472). There is no Windows or Linux signer yet, so an owner without a Mac has no compliant way to sign today.
- **F20.** Phantom Secrets falls back to an encrypted-file vault when the OS keychain is unavailable unless `PHANTOM_REQUIRE_KEYCHAIN` is set. That is acceptable for secret values but must never be reachable for fleet trust material (S-8).
- **F21.** The existing phone WebAuthn ceremony requires user verification but requests no attestation. The fleet signer must request attestation where available and must not copy that setting (S-3).

### Open owner decisions

Owner signing must work without a Mac; that is decided, and the signer interface above covers it. These remain open, with no assumed answer:

1. Who holds each owner's recovery root, and in what form.
2. Whether cross-owner `tool.use` is ever allowed, and whether it may ever run with the tool owner's own credentials (Security recommends never).
3. Which peers are pinned at join, and the out-of-band channel used to compare key fingerprints.
4. The revocation windows (Security recommends 0 seconds for own-issued grants and 15 minutes for foreign lists).
5. Whether the approval endpoint fix is batched into the same authority release.

### Still open for Security

1. Trust and verification rules for bundles fetched from a link rather than handed over as a file.

## M2 scope: first implementation PR

Security approved M2 as a stub on the conditions below. M2 adds no signing, key or network code path.

Commands (all accept `--json`; none uses the network):

```sh
phm bundle export agent <agent-id> --out reviewer.bundle.json
phm bundle export tool <connector-id> --out lint-helper.bundle.json
phm bundle inspect reviewer.bundle.json --json
phm bundle import reviewer.bundle.json --as reviewer-copy            # dry run
phm bundle import reviewer.bundle.json --as reviewer-copy --apply
phm agents roster --principal local --json
phm agents roster --all-owners --json
```

Conditions, each with its own tests:

1. **M2-1.** `checkGrant()` denies every cross-owner input, including malformed, unknown-verb, expired and validly shaped grants. No configuration, environment variable or flag can enable it in M2.
2. **M2-2.** `@` and the `own_` prefix are refused in handles and aliases. The qualified form is parsed only from the structured `{ handle, owner }` pair, and alias or lowercase fallback never resolves a qualified name.
3. **M2-3.** Import writes only inside the new agent's profile directory and refuses pinned targets. Imported connectors start disabled; loopback, link-local and private URLs are refused; command-name connectors need an explicit owner enable outside any agent; secret references never auto-bind.
4. **M2-4.** The all-owners view is the reduced projection above (qualified handle, kind, coarse status, coarse last-seen) and never carries the forbidden fields. The new field is `principal`, not `owner`.
5. **M2-5.** The teammate bridge enqueues only from local-owner envelopes. A foreign-origin task body is stored as data and never previewed or enqueued.
6. **M2-6.** Export refuses parts read from provider auth or session stores, keychains, `.env` files or token files. Tests use fixtures only. Import runs the existing secret-shape scrub unchanged.
7. **M2-7.** This document stays marked pending Security review.

Done when the tests pass in CI, the commands are documented in the CLI reference and `phm bundle import` never writes without `--apply`.
