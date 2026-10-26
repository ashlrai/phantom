# Drive node options

This is a decision document for where `phm drive` capacity should run. The
supervisor and queue come from the queued driver change sets: `phm queue`
(DRIVER-1) owns the `queue.v1` store at `~/.ashlr-runs/queue/queue.v1.json`,
and `phm drive` (DRIVER-2) runs serial ticks that reap finished workers,
publish successful jobs through `publish.sh`, and admit READY jobs into
pools within their floors, ceilings and a global ceiling. Neither change set
is merged yet; this document uses their documented contracts and decides the
node layout they should target. It does not re-decide those contracts. For
the system they plug into, see [Architecture](ARCHITECTURE.md).

A "node" here is wherever a claimed job actually executes. Three things stay
fixed regardless of this decision:

- **The Mac keeps queue and publish custody.** `queue.v1` relies on
  local-filesystem atomic rename and an exclusive lock file, `publish.sh`
  runs under `phantom exec` on the trusted host, and dispatchd remains the
  fallback scheduler until an authorized cutover. Do not mount the queue
  directory over a network filesystem, and do not hand publication to a
  worker node.
- **Auth stays device-bound.** Provider CLI sessions live on the machine
  where a human signed them in. `~/.codex`, `~/.claude` and every other auth
  directory are never copied between machines; the driver bridge contract
  already excludes access to `~/.codex` auth.
- **PAUSE and KILL are host-local sentinels.** Every node that runs workers
  needs its own copies; a node without the sentinels is a node that cannot
  be stopped from here.

The options are not exclusive. Local nodes give steady, already-paid
capacity; remote pools give burst at marginal cost.

## At a glance

| Node | Security boundary | Cost | Capacity | Latency | Worst failure mode |
| --- | --- | --- | --- | --- | --- |
| Grok Bot box, headless | Own sign-ins on owned hardware; nothing copied | $0 incremental | One machine, a few workers | Local spawn, seconds | Box outage; manual re-sign-in |
| Cursor cloud agents | Vendor compute; untrusted PR back | Included pool, then API rates | Elastic burst | Minutes per task | Silent spend past intent |
| Devin and Codex cloud pools | Vendor compute behind existing lanes and gates | Devin ACUs; Codex plan limits | Elastic within plan caps | Minutes; async PR delivery | Budget holds; PR never opens |
| Small paid VM | Live auth on rented hardware | About $5 to $15 per month | Small fixed box | Always-on, remote | Credential surface on rented disk |

## Option A: the Grok Bot box as a headless node

The dedicated box Mason already owns, run headless as a second local node.

- **Security boundary.** The strongest option after the Mac itself. The box
  is owned hardware on Mason's network, so the credential perimeter stays on
  devices he controls. Mason signs in to Codex and Claude on the box himself
  through each CLI's own login flow; nothing is copied from the Mac, which
  is both the device-binding rule and the correct hygiene (copied session
  files are stale, untraceable credential sprawl). The box gets its own
  `~/.ashlr` home rather than a clone of the Mac's, its own PAUSE and KILL
  sentinels, and workers run under the same worktree-plus-environment-strip
  sandbox model on that host. A box holding real subscription sessions needs
  the Mac's posture: full-disk encryption, locked console, current updates.
  Physical access to the box is access to a signed-in seat.
- **Cost.** $0 incremental. Hardware is owned, the Codex and Claude
  subscriptions are already paid, and each device's usage draws down the
  same account allowance (a second sign-in adds a seat, not a second
  allowance). The only new costs are electricity and setup time.
- **Capacity.** One machine's CPU and RAM, independent of Mason's interactive
  use of the Mac. Under the memory-admission model (at most four concurrent
  heavy reservations, 30 percent modeled free RAM after reservations, an
  8 GiB swap block, PAUSE hold), the box roughly doubles local heavy-step
  throughput. Its ceiling is fixed: a saturated box queues, it does not
  burst.
