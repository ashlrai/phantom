# ashlr-log-stream-supervisor. Invoked as:
#   /bin/sh -c SCRIPT ashlr-log-stream-supervisor LOG_BIN stream --style ndjson --predicate PREDICATE
# $1 is LOG_BIN; remaining args are passed through unchanged. The caller
# starts this in its own process group. Stdout and stderr are the capture
# fd: print nothing. If the parent dies (SIGKILL of the wrapper), this
# script notices via kill -0 / ppid and TERM-then-KILL the group.
logbin=$1
shift
[ -n "$logbin" ] || exit 2
"$logbin" "$@" &
child=$!
parent=$PPID
pgid=$$
cleaning=0
cleanup() {
  [ "$cleaning" = 1 ] && return 0
  cleaning=1
  trap '' TERM INT HUP
  kill -TERM "$child" 2>/dev/null
  kill -TERM -"$pgid" 2>/dev/null
  i=0
  while [ "$i" -lt 10 ]; do
    kill -0 "$child" 2>/dev/null || break
    sleep 0.05
    i=$((i + 1))
  done
  kill -KILL "$child" 2>/dev/null
  wait "$child" 2>/dev/null
  # SIGKILL the rest of the group last (this process may die here).
  kill -KILL -"$pgid" 2>/dev/null
  exit 1
}
trap 'cleanup' TERM INT HUP
while :; do
  if ! kill -0 "$parent" 2>/dev/null; then
    cleanup
  fi
  cur=$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')
  if [ "$cur" = "1" ]; then
    cleanup
  fi
  if ! kill -0 "$child" 2>/dev/null; then
    wait "$child"
    rc=$?
    trap '' TERM INT HUP
    exit "$rc"
  fi
  sleep 0.2
done
