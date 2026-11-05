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

- Nightly at `3 9 * * *`, or manual dispatch with `release_gate=false`: retain
  the exhaustive platform suites and the existing seven-day Mac rotation.
  Failed jobs stay red and emit scrubbed `tier=work` repair lines in the
  `phantom-fixup-queue` artifact. Router ingestion is a separate operation.
- At `0,30 * * * *`, or manual dispatch with `release_gate=true`: reuse a
  completed successful **push** CI run for the exact master SHA. The unsigned
  preparation job reuses an immutable artifact for that source when available,
  otherwise builds once with cached compiler inputs. The following one-minute
  smoke job downloads that artifact, checks source/version/package identity,
  parses the current signed updater manifest and launches the native binary
  with `--release-smoke` in an isolated home. It never installs dependencies
  or rebuilds. No current per-PR desktop producer exists; cold preparation,
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
The host `release-autorun` consumer and published signed updater acceptance
must be verified separately before claiming continuous release operation.
The one-minute smoke timeout is a budget, not a measured hosted runtime.
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
