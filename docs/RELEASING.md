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
> `release.yml` and `promote.yml` procedures in the archive describe the historical
> 3.3.2 lane; they are not the current publisher. Publication does not activate
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
receipts and procedures unchanged; its instructions are not the current lane.

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
- At `0,30 * * * *`, or manual dispatch with `release_gate=true`: reuse a
  completed successful **push** CI run for the exact master SHA. The unsigned
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

The existing Release PR workflow evaluates new green master commits every
30 minutes. `RELEASE_CADENCE_MINUTES` sets the minimum interval (5–1440 minutes;
values below 30 are bounded by the timer's polling interval). It requests a
patch bump, then synchronizes README, desktop and registry version carriers
and the dated changelog in that release PR. Its existing guarded merge route
remains required. Auto-tag retries every 30 minutes and only creates the tag
and draft after the exact commit's required checks succeed. Signed publication
then makes the complete updater feed visible; a draft is not an update.

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
