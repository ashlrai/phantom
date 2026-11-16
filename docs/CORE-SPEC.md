# Phantom core spec

> **Scope.** This page defines the irreducible core of Phantom: what the system
> must do and the parts it is made of. It is a design contract, not a claim
> about deployed capability. The [North Star](NORTH-STAR.md) describes the
> objective; this page names the smallest set of parts that serve it.

## The rule

Phantom has six core parts and one leader that drives them. Everything else is
a plugin or an adapter. A feature that does not serve one of the six parts
does not belong in the core.

The same simple core must serve one person on one subscription and scale,
without a redesign, to millions of agents. Scale comes from adding providers,
nodes and adapters, never from special cases in the core.

## The six parts

### 1. Model router

A load balancer across any provider, model or harness. For each job it picks
the route with the best expected outcome per token and per minute, using
measured results rather than fixed preferences. Providers, models and harnesses
are adapters; adding one never changes the router.

Related: [fleet lanes](lanes.md), [work market](QUEUE.md).

### 2. Compute fabric

Any computer can join as a node, from a single laptop to a large pool. Each node
measures its own capacity and advertises it; the fabric schedules against that
measurement. There are no hard-coded caps on concurrency or node count. A lease
guarantees that a job runs on exactly one node.

Related: [node router](NODE-ROUTER.md), [compute pool](NODES.md).

### 3. Unified engineering surface

One surface for humans and agents: the desktop app and the CLI share one
runtime, an agent bus carries messages between agents, and Slack and iMessage
bridges carry the same conversation off the desktop. Every surface reads the
same state; none owns private state.

Related: [agent bus](AGENT-BUS.md), [Slack ingress](SLACK-BUS-INGRESS.md),
[iMessage](IMESSAGE.md).

### 4. Self-approving autonomous fleet

The fleet reviews, approves, merges and releases its own work inside hard
limits. Hard limits are enforced by the system, not by agent discipline: no
spend beyond included usage, no bypass of required checks or the merge queue,
no force-push, no secret access, and protected files change only through a
security review. Inside those limits no human approval is required.

Related: [autonomy authority](AUTHORITY.md),
[standing authority](STANDING-AUTHORITY.md).

### 5. Problem selection and solution curation

A first-class loop, not a side effect. Selection picks the highest-leverage work
next and drops duplicates before they are dispatched. Curation judges each
result on evidence, keeps what is merged and useful, and closes or cuts the
rest. Every repository has an owner, and no pull request or line of code is
left orphaned.

Related: [repository owners](REPO-OWNERS.md).

### 6. Recursive self-improvement

Phantom improves its own router, fabric, surface, fleet and selection loop
through the same pipeline it uses for any other repository. Progress is
measured by merged value per token and merged value per hour. A change that
does not move either measure, or that cannot be measured, is a candidate to cut.

## Autonomous leader

A leader agent drives the fleet every cycle. It acts proactively and never
waits for a prompt: it reads fleet state, runs the selection loop, dispatches
work through the router and fabric, and curates the results. Humans are
passive overseers. They watch, and they can speak to the leader directly, but
the fleet does not stop to wait for them. The hard limits in part 4 apply to
the leader unchanged.

Related: [Leader](LEADER.md).

## Goals mapped to spec parts

| Goal | Parts |
| --- | --- |
| Repositories are fully owned and self-maintaining, with no orphaned pull requests or lines. | 5 |
| Thousands of merged pull requests per day. The first constraints are merge conflicts and merge-queue throughput. | 1, 2, 4 |
| The human is out of the loop through self-approval and self-release within hard limits. | 4 |
| Features are added and cut continuously, dead code is deleted, and Phantom builds itself. | 5, 6 |
| The desktop app is a watch-first observability layer with a one-line direct box to the leader. | 3 |

## Plugins and adapters

Anything outside the six parts and the leader attaches through a plugin or an
adapter: a new provider or harness, a new kind of node, a new chat bridge, a
new dashboard. Adapters may be added or removed without touching the core.
See [plugins](PLUGINS.md) for the trust model.
