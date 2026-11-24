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

Security has reviewed the first draft. Its required changes for M3 and its answers on key storage, revocation windows and cross-owner tools are adopted below. This section stays **pending Security review** until Security clears the M3 PR; a relay of approval does not count.

### Principals

- **Owner.** A human who controls a set of agents. Identified by an opaque `own_<32 hex>` id minted on first setup and an owner root key. Display names are local metadata and never part of an id.
- **Account.** One provider account the owner uses (for example a model subscription). Represented by the existing opaque `eid_` reference from Execution Identity V1 and attached to exactly one owner. One owner may have many accounts. Account credentials never leave the machine that signed in.
- **Device.** A machine enrolled by its owner. Each device has its own non-exportable signing key and an owner-root-signed device record with `owner`, `kid`, public key, `nbf`, `exp` (at most one year) and a domain tag. A device can act for only one owner.
- **Agent.** A handle in the owner's namespace. The qualified form is the structured pair `{ "handle": "reviewer", "owner": "own_..." }`, never a free-form label. `@` and the `own_` prefix are refused in handles and aliases, and alias or lowercase fallback never resolves a qualified name. Existing single-owner handles map to the local owner, so nothing changes for a one-person fleet.
- **Owner handles are local petnames.** A petname is bound at join to the peer's `own_` id and owner key fingerprint, which the two owners compare out of band. A handle or key offered by the remote side is never accepted on its own. A key change for a known owner is a hard stop that needs a re-pin.

### Keys and the signer interface

No private key ever exists in Phantom Secrets, in an environment variable or in any process an agent can start. Phantom Secrets keeps only public keys and records, by name.

All signing goes through the custody helper as a signing oracle. Its new `sign-fleet-grant` command has its own strict input contract, its own domain tag and its own user-presence prompt rendered from the validated payload it is about to sign. Grant issue, revoke and device enrollment are reachable only through that helper, started by the human. They are never reachable through the web API, the MCP server or a bus envelope.

The helper sits behind one pluggable signer interface, so no owner needs any particular operating system:

| Backend | Platforms | Key | User presence | Algorithm |
| --- | --- | --- | --- | --- |
| Secure Enclave | macOS | Non-exportable P-256 | Touch ID or device password per signature | ES256 |
| TPM 2.0 | Windows (Windows Hello) and Linux (`tpm2`) | Non-exportable P-256 created in the TPM | Windows Hello per signature; on Linux a TPM authorization policy that requires a fresh user gesture | ES256 |
| WebAuthn or FIDO2 | Any OS with a hardware security key or a platform passkey | Non-exportable credential on the authenticator | User presence flag required on every assertion; user verification required where the authenticator supports it | ES256 |

Rules for every backend:

- **Algorithm.** ES256 (ECDSA P-256 with SHA-256, IEEE P1363 signature encoding) is mandatory and is the only algorithm verifiers accept in M3, because every backend supports it. Adding another algorithm needs a new Security review.
- **Non-exportable keys.** A backend that cannot prove the key is hardware-bound and non-exportable is refused at enrollment.
- **User presence per signature.** No cached unlock, session token or batch signing.
- **Same signed bytes.** Every backend signs the same domain-tagged canonical bytes. The WebAuthn backend uses SHA-256 of those bytes as the challenge, and verifiers check the assertion's challenge, relying party id, client data type and the user presence flag before checking the signature.
- **One shared contract.** A TypeScript and native test vector suite, including adversarial vectors, pins the bytes for every backend.

### Tenancy

- Every roster row, bus participant, claim, bundle and grant carries the owner principal. The field is named `principal`, because claims already use `owner` for a lane label.
- Each node stores only its own owner's state, plus foreign envelopes it accepted under a grant. There is no shared store between owners.
- Labels remain routing data only. Authority comes from a grant check, never from a label, a display name or a claim that another person approved.
- Messages from another owner are untrusted data that is stored and displayed only. They can never be claimed, dispatched, enqueued to any teammate or lane, or turned into a job, through any configuration.

### Grants

