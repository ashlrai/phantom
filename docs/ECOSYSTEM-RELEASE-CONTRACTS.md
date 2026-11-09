# Ecosystem release planning

The source-only release planner describes dependencies and owner holds across fourteen reviewed repository profiles. It executes no tests, package scripts, Git commands, network reads, deployments, tags or publications. It does not commission automatic publishing or authorize an effect.

Run it from a source checkout with existing development dependencies:

```sh
node --import tsx scripts/ecosystem-release-plan.ts --input /absolute/path/local-snapshot.json
```

`ReleasePlanSnapshot` and `ReleaseRepositoryObservation` in `src/core/ecosystem/release-plan.ts` define the closed input format. Supply exact source, default-branch and tree hashes, package identities and versions, synchronized documentation, workflow source bindings, qualification coverage and owner holds. These are **reported local observations**, not verified provider facts or admission receipts. The explicit observation age limit is five minutes. Unknown, stale, dirty, mismatched, missing and proposal-only observations remain held. Even complete reported prerequisites return `pending-independent-verification`, with `authority: false` and `releaseAdmission: false`.

The dated ecosystem index supplies role labels and unverified historical repository names. It does not prove current remote existence or signed enrollment. Every registry name remains visible, including Lexicon and Stack, with unknown source/artifact/publisher holds when no reviewed contract exists. Fourteen profiles have reviewed pathways; other registry names and explicitly supplied unprofiled repositories never become generic npm publishing jobs.

| Product | Existing release dependency |
| --- | --- |
| Phantom | Full original fifteen-job CI and Audit → protected source → original-artifact attestation → canonical npm publisher → separate signed native artifacts and fresh public facts → separately owned site task |
| Phantom Secrets | Rust/tag artifact release → wrapper acceptance; wrapper publisher commissioning and site ownership remain separate |
| Ashlr Plugin | Tagged VSIX/site archive; separate existing site/server deployments |
| AshlrCode | Existing release-published Bun test/build and npm workflow; source/tag/version hardening and publisher ownership remain explicit |
| Binshield | Actual `packages/cli` product; private workspace root is excluded, npm publisher unresolved |
| Pulse | Existing tagged Go agent artifacts; no npm output presumed |
| Locus | Rust platform artifacts; npm wrapper parity and publisher commissioning unresolved |
| Measurably | Exact main CI/approved SHA/Production environment contract; private packages and native staging are not npm or promotion proof |
| Fleet Canary | Verification only; no package/tag/deployment output presumed |
| Cortex/Auth/Config/Cost/Core Efficiency | Establish current product/source and owner release contract; preserve proposal-only scope where applicable |

Documentation/site PR feedback never substitutes for Phantom's full original producer coverage. Workflow presence or a serialized public-facts record does not prove current commissioning, publication, deployment, or installation. Execute any next step through its existing qualified owner workflow after independent verification; this planner only connects the steps.

## Release dispatch dry run

`planReleaseDispatch(snapshot, nowMs, registry, repository)` in `src/core/release/orchestrator.ts` projects the reviewed dependency plan for one repository. It preserves holds and workflow bindings, redacts owner-supplied blocker text, and identifies the first stage awaiting independent verification. It does not determine a version bump or authorize a tag, publication, or announcement. A pending stage is not evidence of readiness or permission to execute. Unknown or unreviewed paths stay held, and owner gates are never modified.

```sh
node --import tsx scripts/release-dispatch-dry-run.ts --dry-run --input /absolute/path/local-snapshot.json --repo ashlrai/phantom
```

The input uses the same bounded local snapshot format and five-minute freshness rules described above. This preview has no execution mode, network calls, credential resolution, or release effects. Actual releases still require each repository's existing sanctioned path, verified evidence, and applicable grants and controls.
