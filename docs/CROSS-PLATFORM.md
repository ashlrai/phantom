# Platform installation and observations

The CLI package supports macOS, Linux and Windows with Node.js 22.15 or newer.
Install the full package with `npm install -g @ashlr/phantom`, then check
`phm --version` and `phm doctor`. Both `phm` and `ashlr` use the same runtime.
Use [Quickstart](QUICKSTART.md#open-verse) for the console and first session.

The per-user release installers provide the same package route:

```sh
curl -fsSL https://raw.githubusercontent.com/ashlrai/phantom/master/scripts/install-release.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/ashlrai/phantom/master/scripts/install.ps1 | iex
```

These commands trust the HTTPS-delivered bootstrap script. Download and review
it first when you need to pin the bootstrap itself. Artifact checksums verify
the package payload; they are not a claim that the bootstrap was signed.

Set `PHANTOM_VERSION` to a published version to select that exact version. Set
`PHANTOM_PREFIX` for a per-user destination. For an offline tarball, set both
`PHANTOM_TARBALL` and its `PHANTOM_INTEGRITY` value (`sha512-` plus base64).
The scripts copy to private staging, verify those bytes, then install that file.
Invalid integrity or a failed verifier stops before package installation.
On Windows, `PHANTOM_PATH_MODE=session` limits PATH changes to the current
PowerShell session; the default `user` mode persists the per-user PATH entry.

`PHANTOM_PREFER_NATIVE=1` opts into an available native CLI release asset with
the matching architecture and version. Native assets require their SHA-256
release digest and exact official repository/tag download URL. Until console
assets and worker modules are qualified alongside those executables, use npm
for the complete workbench. Missing native assets fall back to the selected npm
version; an integrity failure does not silently fall back.

For the pluggable signer integration, `PHANTOM_VERIFY_RELEASE` names an absolute
executable path. After checksum verification the installer calls it with three
arguments: staged artifact path, `npm` or `native`, and selected version (empty
for an unversioned caller-provided tarball). Nonzero exit fails installation.
It is an explicit verification hook, not a shell expression; signing and
notarization policy remain with the signer implementation.

## Services and onboarding

| OS | Manager | Register | Inspect | Unregister |
| --- | --- | --- | --- | --- |
| macOS | launchd | `phm authority resident start` | `phm daemon service-status --json` | `phm authority resident stop` |
| Linux | systemd --user | `phm daemon install` | `phm daemon service-status --json` | `phm daemon uninstall` |
| Windows | limited per-user Task Scheduler logon task | `phm daemon install` | `phm daemon service-status --json` | `phm daemon uninstall` |

These use the existing daemon service manager. Paths are encoded for each
native service format. Linux needs a working user systemd bus; a minimal
container often has none. Windows needs Task Scheduler under the signed-in
user. Neither installer requests Administrator or root privileges.

`phm daemon doctor --json` distinguishes process liveness from native service
registration. An unavailable manager is unknown, not proof of absence. A native
task or unit can be registered while its daemon is stopped. `phm daemon stop`
retains its global orderly-shutdown semantics; use unregister to remove native
registration. macOS resident start/stop retain their custody and grant checks.
Portable registration does not grant unattended execution authority.

`phm init` recognizes an installed launcher. Windows uses npm's `.cmd` shim
without requiring Unix symlinks; PATH guidance uses Windows conventions.
Optional provider diagnostics are independent of package installation.

## OS sensor contract

`readOsSensors()` in `src/core/resources/os-sensors.ts` returns
`os.sensors.v1`. The opt-in machine sampler includes it as `osSensors` alongside
its existing fields. `phm resources sample --json` requires
`telemetry.machine.enabled = true`; it persists the sample locally as documented
in [machine telemetry](MACHINE-TELEMETRY.md).

| Observation | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Memory pressure | kernel normal/warning/critical | PSI stalled-time averages | committed allocation as a percentage of commit limit |
| Swap used | `vm.swapusage` | `/proc/meminfo` | CIM pagefile current usage |
| Compressed physical memory | pages occupied by compressor | zswap pool plus enumerated zram resident allocation | unsupported, null |
| Load per logical core | one-minute load divided by cores | one-minute load divided by cores | unsupported, null |
| Thermal | CPU speed limit | available thermal-zone maximum | available thermal-zone maximum |

Each value carries a source and an explicit reason when unavailable. Zero is
reported only when measured. Linux PSI, Windows commit pressure and macOS
kernel severity are different signals. Thermal zones need not measure CPU die
temperature. Consumers choose policy per signal kind, check sample freshness,
and preserve unknowns. Sampling changes no admission or scheduling policy.

The desktop app remains a separate port: native custody, platform helpers,
packaging and installed update/rollback behavior need platform-specific review
and evidence. CLI fixture coverage does not establish desktop acceptance.
