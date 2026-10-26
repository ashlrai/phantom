# Dependency security policy

Source reviewed on October 10, 2026 at
`6a731457c7c7d8ad20af4e40cb09132f9270fead` configures Phantom's hosted
[Dependency Audit](../.github/workflows/dependency-audit.yml) to audit the root
and Raycast npm lockfiles plus
`desktop/src-tauri/Cargo.lock` on pull requests, relevant `master` changes,
its weekly schedule, and manual dispatch. Local releases must still reproduce
every required lane before an exact-source receipt is accepted. The workflow
pins every action to a full commit and verifies the SHA-256 of its exact
RustSec scanner archive.
The npm lockfiles must first reproduce through strict `npm ci`. The primary
scanner remains pinned npm, with full and production audits for both graphs.
Only a recognized transport failure after three bounded attempts may invoke an
exact OSV-Scanner release binary whose SHA-256 digest is verified. A valid npm
vulnerability report never falls back, and an unavailable or non-clean fallback
also fails the job. The fallback receives a process-created empty configuration
from the runner's private temporary directory, so repository-controlled
`osv-scanner.toml` ignore rules cannot weaken the required check. Each lane
records its provider result in the job summary.

## Universe example coverage gap

At that source revision, `examples/universe-site/package-lock.json` resolves
`braces 3.0.3` through both example toolchains:

- `shadcn → fast-glob → micromatch → braces` (also through shadcn's
  `ts-morph → @ts-morph/common → fast-glob` dependency).
- `vinext → vite-plugin-commonjs → vite-plugin-dynamic-import → fast-glob →
  micromatch → braces`.

The [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
identifies deeply nested patterns as a stack-exhaustion risk and lists no
patched version as of the review date. The example lockfile does not mark braces
as development-only. The root and Raycast lockfiles contain no braces, but the
hosted workflow omits the example graph from its install/audit steps and omits
its manifest and lockfile from `master` push path filters. A passing covered
lane therefore does not establish that the example is clean.

This review establishes lockfile ancestry and workflow scope, not installation,
packaged or deployed contents, or attacker-controlled runtime reachability.
Adding example audit coverage and qualifying a supported replacement across
both toolchains remain separate follow-up work; this disclosure adds no audit
exception or dependency override.

## Version updates

Dependabot version-update entries are removed. Renovate opens version pull
requests before 6am America/New_York on Monday. Non-major updates share one
pull request. GitHub Actions, including digest and pin updates, are their own
group. Major updates are their own group. `prConcurrentLimit` is 3,
`prHourlyLimit` is 2, and automerge is off.

Dependabot alerts and secret-scanning push protection remain enabled.
Automated Dependabot security-update pull requests stay disabled in repository
settings. Renovate `vulnerabilityAlerts` is enabled, so security pull requests
come from Renovate. Dependabot security updates stay off so the two do not
race. The Renovate configuration does not change those repository settings.

## Version holds

The root npm graph carries four Renovate `allowedVersions` holds, expressed
below as the versions that stay out of version-update pull requests. Each
names one exact dependency and a lower version bound, so every release below
the bound still flows through version updates. None ignores a whole
dependency, an update type, or a wildcard name. Each hold exists because the
held major cannot install or cannot pass here, and each is lifted by its
stated condition, not by expiry:

| Dependency | Held versions | Lifted when |
| --- | --- | --- |
| `typescript` | `>=6.1.0` | a typescript-eslint release admits it in its peer range |
| `eslint` | `>=10.0.0` | the new `eslint:recommended` rules are migrated deliberately |
| `eslint-plugin-react-hooks` | `>=7.0.0` | lifted together with the ESLint 10 migration |
| `jsdom` | `>=30.0.0` | the affected `getByRole` queries are updated |

A hold is a version-update decision, not a security exception. It changes only
which version-update pull requests Renovate would propose; it does not hide an
advisory. Dependabot alerts stay enabled and `npm audit` reads the lockfile
directly, so an advisory against a held version still surfaces there.
Adding or widening a hold is a reviewed change: one exact dependency, a stated
reason, and a stated lift condition.

## Desktop RustSec containment

`desktop/src-tauri/Cargo.lock` still resolves crates.io `glib 0.18.5`, affected
by [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
RustSec identifies `glib >=0.20.0` as patched. Linux desktop builds are blocked
by `desktop/src-tauri/build.rs`, and the release policy rejects Linux bundles.
These source controls and the lockfile do not establish the compiled dependency
graph or runtime reachability of an installed Mac or Windows artifact.

The audit ignores exactly `RUSTSEC-2024-0429` while Linux desktop output remains
quarantined. That exception does not resolve, dismiss, or downgrade
`GHSA-wrw7-89jp-8q8g`; Dependabot alert 32 must remain open until a supported
Tauri v3 / GTK4 migration or another supported dependency chain resolves to
`glib >=0.20` and the documented Linux desktop quarantine exit review succeeds. The root Linux CLI, Bun sidecar, and
web dashboard remain supported.

RustSec reports the existing warning-class findings in the Tauri v2 dependency
graph (unmaintained GTK3-era crates and other warning advisories). Their count
can change as the advisory database evolves; they are visible debt, not green
health. The audit fails on every non-excepted vulnerability, while warning-class
findings remain reported during the quarantined desktop migration.

The gate's introduction also updates only `plist` 1.9.0 to 1.10.0 and its
`quick-xml` child from 0.39.4 to 0.41.0. That removes
`RUSTSEC-2026-0194` and `RUSTSEC-2026-0195` without changing a direct desktop
manifest dependency.

`RUSTSEC-2026-0285` (`GHSA-2mjx-qc3c-rqvc`, moderate) is removed the same way:
a lock-only update of `rustls` 0.23.41 to 0.23.45 and its required
`rustls-webpki` child from 0.103.13 to 0.103.15. It does not touch the GLib
exception above.

A path, git, or vendored replacement for GLib is not remediation. RustSec can
omit non-default-registry packages from its vulnerability lookup, so such a
replacement could create a false clean result without a supported release. The
policy tests require the vulnerable GLib package to retain its exact crates.io
registry source and checksum, prohibit Cargo patch/source replacement, and keep
the Linux build, bundle, workflow, and external-disable controls intact.
