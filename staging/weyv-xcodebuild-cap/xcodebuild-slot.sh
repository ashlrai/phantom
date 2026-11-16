#!/bin/bash
# xcodebuild-slot.sh: run one xcodebuild under a shared N-slot lock, at lower CPU priority.
#
# Six or more concurrent xcodebuild runs drove load1 to 133 on an 18-core Mac
# (2026-11-16, 15:30 ET). This wrapper lets at most WEYV_XCODEBUILD_SLOTS builds
# run at once. Each slot is a lockf(1) lock, and the kernel releases a lock when
# its holder exits, so a crashed build cannot leave a stale slot behind.
#
# Usage: xcodebuild-slot.sh <xcodebuild arguments...>
#
# Environment (all optional):
#   WEYV_XCODEBUILD_SLOTS      builds allowed at once                      (default 2)
#   WEYV_XCODEBUILD_SLOT_DIR   directory for the slot lock files           (default $TMPDIR/weyv-xcodebuild-slots)
#   WEYV_XCODEBUILD_WAIT_SECS  seconds to wait for a free slot, then exit 75 (default 3600)
#   WEYV_BUILD_NICE            nice increment for the build                (default 10)
#   WEYV_XCODEBUILD_BIN        xcodebuild executable; tests point this at a stub
#
# Exit status: the build's own status; 75 (EX_TEMPFAIL) when no slot freed up in
# time; 2 for bad usage or a failed lock.
#
# The build runs in the foreground, so a TERM or INT sent to this process group
# (a terminal, or launchd stopping the job) reaches xcodebuild directly.

set -u

slots="${WEYV_XCODEBUILD_SLOTS:-2}"
slot_dir="${WEYV_XCODEBUILD_SLOT_DIR:-${TMPDIR:-/tmp}/weyv-xcodebuild-slots}"
wait_secs="${WEYV_XCODEBUILD_WAIT_SECS:-3600}"
nice_by="${WEYV_BUILD_NICE:-10}"
xcodebuild_bin="${WEYV_XCODEBUILD_BIN:-xcodebuild}"

LOCKF=/usr/bin/lockf
NICE=/usr/bin/nice

die() {
  echo "xcodebuild-slot: $*" >&2
  exit 2
}

is_uint() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_uint "$slots" && [ "$slots" -ge 1 ] || die "WEYV_XCODEBUILD_SLOTS must be a positive integer"
is_uint "$wait_secs" || die "WEYV_XCODEBUILD_WAIT_SECS must be a whole number of seconds"
is_uint "$nice_by" || die "WEYV_BUILD_NICE must be a whole number"
[ "$#" -ge 1 ] || die "no xcodebuild arguments given"
[ -x "$LOCKF" ] || die "$LOCKF not found; this wrapper needs macOS lockf(1)"
mkdir -p "$slot_dir" || die "cannot create $slot_dir"

# Sets $status and returns 0 if the build ran in slot $1; returns 1 if the slot was busy.
#
# lockf -t 0 fails at once with exit 75 when the slot is held. The marker is
# created from inside the lock, so "marker exists" proves this attempt got the
# slot and that the exit status belongs to the build, not to lockf.
try_slot() {
  local slot="$1"
  shift
  local marker="$slot_dir/.started.$$.$slot"
  rm -f "$marker"
  "$LOCKF" -k -t 0 "$slot_dir/slot-$slot.lock" \
    /bin/sh -c 'touch "$1"; shift; exec "$@"' sh "$marker" \
    "$NICE" -n "$nice_by" "$xcodebuild_bin" "$@"
  status=$?
  if [ -e "$marker" ]; then
    rm -f "$marker"
    return 0
  fi
  rm -f "$marker"
  if [ "$status" -eq 75 ]; then
    return 1
  fi
  echo "xcodebuild-slot: lockf failed on $slot_dir/slot-$slot.lock (exit $status)" >&2
  exit 2
}

waited=0
while :; do
  slot=1
  while [ "$slot" -le "$slots" ]; do
    if try_slot "$slot" "$@"; then
      exit "$status"
    fi
    slot=$((slot + 1))
  done
  if [ "$waited" -ge "$wait_secs" ]; then
    echo "xcodebuild-slot: no free slot of $slots after ${wait_secs}s; giving up" >&2
    exit 75
  fi
  sleep 1
  waited=$((waited + 1))
done
