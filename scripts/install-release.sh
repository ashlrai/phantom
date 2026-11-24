#!/bin/sh
# install-release.sh - per-user Phantom install for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/ashlrai/phantom/master/scripts/install-release.sh | sh
#
# Installs the complete npm package by default. PHANTOM_PREFER_NATIVE=1 opts
# into a matching CLI-only native asset when published (otherwise uses npm). The npm tarball is
# checked the same way src/core/update/release-directory.ts does: registry
# sha512 integrity, then `gh attestation verify` when the GitHub CLI is
# installed. Installs under $HOME/.local. On Linux, registers the systemd --user
# daemon. On macOS, resident registration stays on
# `phm authority resident start`. It then runs phm doctor.

set -eu

REGISTRY_PACKAGE='@ashlr/phantom'
REGISTRY_HOST='https://registry.npmjs.org'
GITHUB_REPO='ashlrai/phantom'
INTEGRITY_RE='^sha512-[A-Za-z0-9+/]{86}==$'

fail() { printf 'fail %s\n' "$*" >&2; exit 1; }
match() { printf '%s\n' "$1" | LC_ALL=C grep -Eq "$2"; }
version=${PHANTOM_VERSION:-}
prefer_native=${PHANTOM_PREFER_NATIVE:-0}
case "$prefer_native" in 0|1) ;; *) fail 'PHANTOM_PREFER_NATIVE must be 0 or 1' ;; esac
[ -z "$version" ] || match "$version" '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'PHANTOM_VERSION must be a stable version (x.y.z).'
# Optional signer-owner adapter: an executable path, never evaluated as shell.
verify_release() {
  if [ -n "${PHANTOM_VERIFY_RELEASE:-}" ]; then
    case "$PHANTOM_VERIFY_RELEASE" in /*) ;; *) fail 'Release verifier must be an absolute executable path' ;; esac
    [ -x "$PHANTOM_VERIFY_RELEASE" ] || fail 'Release verifier is not executable'
    "$PHANTOM_VERIFY_RELEASE" "$1" "$2" "$3" || fail 'Release verifier refused the artifact'
  fi
}

case "$(uname -s)" in
  Linux) os_name=linux ;;
  Darwin) os_name=macos ;;
  *) fail "unsupported operating system $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch_name=x64 ;;
  aarch64|arm64) arch_name=arm64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
printf 'Phantom installer (%s-%s)\n' "$os_name" "$arch_name"

command -v node >/dev/null 2>&1 || fail 'Node.js 22.15 or newer is required.'
node_ok=$(node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.stdout.write(major > 22 || (major === 22 && minor >= 15) ? "1" : "0")')
[ "$node_ok" = 1 ] || fail "Node.js 22.15 or newer is required; found $(node --version)."
command -v npm >/dev/null 2>&1 || fail 'npm is required.'
command -v curl >/dev/null 2>&1 || fail 'curl is required.'

prefix="${PHANTOM_PREFIX:-$HOME/.local}"
mkdir -p "$prefix"
work=$(mktemp -d "${TMPDIR:-/tmp}/phantom-install.XXXXXX")
trap 'rm -rf "$work"' 0
downloaded="$work/package.tgz"

verify_sha512() {
  file="$1" expected="$2"
  match "$expected" "$INTEGRITY_RE" || fail 'Release integrity metadata unavailable'
  node -e '
    const fs = require("node:fs");
    const { createHash } = require("node:crypto");
    const [file, expected] = process.argv.slice(1);
    const got = "sha512-" + createHash("sha512").update(fs.readFileSync(file)).digest("base64");
    if (got !== expected) process.exit(1);
  ' "$file" "$expected" || fail 'Release integrity verification failed'
}

verify_sha256() {
  file="$1" hex="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$hex" "$file" | sha256sum -c --strict >/dev/null
  else
    printf '%s  %s\n' "$hex" "$file" | shasum -a 256 -c >/dev/null
  fi || fail 'Release asset checksum verification failed'
}

installed_bin=0
if [ -n "${PHANTOM_TARBALL:-}" ]; then
  [ -n "${PHANTOM_INTEGRITY:-}" ] || fail 'A local tarball requires PHANTOM_INTEGRITY (sha512-...).'
  [ -f "$PHANTOM_TARBALL" ] || fail "Tarball not found: $PHANTOM_TARBALL"
  cp "$PHANTOM_TARBALL" "$downloaded"
  verify_sha512 "$downloaded" "$PHANTOM_INTEGRITY"
  verify_release "$downloaded" npm "$version"
  printf 'Verified local tarball sha512\n'
else
  asset_name="ashlr-${os_name}-${arch_name}"
  if [ "$os_name" = macos ]; then asset_name=''; fi
  digest=''
  asset_url=''
  if [ "$prefer_native" = 1 ] && [ -n "$asset_name" ]; then
    release_path=latest
    if [ -n "$version" ]; then release_path="tags/v$version"; fi
    release_json=$(curl --fail --silent --show-error --max-time 30 \
      -H 'User-Agent: phantom-install' -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${GITHUB_REPO}/releases/${release_path}" || true)
    if [ -n "$release_json" ]; then
      parsed=$(printf '%s' "$release_json" | node -e '
        let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
          const name = process.argv[1];
          const release = JSON.parse(raw);
          if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag_name) || release.draft || release.prerelease) return;
          if (process.argv[2] && release.tag_name !== "v" + process.argv[2]) return;
          const asset = (release.assets || []).find(item => item && item.name === name);
          if (!asset) return;
          const digest = String(asset.digest || "");
          const match = /^sha256:([a-fA-F0-9]{64})$/.exec(digest);
          if (!match || asset.browser_download_url !== "https://github.com/ashlrai/phantom/releases/download/" + release.tag_name + "/" + name) return;
          process.stdout.write(match[1] + "\n" + asset.browser_download_url + "\n" + release.tag_name.slice(1));
        });
      ' "$asset_name" "$version" || true)
      digest=$(printf '%s' "$parsed" | head -n 1)
      asset_url=$(printf '%s' "$parsed" | sed -n '2p')
      asset_version=$(printf '%s' "$parsed" | sed -n '3p')
    fi
  fi
  if match "$digest" '^[a-fA-F0-9]{64}$' && [ -n "$asset_url" ]; then
    bin_file="$work/$asset_name"
    curl --fail --silent --show-error --location --max-time 120 -o "$bin_file" "$asset_url"
    verify_sha256 "$bin_file" "$digest"
    verify_release "$bin_file" native "$asset_version"
    mkdir -p "$prefix/bin"
    install -m 0755 "$bin_file" "$prefix/bin/ashlr"
    ln -sfn ashlr "$prefix/bin/phm"
    installed_bin=1
    printf 'Installed CLI-only %s (console assets require the npm package)\n' "$asset_name"
  else
    if [ -n "$version" ]; then
      meta_url="${REGISTRY_HOST}/${REGISTRY_PACKAGE}/${PHANTOM_VERSION}"
    else
      meta_url="${REGISTRY_HOST}/${REGISTRY_PACKAGE}/latest"
    fi
    meta=$(curl --fail --silent --show-error --max-time 30 -H 'User-Agent: phantom-install' "$meta_url")
    parsed_meta=$(printf '%s' "$meta" | node -e '
      let raw = ""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
        const meta = JSON.parse(raw);
        const version = meta && meta.version;
        const integrity = meta && meta.dist && meta.dist.integrity;
        const url = meta && meta.dist && meta.dist.tarball;
        if (meta.name !== "@ashlr/phantom" || typeof version !== "string" || typeof integrity !== "string" || typeof url !== "string") process.exit(1);
        process.stdout.write([version, integrity, url].join(" "));
      });
    ') || fail 'Registry metadata unavailable'
    IFS=' ' read -r package_version integrity url <<EOF
$parsed_meta
EOF
    match "$package_version" '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Registry metadata unavailable'
    match "$integrity" "$INTEGRITY_RE" || fail 'Release integrity metadata unavailable'
    [ "$url" = "${REGISTRY_HOST}/@ashlr/phantom/-/phantom-${package_version}.tgz" ] || fail 'Release integrity metadata unavailable'
    [ -z "$version" ] || [ "$version" = "$package_version" ] || fail 'Registry version mismatch'
    curl --fail --silent --show-error --location --max-time 180 -o "$downloaded" "$url"
    verify_sha512 "$downloaded" "$integrity"
    if command -v gh >/dev/null 2>&1; then
      gh attestation verify "$downloaded" --repo ashlrai/phantom --hostname github.com \
        || fail 'GitHub attestation verification failed'
      printf 'GitHub attestation verified\n'
    else
      printf 'sha512 verified; GitHub CLI not installed, attestation left unknown\n'
    fi
    verify_release "$downloaded" npm "$package_version"
    printf 'Verified npm package %s\n' "$package_version"
  fi
fi

if [ "$installed_bin" -eq 0 ]; then
  npm install --global --prefix "$prefix" --no-audit --no-fund "$downloaded"
fi

bin_dir="$prefix/bin"
if [ ! -x "$bin_dir/phm" ] && [ -x "$prefix/phm" ]; then bin_dir="$prefix"; fi
[ -x "$bin_dir/phm" ] || fail 'phm was not installed'
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    printf '%s is not on PATH. Add: export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir"
    export PATH="$bin_dir:$PATH"
    ;;
esac

"$bin_dir/phm" --version
if ! "$bin_dir/phm" doctor; then
  printf 'Installed; doctor found setup items. Review them with phm doctor.\n'
fi
if [ "$os_name" = linux ]; then
  "$bin_dir/phm" daemon install
  printf 'Installed. Per-user daemon: systemctl --user status ashlr-daemon\n'
else
  printf 'Installed. On macOS, register the resident daemon with: phm authority resident start\n'
fi
