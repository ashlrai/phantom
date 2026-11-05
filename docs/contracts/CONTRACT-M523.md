# M523 — GitHub stable-release finalization

The Phantom stable finalizer publishes an existing, fully stocked draft for an
exact `@ashlr/phantom` version after canonical npm publication succeeds. It
replaces the historical Hub 3.3.2 freeze. Historical receipts remain in
[the release archive](../RELEASING-HISTORICAL.md); they do not admit a new release.

## Inputs and identity

[Finalize GitHub stable release](../../.github/workflows/finalize-github-release.yml)
is a manual `workflow_dispatch` on protected `master`, with these inputs:

| Input | Meaning |
| --- | --- |
| `version` | Exact stable `X.Y.Z` package version; tag is `vX.Y.Z`. |
| `publish_run_id` | Completed successful `publish-canonical-npm.yml` run. |
| `publish_run_attempt` | Exact successful attempt of that run. |
| `candidate_sha` | Exact candidate commit, matching the tag and admitted package. |
| `candidate_integrity` | Exact registry `sha512-…` integrity for that package. |
| `confirm_stable_finalization` | Explicit `true` to request publication. |

The canonical publisher remains the sole npm authority. Finalization binds the
selected run and attempt, successful publisher jobs, immutable admitted package
artifact, candidate SHA and SRI, current npm `latest`, registry bytes and audited
npm provenance. A reconciled npm publication can have an earlier provenance run;
that does not waive the selected successful canonical run or exact candidate and
artifact checks. Reuse of CI or attestation is valid only for unchanged candidate
SHA and artifact digests. It never waives desktop signing or quarantine checks.

Use the [release runbook](../RELEASING.md#finalize-a-stocked-phantom-draft) for a
copy-paste JSON dispatch and post-merge workflow-enable procedure. Dispatch
inputs are strings except the boolean confirmation. The workflow invokes its
read-only internal helper as `node scripts/finalize-github-release.mjs prepare
--json` and `node --import tsx scripts/finalize-github-release.mjs verify --json`;
use the dispatch example rather than supplying runner-only environment variables
by hand. It emits JSON evidence receipts for machine inspection.

## Admission and effect

The read-only verification job requires an existing non-prerelease draft for the
exact tag and candidate commit, with nonempty notes and exactly the signed
seven-asset desktop set:

1. Original CLI package archive.
2. CLI archive signature sidecar.
3. Signed app archive.
4. App archive signature sidecar.
5. `manifest.json`.
6. `manifest.json.sig`.
7. `latest.json`.

Names, sizes and digests must agree with the signed manifest. Verification uses
`verifyCompatibleUpdateManifest` and `verifyMinisign` with the commissioned trust
key, checks the declared Apple signer identity, and hashes downloaded archive
bytes. `latest.json` must contain the exact signed discovery envelope. Repository,
version, source revision and source tree must match the candidate tag commit.
The signed qualification package digest, attestor and producer run identities
must match canonical npm admission, and `verifyUpdateAudit` rechecks the exact
candidate audit run and required successful steps. Filenames or seven asset
metadata rows alone are insufficient. Incomplete or changed evidence holds the
draft; rerun only after the sanctioned publisher completes its work.

This read-only Linux verifier does not reconstruct the hosted desktop bundle or
run Apple `codesign`, update or launch checks. Closure of the desktop quarantine
root cause is an external prerequisite owned by
`RQ-RELEASE-DESKTOP-UNQUARANTINE-1`; finalization cannot certify that closure.

The workflow does not upload assets or create a release. It locates the existing
release for the tag, preserves its ID, notes and asset bytes, and refuses an
already public release. The normal sanctioned
[`publish-desktop-release.mjs`](../../scripts/publish-desktop-release.mjs) path
already uploads and publishes. This finalizer is for a complete draft left
before that publisher's publication step, rather than a second mandatory
publication step. Never use `gh release edit` or a hand API PATCH to make an
empty draft public, and never hand-upload assets outside the sanctioned
publisher.

The protected effect job uses the existing
`github-stable-release-finalization` environment. Its protected-branch,
reviewer and no-administrator-bypass policy remains enforced. Only that job has
`contents: write`, for one request to the admitted release ID:

```http
PATCH /repos/ashlrai/phantom/releases/{admitted_release_id}
Content-Type: application/json

{"draft":false,"make_latest":"true"}
```

The effect job rechecks mutable state immediately before the PATCH and verifies
that the same release is public, stable and latest afterward, with unchanged
notes and assets. Its preflight receipt expires after one hour; if protected
environment approval takes longer, redispatch for fresh verification. It records
the preflight identity and post-effect evidence.
There is no npm mutation, OIDC permission, npm token, new secret reference, tag
write, installation, runtime activation, provider, communication or spend
authority. The GitHub token's broad `contents: write` capability does not grant
those operations.

## Failure and recovery

The GitHub release API has no compare-and-swap primitive. An outside writer can
race the final read; a failed postcheck is an incident requiring reconciliation,
not an invitation to replay writes. A subsequent dispatch refuses a public
release. No automatic rollback, unpublication or tag move is provided.

As reported in the verified November 5, 2026 handoff, `v3.30.8` (release ID
`435347257`) is already public with zero assets, and the configured
`releases/latest/download/latest.json` redirects to a 404. Leave that release
and tag as-is: no unpublish, tag move, reversal or hand asset upload. The desktop
publisher's live-feed refusal remains intact. Fix forward on the next free
patch, preferring `3.30.9` only if npm, GitHub tags and release records still show
it is available immediately before candidate selection.

Recovery coordinates with `RQ-RELEASE-DESKTOP-UNQUARANTINE-1`; signed binary
publication belongs to that task. This workflow change is a Security pin-review
`-sec` change: the PR title starts with `[SECURITY REVIEW]`, auto-merge stays off,
and the workflow/permissions diff waits for Security review. Re-enable workflow
ID `350636007` only after the reviewed YAML is merged on `master`.

## Recovery evidence

A file handoff, prompt copied into `leader/inbound/`, or `fleet-page.py say`
proves no execution. Before claiming updater recovery, retain all of:

- Actual fleet job ID, lane and start timestamp from sanctioned Mac read
  surfaces: `dispatch-events.log` `LAUNCH` lines, `metrics/jobs.jsonl`, live
  `launch.sh` or `queue/status.json`. Do not invent an ID or queue an unrelated
  job to fill the record.
- Sanctioned signed seven-asset publication for the next version, after the
  desktop quarantine root cause is resolved. Never skip signing or bypass
  quarantine guards.
- GET of the configured GitHub `releases/latest/download/latest.json` returning
  HTTP 200 after redirects, with signature and provenance verification matching
  the publisher checks.
- Supported installed-app update/version and successful launch evidence, only
  after Mason or an explicitly authorized operator path grants Mac access.
  Until then, installed version and launch remain unverified.

npm `latest`, release metadata, green CI and a source-only handoff each prove
only their own layer. None alone establishes updater or installed-app recovery.
