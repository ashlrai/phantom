import { defaultPoolReachDeps, readPoolReach, type PoolReachDeps } from '../core/fleet/pool-reach.js';

const usage = 'Usage: ashlr fleet pool-reach [--json]';

/** Print sanitized, read-only evidence of whether the pool primary and backup are reachable tailnet peers now. */
export async function cmdFleetPoolReach(args: string[], deps: PoolReachDeps = defaultPoolReachDeps()): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else { console.error(usage); return 2; }
  }
  // readPoolReach copies a thrown config message into reasons[]; swap it for
  // the fixed string the HTTP route uses so private diagnostics never print.
  const status = readPoolReach({
    ...deps,
    readConfig: () => {
      try { return deps.readConfig(); } catch { throw new Error('pool config unreadable'); }
    },
  });
  if (json) { console.log(JSON.stringify(status, null, 2)); return 0; }
  const lines = [
    `self ${status.self} role ${status.role} as of ${status.asOf}`,
    ...status.hosts.map(host => {
      const state = host.online === true ? 'online' : host.online === false ? 'offline' : 'unknown';
      const age = typeof host.ageSeconds === 'number' ? `${host.ageSeconds}s ago` : 'unknown';
      return `${host.slot} ${host.alias} ${state} last seen ${age}${host.isSelf ? ' (this computer)' : ''}`;
    }),
    ...status.reasons.map(reason => `reason: ${reason}`),
  ];
  console.log(lines.join('\n'));
  return 0;
}