A grant is a JSON document signed by one of the issuing owner's devices. Every field below is inside the signed bytes:

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
  "expiresAt": 1798070400,
  "alg": "ES256",
  "sig": "<base64url P1363 signature>"
}
```

Rules:

- Deny by default. No grant means no cross-owner read, post, roster view or bundle pull.
- The verifier rejects a grant whose `aud` is not itself, whose `kid` is not a currently valid device of `issuer`, whose time is outside `nbf` and `expiresAt`, or whose `id` or `nonce` it has already seen with a different body.
- A grant is trust in the grantee **owner**. The agent list is advisory and is enforced only by the grantee's node.
- A cross-owner channel needs a grant from **every** owner whose agents take part. One owner cannot pull another owner's agents into a channel.
- Every grant expires; the default is 30 days, and there are no permanent grants.
- M3 verbs are a closed list: `bus.read`, `bus.post` (store and display only), `roster.view` (reduced view) and `bundle.pull` (signature required; import stays a dry run and drafts-only). Unknown verbs fail closed.
- Cross-owner `tool.use` does not ship in M3. After the M4 transport review it may be allowed only for tools that use no credentials or only credentials the calling owner binds, are read-only, validate a declared argument schema strictly, scrub outputs for secret-shaped values, have per-grant call and byte caps, and are audit-logged on both nodes. Whether a tool may ever run with the tool owner's own credentials is an open owner decision; Security recommends never.
- Grants never authorize spend, outside messages, merges, releases or changes to pinned files. Those keep their existing approvals.
- **Strict canonical parsing.** Verification uses a strict parser that rejects duplicate keys, lone surrogates, non-integer times and unknown fields. It re-canonicalizes (RFC 8785) and compares bytes before checking the signature. Ids and handles are ASCII only.

### Signed envelopes

Every cross-owner envelope is signed by the sending device. The signed bytes include the domain tag `phantom.fleet.envelope.v1`, the grant id, the sender device `kid`, the recipient owner, the channel, a per-device monotonic sequence number and a timestamp. The receiver allows a skew of 5 minutes, keeps a high-water mark per sending device, and rejects duplicates, out-of-order sequence numbers and out-of-window envelopes.

### Revocation

- Each owner publishes a signed revocation list with `seq`, `issuedAt`, `nextUpdate`, the issuer's current device `kid` set and the issuer's audit chain head.
- **Own-issued grants: 0 seconds.** The issuing node checks its own grants at every use against its local revocation state, with no network involved.
- **Foreign lists: 15 minutes.** `nextUpdate` is at most 15 minutes after `issuedAt`. A list past `nextUpdate` is stale, and stale means revoked.
- **Offline fails closed.** Stored foreign envelopes stay readable locally as data, but no new cross-owner action is taken until a fresh list arrives. A node that has never fetched a list from an issuer treats all of that issuer's grants as revoked. A list with a lower `seq` than one already seen is a rollback: it is refused and raises an audit alert.
- Owners can revoke one grant, every grant to one owner, or everything for one device or agent. Revoking a device `kid` makes every grant and envelope signed by it fail on the next check.
- **Kill switch invariant.** No cross-owner verb or envelope kind can write the kill switch, the communications pause, local policy, grants, the roster configuration or pinned files. KILL on any node stops all of that node's cross-owner traffic at once. Each owner's node enforces its own stop and hard limits.

### Rotation and recovery

- **Recovery root.** At setup the owner mints a second owner root on a separate authenticator, and peers pin its public key at join together with the primary.
- **Rotation.** A new root is announced by a statement signed by both the old and new roots (`supersedes`, effective time), each with user presence. Device records are re-signed under the new root. Grants are short-lived and are re-issued, not re-signed; grants signed by a superseded `kid` stop verifying at the cutover. Peers accept a rotation only through the pinned old root or the pinned recovery root.
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
- The custody helper signs the chain head at every grant issue and revoke and at least daily, and each signed revocation list carries the issuer's chain head, so a peer can detect a rewritten log.
- Cross-owner envelopes carry the grant id they rely on, so both owners can match an action to its grant from their own logs.

### Before M3 turns on

1. The changes in this section are implemented with tests, and Security has reviewed the M3 PR.
2. `sign-fleet-grant` ships in the custody helper with the signer interface above, batched into one authority release so routine releases do not re-trip existing standing grants.
3. Each participating owner has, on their own device, set up the signer with user presence, minted a recovery root and compared key fingerprints out of band. Agents cannot do these steps.
4. Adversarial tests are green: replay across device, channel and audience; duplicate-key and surrogate canonicalization; qualified-name spoofing through aliases; foreign task envelopes never dispatched or enqueued; foreign kill or configuration envelopes refused; stale and rollback revocation lists refused; and the reduced roster projection leaking none of the forbidden fields.

### Open owner decisions

Owner signing must work without a Mac: Secure Enclave, TPM (Windows Hello and Linux) and WebAuthn or FIDO2 backends are all in scope, as above. These remain open, with no assumed answer:

1. Who holds each owner's recovery root, and in what form.
2. Whether cross-owner `tool.use` may ever run with the tool owner's own credentials.
3. Which peers are pinned at join, and the out-of-band channel used to compare key fingerprints.
4. Whether to fix, together with the authority release, the existing approval endpoint so that an approval proves a human action rather than possession of the web token.

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
