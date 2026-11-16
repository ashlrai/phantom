# RELEASE-CONTINUOUS-1: installed-app verification and release metrics

Step (5) of RQ-RELEASE-CONTINUOUS-1: verify each release end to end on the Mac and append one line to
`~/.ashlr-runs/metrics/releases.jsonl`. The rev2 pass in `release-autorun.sh` already proves the seven signed
assets and the live updater feed for each signed sha. What is missing is the installed app check and the metrics line.

## What changes

1. New file `~/.ashlr-runs/bin/release-verify-installed.mjs` (byte-identical to `scripts/release-verify-installed.mjs`
   in the repository; see SHA256). Anonymous GET reads of `api.github.com/repos/ashlrai/phantom/...` and
   `github.com/ashlrai/phantom/releases/latest/download/latest.json` only. Reads
   `/Applications/Phantom.app/Contents/Info.plist` (`CFBundleShortVersionString`, via `plutil` when the plist is binary).
   Writes only `~/.ashlr-runs/metrics/releases.jsonl`, at most one line per tag.
2. `release-autorun.sh`: one block appended before the final `exit 0` (release-autorun.diff). It runs the verifier
   every tick (10 minutes) and logs the result through the existing scrubbed `log`. It never changes the exit code.

Metrics line fields: `tag`, `publishedEt` (America/New_York wall time with EST/EDT), `mergeToInstalledMinutes`
(tagged commit committer date to the first tick that saw the installed bundle at that version or newer, an upper bound
within one 10 minute poll), `installedVersion`, plus `mergedAt`, `publishedAt`, `installedObservedAt`, `assets`, `feed`.

## Not changed

No signing, notarization, keychain access, release or tag mutation, publish, new LaunchAgent, credential or token use.
The verifier never reads app data, chat.db, TCC databases or `~/.codex*`.

## Install (Security)

```sh
cd ~/.ashlr-runs/staged/RELEASE-CONTINUOUS-1
shasum -a 256 -c SHA256
install -m 0755 release-verify-installed.mjs ~/.ashlr-runs/bin/release-verify-installed.mjs
patch --dry-run ~/.ashlr-runs/bin/release-autorun.sh < release-autorun.diff && patch ~/.ashlr-runs/bin/release-autorun.sh < release-autorun.diff
```

The diff is against the repository copy `contrib/mac/release-autorun.sh`. If the live copy differs, apply the
appended block by hand right before its final `exit 0`.

## Verify

```sh
node ~/.ashlr-runs/bin/release-verify-installed.mjs --json --metrics "$(mktemp -d)/releases.jsonl"
```

Observed on 2026-11-16 before install: `{"state":"pending","reason":"awaiting-self-update","tag":"v3.30.33",
"feedVersion":"3.30.33","installedVersion":"3.30.32"}`. The latest public release and feed are 3.30.33 while the
installed bundle reports 3.30.32, so the app has not self-updated to the latest release.
Repository tests: `npx vitest run test/release-verify-installed.test.ts` (16 tests).
