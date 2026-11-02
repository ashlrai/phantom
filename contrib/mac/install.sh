#!/bin/bash
# install.sh (RQ-MACDISPATCH-RECONCILE): contrib/mac is the single source for the live Mac dispatcher. Diffs the repo
# files against ~/.ashlr-runs/bin and installs the ones that differ, each with a timestamped backup of the file it replaces.
#   contrib/mac/install.sh [--dry-run] [--json] [--bin DIR]
#     --dry-run  diff only: report what would change, write nothing
#     --json     one JSON object on stdout (human diff output is suppressed)
#     --bin DIR  install target (default $ASHLR_RUNS_BIN, then ~/.ashlr-runs/bin); it must already exist
# Exit 0 = ok (installed, or already identical), 1 = a step failed, 2 = usage. No network, no sudo, nothing else is touched.
# Live files are sha-pinned by Security (G1-CODE-PIN / GS_SHA): re-pin the sha256 values printed here before the next tick.
set -u
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FILES="dispatchd.py install-gate.py launch-gate.sh"
bin=${ASHLR_RUNS_BIN:-$HOME/.ashlr-runs/bin}; dry=0; json=0
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    --json) json=1 ;;
    --bin) [ $# -ge 2 ] || { echo "install.sh: --bin needs a directory" >&2; exit 2; }; bin=$2; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: install.sh [--dry-run] [--json] [--bin DIR]" >&2; exit 2 ;;
  esac
  shift
done
[ -d "$bin" ] || { echo "install.sh: $bin is not a directory" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -c1-64; }
say() { [ "$json" = 1 ] || echo "$@"; }
stamp=$(date +%Y%m%d-%H%M%S); rc=0; rows=""

for f in $FILES; do
  s=$src/$f; d=$bin/$f; status=; backup=; new=$(sha "$s"); old=
  if [ -L "$d" ]; then status=error; say "$f: refusing symlink destination $d"
  elif [ ! -e "$d" ]; then status=new
  elif [ -f "$d" ]; then
    old=$(sha "$d")
    if [ "$old" = "$new" ]; then status=unchanged; else status=changed; fi
  else status=error; say "$f: $d is not a regular file"; fi

  if [ "$status" = changed ]; then [ "$json" = 1 ] || diff -u "$d" "$s" | head -n 400; fi
  if [ "$dry" = 0 ] && { [ "$status" = changed ] || [ "$status" = new ]; }; then
    tmp=$d.tmp.$$
    mode=755
    if [ "$status" = changed ]; then
      backup=$d.bak-macdispatch-$stamp
      cp -p "$d" "$backup" || { status=error; backup=; }
    fi
    if [ "$status" != error ] && cp "$s" "$tmp" && chmod "$mode" "$tmp" && mv -f "$tmp" "$d" && [ "$(sha "$d")" = "$new" ]; then
      status=installed
    else
      rm -f "$tmp"; status=error
    fi
  fi
  [ "$status" = error ] && rc=1
  say "$f: $status${backup:+ (backup $backup)} sha256=$new"
  rows="$rows$f	$status	${old:-}	$new	${backup:-}
"
done

if [ "$json" = 1 ]; then
  ROWS=$rows BIN=$bin DRY=$dry STAMP=$stamp RC=$rc /usr/bin/python3 -I -c '
import json, os
files = []
for line in os.environ["ROWS"].splitlines():
    name, status, old, new, backup = line.split("\t")
    files.append({"file": name, "status": status, "old_sha256": old or None, "new_sha256": new, "backup": backup or None})
print(json.dumps({"schema": "macdispatch.install.v1", "bin": os.environ["BIN"], "dry_run": os.environ["DRY"] == "1",
                  "stamp": os.environ["STAMP"], "ok": os.environ["RC"] == "0", "files": files}, indent=2))'
fi
exit $rc
