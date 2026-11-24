# RQ-PHM-INSTALL-1: all-platform install acceptance

Replacement prompt for the installer owner. The live prompt was inaccessible;
this file is a handoff, not evidence that the live queue was updated.

Support macOS arm64/x64, Linux arm64/x64 and Windows arm64/x64 with Node.js
22.15 or newer. npm is the common complete-package route. Provide matching
`curl -fsSL .../scripts/install-release.sh | sh` and PowerShell
`irm .../scripts/install.ps1 | iex` entrypoints, both per-user and without
elevation. Source installation remains an explicitly separate build route.

Acceptance:

1. A requested version selects only that version. A native asset is usable only
   when its exact repository, release tag, architecture and SHA-256 digest match.
   Missing native assets fall back to the same npm version, never another release.
2. Stage local or downloaded bytes, verify the staged bytes, then consume that
   same file. npm tarballs require strict SHA-512 SRI and canonical metadata.
   Bad checksums, verifier errors and invalid metadata fail before installation.
3. Provide an explicit executable verifier hook after checksum verification for
   the pluggable signer owner. Do not evaluate hook strings, sign, notarize,
   access credentials or silently downgrade a failed verification.
4. Smoke both `phm` and `ashlr`; validate paths containing spaces and non-ASCII
   characters. A missing optional provider in doctor must not undo installation.
   Report service registration failure separately, with a repair command.
5. Use the existing service manager: launchd on macOS, systemd --user on Linux,
   and a limited per-user Task Scheduler logon task on Windows. Preserve all
   custody and authority checks. Installation grants no execution authority.
6. Onboarding must recognize npm launchers on all three OSes. Windows should
   not need Unix symlinks or an Administrator prompt. Diagnose missing PATH
   and unavailable user service managers accurately.
7. Coordinate with PR #8595 for native artifacts. An executable alone is not
   complete: verify adjacent console assets and worker modules, help, doctor,
   loopback console and a bounded dry-run command from the installed artifact.
8. Use the local Linux evidence script. Windows evidence is one optional,
   narrowly path-gated job in a separate `needs-security-review` workflow PR.
   No default matrix, check renaming, additional hosted Linux run or auto-merge.

Leave changes uncommitted for the bridge. Preserve publication and Security
boundaries, and report fixture coverage separately from native OS acceptance.
