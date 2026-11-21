#!/bin/bash
# Tests for xcodebuild-slot.sh. Uses a stub xcodebuild and temp directories only.
# Run: bash test-xcodebuild-slot.sh   (exit 0 = all passed)

set -u

here="$(cd "$(dirname "$0")" && pwd)"
wrapper="$here/xcodebuild-slot.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/xcodebuild-slot-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }
check() { # $1 = description, rest = command
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

# Stub xcodebuild: records its arguments, its nice value, and the peak number of
# concurrent instances, then sleeps for STUB_SLEEP seconds and exits STUB_EXIT.
stub="$work/xcodebuild-stub.sh"
cat > "$stub" <<'STUB'
#!/bin/bash
dir="$STUB_DIR"
mkdir -p "$dir/active"
touch "$dir/active/$$"
echo "$*" > "$dir/args.$$"
/usr/bin/python3 -I -c 'import os; print(os.getpriority(os.PRIO_PROCESS, 0))' > "$dir/nice.$$"
echo "$(ls "$dir/active" | wc -l | tr -d ' ')" >> "$dir/peaks"
sleep "${STUB_SLEEP:-0}"
rm -f "$dir/active/$$"
exit "${STUB_EXIT:-0}"
STUB
chmod +x "$stub"

new_case() { # fresh stub dir and slot dir for one case
  case_dir="$work/$1"
  mkdir -p "$case_dir/stub" "$case_dir/slots"
  export STUB_DIR="$case_dir/stub"
  export WEYV_XCODEBUILD_SLOT_DIR="$case_dir/slots"
  export WEYV_XCODEBUILD_BIN="$stub"
  export WEYV_XCODEBUILD_WAIT_SECS=30
  unset WEYV_XCODEBUILD_SLOTS WEYV_BUILD_NICE STUB_EXIT
  export STUB_SLEEP=1
}

# 1. Six concurrent invocations never run more than two builds at once.
new_case concurrency
pids=""
for i in 1 2 3 4 5 6; do
  "$wrapper" -scheme Weyv "build-$i" > "$case_dir/out.$i" 2>&1 &
  pids="$pids $!"
done
rc_all=0
for p in $pids; do wait "$p" || rc_all=1; done
peak="$(sort -n "$case_dir/stub/peaks" | tail -1)"
check "six concurrent builds all succeed" [ "$rc_all" -eq 0 ]
check "peak concurrency is exactly 2 (got ${peak:-none})" [ "${peak:-0}" -eq 2 ]
check "stub ran once per invocation" [ "$(ls "$case_dir/stub"/args.* | wc -l | tr -d ' ')" -eq 6 ]

# 2. The build's exit status is returned unchanged.
new_case exit-status
STUB_EXIT=3 "$wrapper" -scheme Weyv > /dev/null 2>&1
check "xcodebuild exit status 3 is passed through" [ "$?" -eq 3 ]

# 3. Exit 75 from the build itself is still reported as the build's status.
new_case exit-75-from-build
STUB_EXIT=75 "$wrapper" -scheme Weyv > /dev/null 2>&1
rc=$?
check "build exit 75 is not mistaken for a busy slot (got $rc)" [ "$rc" -eq 75 ]

# 4. Arguments reach xcodebuild unchanged, including spaces.
new_case args
"$wrapper" -project "Weyv App.xcodeproj" -scheme Weyv -configuration Release > /dev/null 2>&1
recorded="$(cat "$STUB_DIR"/args.* 2>/dev/null)"
check "arguments are passed through (got: $recorded)" [ "$recorded" = "-project Weyv App.xcodeproj -scheme Weyv -configuration Release" ]

# 5. Builds run at the nice increment, default 10. The expectation is relative to
# this test's own priority, so running the suite under nice does not break it.
base_nice="$(/usr/bin/python3 -I -c 'import os; print(os.getpriority(os.PRIO_PROCESS, 0))')"
new_case nice-default
"$wrapper" -scheme Weyv > /dev/null 2>&1
ni="$(tr -d ' ' < "$STUB_DIR"/nice.* 2>/dev/null)"
check "default nice increment is 10 (base $base_nice, got ${ni:-none})" [ "$ni" = "$((base_nice + 10))" ]

new_case nice-custom
WEYV_BUILD_NICE=5 "$wrapper" -scheme Weyv > /dev/null 2>&1
ni="$(tr -d ' ' < "$STUB_DIR"/nice.* 2>/dev/null)"
check "WEYV_BUILD_NICE=5 adds 5 (base $base_nice, got ${ni:-none})" [ "$ni" = "$((base_nice + 5))" ]

# 6. A busy slot with no free alternative makes the caller wait, then exit 75.
new_case wait-timeout
WEYV_XCODEBUILD_SLOTS=1 STUB_SLEEP=4 "$wrapper" -scheme Holder > /dev/null 2>&1 &
holder=$!
sleep 1
WEYV_XCODEBUILD_SLOTS=1 WEYV_XCODEBUILD_WAIT_SECS=1 "$wrapper" -scheme Blocked > "$case_dir/blocked.out" 2>&1
rc=$?
wait "$holder"
check "second build times out with exit 75 while the slot is held (got $rc)" [ "$rc" -eq 75 ]
check "timeout message names the wait" grep -q "no free slot" "$case_dir/blocked.out"

# 7. A second build waits for the slot instead of failing, then runs.
new_case waits-then-runs
WEYV_XCODEBUILD_SLOTS=1 STUB_SLEEP=2 "$wrapper" -scheme First > /dev/null 2>&1 &
first=$!
sleep 0.5
WEYV_XCODEBUILD_SLOTS=1 "$wrapper" -scheme Second > /dev/null 2>&1
rc=$?
wait "$first"
check "queued build runs after the slot frees (got $rc)" [ "$rc" -eq 0 ] && [ "$(ls "$STUB_DIR"/args.* | wc -l | tr -d ' ')" -eq 2 ]

# 8. A leftover slot file from a crashed run does not block: lockf releases on exit.
new_case stale-lock-file
: > "$WEYV_XCODEBUILD_SLOT_DIR/slot-1.lock"
: > "$WEYV_XCODEBUILD_SLOT_DIR/slot-2.lock"
"$wrapper" -scheme Weyv > /dev/null 2>&1
check "unlocked leftover slot files do not block a build" [ "$?" -eq 0 ]

# 9. Bad configuration is rejected with exit 2 before any build starts.
new_case bad-config
"$wrapper" > /dev/null 2>&1
check "no arguments exits 2" [ "$?" -eq 2 ]
WEYV_XCODEBUILD_SLOTS=0 "$wrapper" -scheme Weyv > /dev/null 2>&1
check "WEYV_XCODEBUILD_SLOTS=0 exits 2" [ "$?" -eq 2 ]
WEYV_XCODEBUILD_SLOTS=two "$wrapper" -scheme Weyv > /dev/null 2>&1
check "non-numeric WEYV_XCODEBUILD_SLOTS exits 2" [ "$?" -eq 2 ]
WEYV_XCODEBUILD_WAIT_SECS=-1 "$wrapper" -scheme Weyv > /dev/null 2>&1
check "negative WEYV_XCODEBUILD_WAIT_SECS exits 2" [ "$?" -eq 2 ]
check "no build ran for bad configuration" [ "$(ls "$STUB_DIR" | wc -l | tr -d ' ')" -eq 0 ]

echo
echo "xcodebuild-slot tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
