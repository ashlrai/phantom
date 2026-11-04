# Tell me when a condition matches

A `watch` trigger checks read-only GitHub JSON on an RRULE interval. It creates
one notification draft for Mason in Needs-you when a scalar condition matches.
It never launches a worker or sends an outbound message. Sending on Mason's
channel requires explicit approval through that channel's existing flow. Dismiss
the draft with Reject after handling it; Approve cannot launch work for a watch.

Use the existing JSON automation file surface:

```sh
phm automations add --template watch-pr --json
phm automations list --json
```

The template is disabled. Set the PR number and repository in its command and
scope before enabling it. Its trigger JSON is:

```json
{
  "kind": "watch",
  "rrule": "FREQ=HOURLY",
  "command": ["gh", "pr", "view", "123", "--repo", "ashlrai/phantom", "--json", "state"],
  "condition": { "path": "$.state", "equals": "MERGED" },
  "repeat": false
}
```

Commands accept only `gh pr view` or `gh issue view`, a positive number,
`--repo OWNER/REPO`, and `--json` with `state`, `number`, `closedAt` or
`mergedAt`. Arguments are passed directly to the existing bounded GitHub
runner. Unsupported fields fail closed at probe time. No shell, arbitrary flags,
credential arguments or raw probe output enter a notification. Authentication
stays in existing local custody; use Phantom Secrets binding names wherever
credentials need configuration.

Paths use own-property dotted traversal, for example `$.state` or `$.items.0.state`.
Equality is strict scalar equality. Missing fields do not match, including null.
Wildcards, filters, expressions and prototype keys are refused.

The first tick schedules the next future occurrence. Checks never run more than
once per elapsed hour, including clock rollback and manual-run attempts. Use
one BYMINUTE value; missed occurrences collapse into one check. Errors retry at
the next eligible occurrence and retain only a generic error. Stop and missing
authority block scheduled probes.

Once a matching draft is accepted into the queue, a persisted cursor disarms the
watch. With `repeat: true`, each eligible matching occurrence can produce another
draft, subject to existing queue and daily limits. Disarming is independent of
firing-history retention. To start a new one-shot observation, create a new
watch with a new id. Probe output is capped at 64 KiB for evaluation.

This extends the existing automation JSON contract, without adding a CLI command
or HTTP endpoint. The change is scoped to the requested automation files; the
repository-wide AGENTS.md and llms.txt indexes are outside that edit scope.
