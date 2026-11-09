# Scale path: from personal computers to open compute

This is the target architecture for Phantom's node router, not a claim that
multi-host routing or multi-tenant isolation has shipped. Each stage builds on
the previous one; added capacity must not weaken its ownership boundaries.
The [node router guide](../NODE-ROUTER.md) describes today's commands and limits.

## Owner, tenant and node

An **owner scope** identifies the person or organization on whose behalf a job
runs. Every job has exactly one owner; a node may be eligible for explicitly
authorized owners. A **tenant** is the security and administrative boundary
containing its owners, members, jobs, artifacts and policy. Membership in a
team does not confer another person's credentials. Identity, node enrollment
and authorization must be verified by a trusted authority, not inferred from a
caller-supplied owner string. Cross-tenant sharing requires explicit policy
and isolation; capacity sharing never grants access to another tenant's data.

Node kinds describe deployment and custody, not a bypass of routing policy:

- **Personal node:** a person's laptop, desktop or other computer, using its own
  local authentication and secret custody.
- **Team-managed node:** a workstation or server enrolled by an organization,
  using credentials provisioned and controlled on that node.
- **Enterprise node:** customer-managed or dedicated infrastructure subject to
  that tenant's identity, network and administrative policy.
- **Pool node:** an explicitly opted-in provider's capacity, eligible only for
  workloads and isolation levels that both provider and job owner permit.

Today the router models owner scopes and capabilities, not these node kinds as
an enforced taxonomy. A coordinator is also a node, not an exempt superuser.

## 1. One person's computers

Ship a local-first registry, capability and load-aware planning, heartbeats,
owner-scoped jobs, local auth checks, and leased pulls with fencing. The person
owns the jobs and enrolls their own nodes; each node uses its own auth. The
current store coordinates processes on one host in a private directory. It is
not a multi-host consensus service, and its output filters do not protect state
from someone with filesystem access. Multi-computer coordination needs a shared
authority before it can be claimed as shipped.

## 2. First team

Ship authenticated membership and node enrollment, explicit owner grants,
team-scoped visibility, revocation and audit, and a shared routing authority
with durable transactional leases. Personal nodes remain under their owners'
control; team-managed nodes run only authorized team work. Members see only
what their roles and owner grants allow. Team membership does not transfer
credentials, secret values or implicit access to personal jobs. Prove isolation
and failover across hosts before relying on shared routing.

## 3. Other teams and enterprises

Ship tenant-aware identity and authorization at every API and storage boundary,
separate tenant data and policy, administrative lifecycle and audit, and
customer-managed or dedicated nodes. A tenant controls its members, owners,
nodes and workload placement; one team's operator cannot inspect another's
jobs, packs, secret names, artifacts or node metadata. Enforce isolation in the
service and storage, not merely in a client-side filter. Test adversarial
cross-tenant requests, revocation, recovery and failover before onboarding.

## 4. Open compute pooling

Ship explicit provider and job-owner opt-in, policy-based placement, workload
isolation, admission and capacity accounting, and auditable revocation and
cleanup. A provider contributes capacity without receiving another tenant's
credentials or unrestricted workload data; a job owner chooses whether its
work is eligible and what isolation it requires. Do not run a workload on a
pool node unless the execution environment can enforce those terms. Pooling
must preserve tenant isolation across scheduling, execution, artifacts and
observability, including after node reuse and failures.

## Leases and invariants

A pull grants a time-bounded lease tied to a node session, leader epoch and
monotonically increasing fencing token. Renew while working; on expiry, session
loss or leader change, stop and discard authority. A reassignment receives a
newer token and stale renewals and completions are rejected. A lease does not
make external effects exactly once: effect sinks must reject stale fencing tokens
or use a suitable job idempotency key. A multi-host authority must provide
serializable transactions, durable monotonic fencing and an authoritative clock;
uncertain authority fails closed. See the [store contract](../../src/core/drive/nodes/README.md).

These invariants apply at every stage:

- **Own local auth:** nodes use their own locally held credentials. Jobs carry
  secret names only; the router never transports secret values or tokens.
- **Owner-scoped jobs:** reject or leave unrouted work without an owner; only
  authenticated, explicitly authorized nodes may see or execute that owner's work.
- **No cross-tenant leaks:** enforce tenant isolation for jobs, metadata, packs,
  secret names, logs, artifacts and results, including errors and operator views.
- **Loopback-only local models:** local model endpoints stay on loopback; routing
  a job to a node never exposes that node's local model to the network.
- **Fenced effects:** losing a lease removes authority to renew, complete or
  produce an accepted external effect. Never infer effect safety from a prior
  lease check alone.
