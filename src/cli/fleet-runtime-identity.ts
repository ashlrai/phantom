import { defaultRuntimeIdentityDeps, readRuntimeIdentity, type RuntimeIdentityDeps } from '../core/fleet/runtime-identity.js';

const usage = 'Usage: ashlr fleet runtime-identity [--json]';

/** Print sanitized, read-only evidence of which host and build is answering. */
export async function cmdFleetRuntimeIdentity(args: string[], deps: RuntimeIdentityDeps = defaultRuntimeIdentityDeps()): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else { console.error(usage); return 2; }
  }
  const id = readRuntimeIdentity(deps);
  if (json) { console.log(JSON.stringify(id, null, 2)); return 0; }
  const f = id.fleetState;
  const lines = [
    `host: ${id.host}`,
    `platform: ${id.platform}`,
    `asOf: ${id.asOf}`,
    `installedVersion: ${id.installedVersion}`,
    `sourceVersion: ${id.sourceVersion}`,
    `versionDrift: ${id.versionDrift}`,
    `fleetState.path: ${f.path}`,
    `fleetState.mtime: ${f.mtime}`,
    `fleetState.ageSeconds: ${f.ageSeconds}`,
    `fleetState.stale: ${f.stale}`,
    `tailnetName: ${id.tailnetName}`,
    ...id.reasons.map(reason => `reason: ${reason}`),
  ];
  console.log(lines.join('\n'));
  return 0;
}
