# Releasing Phantom

> **Current release process:** follow the
> [canonical npm trusted-publishing procedure](RELEASING-LOCALLY.md#canonical-npm-trusted-publishing).
> The commissioned GitHub workflow publishes the original qualified CI
> archive using short-lived identity, verifies public bytes and npm provenance,
> tests an isolated consumer, then promotes `latest`. Routine qualified npm
> releases do not require repeated Touch ID or browser approvals. Initial or
> changed publisher bindings still require npm owner authentication.
>
> Both qualification profiles require exact-source hosted CI, independent Audit and trusted attestation
> remain prerequisites. Native desktop finalization, signed asset publication,
> installation and resident activation are separate steps. The frozen
> `release.yml` procedure in the archive describes the historical
> 3.3.2 lane; it is not the current publisher. Publication does not activate
> provider credentials, spending permissions or resident autonomy.

<a id="current-canonical-source-candidate"></a>

## Current canonical release

The canonical repository is `ashlrai/phantom`; its package is `@ashlr/phantom`,
with `phm` and compatible `ashlr` launchers. Use
[`phm release-articles metadata --json`](https://github.com/ashlrai/phantom/blob/master/src/cli/release-articles.ts) for freshly
verified public release facts. It checks GitHub, npm and the complete source
qualification before returning a published version; a candidate version bump
does not become a publication claim. See the
[GitHub release records](https://github.com/ashlrai/phantom/releases) and
[npm version records](https://www.npmjs.com/package/@ashlr/phantom?activeTab=versions)
for exact distributions. This commissioned workflow is the one sanctioned npm
release path; every earlier script, shim, flag and manual lane is retired or
preserved only as immutable historical evidence.

The artifact installer remains a separate maintenance operation. Existing legacy
local-production policy receipts do not admit the canonical profile. Public
registry acceptance and installed startup acceptance remain separate. The [historical release archive](RELEASING-HISTORICAL.md) preserves earlier
receipts and procedures; its instructions are not the current lane.

## Keep candidate metadata consistent

Run `npm run version:sync -- X.Y.Z` in the source checkout, then
`npm run check:version`. The helper updates explicit source metadata in ten files
and validates every field before writing. Dependency versions and release
history remain unchanged. A candidate bump does not update published website,
registry or installed-app status.

## Qualified CI build handoff

Canonical admission requires exact-source hosted qualification, independent
Dependency Audit and trusted attestation. Local feedback and
`prepublishOnly` do not replace those gates. Native signing, installation, Stop/drain, rollback
and live acceptance remain separate.

The existing [CI workflow](../.github/workflows/ci.yml) has two explicit modes:

- At `17 */6 * * *`, or manual dispatch with `release_gate=false`: retain
  the exhaustive platform suites and the existing seven-day Mac rotation.
  Failed jobs stay red and emit scrubbed `tier=work` repair lines in the
  `phantom-fixup-queue` artifact. Router ingestion is a separate operation.
  Forty minutes before each of those full runs (`37 5,11,17,23 * * *`),
  [Preflight fixer](../.github/workflows/preflight-fixer.yml) runs the affected
  tests since the last green full run plus test paths named by open
  `p0-fix-forward` issues. Auto-tag starts that same workflow with
  `workflow_dispatch` on master. The fixer has no `workflow_run` trigger. A
  dispatch skips unless master still owes a published release, and a second
  dispatch for the same SHA inside six hours does not run the suite again.
  It uploads `preflight-reds.json`
  and updates one `p0-fix-forward` issue. Each failing test also gets its own
  issue with a stable `RQ-PREFLIGHT-<test>` line in the RQ-FIXUP shape, so a
  lane can pick it up before the scheduled run. The weekly
  [Release flow metrics](../.github/workflows/release-flow-metrics.yml) job
  records the scheduled full-run pass rate and the time from the tagged
  commit to `published_at` in
  [`.github/metrics/release-flow.json`](../.github/metrics/release-flow.json).
  The committed file is the baseline; each weekly run uploads a fresh copy.
- On manual dispatch with `release_gate=true` (release-prep.yml once per owed version while a run is outstanding, and Auto-tag on a tag): reuse a
  completed successful **push** CI run for the exact master SHA. After both
  release-gate jobs succeed on master, CI dispatches Auto-tag with that run's
  `GITHUB_SHA` (a `GITHUB_TOKEN` dispatch does not emit a `workflow_run` event);
  the tag-driven path remains scoped to its tag ref. The unsigned
  combined `Desktop release smoke` job reuses an immutable artifact for that
  source when available, otherwise builds once with cached compiler inputs.
  On that same runner, the smoke phase checks source/version/package identity,
  parses the updater feed/manifest contract under canonical-v2 trust and
  launches the native binary with `--release-smoke` in an isolated home.
  Only a repeated HTTP 404 redirected to the observed latest tag, bracketed
  by unchanged stable release metadata and independently complete zero-asset
  inventories, permits a previous stocked feed. Partial releases, unknown or
  malformed metadata, auth/rate-limit/server errors and observed races fail.
  The scan must finish within ten 100-row pages; asset lists must stay below
  a full page. Published release and asset identities must match the repository
  and tag; draft rows are never admitted (GitHub may give them untagged URLs).
  The selected prior release is rechecked before and after reading its bounded,
  size/SHA256-matching, version-matched feed. The 60-second smoke budget remains.
  Outputs `updater_live_http_status` and `updater_contract_source` and the step
  summary distinguish live HTTP 200 from historical contract coverage while
  the live endpoint remains HTTP 404. The unchanged parser/launch receipt does
  not establish updater recovery, cryptographic publication verification or
  installed acceptance; those remain separate gates. It never installs dependencies
  or rebuilds. The combined job retains the existing 90-minute build ceiling,
  while push verification, smoke and qualified upload share a separate hard
  five-minute phase deadline. Command cancellation retains the existing bounded
  cleanup grace. Native launch stays bounded at five seconds and the smoke body
  still asserts its 60-second limit. This is not a five-minute cold-build promise.
  No current per-PR desktop producer exists; cold preparation,
  hosted queueing, attestation and signing are outside the smoke budget.

The release job never builds in its own checkout. It runs
`node scripts/release-isolated-tree.mjs create "$RUNNER_TEMP/phantom-release-tree"`,
a `git worktree add --detach` of the pinned commit, then builds, packs, captures
custody and smokes in that tree. `verify` runs after the build and again after
pack. It refuses any drift from the pinned commit: tracked bytes or modes in the
worktree or index (`git diff --exit-code <sha>`), an unignored file, a hidden
assume-unchanged or skip-worktree flag, or an ignored file outside the build
output inventory in [`scripts/build-outputs.mjs`](../scripts/build-outputs.mjs).
The build writes only gitignored, untracked paths. `test/build-outputs.test.ts`
ties that inventory to `npm run build` and the desktop step plan. A local
release build uses the same pattern: run
`ASHLR_RELEASE_SHA=<sha> node scripts/release-isolated-tree.mjs create "$(mktemp -d)"`,
then build there. Durations and pass rates are tracked in
[the smoke timing record](release/SMOKE-TIMING.md).

The fast handoff uses profile `fast-release-v1`. A successful hosted smoke job
and its required steps select this profile; an artifact's own claim cannot.
Qualification rechecks exact repository/run/attempt/SHA identities, artifact
IDs and digests, the green push CI steps, and the hashed native smoke receipt
and binary. The legacy exhaustive profile still requires every whole-module
partition and report. Tests are neither skipped nor reclassified as passing.

[Attest qualified CI build](../.github/workflows/attest-ci-build.yml) polls at
`15,45 * * * *`. It selects a completed fast CI run for its exact source, or
accepts manual exact CI run/attempt/candidate SHA/artifact ID inputs. Its
trusted checkout verifies original bytes before signing the same `dist.tar`,
`manifest.json` and `qualification.json` subjects. Downloaded candidate code
never executes in the attestor.

**Current limits:** the trusted tree must still equal the candidate tree, and
finalization still requires the attestor revision to equal live master. Merges
between preparation, attestation and signing can therefore defer a release.
The host `release-autorun` consumer now includes a rev2 published-state pass:
after a completed successful signing outcome it proves the tag's seven-asset
set, feed binding and live `latest.json` endpoint through GET-only reads and
writes a final `feed-<sha>.rc` receipt (see
[the desktop update channel](DESKTOP-UPDATE-CHANNEL.md)). Installed-app
startup acceptance remains a separate gate. The one-minute smoke-body limit is
a budget, not a measured hosted runtime. The phase deadline does not shorten
the build job or weaken qualification.

The pinned immutable input upload binds the same four local files before and
after upload to the exact source/run/attempt and artifact ID/digest. Smoke
rechecks those bytes and fresh API metadata instead of downloading them again.
Reused older input is downloaded by its producer artifact ID/run, never by a
name reconstructed from the consumer attempt, then uploaded under the current
producer tuple. Fresh workspace `dist` must exactly match admitted archive
membership/bytes/modes before retention in a private backup; smoke still
restores the original archive itself. Mutation or unknown identity refuses.
The qualified upload is the same pinned action; its Node process has a fixed
phase watchdog and cannot spawn executable children. All three canonical
critical steps remain actual successful API steps under `fast-release-v1`.
No test has been newly quarantined by this change; individual quarantine needs
reproducible evidence and a linked issue in the existing ledger.

### Patch cadence and notes

The Release PR workflow and the release train both wake every 5 minutes.
`RELEASE_CADENCE_MINUTES` sets the requested interval, from 5 to
1440 minutes, and defaults to 5. The train does not raise that value.
The cadence check evaluates the live master tip rather than the SHA that
woke the workflow, reads its independent tip-pinned inputs concurrently to
keep the verification window small, and tolerates master movement instead
of demanding a still tip: when the tip moves mid-check the pass verifies
the evaluated tip is still a bounded fast-forward ancestor of the live tip
and that the version carriers are unchanged there, growing the green
evidence distance by exactly the moved window; only a snapshot that
genuinely changed — a version bump, a non-fast-forward move, or a tip that
keeps moving past the bound — re-evaluates, a bounded number of times,
instead of starving the release. A read budget exhausted mid-plan defers
to the next wake rather than failing the job.
Green evidence is the newest decisive completed master push CI run on the
tip or a bounded ancestor whose required checks — read from the branch
ruleset and protection and judged on that run's SHA through the check-runs
API — are green, so an advisory job failure (for example authority drift,
which is deliberately off Merge Gate needs) cannot starve a release while
the merge queue's own authority stays green, and the release PR's own
required checks remain the merge gate for the exact head that ships. While
an open release PR's required checks are still running or green and
awaiting the train's enqueue, the cadence reports not-due
(`release-pr-checks-in-flight`) before reading any tip state: every
release-please update force-pushes the branch and restarts CI on a new
head, so during merge bursts the head never survived long enough for
checks to finish and every release starved. Freezing updates — never the
merge — lets the PR's own checks reach a verdict on a stable head; a
decisively red verdict, an unreadable check inventory, a conflicting PR
(whose heal is the rebase update), or a head whose required contexts have
not all reported yet all leave updates allowed. It requests a patch bump,
then synchronizes
README, desktop and registry version carriers and the dated changelog in that
release PR. Auto-tag creates the tag and draft only after the exact commit's
required checks succeed. Signed publication then makes the complete updater
feed visible; a draft is not an update.

## Continuous release train

Standing approval, recorded verbatim:

> Standing approval: Phantom may automatically cut, sign, notarize and publish releases from green master as often as hourly, using only the existing signing identity and the sanctioned release workflows (GitHub release, npm trusted publishing, update feed, docs and website), and may mark older unshipped drafts superseded, with no per-release approval from me. No new spend, no bypass of signing, notarization, attestation or secret gates, and KILL still stops it.

The train is [`.github/workflows/release-train.yml`](../.github/workflows/release-train.yml).
It does not replace signing, notarization, attestation, the secret-shape gate,
or trusted publishing. It resumes the sanctioned jobs and records
`phantom.release-train.v1` state for `phm release status --json`.

What runs without a per-release approval:

- A green `release-please` pull request is merged when the cadence is due
  (default 5 minutes), and only
  when its version is the next patch, its head is `release-please--*`, the
  pull request is conflict-free and not already in the merge queue (queue
  membership is read through GraphQL; REST pull reads never expose it), and
  the required checks on that head — currently `Merge Gate` — are green.
  Advisory Actions runs neither block nor substitute for the required
  context. The merge uses the
  existing release app token and has no admin flag.
- A release-please tag whose commit is an ancestor of master (compare
  `tag...master` status `ahead`, or `identical` when it is master HEAD) is
  the candidate when required CI on that exact SHA is green. Diverged and
  red candidates are refused. The train does not retag and does not delete
  tags. A green open release PR for the next patch is still enqueued only
  after its required checks are green and its queue state is observed; an
  already-queued PR is never re-enqueued. The Release PR workflow independently
  checks green master, cadence and version carriers. When the merge queue's
  newest event for that PR is a removal that postdates the head commit and
  the head trails master, the green head checks are stale evidence the queue
  already rejected, so the train plans a head-pinned `updatePullRequestBranch`
  merge (never a rewrite) instead of enqueue: the new head's own checks
  re-verify the exact revision, which either re-greens for enqueue or goes
  red so release-please regenerates, ending the re-enqueue loop a doomed
  merge group would otherwise repeat every cadence tick. When that base
  compare cannot be read or returns no recognized status, the
  head-trails-master evidence is unknown rather than clear: the train plans
  no write to that pull request — neither enqueue nor a blind sync — while
  still completing the rest of the observation, and retries the compare on
  the next tick.
- For an unchanged version with no `vX.Y.Z` tag, Auto-tag can qualify a later
  canonical master commit that still carries `X.Y.Z` and has the matching
  release-please commit in its history. It creates the tag only after the
  required checks and release gate pass on that exact SHA.
  The train treats that tagged SHA as the candidate
  when `package.json` there is `@ashlr/phantom` at `X.Y.Z` and the same
  release-gate receipt is green. The commit subject is not required. Receipt,
  digest, and attestation checks stay bound to that SHA. `v3.30.34` is never
  patched, published, deleted, or moved, including when a newer candidate is
  selected.
- `auto-tag.yml` still creates `vX.Y.Z` and the draft after required checks
  on that commit.
- Release prep dispatches its release-gate CI run with `GITHUB_TOKEN`, which
  does not produce a `workflow_run` event. After Desktop release smoke and
  Release suites both succeed on master, CI explicitly dispatches Auto-tag
  with that run's `GITHUB_SHA`. Auto-tag validates the supplied lowercase
  40-character SHA as current or an ancestor of master, then evaluates checks
  and the release gate on that SHA instead of moving master HEAD. A manual
  Auto-tag dispatch without `sha` retains its fail-closed behavior.
- Release prep's decide step skips the dispatch entirely when the version
  `package.json` carries at the master SHA is already tagged **and** its
  GitHub release is published — the same nothing-to-do proof Auto-tag's
  version step uses (`git/ref/tags/v<version>` plus `releases/tags/v<version>`,
  which 404s drafts). Release-gate runs therefore exist only while a
  version is owed: from its bump merge until tag + published release. A tag
  whose release is still a draft, or whose release leg never ran, stays a
  candidate so Auto-tag's heal path keeps its evidence; any failed or
  incomplete read also fails open to dispatching. Because each dispatch
  pins the master SHA that was tip at dispatch time and the release-gate
  concurrency group is serial, the decide step also treats any unfinished
  `workflow_dispatch` CI run on master — created within the last three
  hours — as release-gate work already outstanding and dispatches nothing
  further. During a merge burst this keeps at most one release-gate run
  queued or running per owed version instead of one per moved tip; the
  outstanding run's SHA is still tagged through Auto-tag's exact-SHA
  dispatch when it completes. A stale or unreadable dispatch timestamp
  fails open to dispatching, so a zombie queued run cannot gate releases
  forever.
- Only the release-please PR changes the release version. The `Quick
  typecheck` job refuses a pull request that changes the `package.json`
  version or `.release-please-manifest.json` unless its head is a
  `release-please--*` branch of `ashlrai/phantom`
  (`.github/scripts/release-version-provenance.mjs`). A hand bump that lands
  anyway still gets a tag and draft from auto-tag. The train skips it as
  `release_message_mismatch`, keeps admitting the last release-please tag and
  merging the next release PR. That release then supersedes the orphan draft,
  which stays unpublished. This happened with `v3.30.25` (#4098) and `v3.30.32`
  (#4735). Recover with the next release-please patch. Do not retag, and do not
  widen the release-subject match.
- A `workflow_dispatch` of `ci.yml` with `release_gate=true` builds that
  candidate. The ref is the tag when the tag is behind master, and `master`
  when the SHAs match. Attestation uses the same ref, so the checkout SHA is
  the candidate rather than a newer master HEAD. There is no half-hour
  schedule; release-prep and Auto-tag dispatch `release_gate=true`.
- A candidate whose master push CI run concluded red can never build:
  release-build reuses only a green exact-source push run. When that
  candidate has no build, master is strictly past it and still carries its
  version, and the required checks (the fast Merge Gate) on master HEAD are
  green, the train fixes forward. The plan lists the candidate in
  `skippedTags` and `superseded`, sets `advance` to the next patch at master
  HEAD with reason `candidate-push-ci-red`, and its next step is
  `release-pr`. It then enqueues a green release PR for exactly that patch,
  or dispatches the Release PR workflow, which re-checks green master and
  cadence itself. That run writes nothing to the skipped tag or its draft.
  The new tag then proceeds through build, attest, npm, feed, docs and
  finalize as usual.
- When that build artifact exists, the train dispatches
  `attest-ci-build.yml` and then `publish-canonical-npm.yml` with the exact
  run, attempt, and artifact ids. The publisher's own admission still runs.
- Older draft releases are patched with `Superseded by vX.Y.Z. This draft
  stays unpublished.` Published releases are not edited and nothing is deleted.
- README and the other version carriers are updated in the release commit by
  the existing candidate sync before the tag exists.

KILL fails closed. On a hosted runner the train proceeds only when the
repository variable `PHANTOM_RELEASE_TRAIN` is `on`. Unset and `off` both
stop it. `ashlr authority stop` and `ashlr fleet pause` arm `~/.ashlr/KILL`,
create `~/.ashlr-runs/RELEASE_AUTORUN_OFF` with the `fleet-stop` marker, record
the variable's previous state in `RELEASE_TRAIN_PAUSED_BY_STOP`, and
best-effort set it to `off`. After a successful `ashlr authority clear-stop`
or `ashlr fleet resume`, the helper removes only that exact marked OFF file and
restores the variable to `on` only if it was `on` before the stop. A legacy or
manually written OFF file is preserved; delete it manually if the hold is not
intentional. GitHub failures are logged and never block clearing Stop. The Mac
signer still stops when the OFF file exists. The npm publish job uses the same
variable.

Signing and notarization stay in `contrib/mac/release-autorun.sh` and the
stock `release-sign.sh` wrapper. CI does not codesign and does not notarize.
The plan reason `mac-release-autorun` means signed assets are still pending
from this wrapper; it blocks desktop completion, but not npm dispatch once
build, attestation and audit evidence are available. It is not a new hold.
The wrapper picks up a successful attestation of a `v*` tag on its existing
10 minute poll. The attestor may be current master, or the release tag commit
when that tag's peeled sha is the candidate, the commit is an ancestor of
master, and required CI on that sha is green. A diverged attestor, a
non-release ref, or a tag whose sha does not match is not signed. The live
host copy under `~/.ashlr-runs/bin/` is not updated by this repository change. If `~/.ashlr-runs/release-sign/keychain-allowed` is
missing, the wrapper writes `NEEDS-MASON-<tag>` and waits. That file is the
one-time unlock of the existing signing identity, not a per-release approval.

`phm.dev` is not deployed from this repository. The host profile is
`phantom-public-web` in `src/core/website/host-release.ts`: repository
`ashlrai/phantom-secrets`, root `apps/web`, domain `phm.dev`. The train
records that hook. Its `phantom-secrets` reason identifies the separate
website owner; the website step is outside the publishing dependency order
and does not block npm or desktop finalization. `src/core/website/release-metadata.ts` is the existing
task that refreshes `apps/web/src/lib/workbench-release.json` from public
GitHub and npm facts after publication. A train state file does not mean the
site was deployed.

After publication, the train reads
`https://github.com/ashlrai/phantom/releases/latest/download/latest.json`
and fails when its `version` is not the semver it just published. A list of
stocked feeds is chosen by highest semver. Creation time, list order, and a
cached older asset do not win. Installed 3.30.24 must not be offered 3.29.3
while 3.30.28 is stocked.

`phm release status --json --file <phantom-release-state.json>` prints the
uploaded train state. The same JSON is the `phantom-release-state` workflow
artifact. Stage keys are `merge`, `tag`, `build`, `attest`, `sign`,
`notarize`, `npm`, `feed`, `docs`, `website`, and `finalize`. `at` is an
observed timestamp. `sinceMergeMs` is set only when both timestamps exist
and are in order. Missing evidence stays null.

On the fast path, the tagged build reuses the green push CI and the smoke
phase budget is 5 minutes. Attestation's job timeout is 15 minutes. The Mac
poll is 10 minutes. A cold desktop build still has the existing 90 minute
ceiling, so a cold build can take longer than one hour. The train does not
shorten that ceiling.

Keep all contents of the original `ashlr-attested-…` artifact together in a
private directory. In a clean checkout at the exact candidate commit, verify:

```sh
node scripts/hosted-build-artifact.mjs verify \
  --root "$PWD" --sha "$candidate_sha" --bundle "$bundle" \
  --run "$ci_run_id" --attempt "$ci_run_attempt" \
  --attestor-sha "$trusted_master_sha" \
  --attestor-run "$attestor_run_id" --attestor-attempt "$attestor_run_attempt"
```

Use the same arguments with `adopt` to write verified output into an **absent**
`dist` directory. Adoption performs fresh verification; a saved receipt does
not authorize it. Preserve the original npm archive rather than repacking.
Expired, failed, changed or incomplete evidence requires fresh hosted
qualification, not local evidence substitution.

Native packaging can reuse those adopted JavaScript bytes with
[`build-sea.mjs`](../scripts/build-sea.mjs) and the same hosted bundle, CI and
attestor arguments. The native path checks the adopted bytes again. Follow
[Releasing locally](RELEASING-LOCALLY.md#reuse-a-qualified-ci-build) for the exact
packaging and toolchain procedure.

## Complete publication and installation

### Orchestration and evidence boundaries

The current release pipeline is not yet an end-to-end autonomous orchestrator.
The release PR and auto-tag lanes prepare a candidate; hosted CI, Dependency
Audit and the attestor qualify its exact source and original artifact. The
canonical npm publisher then admits that evidence, publishes the original
archive and verifies registry bytes, integrity, provenance, an isolated
consumer and the `latest` tag. Its successful run is evidence for npm only.
Desktop signing and publication have separate requirements, including any
owner-reserved keychain interaction; an npm result does not prove a signed
desktop feed, a Homebrew update or an installed application.

The release dispatch dry run in `scripts/release-dispatch-dry-run.ts` sequences
reported observations only. It does not independently authenticate them or
dispatch a workflow. The release candidate planner likewise provides recovery
guidance, not permission to publish. A future executor must obtain and recheck
the exact candidate, CI, audit, attestor and immutable artifact identities from
fresh authoritative reads, invoke only the commissioned workflow with those
inputs, and reconcile uncertain dispatch or publication outcomes before any
retry. It must report verification per distribution and preserve unknown or
failed checks as such. Do not infer checksums, attestations, npm, Homebrew or
desktop acceptance from the existence of a GitHub release record.

The commissioned [canonical npm publisher](../.github/workflows/publish-canonical-npm.yml)
publishes the original archive once, reconciles public bytes and provenance,
validates an isolated installed consumer, then promotes and reads back `latest`.
Unknown publication state is reconciled through reads rather than replaying
writes. See [publisher commissioning and dispatch](RELEASING-LOCALLY.md#canonical-npm-trusted-publishing).

Native desktop finalization creates the original signed app archive and paired
manifest. Use the [artifact installer](../scripts/install-desktop-artifacts.mjs)
only after its original-asset qualification and required Stop/drain and Quit.
An npm version, GitHub release or downloaded archive does not establish installed
startup acceptance. Use the [desktop install guide](../desktop/README.md#install)
for supported paths and the locally signed, non-notarized app limitations.
For an existing managed CLI, see [managed upgrades](../desktop/README.md#upgrade-an-existing-managed-install):
`phm desktop install --upgrade` plans the switch; explicit `--apply` uses resident
stop but never restarts it. Journaled `--rollback` is separate from release
publication. Any Touch ID grant and resident restart remain owner actions.

Website promotion, provider sign-ins, spending permissions and resident fleet
activation are separate verified operations. Neither this guide nor a version
bump claims `phm.dev` was deployed. The legacy static site at `verse.ashlr.ai`
is a separate surface.

## Finalize a stocked Phantom draft

The [stable finalizer](../.github/workflows/finalize-github-release.yml) accepts
an exact Phantom version and a successful canonical npm run/attempt. It only
publishes an existing draft after checking nonempty notes, the complete signed
seven-asset desktop set, source identity and provenance. It neither creates a
release nor uploads assets or changes npm. The normal sanctioned
[`publish-desktop-release.mjs`](../scripts/publish-desktop-release.mjs) procedure
already uploads and publishes; use this workflow for a complete draft left
before that publisher's publication step. A public release is refused.

[CONTRACT-M523](contracts/CONTRACT-M523.md) defines the evidence and authority.
The inputs are `version`, `publish_run_id`, `publish_run_attempt`,
`candidate_sha`, `candidate_integrity` and `confirm_stable_finalization`.
The protected `github-stable-release-finalization` environment remains required.
The preflight receipt expires after one hour; redispatch for fresh verification
if approval is delayed beyond that window.
For a reviewed, complete draft, set these shell variables to its actual
verified evidence, then dispatch from the repository root:

```sh
jq -n --arg version "$version" \
  --arg run "$publish_run_id" --arg attempt "$publish_run_attempt" \
  --arg sha "$candidate_sha" --arg integrity "$candidate_integrity" \
  '{version:$version, publish_run_id:$run, publish_run_attempt:$attempt,
    candidate_sha:$sha, candidate_integrity:$integrity,
    confirm_stable_finalization:true}' |
  gh workflow run finalize-github-release.yml --repo ashlrai/phantom \
    --ref master --json
```

The dispatch mutates the release only through the protected finalization job.
Inspect the created run's JSON evidence receipts and postchecks before claiming
publication. A failed postcheck requires reconciliation; do not replay a hand
PATCH or change a tag. Never publish an empty draft with `gh release edit`, and
never upload assets outside the sanctioned publisher. The publisher's refusal
to touch a live feed must remain intact.

The verified November 5, 2026 incident handoff records `v3.30.8` as already public
and empty (release ID `435347257`), with the configured updater feed redirecting
to a 404. Leave that release and tag as-is: no unpublish, reversal, tag move or
hand asset upload. Recover on the next free patch; prefer `3.30.9` only after
fresh npm, GitHub tag and release checks establish that it is available.
The fast-gate smoke is repaired repo-side for this state: it verifies the newest
stocked published feed only after a live HTTP 404 and authenticated metadata
confirm that stable `releases/latest` has no feed asset. Inventory rows must
have exact repository/tag URLs, valid bounded identities, timestamps and asset
counts; a historical feed must report its selected release version. Other HTTP failures or
a missing advertised asset remain failures. Historical contract verification
does not establish that the configured live updater endpoint works; recovery
still requires its post-publication HTTP 200 and signed-feed checks.
Coordinate with `RQ-RELEASE-DESKTOP-UNQUARANTINE-2`, which supersedes
`RQ-RELEASE-DESKTOP-UNQUARANTINE-1`; this finalizer does not build
or release desktop binaries and must not bypass signing or quarantine guards.
The read-only Linux verifier checks signed metadata, archive bytes, trust and
qualification identities, but does not reconstruct the hosted desktop bundle or
run Apple `codesign` or launch checks. Desktop quarantine root-cause closure is
an external prerequisite; this finalizer cannot certify it.

This workflow replacement requires one `[SECURITY REVIEW]` PR with no
auto-merge and Security pin review of the workflow/permissions diff. Workflow
state is a separate GitHub setting. Only after the reviewed fixed YAML is on
`master`, an authorized operator enables ID `350636007` and confirms `active`:

```sh
gh api repos/ashlrai/phantom/actions/workflows/350636007 \
  --jq '{id,path,state}'
gh workflow enable 350636007 --repo ashlrai/phantom
gh api repos/ashlrai/phantom/actions/workflows/350636007 \
  --jq '{id,path,state}'
```

These `gh api` reads return JSON; enable changes workflow state and must not run
against the old disabled YAML. An uncommitted worktree handoff does not satisfy
the merge or enable step.

Updater recovery additionally requires actual fleet job ID/lane/start timestamp
from sanctioned Mac read surfaces, sanctioned signed seven-asset publication
after quarantine repair, and HTTP 200 after redirects from the configured
`releases/latest/download/latest.json` with publisher-equivalent signature and
provenance verification. The rev2 `release-autorun` pass performs the endpoint
HTTP 200 and signed-feed checks for each completed signing outcome; see
[the desktop update channel](DESKTOP-UPDATE-CHANNEL.md). File handoff, inbox
messages, npm `latest` and GitHub
release metadata are insufficient. Installed-app version/update and successful
launch remain unverified until supported tooling is used with authorized Mac
access. See the [complete evidence checklist](contracts/CONTRACT-M523.md#recovery-evidence).

## Supplemental and historical references

The [archive](RELEASING-HISTORICAL.md) retains immutable quarantine, publication,
promotion and recovery receipts, including the frozen 3.3.2 workflows and 3.4.0
local-policy proposals. Its old repository-disabled instructions are historical and must not govern
the current commissioned workflow.

The archived [observation-only canary](RELEASING-HISTORICAL.md#signed-observation-only-canary)
and [maintainer PR verification notes](RELEASING-HISTORICAL.md#verify-an-existing-maintainer-pr)
retain their original limitations. The canary runner and receipt verifier are
retired and removed from `scripts/`; the archived procedure is evidence only,
not a runnable lane. None of the archive replaces canonical release
admission. Use [Authority](AUTHORITY.md) and the installed CLI help for current
maintainer verification and account/Stop requirements.

## Release PR enqueue pass

On an authorized Mac with repository-scoped `gh` access, run
`node scripts/release-enqueue.mjs` for a read-only pass and
`node scripts/release-enqueue.mjs --apply` to enqueue eligible release PRs.
Schedule the pass at least every 15 minutes using the existing operator-owned
scheduler; this repository change does not install or activate a scheduler. The
under-one-hour open-to-merge target depends on check duration, scheduler uptime,
and merge queue dwell, and is not a guaranteed deadline.

The pass discovers open `autorelease: pending` PRs and requires the master
rules to require `Merge Gate`, successful head-specific gate evidence, a clean
and mergeable non-draft PR, and no existing queue entry. Unknown, conflicting,
or inaccessible evidence is refused. It repeats the checks immediately before
calling exactly `gh pr merge <number> -R ashlrai/phantom`; GitHub's rules and
merge queue remain authoritative if the PR changes in the remaining race.
The pass makes one immediate observation of the queue event and merge time, then
stops. If the event is not yet visible, inspect the PR timeline before retrying;
a successful request alone does not prove enqueue. Record the event and eventual
`mergedAt`, and calculate opening-to-merge time after the merge. PR #4130's
baseline was 2h 29m 52s; report an after value only for a measured later PR.

This lane does not publish, sign, stock assets, finalize releases, or dispatch
workflows. Release Please and auto-tag can temporarily create empty drafts;
those are not by themselves failed releases or evidence of a settled published
release with signed assets. SIGN-PUBLISH-3311 and the desktop, Terra and Dot
lanes retain their separate ownership.

### Check release status

`phm release status` emits `phantom.release-status.v2` JSON by default; use
`--text` for people. The existing `repos` rows remain; `release` contains the
same Phantom fields as the Fleet goals Release card and its **See log** action.
`releaseRepos` adds the same typed commit status shown in the desktop and mobile
Releases cards: repo, latestTag, tagDate, commitsSinceTag, state and reason.
Local git is tried first; incomplete, shallow or missing clones fall back to
bounded public remote-tag reads. Confirmed tagless remotes are `due` (no release
yet); `unknown` means both reads lacked complete evidence, with the reason shown.
With commits waiting, over 20 commits or 7 days is `due`, over 14 days is `stale`;
zero waiting commits is `ok`. The cards show all seven repos without another tap.
`release` still reads only local refs, `release-sign/last-released-tag` and
SHA-bound autorun receipts and logs. Tags alone do not prove publication;
publication time needs a saved release record. Missing evidence is JSON `null`.
Signed assets and updater HTTP are the last recorded check, dated `recordedAt`.
Merged PRs count distinct merge/squash PR numbers on the default branch's first
parent history; shallow or unavailable history is unknown. The planned candidate
and earliest ETA use local versions, tag time and `RELEASE_CADENCE_MINUTES`
(the train's five-minute default); an overdue ETA stays overdue, not a promise
to ship. Autorun reports rc and the scrubbed log's last `Reason:` line.
`--file <path>` still inspects a saved release-train state file.

### See which repo is due a release

`phm releases` lists the seven Ashlr repos with the latest tag, its age in
days, the PRs merged since and a verdict: `fresh`, `due`, `no release yet` or
`unknown`. A repo is due when its latest tag is over 7 days old or over 50 PRs
merged since it; an old tag with nothing merged since is fresh. `--json` emits
`phantom.releases.v1` with `version`, `repos` and `next`, the single most
overdue repo, or `null` when nothing is due. The Metrics pane shows the same
legacy report plus `releaseRepos` from `phm release status --json`, read from
`GET /api/fleet/releases`. Both cards render those shared commit rows.

The command only reports. It reads local clones under `~/Projects/ashlrai`,
makes no network calls and never tags or publishes; open the release PR through
the repo's own release workflow. Fetch the clones first for current numbers. A
missing clone or an unreadable tag date is `unknown`. A shallow clone is counted
only when its history reaches back to the latest tag.

### Compare publication with later merges

```sh
phm fleet publication-evidence --repo phantom
phm fleet publication-evidence --repo phantom --json
```

This read-only report separates the latest published stable release, drafts,
prereleases and PRs merged into the default branch after the stable release's
publication time. Omit `--repo` to inspect all enrolled repositories. It reads
GitHub through `gh` and local clones under `~/Projects/ashlrai`; use
`--root /absolute/path/to/clones` to choose another parent directory. Local
`origin/HEAD` must identify each clone's default branch. Fetch clones first
for current refs; the report does not fetch them.

JSON uses `phantom.publication-evidence.v1`. Each repository has `published`,
`drafts`, `prereleases`, `mergedAfterPublication`, `lag`, `reason`, `next` and
separate `localTag` facts. `next` suggests `no new merged PRs`, `write changelog`,
`review release` or `unknown`. These are suggestions; the command changes no
files and starts no release.

Merged-after-publication is a timing count, not proof of which commits an
artifact contains or what is installed. Missing or incomplete evidence stays
unknown, including capped GitHub results, a missing stable baseline or an
unknown default branch. Local tag commit counts also stay unknown in shallow
clones. A successful read can contain unknown fields; inspect `lag` and
`reason` before using the count.

### Draft release notes

Run `phm release notes` inside a repository for Markdown since its latest
reachable stable version tag, or choose `--since v3.30.35`. It reads the current
branch's mainline, including squash and ordinary GitHub PR merges. Fetch history
and tags first when the requested range is unavailable. No network calls occur.
`--since` also takes a date (`2026-11-01`). `--markdown` prints the reader's
version: a three-sentence summary, then short lists under plain headings (New
in the app, Phone, Fleet and speed, Fixes, Docs, Under the hood), with test and
recovery work as one count. The app's Settings shows the same notes through
`GET /api/verse/app/whats-new`. `--json` returns `phantom.release-notes.v1`
with `since`, `head`, `summary`, `headline`, `sections` and
ordered `groups` (New, Improved, Fixed, Internal); entries carry text, PRs and
commit SHAs. Direct commits without a PR retain their short SHA in Markdown.
Opaque subjects use touched files as context, without inferring user benefits.
Add `--write` to prepend notes inside `CHANGELOG.md`'s existing `Unreleased`
section. Repeated writes replace only the generated block, preserving manual
entries and release history. New/Improved become Added/Changed in the changelog.
No version, tag, release or workflow is changed. Invalid flags exit 2; unreadable
history or an unsupported changelog exits 1 (JSON errors have `ok: false`).
