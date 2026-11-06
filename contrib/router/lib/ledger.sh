#!/usr/bin/env bash
# Ledger lines and best-effort usage parsing. JSON is written by router_io.cjs.

router_usage_summary() {
  local now=$1
  node "$ROUTER_IO" parse-usage --now "$now"
}

router_append_job() {
  local ledger=$1
  shift
  node "$ROUTER_IO" append-job "$ledger" "$@"
}
