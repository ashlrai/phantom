# RQ-OSS-MULTINODE-1: Multi-node pooling and distributed runtimes

Research date: 2026-11-06. Ranking is for a small heterogeneous Mac fleet, not general cluster scale. Effort estimates cover a bounded evaluation/integration, not production hardening. “Adopt” means an opt-in pilot after the stated acceptance tests, not permission to deploy, spend, or replace admission. Licenses refer to the linked upstream source, not hosted services, images, dependencies, or every subdirectory; verify the exact version and notices before distribution.

## Ranked adoption table

| rank | project (tag) | url | license (SPDX) | license_url | effort | impact (1–5) | Phantom fit note | recommend |
|---:|---|---|---|---|:---:|:---:|---|---|
| 1 | NATS JetStream (queue) | [nats-server](https://github.com/nats-io/nats-server) | Apache-2.0 | [LICENSE](https://github.com/nats-io/nats-server/blob/main/LICENSE) | M | 5 | Pilot durable, replayable notifications and bounded pull consumers; SSH remains baseline and Phantom retains admission, leases and fencing. | adopt |
| 2 | Dev Container CLI (runtime/sandbox) | [cli](https://github.com/devcontainers/cli) | MIT | [LICENSE](https://github.com/devcontainers/cli/blob/main/LICENSE.txt) | M | 4 | Opt-in reproducible Linux build environments; on Macs requires a Linux VM and does not reproduce native macOS jobs or itself establish a security boundary. | adopt |
| 3 | Podman (runtime/sandbox) | [podman](https://github.com/containers/podman) | Apache-2.0 | [LICENSE](https://github.com/containers/podman/blob/main/LICENSE) | M | 4 | Optional local Linux container backend; Mac uses a VM. Enforce mounts, network and resource limits separately; not a cluster scheduler. | adopt |
| 4 | Crawlee Browser Pool (runtime/sandbox) | [browser-pool](https://github.com/apify/crawlee/tree/master/packages/browser-pool) | Apache-2.0 | [LICENSE](https://github.com/apify/crawlee/blob/master/LICENSE.md) | M | 3 | Per-worker bounded Playwright browser lifecycle for browser jobs; not cross-node scheduling or isolation. | adopt |
| 5 | HTCondor (scheduler) | [htcondor](https://github.com/htcondor/htcondor) | Apache-2.0 | [LICENSE](https://github.com/htcondor/htcondor/blob/main/LICENSE) | L | 4 | ClassAd-style capability matching and resource constraints are directly relevant; a second scheduler and operations burden are not justified yet. | inspire-only |
| 6 | memberlist (membership) | [memberlist](https://github.com/hashicorp/memberlist) | MPL-2.0 | [LICENSE](https://github.com/hashicorp/memberlist/blob/master/LICENSE) | M | 3 | Gossip health and discovery ideas; suspicion is not a lease or fencing authority and static SSH aliases already suffice. | inspire-only |
| 7 | SeaweedFS (artifact-store) | [seaweedfs](https://github.com/seaweedfs/seaweedfs) | Apache-2.0 | [LICENSE](https://github.com/seaweedfs/seaweedfs/blob/master/LICENSE) | L | 3 | S3-compatible private artifact store if measured transfers justify it; operate replication, access and retention, not a shared queue filesystem. | inspire-only |
| 8 | Temporal Server (scheduler) | [temporal](https://github.com/temporalio/temporal) | MIT | [LICENSE](https://github.com/temporalio/temporal/blob/main/LICENSE) | L | 3 | Durable multi-worker workflows and retry history; duplicate-delivery semantics still require fenced effects, plus a server and persistence. | inspire-only |
| 9 | OpenHands OSS runtime (runtime/sandbox) | [OpenHands](https://github.com/All-Hands-AI/OpenHands) | MIT, excluding enterprise | [LICENSE](https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE) | L | 3 | Study isolated execution and lifecycle; assess exact runtime version and dependencies. Enterprise has separate terms. | inspire-only |
| 10 | Ray (scheduler) | [ray](https://github.com/ray-project/ray) | Apache-2.0 | [LICENSE](https://github.com/ray-project/ray/blob/master/LICENSE) | L | 2 | Distributed Python compute useful for data workloads, but subscription-bound native CLIs and existing admission do not benefit enough. | inspire-only |
| 11 | SkyPilot (scheduler) | [skypilot](https://github.com/skypilot-org/skypilot) | Apache-2.0 | [LICENSE](https://github.com/skypilot-org/skypilot/blob/master/LICENSE) | L | 2 | Resource and cloud placement ideas; provisioning cloud capacity changes trust and may cost money. | inspire-only |
| 12 | RabbitMQ core (queue) | [rabbitmq-server](https://github.com/rabbitmq/rabbitmq-server) | MPL-2.0; some OCF files Apache-2.0 | [LICENSE](https://github.com/rabbitmq/rabbitmq-server/blob/main/LICENSE) | M | 3 | Viable durable broker; greater operational footprint for this fleet than the NATS pilot. | inspire-only |
| 13 | Kubernetes Jobs (scheduler) | [kubernetes](https://github.com/kubernetes/kubernetes) | Apache-2.0 | [LICENSE](https://github.com/kubernetes/kubernetes/blob/master/LICENSE) | L | 2 | Strong Linux batch primitives, but a cluster and Linux VMs do not solve native Mac identity or queue ownership. | skip |
| 14 | Firecracker (runtime/sandbox) | [firecracker](https://github.com/firecracker-microvm/firecracker) | Apache-2.0 | [LICENSE](https://github.com/firecracker-microvm/firecracker/blob/main/LICENSE) | L | 2 | Linux/KVM microVMs fit dedicated Linux workers, not native macOS; a VM alone does not cover host, network or secrets policy. | inspire-only |
| 15 | LiveKit server (membership) | [livekit](https://github.com/livekit/livekit) | Apache-2.0 | [LICENSE](https://github.com/livekit/livekit/blob/master/LICENSE) | L | 1 | WebRTC media/session infrastructure is not fleet membership, queueing or fencing. | skip |

## Architecture sketch

```text
Mac primary: dispatchd + ready.tsv + lockfiles + publish.sh
          |  future explicit, atomic shared-claim adapter* 
          v
Phantom node-router primary <---- witnessed transitions ----> designated backup
          |                       (promotion + epoch fencing)
          | existing SSH RPC; optional JetStream notification pilot
          v
workers: pull owner-scoped lease -> local runner -> result reference
   Mac A: native CLI, local auth, capacity/sentinels
   Mac B: native CLI, local auth, capacity/sentinels
   Linux (optional): Podman/devcontainer; browser pool as needed
          |
          +--> private bounded artifacts, checksummed and scoped; primary validates
```

*The production dispatchd-to-node claim adapter does **not** exist yet. Do not enqueue the same work into both systems. Start with synthetic jobs or the existing node queue, then commission an atomic claim/receipt bridge with reconciliation before any production routing. The current [node pool](../NODES.md) documents backup witness, a 15-minute timeout, leader epoch, fail-closed witness loss, resource pressure, local kill controls and primary-only publication; preserve those semantics. A broker may carry hints or redeliveries, never grant claims, elect the leader, or replace the witness. Authenticate and scope any broker connections; carry only opaque job/result references and secret names, not credentials or private payloads. Node credentials and provider subscriptions remain local, and unknown sign-in or resource telemetry means no admission. Capability advertisements include owner scope, native OS/architecture, installed runtime, local provider lanes, available slots, memory/disk pressure and freshness; the leader validates them against lease and policy. Pull only up to free slots; stop on failed renewal, PAUSE/KILL or pressure. A stale epoch cannot renew, complete, upload an accepted result, or publish; primary verifies result integrity and uses the existing publication path. Lease expiry cannot prove side effects stopped: use idempotency/fencing for every accepted effect and reconcile ambiguous attempts before retry.

Pilot failure tests: duplicate notifications and lost ACK; worker crash or partition during execution; witness loss; old primary returning after promotion; stale completion and artifact upload; pressure/kill during a lease; differing local subscriptions; and broker restart. Assert no duplicate accepted effect or publication, fail-closed admission where authority is uncertain, bounded storage/queue growth, and recovery without copying auth. Measure queue wait, dispatch latency, CPU/RAM and artifact transfer against SSH baseline before adopting a broker or object store. Treat worker artifacts as untrusted: size limits, content hashes, owner-scoped access, retention and safe extraction; never network-mount the queue lockfiles.

## Other candidates and boundaries

- [Nomad](https://github.com/hashicorp/nomad/blob/main/LICENSE) is **BUSL-1.1**, source-available with an additional use grant and delayed change license, not current OSS; inspire-only. [Knative Serving](https://github.com/knative/serving/blob/main/LICENSE) is Apache-2.0 but adds request-driven Kubernetes infrastructure, skip. [Serf](https://github.com/hashicorp/serf/blob/master/LICENSE) (MPL-2.0) offers gossip ideas, not authoritative fencing.
- [Redis 8](https://github.com/redis/redis/blob/unstable/LICENSE.txt) offers RSALv2 OR SSPL-1.0 OR AGPL-3.0-only; license selection and operational semantics need review. [LocalStack's archived OSS repository](https://github.com/localstack/localstack/blob/main/LICENSE.txt) is Apache-2.0 for that source, with an EULA noted in its README; it is AWS emulation, not a production SQS broker. Skip both for this pilot.
- Docker Engine's [Moby](https://github.com/moby/moby/blob/master/LICENSE) is Apache-2.0; Docker Desktop is a separately licensed product. Podman was selected for the pilot, not an assertion that Docker Desktop is OSS. [Cloud Hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor) is Linux virtualization-oriented; license not independently verified here, so no adoption recommendation.
- [Gitpod Classic](https://github.com/gitpod-io/gitpod/blob/main/LICENSE.md) is AGPL-3.0, with project-specific carve-outs to check; classic hosted service has sunset. The [CodeSandbox SDK](https://github.com/codesandbox/codesandbox-sdk) calls hosted microVM infrastructure and requires an API token; the SDK repository's license was not verified. [Modal](https://modal.com/) and [Coiled](https://coiled.io/) are hosted services; inspire-only, not self-hosted OSS or approved spend. No license claim is made for their service implementations.
- [Browserless](https://github.com/browserless/browserless/blob/main/LICENSE) is SSPL-1.0 OR commercial, with upstream conditions; skip for this pilot. Crawlee's pool is a local browser manager and needs worker-level isolation, not a remotely exposed Browserbase replacement. No academic computer-use farm was identified with a sufficiently verified license and a stronger fit than this OSS browser pool.

## READY one-liners

- READY RQ-MULTINODE-NATS-PILOT-1: Prototype authenticated JetStream notifications for synthetic node-router jobs; preserve witnessed admission and fenced leases, and test partition, replay, stale epoch and broker restart against SSH baseline.
- READY RQ-MULTINODE-CLAIM-BRIDGE-1: Design and test an atomic dispatchd-to-node-router claim and reconciliation contract, including lock custody, idempotent completion and primary-only publication; do not enable production routing.
- READY RQ-MULTINODE-RUNTIME-1: Prototype opt-in Podman/devcontainer Linux workers with bounded resources, local credentials and PAUSE/KILL behavior; compare against native Mac execution without changing production pools.
- READY RQ-MULTINODE-ARTIFACT-1: Specify and test owner-scoped, bounded, content-addressed result transfer and stale-epoch rejection before evaluating SeaweedFS against existing SSH transfers.

## Sources

License links in the table are the primary source for each scoped row. Capability and operational evidence: [Phantom node design](../NODES.md), [node router](../NODE-ROUTER.md), [JetStream persistence and replication](https://docs.nats.io/nats-concepts/jetstream), [Crawlee browser pool lifecycle](https://github.com/apify/crawlee/blob/master/packages/browser-pool/README.md), [Podman on macOS](https://github.com/podman-container-tools/podman.io/blob/main/docs/installation.md), [Temporal architecture](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/temporal-service/temporal-server.mdx), [LocalStack project update](https://github.com/localstack/localstack), and [OpenHands enterprise terms](https://github.com/OpenHands/enterprise). Findings are architectural assessments, not measured benchmarks or legal advice.
