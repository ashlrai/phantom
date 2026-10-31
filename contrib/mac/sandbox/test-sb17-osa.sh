#!/bin/bash
# test-sb17-osa.sh — SB-17 acceptance: inside each lane profile, app-launch
# (LSOpen/NSWorkspace) and AppleEvent escapes must FAIL while normal dev
# commands still pass. Run OUTSIDE any lane, unsandboxed:
#   bash test-sb17-osa.sh
# Override the live bin dir for a staged rehearsal:
#   ASHLR_RUNS_BIN=/path/to/bin bash test-sb17-osa.sh
# Verdicts: ESCAPED (the dangerous op provably ran — violation), BLOCKED
# (provably refused — pass), INCONCLUSIVE (probe itself errored — violation,
# needs eyes). Exit 0 only when every probe is BLOCKED/ok.
set -u
B=${ASHLR_RUNS_BIN:-$HOME/.ashlr-runs/bin}
PROFILES="agent.sb claude.sb codex-cmp.sb codex-local.sb codex-personal.sb"
FX=$(mktemp -d); trap 'rm -rf "$FX"' EXIT
mkdir -p "$FX/bun" "$FX/crate/src"
printf 'import {test, expect} from "bun:test"; test("sb17 fixture", () => expect(1+1).toBe(2));\n' > "$FX/bun/sb17.test.ts"
printf '[package]\nname = "sb17fx"\nversion = "0.0.0"\nedition = "2021"\n' > "$FX/crate/Cargo.toml"
printf 'pub fn add(a:i32,b:i32)->i32{a+b}\n#[cfg(test)]mod t{use super::*;#[test]fn adds(){assert_eq!(add(1,1),2);}}\n' > "$FX/crate/src/lib.rs"
# NSWorkspace/AppKit probe: prints OPENED iff the launchservicesd RPC worked.
cat > "$FX/nsopen.swift" <<'EOF'
import AppKit
let u = URL(fileURLWithPath: "/System/Applications/Calculator.app")
print(NSWorkspace.shared.open(u) ? "OPENED" : "BLOCKED")
EOF
PY_OPEN='import subprocess; 
try:
 r=subprocess.run(["/usr/bin/open","-a","Calculator.app"],capture_output=True); print("OPENED" if r.returncode==0 else "BLOCKED")
except Exception: print("BLOCKED")'

run(){ sandbox-exec -f "$B/$1" /bin/bash -c "$2" 2>/dev/null; }
fails=0; rows=""
deny_probe(){ # name profile cmd -> cmd must print BLOCKED on stdout
  out=$(run "$2" "$3")
  case "$out" in
    *OPENED*)  rows="$rows  deny  $1  ESCAPED\n"; fails=$((fails+1)) ;;
    *BLOCKED*) rows="$rows  deny  $1  BLOCKED\n" ;;
    *)         rows="$rows  deny  $1  INCONCLUSIVE\n"; fails=$((fails+1)) ;;
  esac; }
pass_probe(){ # name profile cmd -> pass iff cmd rc==0
  if run "$2" "$3" >/dev/null; then rows="$rows  pass  $1  ok\n"; else rows="$rows  pass  $1  FAILED(rc!=0)\n"; fails=$((fails+1)); fi; }

for p in $PROFILES; do
  [ -f "$B/$p" ] || { echo "MISSING $B/$p"; fails=$((fails+1)); continue; }
  echo "== $p =="
  deny_probe "LSOpen(/usr/bin/open)"   "$p" '/usr/bin/open -a Calculator.app >/dev/null 2>&1 && echo OPENED || echo BLOCKED'
  deny_probe "python3 subprocess+open" "$p" "python3 -c '$PY_OPEN'"
  deny_probe "AppKit/NSWorkspace"      "$p" "swift '$FX/nsopen.swift'"
  deny_probe "AppleEvent send"         "$p" 'osascript -e "tell application \"System Events\" to count processes" >/dev/null 2>&1 && echo OPENED || echo BLOCKED'
  pass_probe "git --version"           "$p" 'git --version'
  pass_probe "bun test"                "$p" "cd '$FX/bun' && bun test >/dev/null 2>&1"
  pass_probe "cargo test"              "$p" "cd '$FX/crate' && cargo test --quiet >/dev/null 2>&1"
  pass_probe "codex --version"         "$p" 'codex --version'
  pass_probe "devin dry run"           "$p" 'devin --help >/dev/null 2>&1 || devin --version >/dev/null 2>&1'
  printf "%b" "$rows"; rows=""
done
echo "----"
[ "$fails" -eq 0 ] && { echo "SB-17 ACCEPTANCE: all profiles ok"; exit 0; }
echo "SB-17 ACCEPTANCE: $fails violation(s)"; exit 1
