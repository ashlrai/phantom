/** `ashlr fleet recheck` — one read-only verdict joining the runtime identity,
 * claims ledger, channel health and work board readers into four sections plus
 * an overall state. Text mode prints exactly five lines — RUNTIME, CLAIMS,
 * BRIDGE, TASK, OVERALL — each with as-of and source. Exit 0 only when every
 * section is VERIFIED, 1 otherwise. Read-only: nothing is written, sent or
 * dispatched, and the verdict grants no authority. */
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../core/fleet/fleet-recheck.js';

const usage = 'Usage: ashlr fleet recheck [--json]\n'
  + 'Prints one read-only verdict: RUNTIME|CLAIMS|BRIDGE|TASK|OVERALL lines with\n'
  + 'as-of and source, or the fleet.recheck.v1 object with --json. Exit 0 only\n'
  + 'when all four sections verify; 1 otherwise; 2 on bad arguments.';

function num(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function line(label: string, state: string, asOf: string, source: string, detail: string): string {
  return `${label} ${state} as-of=${asOf} source=${source} ${detail}`;
}

function textLines(recheck: FleetRecheck): string[] {
  const { runtime, claims, bridge, task } = recheck.sections;
  const channel = (name: 'slack' | 'imessage'): string => {
    const view = bridge.channels.find(c => c.channel === name);
    return `${name}=${view === undefined ? 'absent' : `${view.state}${view.runtimeHost === null ? '' : `@${view.runtimeHost}`}`}`;
  };
  const pick = task.task;
  return [
    line('RUNTIME', runtime.state, runtime.asOf, runtime.source,
      `host=${runtime.host} tailnet=${runtime.tailnetName} installed=${runtime.installedVersion} source-version=${runtime.sourceVersion} `
      + `fleet-state-age=${runtime.fleetState.ageSeconds} stale=${runtime.fleetState.stale} missing=${runtime.missing[0] ?? 'none'}`),
    line('CLAIMS', claims.state, claims.asOf, claims.source,
      `active=${num(claims.active)} expired=${num(claims.expiredClaims)} top=${claims.top.length} missing=${claims.missing[0] ?? 'none'}`),
    line('BRIDGE', bridge.state, bridge.asOf, bridge.source,
      `${channel('slack')} ${channel('imessage')} missing=${bridge.missingBridge ?? 'none'}`),
    line('TASK', task.state, task.asOf, task.source,
      `id=${pick?.id ?? 'none'} state=${pick?.state ?? 'none'} owner=${pick?.owner ?? 'none'} `
      + `claim=${pick?.claimReceipt ?? 'none'} missing=${task.missing[0] ?? 'none'}`),
    line('OVERALL', recheck.overall.state, recheck.asOf, 'fleet-recheck',
      `missing=${recheck.overall.missing.length} first=${recheck.overall.missing[0] ?? 'none'}`),
  ];
}

export async function cmdFleetRecheck(args: string[], deps: FleetRecheckDeps = {}): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !json) { json = true; continue; }
    console.error(usage);
    return 2;
  }
  const recheck = await readFleetRecheck(deps);
  if (json) console.log(JSON.stringify(recheck, null, 2));
  else for (const l of textLines(recheck)) console.log(l);
  return recheck.overall.state === 'VERIFIED' ? 0 : 1;
}
