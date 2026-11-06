# Friction loop doctrine

Mason's operating pattern for the fleet: delegate everything, find where delegation breaks, and build the tool that removes the break safely. This page is doctrine — it describes how autonomy work is chosen. It grants no runtime authority and changes no gate; [Security GATES v3 and the hold list](../../AGENTS.md#article-1-full-autonomy-always-forward) stay exactly as they are.

## The pattern

The default is that an agent does the work. When a task stops for a human, that stop is a signal, not an annoyance to route around. Repeated stops of the same shape mean the harness is missing a capability, and the highest-leverage fix is usually not a better prompt — it is a tool, an interface, or a custody boundary that makes the human step unnecessary without removing the protection it was pretending to provide.

The loop has four phases. It is a loop, not a pipeline: measurement feeds the next round of identification, and a fix that did not move its signal is reopened, not celebrated.

## 1. Identify — collect friction signals

A friction signal is any point where delegated work had to stop for Mason, or where Mason did the step himself because delegation could not. Signals already observable in this ecosystem:

- **Needs-you items.** Every row in the needs-you drawer ([NEEDS-YOU.md](../NEEDS-YOU.md)) is a residual human step; each recurring row class is a candidate.
- **Holds and gates.** The hold list, lane holds, dispatch switches, parked dependency gates (`phm fleet parked --json`), and stuck-PR quarantine rows are all places work waits on a person or a pin.
- **Stalls in the job ledger.** `metrics/jobs.jsonl` shows queue wait, checkout, model, CI and merge time per attempt (`phm fleet job-latency --jobs jobs.jsonl --json`); a phase that consistently outruns the others is friction with a number on it.
- **Direct reports.** The desktop *Flag UI friction* action appends to `~/.ashlr/router/feedback.jsonl` (see the router README's desktop friction queue); Mason naming a repeated annoyance in chat is the same class of evidence.
- **Hard-limit escalations.** Passwords, 2FA, device approvals, payments and outside sends are the four kept human steps. Each recurring *kind* of escalation is a signal to make the safe path easier, never to remove the limit.
- **Red-main streaks and silent red tests.** A main branch that is red, or a check that has been failing so long nobody reads it, is delegation breaking on verification.

Record the shape of the break — what delegated task stopped, on what missing capability — not just that it stopped.

## 2. Select — score by autonomy unlocked, not ease

Score each candidate on how much delegation it unlocks across fleet work *and* client work:

- **Breadth.** Does it unblock one lane or every lane? A fix used by every agent on every repo outranks a fix used by one worker on one task.
- **Depth.** Does it remove a whole class of human steps (all secret handling) or one instance (this one API key)? Class-removals compound; instance-fixes recur.
- **Safety cost.** The fix must keep the protection while removing the step. A fix that removes friction by removing a gate is a regression, not a win — it is rejected under Article 1.
- **Measurability.** A signal that can be counted before and after beats one that can only be described.

Explicit anti-targets: do not score on ease, speed, or how interesting the tool is. Choosing the easy fix optimizes the fleet's activity metrics, not Mason's leverage. A hard fix that deletes a daily human step beats ten easy fixes that each delete a step nobody takes.

## 3. Solve — design, place, build, verify, ship

- **Design the boundary first.** What does the agent see, what does it never see, and where does custody live? The worked examples below all share one shape: the agent holds a reference, the trusted edge holds the value.
- **Prefer an existing repo over a new tool.** The default is a change inside Phantom or the repo that owns the capability. A new tool is justified only when the friction is a custody boundary the existing repos cannot hold — secret values, identity scope, personal voice data each became a separate tool for exactly that reason.
- **Build through the normal path.** Branch, PR, affected-only checks, merge, release through the sanctioned workflow — same as any other change. Doctrine does not create a shortcut around the merge path.
- **Verify end-to-end.** Run the real delegated task that used to stop and confirm it completes without the human step. A build that cannot be exercised is not done.

## 4. Measure — did the signal drop

Name the signal before building, then check it after shipping:

- The class of needs-you item stops appearing, or its rate drops.
- Human touches per merged PR in that area fall toward zero.
- Jobs no longer stall on the removed step; the ledger shows the phase shrinking.
- The escalation to Mason happens less often, or disappears.

If the signal did not drop, the loop repeats: either the fix missed the real break, or the signal was misread. Unmeasured is not fixed — if the signal cannot be counted, instrument it first and treat the instrumentation as part of the fix.

## Worked examples

### Phantom Secrets — the credential boundary

- **Break.** Every secret a delegated task needed was a Mason step: paste a key, reveal a value, approve an environment. Delegation stopped at every credential.
- **Fix.** A secrets layer where agents carry `phm_` references and `phantom_*` tool calls while real values are injected at the network edge. Values never enter config, logs, or model context — the protection got *stronger* as the step disappeared.
- **Signal that dropped.** Secret-paste steps and "reveal this key" asks per task, to zero.

### Locus — the identity boundary

- **Break.** Agents acting on infrastructure had no scoped identity: "which account, project, org" questions became human steps, and ambient unscoped identity was the unsafe alternative.
- **Fix.** An identity plane with hard-scoped pins — `locus pin`/`locus enter`, frozen scopes, and `whoami`/`doctor` surfaces an agent can read before mutating. The agent can act inside the pin; it can never widen it.
- **Signal that dropped.** Account-scope stalls and ambient-identity workarounds.

### Lexicon — the voice-input boundary

- **Break.** Mason dictates, and speech-to-text mangled the same names every time; each mangled proper noun was a manual correction — voice input, the cheapest delegation channel, was the least reliable one.
- **Fix.** A personal voice lexicon: canonical spellings, `normalize_transcript`, and `learn_correction` so each name is corrected once, permanently.
- **Signal that dropped.** Repeated corrections of the same names across sessions.

### Phantom — engineering work itself

- **Break.** The largest friction was engineering work itself: every repo task needed Mason driving it — queueing, reviewing, merging, watching.
- **Fix.** This workbench: a queue of well-scoped jobs, isolated worktrees, one merge path, fleet lanes, and a needs-you surface that makes the remaining human steps visible and countable.
- **Signal that dropped.** Mason-driven task flow. The needs-you drawer is the residual measure — every item on it is the next loop's input.

## Applying the loop to queue picks

Any job or self-improvement proposal that claims to reduce friction should name, in its description: the signal it addresses, the class of human step it removes, where the change belongs (existing repo or new tool and why), and the metric checked after merge. Proposals scored on ease rather than autonomy unlocked are deprioritized; proposals that remove a gate instead of the human step are rejected.

## Non-goals

- **Not a license to remove gates.** The four hard limits — secrets, money, outside sends, destruction of Mason's data — are kept human steps, not friction to optimize away.
- **Not a license for new tools.** A new repo is the exception and must justify itself by a custody boundary; otherwise the fix goes into the existing repo.
- **Not telemetry for its own sake.** Signals exist to find the next fix, not to produce dashboards. No measurable signal, no claimed win.