- **Latency.** Lowest of any option. Workers spawn as local processes, repo
  access rides existing LAN and git credentials, and an always-on headless
  box avoids the sleep and throttle stalls an interactive machine has.
- **Failure modes.** Power or LAN outage stalls its workers and leaves
  STARTING jobs for reconciliation against the queue (fail-closed, not
  double-dispatch). Reboots and OS updates need a restart story for the
  supervisor process. Subscription sign-ins expire; there is no headless
  refresh, so an expired seat surfaces as `auth` launch failures until Mason
  signs in again by hand. Sustained builds can thermal-throttle. Disk fill
  fails admission. One box is still one box: whatever runs only there stops
  when it stops.

## Option B: Cursor cloud agents as burst capacity

Cursor's hosted cloud agents, used as overflow when local pools saturate.

- **Security boundary.** A separate trust domain, same shape as the existing
  cloud lanes. Task text and repository access move to the vendor's
  infrastructure; the agent works from GitHub and returns a branch or pull
  request. That delivery is untrusted input until the standing merge gates
  and Needs-you triage evaluate it; a cloud PR is a proposal, never a merge.
  No local credential, token or auth directory crosses to the vendor.
- **Cost.** Usage-based, not free. Cloud agents exist on the Premium tier
  ($30 per month) and above, and bill at the selected model's API rate:
  draws on the plan's included usage pool first, then on-demand prepaid
  credit. A spend limit is configured at first use. Third-party models bill
  separately at API list price. Burst is cheap to start if the plan is
  already paid for; the marginal cost of real work is real API spend.
- **Capacity.** Elastic and the widest burst of any option: many agents in
  parallel, each in its own environment, bounded by the spend limit and plan
  rather than by local hardware.
- **Latency.** Minutes per task for environment provisioning and clone.
  Wrong for latency-sensitive serial dispatch; right for absorbing a sudden
  queue spike.
- **Failure modes.** The included pool or spend limit running out mid-burst
  quietly changes the marginal cost of the next job. Sessions time out. A
  session that never opens a PR leaves an expired task, not a delivery.
  There is no mid-session readback comparable to a local worker's
  transcript, so the delivery contract is the only evidence channel.
  Provider outage or model changes are outside local control.

## Option C: Devin and Codex cloud sessions as remote pools

The lanes Phantom already operates, modeled as driver pools with their own
floors and ceilings.

- **Security boundary.** Already answered, which is this option's strongest
  property. Devin runs on a `cog_` key held in the macOS Keychain behind an
  ACU ledger, and Devin PRs merge only at a stage that names Devin with
  judges from two different model families ([DEVIN.md](DEVIN.md)). Codex
  cloud tasks run under the account's own product limits and likewise
  deliver through pull requests. Every delivery lands behind the standing
  gates; nothing in this option changes the merge boundary. Devin's training
  opt-out and per-repository GitHub integration are the two decisions that
  matter before private code goes to it.
- **Cost.** Metered on both sides. Devin bills in ACUs against the
  configured ledger (default estimate $2.25 per ACU, per-session cap 10,
  per-day 30, reserve 10; the ledger is a local estimate, not a provider
  balance). Codex cloud draws on the ChatGPT plan's own included limits.
  Neither is free burst.
- **Capacity.** Elastic within plan caps. Devin's defaults cap concurrency
  at 2 sessions, fleet launches at 1 at a time and 3 a day; Codex follows
  its account limits. Giving each lane its own pool ceiling lets the driver
  mix local and remote work without one starving the other.
- **Latency.** Minutes to provision, asynchronous delivery by pull request.
  Remote pools suit parallel backlog work; they are the wrong shape for the
  serial supervisor tick itself, which stays local.
- **Failure modes.** Budget gates refuse launches (paused, reserve, per-day
  or concurrency caps). A lost create response holds the session's whole
  ACU cap until settlement evidence arrives (the uncertain-create rule in
  [DEVIN.md](DEVIN.md)). A refused key, a missing GitHub integration or a
  session blocked on a human all leave tracked, named failure states. A PR
  that never opens leaves an expired task (12 hours for Devin), not a
  delivery. These modes are already implemented and tested in the lanes,
  which is more than any new remote path can claim.

