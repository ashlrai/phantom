# Persistent Linux nodes for Phantom

Status: research and design, with an offline planning CLI and a Lima template.
Research checked 2026-10-26. Nothing has been provisioned. The command does not
measure capacity, log in, join a registry, or enable dispatch.

## Evidence and attribution

The closest verified video title is [Stanford CS146S: How always-on agents
work](https://www.youtube.com/watch?v=L1OBRtfPS34), published by `leerob`, confirmed by [YouTube metadata](https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=L1OBRtfPS34&format=json).
The accessible YouTube page identifies CS146S, not Stanford GSB. The requested
GSB attribution, speaker's exact SpaceX engineering title, spoken Linux-instance
wording, and a timestamp for that wording are **unverified**: the primary video
page did not expose captions in this research environment. Do not present a
third-party transcript as a verified quotation or silently substitute CS146S
for GSB. No spoken quotation is asserted here.

Primary product documentation does establish the useful pattern:

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview) describes persistent
  cloud computers with a browser, filesystem and terminal, and retained context.
- [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq) explicitly says:
  "The computer is assigned per user, not per Bot." This is a documentation
  quotation, not a quotation from the talk.
- [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) says bots on
  an account share files, browser sessions and command-line credentials.
- [Deployment documentation](https://docs.x.ai/grok-bot/deployment) identifies
  the hosted computers as Linux, separate from the operator's managed device.

Phantom should adopt persistent storage and resumable work, while choosing
**one VM per node trust boundary**. Multiple bot identities inside one VM would
share that boundary; they must not be advertised as mutually isolated. This is
our design, not a claim that Grok allocates a VM per bot. Specific Grok RAM,
cloud provider, hypervisor, price and lease protocol are not established here.

## Local choice and capacity gate

Use Lima with Apple's Virtualization.framework (`vmType: vz`) on Apple silicon,
macOS 13 or newer. The supplied template is ARM64 only. Intel Macs need a
separately reviewed native x86_64 image/template, not implicit ARM emulation.
[Lima's VZ documentation](https://lima-vm.io/docs/config/vmtype/vz/) describes
this backend. No paid service is required; existing hardware and electricity
are not literally free, and model/vendor subscriptions remain separate.

These are planning allocations, **not measured footprints or benchmarks**:

| Option | Guest allocation | Host overhead reserve | Assessment |
| --- | --- | --- | --- |
| Lima + VZ, terminal only | 4 GiB, 2 vCPU | initially 1 GiB | Recommended CLI lifecycle, reproducible YAML, no GUI required |
| UTM + Apple virtualization, same Linux image | 4 GiB, 2 vCPU | initially 1 GiB plus measured GUI overhead | Useful interactive console; no evidence it consumes less RAM than Lima |
| Direct Virtualization.framework app | 4 GiB, 2 vCPU | initially 1 GiB until measured | Can omit a manager UI, but we must implement image boot, networking, storage and lifecycle; no measured savings justify this work yet |
| Optional desktop/browser, any backend | 6 GiB starting budget | initially 1 GiB plus measured UI overhead | Re-admit against host capacity; tabs and builds can exceed this budget |

[UTM](https://mac.getutm.app/) offers a free direct download; the paid App Store
version is unnecessary. Its [directory sharing controls](https://docs.getutm.app/settings-apple/sharing/)
must stay empty. [Apple's framework](https://developer.apple.com/documentation/virtualization)
is a building block, not an already configured node manager. None of these
sources supplies an apples-to-apples memory benchmark. Use the same guest,
workload, RAM cap and cold/warm phases before comparing them.

Apply the queue's MEMORY P0 invariant as a hard admission gate:

```text
H = total physical host RAM
B = peak host usage excluding the candidate VM, including other VMs
G = configured guest RAM, not its optimistic idle RSS
O = max(1 GiB provisional reserve, measured VM-manager overhead)
admit only if H - B - G - O >= 0.30 * H
```

For a 4 GiB guest and 1 GiB overhead, the maximum B is 6.2 GiB on a 16 GiB Mac,
17.4 GiB on 32 GiB, or 28.6 GiB on 48 GiB. A 6 GiB desktop guest reduces each
limit by 2 GiB. Reserve per VM, account for all running nodes, and reject
unknown/stale samples. Do not treat swap or compressed memory as extra RAM.
Keep memory pressure green with no sustained swap growth. If the budget fails,
queue work or stop the candidate VM; never silently weaken the 30% reserve.

The template caps its persistent guest disk at 40 GiB. Treat the **20 GB free
disk floor** as 20,000,000,000 bytes on both host and guest before admission.
For host admission reserve the full 40 GiB even when the image is sparse, plus
5 GiB for the downloaded image/cache and installation work, plus the floor:
roughly 68.3 decimal GB free initially. Add separate capacity for snapshots,
logs and extra images. Guest jobs must also leave 20 GB free after their
estimated checkout/build output. Neither thin provisioning nor APFS purgeable
space is a promise of capacity. Stop admission at the floor, preserve work,
and request operator cleanup instead of deleting data automatically.

Measure Activity Monitor's memory pressure and VM process footprint, `vm_stat`,
and swap growth during idle, one dependency install/build, and a browser task.
Use `df -k` on the actual VM storage volume and inside the guest. Record hardware,
OS/Lima/image versions, elapsed time, peak memory and minimum disk free. Idle
for ten minutes and sample the workload for at least thirty. No VM measurements
were taken in this change; the capacity rules are proposed admission criteria,
not enforcement implemented by the dry-run stub.

## Template and operator sequence

The [template](../contrib/nodes/lima/phantom-node.yaml) uses an Ubuntu 24.04
ARM64 release image and SHA-256 from the dated
[Ubuntu image manifest](https://cloud-images.ubuntu.com/releases/noble/release-20261017/SHA256SUMS).
A missing image or digest mismatch must fail, never fall back to an unpinned
image. Update URL and digest together after reviewing the publisher manifest.

[Lima's versioned default configuration](https://github.com/lima-vm/lima/blob/v2.0.0/templates/default.yaml)
defines the fields used here. The template has no inherited base, mounts,
provision scripts, container runtime, copied certificates, environment values,
SSH-agent forwarding or X11 forwarding. Proxy environment propagation is off.
A catch-all rule suppresses automatic application-port forwarding. Lima still
manages its SSH transport; its generated public access key is infrastructure,
not a copy of the operator's private key or vendor login. No tokens are created
by this change. No host vendor directory, including `~/.codex`, is accessed.

Preview from a source checkout:

```sh
npm run dev -- node bootstrap --dry-run
npm run dev -- node bootstrap --dry-run --json
```

After a human has measured capacity, the following is the proposed manual local
procedure. These commands were **not run** as part of this change:

```sh
# Use a new dedicated directory, never an existing Lima configuration tree.
mkdir -m 700 "$HOME/.phantom-node-lima"
export LIMA_HOME="$HOME/.phantom-node-lima"
limactl validate contrib/nodes/lima/phantom-node.yaml
limactl create --name=phantom-node contrib/nodes/lima/phantom-node.yaml
# Inspect $LIMA_HOME/phantom-node/lima.yaml locally before starting.
limactl start phantom-node
limactl shell phantom-node
# Later, stop without deleting the persistent disk:
# limactl stop phantom-node
```

Lima merges global defaults/overrides. A new dedicated LIMA_HOME prevents
inheriting ordinary personal Lima mounts, scripts or environment settings;
inspect the effective instance configuration and verify no unexpected shares
before boot. Do not add personal `_config` files. Do not print the process
environment. Run vendor login only in a guest shell, never in cloud-init or
recorded bootstrap logs. Install Node >=22.15.0 and a reviewed Phantom build
inside the guest, using reviewed source/artifacts without `.env`, auth files,
SSH keys, cookies, agent state or personal dotfiles. Do not mount the repository
from a parent containing credentials. Use Locus for approved companion access
and Phantom Secrets references for later secret needs, not copied secret files.

Device-code authorization belongs to RQ-PHM-CONNECT-WIZARD: the guest initiates
a vendor-supported device authorization; the owner confirms on the vendor's
verification page; resulting vendor state remains inside the guest. Never copy
host login state to make an unsupported flow work. A vendor without a supported
flow remains disconnected. This stub does not implement that wizard or claim
any particular vendor currently supports it. Do not snapshot an authenticated
VM as a reusable template; snapshots can contain guest credentials.

A VM protects host files only to the extent its configuration permits. Default
NAT is **not an egress firewall** and does not guarantee host/LAN isolation.
Before untrusted execution, enforce and test a guest/network policy blocking
host services, private networks and cloud metadata while allowing only required
vendor and registry destinations. This template alone is not admission for
hostile jobs. Guest root, browser sessions and code share one trust boundary.

## Registry and lifecycle contract

RQ-DRIVER-NODES-1-LEASE is not present in this checkout. The CLI prints a stub
handoff, not a fake registration or a successful readiness check. The proposed
adapter boundary is:

1. `join(identity, capabilities, capacity)` proposes a stable node identity,
   boot incarnation, Linux architecture, Phantom version and measured resources.
   Repeated joins must be idempotent. No credentials appear in the plan.
2. Registry acceptance returns a bounded lease and fencing generation through
   the registry's approved enrollment/authentication mechanism. This change
   invents neither an endpoint nor a new enrollment token.
3. `heartbeat(nodeId, incarnation, generation, health)` renews only while the
   registry permits it. Use the eventual NODES-1 TTL/renewal policy, not a
   second hard-coded lease schedule. Server-side expiry is authoritative.
4. Jobs carry lease generation and idempotency identity. Check lease, Stop,
   enrollment and resource limits before admission and before committing an
   external effect. Reject stale generations after a reboot or reconnect.
5. Lost connectivity, expired lease or Stop closes admission and fences work.
   Suspend/resume never revives an old lease. Rejoin before becoming ready.
   Drain jobs before planned shutdown; preserve the disk and work receipts.

Future states: planned -> provisioned -> joined -> ready -> draining -> stopped;
lease failure moves ready to unavailable. Persist work and receipts inside the
node, but keep registry authority outside it. VM presence or a successful SSH
connection is not readiness. Persistence survives stop/start, not disk deletion;
Mac sleep/offline periods interrupt local service. Cloud independence from the
laptop is a separate deployment choice.

## Optional headless browser and desktop

Keep both off by default. For browser-only work install a maintained browser
inside the guest and run it as the unprivileged node user, with its normal
sandbox enabled. Do not use `--no-sandbox`. Keep any debugging endpoint on guest
loopback and grant access only for an active authorized session.

For visual workflows, add a minimal desktop such as Xfce on a virtual display
and a maintained VNC server bound to guest loopback. Disable clipboard/file
transfer, retain guest authentication, and use an explicitly requested SSH tunnel
bound to host loopback. Never expose VNC, noVNC or browser debugging to a public
interface. The catch-all forwarding rule remains in place. A separate reviewed
profile must implement and test this; the base YAML does not install a desktop.
Re-budget at 6 GiB or measured peak, whichever is larger. Shut down the desktop
when idle; do not confuse a stopped display with a stopped agent or revoked login.

## Cloud alternative, priced only

[DigitalOcean Basic Droplet pricing](https://www.digitalocean.com/pricing/droplets),
checked 2026-10-26, lists the following regular shared-CPU plans in USD:

| Candidate | RAM / vCPU | Disk / included transfer | Monthly base cap |
| --- | --- | --- | --- |
| Terminal node | 4 GiB / 2 | 80 GiB / 4,000 GiB | $24 |
| Desktop/browser node | 8 GiB / 4 | 160 GiB / 5,000 GiB | $48 |

Base annual arithmetic is $288 or $576 for twelve fully billed months. Taxes,
backups, snapshots, transfer overages, extra disks and model subscriptions are
excluded; re-price the actual region and options before approval. Reserve guest
memory for the OS and keep the same 20 GB free guest disk floor. A stopped cloud
VM is not assumed free. Cloud images need a separate provider configuration;
the Mac VZ template is not a cloud deployment manifest. No cloud API, account,
credential, Terraform apply or provisioning command is part of this change.
Spending and provisioning require owner approval under repository policy.

## Validation and remaining work

`test/node-bootstrap.test.ts` covers text/JSON planning, fail-closed arguments,
help, no side effects, and the explicit registry stub. The offline schema/profile
test parses the YAML, validates its constrained Lima field schema, and rejects
credential-sharing regressions. Tests fetch no images and make no network calls.
If Lima is installed, also run `limactl validate` against the template in a fresh
LIMA_HOME. Offline schema validation is not a boot or hypervisor compatibility test.

Remaining runtime work is explicitly separate: measured capacity enforcement,
network isolation, guest installation/login, the NODES-1 adapter, fencing and
recovery integration tests, and optional desktop provisioning. This change
provides a reviewable design and safe preview surface without claiming those
systems are active.
