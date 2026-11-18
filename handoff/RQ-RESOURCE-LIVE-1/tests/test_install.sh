#!/bin/bash
# Dry-run and refusal checks for install.sh. Writes only under a temp dir. Never loads a LaunchAgent.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0; pass=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1"; }
mkdir -p "$tmp/agents" "$tmp/runs"

out=$(HOME="$tmp" "$here/install.sh" --phm /opt/phm --runs-dir "$tmp/runs" --agents-dir "$tmp/agents"); rc=$?
[ $rc = 0 ] && ok || bad "dry run exit $rc"
[ -z "$(ls -A "$tmp/agents")" ] && ok || bad "dry run wrote a file"
[ ! -e "$tmp/runs/state" ] && ok || bad "dry run created the state dir"
echo "$out" | grep -q '<string>/opt/phm</string>' && ok || bad "phm path not rendered"
echo "$out" | grep -q "<string>$tmp/runs</string>" && ok || bad "runs dir not rendered"
echo "$out" | grep -q '__[A-Z_]*__' && bad "placeholder left in plist" || ok
echo "$out" | grep -Eq 'package sha256=[0-9a-f]{64}$' && ok || bad "package sha missing"
if command -v plutil >/dev/null; then
  echo "$out" | sed -e '1d' -e '$d' > "$tmp/rendered.plist"
  plutil -lint "$tmp/rendered.plist" >/dev/null && ok || bad "rendered plist does not lint"
fi

HOME="$tmp" "$here/install.sh" --apply --phm /opt/phm --runs-dir "$tmp/runs" --agents-dir "$tmp/agents" 2>/dev/null; [ $? = 2 ] && ok || bad "apply without pin accepted"
HOME="$tmp" "$here/install.sh" --apply --pin 0000 --phm /opt/phm --runs-dir "$tmp/runs" --agents-dir "$tmp/agents" 2>/dev/null; [ $? = 1 ] && ok || bad "wrong pin accepted"
[ -z "$(ls -A "$tmp/agents")" ] && ok || bad "refused apply wrote a file"
HOME="$tmp" "$here/install.sh" --runs-dir relative --phm /opt/phm 2>/dev/null; [ $? = 2 ] && ok || bad "relative runs dir accepted"
HOME="$tmp" "$here/install.sh" --runs-dir "$tmp/.codex-2/runs" --phm /opt/phm 2>/dev/null; [ $? = 2 ] && ok || bad "codex runs dir accepted"
HOME="$tmp" "$here/install.sh" --nope 2>/dev/null; [ $? = 2 ] && ok || bad "unknown flag accepted"

echo "install.sh checks: $pass passed, $fail failed"
[ $fail = 0 ]
