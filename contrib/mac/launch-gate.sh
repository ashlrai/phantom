# launch-gate.sh (RQ-MACDISPATCH-RECONCILE): source this from the pinned launch.sh before the agent starts, so every
# npm ci / pnpm install / bun install the agent runs takes the fleet-wide install-gate.py semaphore (RQ-LOADGATE-1):
#   . "${ASHLR_RUNS_BIN:-$HOME/.ashlr-runs/bin}/launch-gate.sh"
# Sourced, not executed: it only prefixes PATH. Fails open (no gate, launch continues) if the shims cannot be written.
_lg_bin="${ASHLR_RUNS_BIN:-$HOME/.ashlr-runs/bin}"
_lg_shims="${ASHLR_RUNS_DIR:-$HOME/.ashlr-runs}/install-shims"
if [ -f "$_lg_bin/install-gate.py" ] && /usr/bin/python3 "$_lg_bin/install-gate.py" --shims "$_lg_shims" >/dev/null 2>&1; then
  PATH="$_lg_shims:$PATH"; export PATH
fi
unset _lg_bin _lg_shims
