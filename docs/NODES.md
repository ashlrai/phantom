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

The Mac is the only local hardware. The existing Grok Bot box is a hosted,
vendor-operated Linux machine shared by all of Mason's Grok Bot agents.
It is remote capacity, with a different trust boundary from the Mac.
Existing subscriptions do not establish spare capacity or permission to spend.

## At a glance

| Node | Security boundary | Cost | Capacity | Latency | Worst failure mode |
| --- | --- | --- | --- | --- | --- |
| Grok Bot box, headless | Hosted shared Linux; vendor and co-agent credential exposure | No new spend authorized; existing plan limits apply | One shared machine; headroom unverified | Remote dispatch plus process spawn | Shared-host compromise or outage |
| Cursor cloud agents | Vendor compute; untrusted PR back | Included pool, then API rates | Elastic burst | Minutes per task | Silent spend past intent |
| Devin and Codex cloud pools | Vendor compute behind existing lanes and gates | Devin ACUs; Codex plan limits | Elastic within plan caps | Minutes; async PR delivery | Budget holds; PR never opens |
| Small paid VM | Live auth on rented hardware | About $5 to $15 per month | Small fixed box | Always-on, remote | Credential surface on rented disk |

## Option A: the Grok Bot box as a headless node

The existing hosted shared Linux box provided with Grok Bot is a possible
remote worker, subject to qualification before any pilot.

- **Security boundary.** The vendor operates the host, and all of Mason's
  Grok Bot agents share that machine. Codex and Claude CLI sessions signed
  in there are usable by every agent on the box. Device-bound sign-in does
  not isolate one agent from another or remove vendor access. Mason must
  approve that exposure before signing in through each CLI's native flow.
  Never copy auth directories from the Mac. A fresh `~/.ashlr` home,
  worktrees and environment stripping are required hygiene, not proof of
  credential isolation from other agents or the host operator. The box
  needs its own PAUSE and KILL sentinels and a tested remote stop path.
- **Cost.** No new spending is authorized. Reuse is conditional on verified
  existing plan coverage, included usage and compute limits, with on-demand
  billing disabled. Remaining allowance, CPU, RAM and concurrent usage by
  other agents are unverified; hold admission until checked. Signing in on
  another host does not establish an additional account allowance. See the
  [Grok Bot companion's billing boundary](GROK-BOT-COMPANION.md#allowance-resets-and-billing).
- **Capacity.** One shared machine, contending with every agent on it.
  There is no measured throughput increase or qualified worker ceiling.
  Current engineer rules keep heavy builds and full suites on the Mac
  pools. This decision does not change those rules. Mason must explicitly
  approve any later routing change after capacity and isolation evidence;
  a pilot here is limited to approved lightweight work.
- **Latency.** Dispatch and result delivery cross a remote network boundary.
  Process spawn on the box is only part of the latency; transport and repo
  access must be measured. Existing authenticated access is a prerequisite,
  not an assumption that the box shares the Mac's LAN or credentials.
- **Failure modes.** Provider or network outage, shared-agent resource
  contention, host restart, disk exhaustion and cross-agent credential use.
  Lost transport leaves claims for reconciliation on the Mac; it must not
  trigger duplicate dispatch. Expired subscription sessions hold launches
  until Mason restores sign-in. Provider maintenance and host custody are
  outside the Mac's control.

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
- **Security boundary.** Like option A, this is provider-hosted hardware.
  A separately administered VM could reduce co-agent sharing, but that
  isolation would need verification. The same device-bound rule
  applies, so Mason would sign in natively on the VM, which puts live Codex
  and Claude session material on hardware inside a provider's physical and
  hypervisor control. Add SSH attack surface, disk persistence on rented
  storage, an ongoing patching burden, and a real gap in today's auth model:
  Devin's key lives in the macOS Keychain only, and `phantom exec` needs
  Phantom Secrets installed and initialized on the VM. Neither hosted
  option inherits the Mac's physical custody; relative capacity is unverified.
- **Capacity.** Small and fixed. 4 GB is tight for typecheck-and-test-class
  heavy steps, so the memory-admission model would queue most parallel work;
  resizing upward costs more. Roughly one modest worker's worth of steady
  capacity.
- **Latency.** Remote like the Grok Bot box: every dispatch crosses the
  network. The queue stays on the Mac; a partition pauses admission and
  requires reconciliation before retry. Moving queue custody is outside
  this decision.
- **Failure modes.** Provider outage or billing suspension; SSH
  misconfiguration or lockout; unpatched vulnerabilities; OOM on heavy
  steps; snapshot and image drift; credentials persisting on rented disk;
  and the quiet one, a forgotten VM that keeps billing.

## Recommendation

Keep the Mac as the local execution, heavy-build and full-suite host, with
sole queue and publish custody. Prefer qualifying the existing Grok Bot box
(option A) for approved lightweight remote work before buying another VM.
This is conditional reuse, not permission to sign in or launch workers:
the hosted shared credential boundary and plan coverage must first be
accepted by Mason. Option A avoids a new VM bill if existing coverage is
verified; it has no owned-hardware security advantage over option D, and
sharing it with all Bot agents adds exposure. A separate VM might offer
better isolation, but its extra bill is not approved. Defer option D.

Keep Devin and Codex cloud sessions within their existing gated budgets
(option C), and Cursor manual-only (option B, no adapter exists). No new
spending, on-demand billing, tokens or paid resources are authorized by
this decision. If qualification fails, keep execution on the Mac and within
already authorized remote lanes; do not purchase replacement capacity.

## What Mason must do

1. Before any box pilot, verify existing plan coverage and limits with
   on-demand billing disabled, and decide whether every agent on the hosted
   shared Linux box may access the proposed CLI sessions. Only after Mason
   approves that exposure may he sign in to Codex and Claude there himself,
   through each CLI's own login flow. Never copy `~/.codex`, `~/.claude` or
   any other auth directory from the Mac or anywhere else.
2. Install Node 22.15 or later and Phantom on the box (published package or
   source checkout) and let it create a fresh `~/.ashlr` home; do not clone
   the Mac's `~/.ashlr`.
3. Sign in `gh` on the box under his own GitHub account so workers can fetch
   and push their branches.
4. Qualify an authenticated channel to the Mac's bridge using existing
   authorized access, such as SSH if already available; create no new
   tokens. The `phm-drive/v1` bridge is a local subprocess contract, not a
   remote transport. The Mac remains the sole `queue.v1` claim and custody
   authority; the box must not create an independent production queue.
   Do not share `~/.ashlr-runs/queue/` over a network filesystem. Without a
   qualified channel, hold the box pilot.
5. Give the box its own memory-admission state directory and its own PAUSE
   and KILL sentinels; confirm PAUSE prevents launches and KILL stops an
   active synthetic worker through the remote control path before trusting it.
6. Rehearse before cutover: `phm drive --once --dry-run` on the box against
   synthetic queue state, then an approved lightweight one-pool pilot.
   Keep heavy builds and full suites on the Mac pools. The pilot and
   dispatchd must share the Mac's atomic claim authority; otherwise stop
   or isolate dispatchd from pilot jobs before admission. Keep dispatchd
   available for rollback after pilot claims are reconciled.
7. Keep Devin's ACU budget and any future Codex cloud pool ceilings where
   they are today; set a Cursor spend limit before treating cloud agents as
   burst, and do not build the paid VM without a separate decision.
