#!/bin/bash
# launch.sh JOB REPO POOL [TIER]; prompt on stdin. See INSTALL.md.
set -euo pipefail
unset NODE_OPTIONS NODE_PATH OPENSSL_CONF ELECTRON_RUN_AS_NODE
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
exec python3 "$SCRIPT_DIR/bridge.py" launch "$@"
