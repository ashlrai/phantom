# Merge identity

Which merges came from automation and which from a person, using only data
GitHub already records. `phm prs merges` applies these rules; this page is the
reference for the rules and the raw queries behind them.

## What GitHub records

| Signal | Where | What it tells you |
| --- | --- | --- |
| `merged_by` / GraphQL `mergedBy` | PR | The merger. For a merge queue merge this is the queue relay `github-merge-queue[bot]`, not the person. |
| `AddedToMergeQueueEvent.enqueuer` | PR timeline (GraphQL) | Who put the PR in the queue. This is the real actor behind a queued merge, including a bare `gh pr merge` on a queue-protected branch. |
| `AutoMergeEnabledEvent.enabler` | PR timeline (GraphQL) | Who armed auto-merge, when auto-merge rather than the queue is used. |
| Actor `__typename` | Any actor | `Bot` for a GitHub App (login `<slug>`, or `<slug>[bot]` in REST), `User` for an account. |
| App installation | `GET /orgs/{org}/installations` | Which App is installed, on which repos, with which permissions. |

## Classification rules

`phm prs merges` credits each merge to one actor, then classes the actor:

1. If `mergedBy` is `github-merge-queue`, the actor is the latest enqueuer. With no enqueue event the merge is `unknown`.
2. Otherwise the actor is `mergedBy`. With no merger (a deleted account) the merge is `unknown`.
3. An actor of type `Bot`, or whose login you pass with `--automation-login`, is `automation`.
4. Any other actor is `human`.

The release train merges through the `ashlr-release` App, so its merges land as
a `Bot` and count as automation with no configuration.

### Limit: a shared login looks human

A queued merge started by `gh pr merge` under Mason's own `gh` login is
recorded with Mason as enqueuer. GitHub holds no field that separates that from
Mason merging by hand, so those merges count as `human`. Two honest fixes:

- Run the lanes under a dedicated machine account and pass it with `--automation-login <login>` (repeatable). Past merges stay misclassed.
- Run the lanes as an App token (a `Bot` actor), which needs no flag.

Until one of those is in place, the `human` count is an upper bound and the
`automation` count a lower bound. Do not infer identity from branch names or
titles; they are author-chosen and not evidence.

## Queries

Read-only. Replace `ashlrai/phantom` and the timestamp as needed.

Merged PRs in a window with merger and enqueuer (what the command runs, one page):

```sh
gh api graphql -f q='repo:ashlrai/phantom is:pr is:merged merged:>=2026-11-01T00:00:00Z' -f query='
query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes { ... on PullRequest {
      number mergedAt
      mergedBy { __typename login }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT]) {
        nodes { ... on AddedToMergeQueueEvent { enqueuer { __typename login } } }
      }
    } }
  }
}'
```

One PR's merger over REST (shows the queue relay for queued merges):

```sh
gh api repos/ashlrai/phantom/pulls/4210 --jq '{merged_by: .merged_by.login, type: .merged_by.type}'
```

Who armed auto-merge on one PR:

```sh
gh api graphql -F n=4210 -f query='
query($n: Int!) {
  repository(owner: "ashlrai", name: "phantom") {
    pullRequest(number: $n) {
      timelineItems(itemTypes: [AUTO_MERGE_ENABLED_EVENT, ADDED_TO_MERGE_QUEUE_EVENT], first: 10) {
        nodes {
          ... on AutoMergeEnabledEvent { enabler { __typename login } }
          ... on AddedToMergeQueueEvent { enqueuer { __typename login } }
        }
      }
    }
  }
}'
```

App installations and their granted permissions (needs an organization owner token):

```sh
gh api orgs/ashlrai/installations --jq '.installations[] | {app_slug, permissions}'
```

The command itself:

```sh
phm prs merges --since 2026-11-01T00:00:00Z --json
phm prs merges --since 2026-11-01 --automation-login <machine-login> --json
```

The search returns at most 1000 results. When a window is larger, the command
sets `truncated: true`; narrow the window with `--until`.

## Release train App permission

`.github/workflows/release-train.yml` mints an `ashlr-release` App token that
asks for `contents: write` and `pull-requests: write` on this repository only.
Since `PHANTOM_RELEASE_TRAIN` was turned on, 23 of 52 recent runs failed at that
step with `The permissions requested are not granted to this installation`: the
installation has not been granted what the token request names. Only an
organization owner can grant it. This change touches no workflow or App request.

- [ ] Owner step: in GitHub, open the `ashlr-release` App settings, set Repository permissions to **Contents: Read and write** and **Pull requests: Read and write**, save, then accept the updated permissions on the installation (Organization settings, Installed GitHub Apps, `ashlr-release`, Review request). Confirm with the installations query above; the next hourly `Release train` run should pass the token step.
