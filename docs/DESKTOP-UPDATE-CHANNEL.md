# Desktop update channel

The Phantom desktop app's signed updater channel — what the feed is, who may
publish it, how an installed app consumes it, and how `release-autorun` proves
a published feed is live. There is no mobile companion in this repository; the
channel covers the macOS arm64 Tauri app only.

## Channel shape

- **Endpoint.** `desktop/src-tauri/tauri.conf.json` pins the updater to
  `https://github.com/ashlrai/phantom/releases/latest/download/latest.json`
  on channel `stable`, platform `darwin-aarch64`.
- **Feed.** `latest.json` carries `version`, `platforms["darwin-aarch64"].url`
  pointing at `Phantom_<version>_aarch64.app.tar.gz` on the same tag, and
  `platforms["darwin-aarch64"].signature` — the detached minisign signature of
  that archive. Its `phantom` envelope carries the exact `manifest.json` text
  and `manifest.json.sig` bytes for the paired release.
- **Paired manifest.** `manifest.json` (`schemaVersion: 2`, kind
  `phantom-paired-release`) binds the source revision, the app archive's
  filename/URL/SHA-256 and the paired `ashlr-phantom-<version>.tgz` CLI
  archive's filename/URL/SHA-256, plus signatures and qualification run
  identities. The validation rules live in
  `src/core/desktop/update-manifest.ts`.
- **Asset set.** A complete tag release holds exactly seven assets: the app
  archive and its `.sig`, the CLI archive and its `.sig`, `manifest.json`,
  `manifest.json.sig` and `latest.json`.
- **Trust.** The commissioned updater public key and repository identities
  live in `src/core/desktop/update-trust.ts`; the canonical profile maps to
  `ashlrai/phantom` / `@ashlr/phantom` / `ai.ashlr.desktop`.

## Production and publication

`scripts/finalize-desktop-update.mjs` is the trusted local producer. It
requires fresh source, hosted qualification, independent audit evidence, the
pinned toolchain (`scripts/desktop-release-policy.mjs`), the existing Apple
signing identity and the private local release-signing key, which is never
packaged. `scripts/publish-desktop-release.mjs` is the maintainer publication
step; it verifies the finalized artifacts and publishes only on explicit
`--publish`. Signing and publication stay owner-controlled; nothing below
moves that boundary.

## Consumer behavior

The installed app polls the endpoint every 15 minutes and rechecks after wake
when the polling gap exceeded 30 seconds. Downloads are verified against the
feed's minisign signature in the background; concurrent checks coalesce.
Publication alone never installs anything: automatic installation additionally
requires an idle app, authority Stop, zero leases, a normal Quit and an
unchanged active grant. The updater never relaunches the app, never stops
work and never clears Stop. See
[the signed idle update flow](../desktop/README.md#signed-idle-updates) and
`src/core/desktop/qualified-update.ts`.

## Published-state verification (release-autorun rev2)

`contrib/mac/release-autorun.sh` adds a bounded post-selection pass after the
signing selection loop. Each completed successful signing outcome
(`sha-<sha>.rc` = `0` in `~/.ashlr-runs/release-sign/autorun/`) without a
`feed-<sha>.rc` marker is checked once per tick through GET-only `gh api`
reads plus one unauthenticated `curl` download:

1. The `v*` tag on the signed sha must resolve, and
   `releases/tags/<tag>` must be a non-draft, non-prerelease release whose
   `target_commitish` equals the signed sha.
2. `releases/<id>/assets` must be exactly the seven-asset set, all `uploaded`
   with `sha256:` digests.
3. The four small signed bodies (`latest.json`, `manifest.json`,
   `manifest.json.sig`, app `.sig`) are fetched with
   `Accept: application/octet-stream` and hashed against the recorded
   digests; feed fields, the `phantom` envelope and manifest fields must
   bind the tag, source sha and both artifact digests.
4. While that release is `releases/latest`, the public endpoint must serve
   the same feed bytes over HTTP 200 within 15 seconds, redirects followed.

Outcomes are written to `feed-<sha>.rc` and are final:

| rc | state | meaning |
|----|-------|---------|
| `0` | `verified-live` | complete set verified and the endpoint serves it; receipt `feed-<sha>.json` records release id, HTTP code and feed/manifest digests |
| `21` | `verified-but-superseded` | the complete set verified but a newer release holds `latest`; informational, no operator action |
| `22` | `failed` | an inconsistency (identity, asset set, binding or endpoint bytes); receipt plus `NEEDS-MASON-<tag>-feed`; remove the rc file to allow one manual recheck |

Pending conditions — no tag, draft/absent release, digests still populating,
or the endpoint not yet serving — write no marker and are re-read on later
ticks. The pass never signs, publishes, mutates a release or touches the
keychain; signature-level minisign verification stays with the
consumer/finalizer path.

Manual read-only spot check, from a clean shell:

```sh
gh api repos/ashlrai/phantom/releases/latest --jq '{tag_name,draft,prerelease}'
gh api repos/ashlrai/phantom/releases/tags/<tag> \
  --jq '{id,target_commitish,draft,prerelease}'
gh api 'repos/ashlrai/phantom/releases/<id>/assets?per_page=100' \
  --jq '[.assets[].name]'
curl -sS -L --max-time 15 -o /tmp/latest.json -w '%{http_code}\n' \
  https://github.com/ashlrai/phantom/releases/latest/download/latest.json
```

## Boundaries

This document describes verification and consumption, not new authority.
Apple signing and the private release key remain owner steps;
`keychain-allowed` still gates the signer; `RELEASE_AUTORUN_OFF` still stops
the observer. Linux remains quarantined
(`RQ-RELEASE-DESKTOP-UNQUARANTINE-2`); Windows artifacts remain draft-only.
The November 5 `v3.30.8` incident notes in
[RELEASING.md](RELEASING.md#finalize-a-stocked-phantom-draft) still govern
that tag.
