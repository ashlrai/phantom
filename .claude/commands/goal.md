---
description: Create, plan, and advance an ashlr goal — sandboxed, proposal-only, routed across the polyglot backend fleet (M55).
argument-hint: "<objective>" [--project <repo>] [--allow-cloud] [--plan-only] [--direct [--json]]
---

Run the ashlr **goal conductor** for this objective:

$ARGUMENTS

Execute it:

```bash
ashlr goal $ARGUMENTS
```

(`phm goal` is the same command; `phm` and `ashlr` are both bins of
`@ashlr/phantom`.)

`ashlr goal` creates a goal, plans it into milestones, and advances the next
milestone as a **sandboxed, proposal-only** run. Without `--allow-cloud` the
milestone runs on the builtin swarm; with it, the milestone runs on a frontier
engine rotated from `foundry.allowedBackends`, drawn from the polyglot backend
roster (local models · Hermes · Claude · Codex · NVIDIA NIM · Kimi/Moonshot ·
…) by capability and trust tier. **Nothing is applied to the working tree or
`main`**: the run files a PENDING proposal. `--plan-only` stops after planning
and advances nothing (it cannot be combined with `--direct`).

After it completes, summarize the proposal that was filed and remind the user to
review it with `ashlr inbox`. The kill-switch (`~/.ashlr/KILL`) halts everything.

For one concrete owner-invoked task, use `--direct --project <repo>`. Run it
only in a disposable OS account or VM with no remotes, credential helpers,
provider tokens, or shared Git common dir. Use `--json` for one bounded result
containing run/proposal identity, deliberately unreported usage, scoped
wrapper-controller effect claims, and `unattendedExecutionAuthorized:false`.
This output does not prove
verification, human acceptance, protected merge, deployment, or confinement.