## Option D: a small paid VM

A rented always-on Linux box running workers headlessly. Cost is listed
here; nothing is provisioned.

- **Cost.** A Hetzner-class shared-vCPU VM (2 vCPU, 4 GB RAM, 40 GB disk)
  lists at about 4.5 euros per month before tax; a build-comfortable 8 GB
  class runs about 9 euros to 15 dollars per month depending on provider.
  Recurring spend is owner-reserved under AGENTS.md, so this option needs
  Mason's explicit approval before anything is created.
- **Security boundary.** The weakest option. The same device-bound rule
  applies, so Mason would sign in natively on the VM, which puts live Codex
  and Claude session material on hardware inside a provider's physical and
  hypervisor control. Add SSH attack surface, disk persistence on rented
  storage, an ongoing patching burden, and a real gap in today's auth model:
  Devin's key lives in the macOS Keychain only, and `phantom exec` needs
  Phantom Secrets installed and initialized on the VM. More boundary to
  defend for less capacity than the box.
- **Capacity.** Small and fixed. 4 GB is tight for typecheck-and-test-class
  heavy steps, so the memory-admission model would queue most parallel work;
  resizing upward costs more. Roughly one modest worker's worth of steady
  capacity.
- **Latency.** Always-on like the box, but remote: every dispatch crosses
  the network. Either the queue stays on the Mac (a partition pauses
  admission, which fails closed correctly but stops the node doing anything)
  or the store migrates to the VM, which is a real migration of the custody
  point this document keeps on the Mac.
- **Failure modes.** Provider outage or billing suspension; SSH
  misconfiguration or lockout; unpatched vulnerabilities; OOM on heavy
  steps; snapshot and image drift; credentials persisting on rented disk;
  and the quiet one, a forgotten VM that keeps billing.

## Recommendation

Run the Grok Bot box as the headless node (option A). It adds a second
machine of real capacity for $0 incremental spend, keeps every credential on
hardware Mason controls under correct device-bound sign-ins, and needs no
new vendor relationship. Keep Devin and Codex cloud sessions as the remote
pools for elastic work (option C, already built and gated), treat Cursor
cloud agents as manual burst for now (option B, no adapter exists), and
defer the paid VM (option D): it buys availability rather than capacity, at
a recurring bill and the largest credential surface, and is worth revisiting
only if an off-site always-on node becomes a requirement.

## What Mason must do

1. Sign in to Codex and Claude on the Grok Bot box himself, through each
   CLI's own login flow. Never copy `~/.codex`, `~/.claude` or any other
   auth directory from the Mac or anywhere else.
2. Install Node 22.15 or later and Phantom on the box (published package or
   source checkout) and let it create a fresh `~/.ashlr` home; do not clone
   the Mac's `~/.ashlr`.
3. Sign in `gh` on the box under his own GitHub account so workers can fetch
   and push their branches.
4. Choose the transport between the Mac's queue and the box. The
   `phm-drive/v1` bridge is a local subprocess contract, so the box needs
   either its own bridge executable and queue pair or an authenticated
   channel (his existing SSH between his own machines, no new token types)
   to the Mac's bridge. Do not share `~/.ashlr-runs/queue/` over a network
   filesystem.
5. Give the box its own memory-admission state directory and its own PAUSE
   and KILL sentinels; confirm a file placed there actually pauses launches
   before trusting it.
6. Rehearse before cutover: `phm drive --once --dry-run` on the box against
   synthetic queue state, then a one-pool pilot, with dispatchd left running
   as the fallback on the Mac.
7. Keep Devin's ACU budget and any future Codex cloud pool ceilings where
   they are today; set a Cursor spend limit before treating cloud agents as
   burst, and do not build the paid VM without a separate decision.
