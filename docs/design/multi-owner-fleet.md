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

1. **M2 (first implementation PR):** portable agent and tool bundles with `phm` export, inspect and import; a multi-owner roster with an owner field and per-owner views; grant checks stubbed to deny-by-default against the model below. No network, no keys and no cross-owner sends yet.
2. **M3:** owner keys, signed grants, revocation list and audit log, after Security review of this document.
3. **M4:** one external bus transport for cross-owner channels between owner nodes over a private network, behind the existing `ownerApproved` egress gate.
4. **M5:** desktop app surfaces: an owner switcher, a shared roster, an Import from link flow and a grants panel.

## External agents and machines as roster members

Some agents are not Phantom processes at all. Two already have a bus identity: an OpenAI Dot (`agent:imsg-dot`) and an independent agent called Instinct (`agent:imsg-instinct`) that has its own GitHub access and takes PR rebase and triage work. Both are reached only by iMessage, through the existing [teammate task transport](../IMESSAGE.md#fleet-teammate-tasks-and-evidence). This design keeps that path and adds no new sender.

Bridge, inbound and outbound:

- **Bus to teammate.** A bus envelope addressed to `agent:imsg-dot` or `agent:imsg-instinct` with a v2 `task` body becomes a teammate task preview (`phm fleet imessage-tasks enqueue`). Nothing is sent until the owner-approved dispatch runs, and that dispatch keeps every current gate: the local allowlist, the send policy, the kill switch, the communications pause and the hourly cap.
- **Teammate to bus.** A matching task result from the expected peer will be posted back to the bus (new in M2) as a `result` envelope that cites the task's envelope id. It is marked `peer-reported`; it is evidence, never proof and never authority. Free-form texts from these peers are never turned into work.
- **Presence.** The mesh publisher already writes `imsg-dot` and `imsg-instinct` observations from the task store. The multi-owner roster shows them with `kind: "external"`, their transport, their last result time and their open task ids.

Ownership:

- An external agent belongs to the owner whose account hosts it. That owner's grants decide who may address it.
- When the hosting owner is not verified, the roster records `owner: null` with the reason `unverified`. Such an agent can receive tasks only from the local owner, and only through the existing approved transport.
- No raw handle, phone number or address ever appears in the roster, a bundle or this repository; only the existing hashed sender ids and routing labels do.

Machines:

- Each machine is a device of exactly one owner, enrolled from the existing node registry. The roster groups agents by owner, then by device, and shows offline devices as offline rather than dropping them.

## Identity and grant model (pending Security review)

### Principals

- **Owner.** A human who controls a set of agents. Identified by an opaque `own_<32 hex>` id minted on first setup and an Ed25519 owner key. Display names are local metadata and never part of an id. The owner private key stays on the owner's machines and is stored only in Phantom Secrets; other code refers to it by name.
- **Account.** One provider account the owner uses (for example a model subscription). Represented by the existing opaque `eid_` reference from Execution Identity V1 and attached to exactly one owner. One owner may have many accounts. Account credentials never leave the machine that signed in.
- **Device.** A machine enrolled by its owner with an owner-signed device record (device public key, owner id, expiry). A device can act for only one owner.
- **Agent.** A handle in the owner's namespace. The qualified form is `<agent-handle>@<owner-handle>`; the bus address stays `agent:<qualified>`. Existing single-owner handles map to the local owner, so nothing changes for a one-person fleet.

### Tenancy

- Every roster row, bus participant, claim, bundle and grant carries an `owner` field.
- Each node stores only its own owner's state, plus foreign envelopes it accepted under a grant. There is no shared store between owners.
- Labels remain routing data only. Authority comes from a grant check, never from a label, a display name or a claim that another person approved.
- Messages from another owner are untrusted data. They can never launch work, spend usage, send outside messages or change configuration on the receiving node unless the receiving owner's own local policy allows that exact action.

### Grants

A grant is a JSON document signed by the issuing owner:

```json
{
  "v": 1,
  "kind": "fleet.grant",
  "id": "grt_0123456789abcdef0123456789abcdef",
  "issuer": "own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "grantee": { "owner": "own_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "agents": ["reviewer@owner-b"] },
  "scope": [
    { "verb": "bus.read", "channel": "group:shared-review" },
    { "verb": "bus.post", "channel": "group:shared-review" },
    { "verb": "roster.view" },
    { "verb": "tool.use", "tool": "lint-helper", "digest": "sha256:<64 hex>" }
  ],
  "limits": { "expiresAt": "2026-12-24T00:00:00Z", "maxMessagesPerHour": 120, "spend": "none", "egress": "none" },
  "issuedAt": "2026-11-24T00:00:00Z",
  "sig": "ed25519:<base64>"
}
```

Rules:

- Deny by default. No grant means no cross-owner read, post, roster view or tool use.
- A cross-owner channel needs a grant from **every** owner whose agents take part. One owner cannot pull another owner's agents into a channel.
- Every grant expires; the default is 30 days, and there are no permanent grants.
- Scope verbs are a closed list (`bus.read`, `bus.post`, `roster.view`, `tool.use`, `bundle.pull`). Unknown verbs fail closed.
- `tool.use` names a tool by id and content digest. A changed tool needs a new grant.
- Shared tool use runs on the tool owner's node with that owner's credentials and limits, or not at all. A grant never moves a credential.
- Grants never authorize spend, outside messages, merges, releases or changes to pinned files. Those keep their existing approvals.
- Signatures use canonical JSON (RFC 8785) so every node verifies the same bytes.

### Revocation

- Each owner publishes a signed, monotonically numbered revocation list. A node rejects any grant whose id is on the issuer's latest list and refuses lists with a lower sequence number than one it has already seen.
- Every use rechecks expiry and revocation. A node that cannot reach a fresh list within the configured staleness window treats grants from that issuer as revoked.
- Owners can revoke one grant, every grant to one owner, or everything for one device or agent. A per-owner kill switch stops all cross-owner traffic at once and reuses the existing local bus hold.
- Removing a device revokes its device record; envelopes signed by that device are rejected from then on.

### What a copied agent or tool carries

A bundle (`phantom.bundle.v1`) is one JSON file with a manifest and content-addressed parts.

Carries:

- agent profile fields (role, resource class preference, drafts-only send policy),
- doctrine and prompt text,
- an optional memory seed the exporting owner explicitly chose to include,
- tool manifests and connector profile entries (kind, command name or HTTPS URL, scopes),
- credential **references** by Phantom Secrets name only, for example `{ "credential": "GH_TOKEN", "secret": "github-access" }`,
- automation definitions, which import disabled,
- origin metadata: exporting owner id, bundle version, SHA-256 digest of each part, and an optional owner signature.

Never carries:

- secret values, tokens, cookies, keys or environment values,
- provider sign-in state, session stores or transcripts,
- account ids, device ids, machine names or local paths,
- private memory the owner did not select,
- grants. A copy gets no authority from its source.

Import rules:

- Import is a dry run by default and prints what the bundle would create, which tools it references and which secret names it needs.
- Every part is checked against its digest, and the whole bundle goes through the existing secret-shape scrub. Any secret-shaped value refuses the import.
- Imported agents start drafts-only with automations disabled, the same as bot templates today.
- Secret references stay unbound until the importing owner binds them to secrets in their own vault.
- The imported agent belongs to the importing owner. The bundle's origin is kept as provenance, not as ownership.

### Audit trail

- Each node keeps an append-only, hash-chained audit log of grant issue, grant use, revocation, export, import and every denied cross-owner action.
- Entries hold ids, verbs, digests, decisions and times only, never message bodies or secret values.
- Cross-owner envelopes carry the grant id they rely on, so both owners can match an action to its grant from their own logs.
- `phm fleet audit --json` reads the log; the desktop grants panel shows the same data.

### Open questions for Security

1. Key storage and rotation for owner and device keys in Phantom Secrets, and recovery when an owner loses every device.
2. The default revocation staleness window.
3. Whether `tool.use` across owners should ship in M3 or wait until the external transport has been reviewed.
4. The trust and verification rules for bundles fetched from a link rather than handed over as a file.

## M2 scope: first implementation PR

Commands (all accept `--json`; none uses the network):

```sh
phm bundle export agent <agent-id> --out reviewer.bundle.json
phm bundle export tool <connector-id> --out lint-helper.bundle.json
phm bundle inspect reviewer.bundle.json --json
phm bundle import reviewer.bundle.json --as reviewer-copy            # dry run
phm bundle import reviewer.bundle.json --as reviewer-copy --apply
phm agents roster --owner local --json
phm agents roster --all-owners --json
```

Code:

- `src/core/bundles/`: bundle schema, canonical JSON, digests, export from agent profiles and connector profiles, import that reuses the profile and connector writers.
- Roster: an `owner` field on every session row (defaults to the local owner), a `kind` of `local` or `external`, a per-owner filter and an all-owners view that, until M3, shows only the local owner and its external agents.
- `src/core/fleet/grants.ts`: grant and revocation schemas and a `checkGrant()` that always denies cross-owner actions until M3 enables signature checks.
- Tests: round-trip export and import, digest tampering, secret-shaped value refusal, path and machine name stripping, unknown-field refusal, drafts-only and disabled automation on import, roster owner filtering, and deny-by-default grant checks.

Done when the tests pass in CI, the commands are documented in the CLI reference and `phm bundle import` never writes without `--apply`.
