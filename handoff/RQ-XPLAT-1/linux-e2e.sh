#!/bin/sh
# Run on a disposable Linux box with this worktree copied there.
# Usage: sh handoff/RQ-XPLAT-1/linux-e2e.sh /path/to/phantom
set -eu
repo=${1:-.}
cd "$repo"
[ "$(uname -s)" = Linux ] || { echo 'Run this script inside a Linux box or container.' >&2; exit 2; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<15))process.exit(1)'
[ -d node_modules ] || { echo 'Install Linux dependencies first: npm ci --ignore-scripts --no-audit --no-fund' >&2; exit 2; }
task_home=$(mktemp -d)
trap 'rm -rf "$task_home"' EXIT HUP INT TERM
env HOME="$task_home" USERPROFILE="$task_home" npm run test:ci -- --maxWorkers=1 --fileParallelism=false \
  test/install-user-scripts.test.ts test/install-release-posix.test.ts \
  test/m93.daemon-service.test.ts test/m20.onboard.test.ts test/os-sensors.test.ts
env HOME="$task_home" USERPROFILE="$task_home" node --import tsx --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readOsSensors } from './src/core/resources/os-sensors.ts';
import { generateServiceDefinition } from './src/core/daemon/service.ts';
const snapshot = await readOsSensors();
assert.equal(snapshot.platform, 'linux');
assert.equal(snapshot.schema, 'os.sensors.v1');
assert.ok(snapshot.loadPerCore.value !== null);
assert.ok(snapshot.swapUsedBytes.value !== null);
const definition = generateServiceDefinition({ platform: 'linux', homeDir: process.env.HOME });
assert.ok(definition.registerArgs.includes('--user'));
assert.ok(definition.content.includes('ExecStart='));
console.log(JSON.stringify({ evidence: 'linux-host-sensors-and-service-generation', snapshot }));
NODE
echo 'PASS Linux fixtures and real /proc observations. Native systemd activation remains unverified in containers without a user bus.'
