# Open fleet adapters and replay

Implementation direction. This page distinguishes what exists from what we
intend to build. It does not configure a provider, grant tool access, or enable
execution.

## One tool shelf, not one shared account

An open-source software factory should be able to discover the same useful
capabilities from a laptop, a coding subscription, a company API organization,
or a GPU cluster. A model, a coding agent, and the tools that agent can use are
different resources. Keep that distinction even when one vendor provides all
three.

Today, [the toolchain](../AGENT-TOOLCHAIN.md) and `phm inventory --json` describe
tools across harnesses. Connection, authentication, quota, and execution
support are separate observations in [resource pools](../RESOURCE-POOLS.md).
The [agent bus](../AGENT-BUS.md) carries coordination and evidence, not
authority. The current [context packer](../GRAPH-CONTEXT-CHOICES.md) accepts
task/output snapshots from the caller; it does not discover all live
prerequisites independently.

The proposed adapter contract describes what a binding can do, its protocol,
its version and its provenance. An instance observation says what was actually
probed, when it was observed and when it expires. Assignment then intersects
those facts with the task scope, execution policy, remaining budget and
capacity. Only the effect boundary can consume the resulting scoped permit.

| Plane | Inputs | Output |
| --- | --- | --- |
| Discovery | Versioned declarations from CLI, API, SDK, MCP, A2A or skill artifacts | Capabilities and protocol support, without commands, keys, raw provider responses or inferred readiness |
| Eligibility | Task requirements, compatible binding, local auth evidence, fresh quota and worker headroom | Eligible or held, with machine-readable reasons; unknown evidence never grants access |
| Execution | An admitted, scoped job and a current lease | A versioned receipt with task, attempt, adapter, result reference and termination state; private data stays in scope |
| Learning | Independent checks, accepted completions, retry, latency and cost receipts | Reproducible comparisons; no candidate rewrites its evaluator, authority, or budget |

Use [MCP tool discovery](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
for typed tool descriptions and [A2A Agent Cards](https://a2a-protocol.org/latest/specification/agent-card/)
for agents that advertise task interfaces. Normalize SDK-based model surfaces
through adapters such as the [AI SDK provider interface](https://ai-sdk.dev/providers/community-providers/custom-providers).
Do not treat a manifest, annotation, or SDK import as proof of authentication,
availability, or permission. A new adapter must run through its own scoped
grant and conform to provider account terms.

## Use a graph, but keep evidence and commands separate

- Keep the authored task dependency DAG separate from the live inventory and
  execution graphs. A task depends on a specific artifact or acceptance
  predicate, not on whichever agent last mentioned it.
- Record observed edges with evidence and expiry: adapter on worker, attempt
  used adapter, attempt produced artifact, check accepted exact artifact.
  Missing work, missing observations, and pending results are different states.
- Build a context pack for the receiving task from the permitted dependency
  edges. Carry stable artifact references, versions and a cursor, not every
  agent's entire conversation. Enforce scope and byte budgets before including
  content. Treat retrieved tool output and agent messages as untrusted data.
- Keep owner, quota, launch and effect boundaries explicit across the graph.
  Revoking a binding must remove future eligibility without erasing history.

## Put policy changes through a simulator first

The [router replay harness](../router/eval.md) already evaluates frozen router
decisions and marks an unlogged alternative unobserved. The queue controller
simulator can compare fixed and adaptive capacity on recorded traces. Extend
those tools before introducing another scheduler. Run alternate policies on
the same pinned cohort and seeded event order, with no provider calls,
credentials, filesystem mutations outside test artifacts, or live dispatch.

1. Freeze a sanitized trace of arrivals, quotas and resets, slots, worker
   health, durations and terminal evidence. Pin both code and fixture digests.
2. Compare the current policy with one candidate. Start with synthetic
   scenarios for a provider reset, a worker loss, a stale observation and an
   expiring capacity window. Use historical outcomes only where observed.
3. Report eligible assignments, accepted completions, unfinished work,
   queue-age tails, cost per accepted result and resource utilization. Never
   call a lower latency a win when the candidate simply skips slow jobs.
4. Refuse promotion if the candidate admits ineligible work, duplicates
   accepted effects, exceeds budget, or improves a headline metric by
   starving a repo or task class. Follow the existing
   [shadow and canary plan](RECURSIVE-SELF-IMPROVEMENT-AND-OPEN-FLEET-2026-11.md#the-proposed-recursive-loop);
   offline success is not deployment approval.

[Temporal's deterministic replay](https://docs.temporal.io/workflows) is a
useful model for separating simulated decisions from real effects.
[Kubernetes' scheduling framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
likewise keeps scoring separate from reservation and binding.

## Scale through existing compute schedulers

Phantom should schedule **engineering intent**, not replace a cluster's
workload scheduler. Start with one existing cluster as an observed capability
source, then use its sanctioned admission API for scoped jobs. Advertise CPU,
RAM, accelerator type, available VRAM, isolation mode, locality and freshness.
Do not count time-sliced devices as isolated partitions or interchangeable free
slots. [Kueue's topology-aware scheduling](https://kueue.sigs.k8s.io/docs/concepts/topology_aware_scheduling/)
and [NVIDIA's GPU Operator MIG configuration](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-operator-mig.html)
show how to preserve placement and partition information instead of flattening
it into a single number. No GPU-cluster integration or measurement is implied.

The first milestone is a better decision, not more simultaneous agents:
complete more verified work on the same resources while preserving locality,
approval, budget, and a recoverable history.
