#!/usr/bin/env bash
# Disk, battery, pause, and concurrency gates. Inputs are plain values so tests
# can run without pmset or a full disk.

router_df_available_kb() {
  local target=$1
  local kb
  kb=$(df -P -k "$target" 2>/dev/null | awk 'NR==2 { print $4 }')
  if [[ -z "$kb" ]]; then
    printf '0\n'
    return
  fi
  printf '%s\n' "$kb"
}

router_parse_pmset() {
  local text=$1
  local pct power
  power=unknown
  pct=$(printf '%s\n' "$text" | grep -Eo '[0-9]+%' | head -n 1 | tr -d '%' || true)
  if printf '%s\n' "$text" | grep -q 'Battery Power'; then
    power=battery
  elif printf '%s\n' "$text" | grep -q 'AC Power'; then
    power=ac
  fi
  if [[ -z "$pct" ]]; then
    if [[ "$power" == "battery" ]]; then
      pct=0
    else
      pct=100
    fi
  fi
  printf '%s %s\n' "$power" "$pct"
}

router_battery_line() {
  local text parsed
  if ! command -v pmset >/dev/null 2>&1; then
    printf 'unknown 100\n'
    return 0
  fi
  text=$(pmset -g batt 2>/dev/null || true)
  if [[ -z "$text" ]]; then
    printf 'unknown 100\n'
    return 0
  fi
  parsed=$(router_parse_pmset "$text")
  printf '%s\n' "$parsed"
}

# Arguments: pause free_kb min_free_kb power pct min_pct active max_jobs cli_busy
# Prints one token: ok, pause, disk, battery, jobs, or cli-busy.
router_gate_reason() {
  local pause=$1
  local free_kb=$2
  local min_free_kb=$3
  local power=$4
  local pct=$5
  local min_pct=$6
  local active=$7
  local max_jobs=$8
  local cli_busy=$9
  if [[ "$pause" == "1" ]]; then
    printf 'pause\n'
    return 0
  fi
  if [[ -z "$free_kb" || "$free_kb" -lt "$min_free_kb" ]]; then
    printf 'disk\n'
    return 0
  fi
  if [[ "$power" == "battery" ]]; then
    if [[ ! "$pct" =~ ^[0-9]+$ || "$pct" -lt "$min_pct" ]]; then
      printf 'battery\n'
      return 0
    fi
  fi
  if [[ "$active" -ge "$max_jobs" ]]; then
    printf 'jobs\n'
    return 0
  fi
  if [[ "$cli_busy" == "1" ]]; then
    printf 'cli-busy\n'
    return 0
  fi
  printf 'ok\n'
}
