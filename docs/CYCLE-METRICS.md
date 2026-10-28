# Cycle metrics collector

Run the source collector with Node 22.15+ and an already commissioned `gh`
identity. Account access must follow the repository's Locus policy. Collection
uses read-only `gh api graphql` requests; it never dispatches workflows or
changes pull requests. It needs access to PRs, timelines and commit checks.

```sh
node scripts/cycle-collect.mjs --repo ashlrai/phantom --since 2026-10-25 --until 2026-10-26
```

The default is **dry-run**: append `cycle_stage` envelopes to
`.ashlr/cycle-metrics/events.jsonl` and save deduplication state in
`.ashlr/cycle-metrics/cursor.json`. Both paths can be overridden with `--spool`
and `--state`. Keep them together across invocations. New files use mode 0600;
new directories use 0700. No credentials are needed for spooling beyond the
existing GitHub authentication used by `gh`.

Without `--repo`, collect phantom, ashlr-md, phantom-secrets, locus, lexicon,
ashlr-plugin and ashlr-stack under ashlrai. Repeat `--repo owner/name` for a
custom set. The initial window is the last 24 hours. Dates mean midnight UTC;
UTC timestamps allow narrower windows. A search exceeding GitHub's 1,000-result
limit fails before writing state: split it into smaller `--since`/`--until`
windows. Every PR, timeline, check-suite and check-run connection is paginated.
Checks are fetched from the PR's final head SHA, rather than its merge SHA.

## Boundaries and missing evidence

| Stage | Start | End |
| --- | --- | --- |
| `rework` (S4) | PR opened | First Actions suite created on final head |
| `ci_pr` (S5) | First Actions suite created on final head | Last required check completed |
| `review` (S6) | Last ready-for-review event, or opened | First subsequent owner review/comment or CodeRabbit pass |
| `green_to_enqueue` (S7) | Later of completed CI and review | Queue admission or auto-merge enablement after green |
| `merge_group` (S8) | Final queue admission | Merged |

For S5, check-run `isRequired` selects required checks, including external
apps. If GitHub marks none required, all Actions checks are used, matching the
baseline's all-Actions-suites approximation. For reruns within a suite, the
latest run of each check name is used. CI must finish successfully, neutrally
or skipped before its end is used as a green boundary. Missing checks, reviews
or timestamps stay unknown: the corresponding event is omitted. Events never
have negative durations or extend beyond merge. Concurrent stages overlap and
must not be summed to estimate total cycle time.

The default owner reviewer is `masonwyatt23`; override with
`--owner-reviewer login`. Owner formal reviews and owner issue comments are
review signals; comments are a heuristic, not evidence of an approval. For
CodeRabbit, an approved formal review or an explicit pass comment is required;
progress comments are ignored. Comment text is inspected in memory and never
written to the spool. Queue exits and re-entries select the last admission;
auto-merge enablement alone cannot supply S8's start. For repos other than
phantom and ashlr-md, S7/S8 are combined as `green_to_merged`.

Each event has schema `cycle_stage.v1`, source `backfill`, attempt 1, integer
seconds, UTC timestamps, and `distinct_id` `cycle:<owner/repo>:<pr>`. Stage names
are the names in the table, without the S-number prefix. `job_id` is an RQ
identifier from the branch name when available, otherwise `pr-<repo>-<number>`.
Pool attribution is unknown (`none`); it is never guessed from PR prose.
`$insert_id` is the first 32 hex characters of SHA-256 over
`repo|pr|job_id|sha|stage|attempt`, matching the live-emitter contract.

## Resume, recovery and delivery

Rerunning emits zero duplicate IDs. The merged timestamp watermark is inclusive
and overlaps the previous 24 hours to catch delayed evidence. For older or
corrected evidence, use an explicit `--since` backfill. A persisted insert ID is
immutable: corrected boundaries require deliberate reconciliation rather than
silently replacing historical telemetry. This collector emits S4–S8 only;
release/live events and `cycle_complete` belong to the other emitters.

Collection completes for all selected repos before appending any events. The
spool is flushed before atomic cursor replacement. On restart, complete spool
records recover IDs even if a crash prevented the cursor update. Invalid state
or a damaged spool fails closed; preserve the files and investigate before
repairing. The state lock prevents concurrent collectors sharing one state
file. Use one state/spool pair per collector; never share a spool across
independent state files. After an abrupt process termination, confirm the
collector is stopped before manually removing its `.lock` file.

```sh
node scripts/cycle-collect.mjs --repo ashlrai/phantom --send
```

`--send` collects first, then invokes the separate sender through
`phantom exec -- node scripts/cycle-send.mjs --spool ...`. Commission
`POSTHOG_PROJECT_KEY` through Phantom Secrets; never put it in a command,
tracked file or model context. The sender uses the fixed US PostHog capture
endpoint, refuses redirects, validates the identifier-only event envelope,
and keeps a flushed `.sent` receipt file beside the spool. It does not print
keys, payloads or response bodies. With no key it retains the spool and reports
`unavailable: true`. Delivery failures retain all unsent records for retry;
remote deduplication covers a crash between capture and receipt persistence.
A failed collection does not attempt delivery. Use the sender under Phantom
Secrets directly to retry an existing spool without collecting more data.

Offline acceptance:

```sh
HOME=$(mktemp -d) npx vitest run test/cycle-collect.test.ts
```

The recorded-shape fixture covers final-head checks, draft readiness, bot
progress/pass comments and queue admission. Expected baseline durations are
hand-calculated from its timestamps; no GitHub or PostHog access is used.
