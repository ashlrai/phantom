# Cortex engineering bridge

Use Cortex to prepare a company engineering request and Phantom to produce one
pending patch proposal on an explicitly selected local repository. The bridge
uses Cortex's authenticated worker protocol v2 at `/api/fleet/worker` and the
signed `ashlr-engineering-assignment/v1` contract. A worker advertising
`engineering-assignment-v1` receives engineering assignments only.

The command runs in the foreground once. It creates private local artifacts and
returns their hashes plus a bounded summary to the original Cortex run. It does
not install a resident worker, push a branch, merge a proposal, or deploy code.
Google/provider activation and proactive-assistant adapters are separate from
this engineering transport.

## Configure a worker

The operator must obtain a worker-scoped Cortex API token, the organization ID,
and the issuer/audience/key ID and Ed25519 public key from the Cortex deployment
owner. Pin that public key independently of the claim response. Never copy a
signing private key onto the worker. The token's current organization membership
and workstream permissions are checked by Cortex on every request.

Create an owned private directory for bridge records and a private JSON
configuration (mode `0600`). Paths must be absolute physical paths without
symlink aliases. Repository mapping is explicit; a server cannot choose arbitrary
local paths. Example values below are fictional:

```json
{
  "schemaVersion": 1,
  "url": "https://cortex.example.invalid",
  "organizationId": "company-example",
  "tokenEnv": "CORTEX_WORKER_TOKEN",
  "root": "/absolute/private/cortex-bridge",
  "verifier": {
    "issuer": "ashlr-cortex",
    "audience": "ashlr-phantom",
    "publicKeys": {
      "company-key-1": "-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_OPERATOR_PINNED_ED25519_PUBLIC_KEY\n-----END PUBLIC KEY-----\n"
    }
  },
  "repositories": [
    {
      "repository": "example-company/example-project",
      "path": "/absolute/repositories/example-project",
      "workstreams": ["company"]
    }
  ],
  "runtimes": ["codex"],
  "budget": { "maxTokens": 200000, "maxSteps": 40, "allowCloud": true }
}
```

`runtimes` must be exactly `["codex"]` for the current Cortex engineering queue.
Claude Code is not admitted by this bridge. Runtime authentication, repository
enrollment and normal Phantom KILL/policy checks remain required. The mapped
repository must have the signed GitHub origin, a clean worktree, and HEAD equal
to the assignment's exact source commit. A signed assignment permits at most
32 allowed-file patterns of 220 characters each on this worker. Changes to
build/CI/manifests may be refused by the existing proposal verifier and require
normal manual review.

The bridge replaces Codex's usual unattended bypass flags with an explicit
`cortex-proposal` native permission profile: minimal runtime reads, workspace
writes, and no command network access. It forces Phantom's existing hardened
outer confinement, ignores Codex user configuration and execpolicy rules, and
disables apps, plugins, hooks, browsers, computer use, memory and subagents.
Repositories containing a project `.codex` directory are refused because project
configuration can launch MCP tools outside the command sandbox. Codex's own
model transport still connects to OpenAI; shell subprocesses cannot use it as
general outbound access. These controls require a Codex CLI supporting the
named permissions configuration and ignore-user-config flags. Unsupported flags
fail the invocation. The native macOS regression probe runs without inference or
provider credentials and checks successful workspace writes, denied outside
writes, and a direct TCP connect returning an OS permission denial.

See the [official permissions documentation](https://learn.chatgpt.com/docs/permissions)
for command network and filesystem behavior. Other agent backends need equivalent
enforced isolation before they can handle company evidence through this bridge.

Check the configuration offline:

```sh
ashlr cortex check --config /absolute/private/cortex.json --json
```

With the worker token supplied in the selected environment variable by the
operator's secret manager, explicitly execute one prepared request:

```sh
ashlr cortex once --config /absolute/private/cortex.json --execute --json
```

The token is sent only in the HTTPS authorization header. Redirects are refused.
The foreground process removes that token from its environment while executing
the producer and verification commands, restoring it before exit. No company
memory is recalled or captured by the bridge's model invocation.

## Review the result

An empty queue returns `{"state":"idle"}`. A successful round trip returns
`{"state":"proposed","runId":"…","proposalId":"…","cortexProposalId":"…"}`.
The two proposal IDs name the local patch and the confirmed Cortex Approval Inbox
item respectively. This means a signed,
complete pending Phantom proposal was correlated to the producer's durable run,
and the existing separate-worktree verifier accepted it at the signed base
commit. Captured changed paths, changed files and added/deleted lines are checked
against the signed assignment. Cortex receives a proposal receipt and creates
its own review item; the receipt is authenticated worker evidence, not an
independent attestation or a completed business outcome.

After verification, the bridge locks the local proposal, reloads its signed
pending identity, and requires the persisted verification to match the original
diff bytes and source commit before saving receipt artifacts. A generic successful
worker response without a Cortex proposal ID is held, preserving `receipt.json`
without writing `accepted.json`.

Each attempt has a private directory named by SHA-256 of the Cortex run ID:
`assignment.json`, `proposal.diff`, `proposal.json`, `verification.json`,
`receipt.json`, and (after acceptance) `accepted.json`. The three artifact hashes
in the receipt identify the exact local diff, proposal, and verification record.
Artifact paths are local relative references; this version does not upload raw
patches or company repository files to Cortex.

## Cancellation and uncertain results

The separate proposal verifier is also required to use Phantom's existing OS
confinement with network disabled, even when no standing authority grant exists.
If the platform cannot construct that sandbox, verification fails closed. The
bridge does not enable a standing grant to obtain this isolation.

A fresh heartbeat is required before producing work and before returning a
receipt. The producer receives an abort signal on revocation, lost heartbeat,
SIGINT/SIGTERM, assignment expiry, or the bounded wall-clock deadline. Existing
verification commands do not accept this signal: a verification already running
may finish its locally bounded checks, but the bridge cannot publish its receipt
without another successful heartbeat.

Every assignment reserves its local attempt directory exclusively before model
execution. A replay or uncertain crash is held rather than dispatched again.
Do not delete this directory to retry. Inspect the Cortex run and retained local
proposal, then make a new reviewed assignment if needed. If the final network
response is lost, `receipt.json` is retained and `accepted.json` may be absent;
that absence does not prove Cortex rejected it. Reconcile the run in Cortex
before creating replacement work. Invalid local configuration, failed checks,
or unsuccessful receipt acceptance exit nonzero.

## Implementation references

- [Foreground bridge and receipt construction](../src/core/cortex/bridge.ts)
- [Portable signed assignment codec](../src/core/cortex/engineering-assignment.ts)
- [Existing sandboxed producer](../src/core/run/sandboxed-engine.ts)
- [Existing pending-proposal authority](../src/core/inbox/pending-authority.ts)
- [Existing separate-worktree verification](../src/core/inbox/merge.ts)
