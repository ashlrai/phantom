# Cycle collector

Run with Node 22.15+ and an authenticated `gh` CLI. The default is a local,
key-free JSONL spool; no PostHog request is made unless `--send` is specified.

```sh
node scripts/cycle/collect.mjs --since 2026-10-26T00:00:00Z
node scripts/cycle/collect.mjs --dry-run --repo phantom,ashlr-md
node scripts/cycle/collect.mjs --send
```

The seven default repositories are `ashlrai/{phantom,phantom-secrets,locus,
lexicon,ashlr-md,ashlr-stack,ashlr-plugin}`. Without `--since`, the initial run
backfills all merged PRs. Use an explicit start time for a bounded first run.
PRs, timelines, final-head check suites, and check runs are all paginated.
PR summaries use stable creation order and are fully paginated, so comments
cannot move unread PRs ahead of the cursor. Detail queries use the merge
watermark. A fixed scan-start cutoff defers PRs merged during enumeration to
the next pass. This costs extra summary pages but avoids missing old PRs that
merged recently.

State defaults to `~/.ashlr/cycle/{cursor.json,spool.jsonl}`; override with
`--cursor` and `--spool`. Use the same pair for dry-run and send. The cursor
contains each repo's last merged timestamp, unresolved PR identities, and
acknowledged insert IDs. A dry-run advances observation watermarks but never
marks events delivered. Missing stage evidence stays pending and is revisited
even when a newer merge moves the watermark. Historical PRs without reviews or
queue entries can remain unresolved indefinitely.

The spool is appended and synced before cursor advancement. It is also the
deduplication ledger, so a restart after spool write but before cursor save
does not append duplicate IDs. Successful sends checkpoint each receipt;
retries after a send/checkpoint crash use the same PostHog insert ID. Keep the
spool until the telemetry has been retained elsewhere. Do not independently
rotate either state file. Corrupt state or a truncated spool fails closed.
An existing cursor with a missing spool fails closed. The cursor lock prevents
overlapping runs using the same cursor. Following an
interrupted process, inspect the lock's PID and verify that collector has
exited before removing the lock; automatic stale-lock removal can race a
second collector.

## Boundaries and missing evidence

- S4 `rework`: opened to first GitHub Actions suite on the final head SHA.
- S5 `ci_pr`: that suite start to the last required check's completion. Latest
  pre-merge attempts per workflow/check name determine completion; historical
  attempts are requested so post-merge reruns cannot hide merge-time evidence.
  If GitHub reports no
  required checks, use all Actions checks. Failed conclusions do not establish
  a green boundary.
- S6 `review`: latest ready-for-review event, or opened for a never-draft PR,
  to the first owner formal review, owner approval comment, or CodeRabbit pass.
  Edited comments use their update time as the observable pass boundary.
  Approval comments require explicit positive markers; arbitrary conversation
  and generic CodeRabbit completion notices do not count.
- S7 `green_to_enqueue`: max(CI end, review end) to the surviving queue entry,
  falling back to surviving auto-merge enablement. An enablement before green
  does not establish a nonnegative S7 interval.
- S8 `merge_group`: surviving queue entry to merge. Auto-merge alone does not
  establish queue entry. Queue removal/reentry uses the final surviving entry.
- Other repositories combine S7/S8 as `green_to_merged`.

Unknown, post-merge, or inverted boundaries are omitted. An absent review is
not assumed to finish at CI completion. All output is explicitly allowlisted:
no titles, bodies, diffs, logs, paths, or comment text. Without a supplied
router identity contract, `job_id` is `pr-<repo>-<number>`, `pool` is `none`,
and `attempt` is 1. Stage names are the spec's names (`rework`, `ci_pr`, etc.).
S1-S3, S9-S10, and `cycle_complete` are outside this S4-S8 backfill.

## Sending and key custody

`--send` drains pending JSONL through
`phantom exec -- node scripts/cycle/capture.mjs`. Events travel on stdin,
because Phantom logs command arguments. Only the child reads
`POSTHOG_PROJECT_KEY` from its runtime environment. Do not put that key in a
file, shell history, fixture, or CLI argument. The collector never loads or
prints it. The capture endpoint is fixed to the US PostHog ingest service;
redirects are refused. Sender output is consumed as a keyed receipt; raw
Phantom output and HTTP response bodies are never logged by the collector.

A missing key leaves the event in the spool and exits successfully. A vaulted
`phm_` placeholder also remains pending without a network call: Phantom's
current proxy does not substitute JSON body keys, while the
[PostHog capture API](https://posthog.com/docs/api/capture) requires `api_key`
in the body. Sending therefore requires the runtime
environment to provide a usable project key. This collector does not create
credentials, change vault bindings, or claim that vaulted PostHog sending has
been activated. HTTP failures log only the status; transport failures use a
fixed message. Unacknowledged events remain pending.

## Offline replay

```sh
node scripts/cycle/collect.mjs \
  --fixture test/fixtures/cycle/synthetic-merged-prs.json \
  --cursor /tmp/cycle-replay/cursor.json --spool /tmp/cycle-replay/spool.jsonl
```

Repeat the command: `emitted` must be 0. A fixture has the shape
`{"repositories":{"phantom":[...]}}`; include every requested repo, with empty
arrays for repos without PRs. PR rows contain the queried PR metadata plus
`timelineItems.nodes` and `checkSuites.nodes`, each suite with `checkRuns.nodes`.
`--fixture` replays these snapshots without invoking `gh`.

The included fixture is explicitly synthetic and has independently calculated
durations. The original `cycle/baseline.py` and `cycle/baseline-prs.json` were
not available during implementation, and local `gh` configuration access was
denied. Recorded GitHub fixture acceptance and exact baseline parity must be
verified with those inputs; synthetic replay does not establish either.
