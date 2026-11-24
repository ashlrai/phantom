import { homedir } from 'node:os';
import { join } from 'node:path';
import { orchestrateFleet, type OrchestrationOptions } from '../core/fleet/orchestrate.js';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { readChiefOfStaffSnapshot, type FleetChiefOfStaffDeps } from './fleet-chief-of-staff.js';
import { readEnvironmentCredential } from '../core/integrations/secrets.js';
import { ownerThreadOptions } from './comms-owner-thread.js';

const usage = 'Usage: phm fleet orchestrate [--snapshot <path|auto>] [--top <1..8>] [--apply] [--json]\nOne advisory cycle; preview by default. Apply delegates through the authenticated peer bus and records a desktop owner-thread brief. Existing dispatch executes jobs.';
export async function cmdFleetOrchestrate(args: string[], deps: FleetChiefOfStaffDeps & Omit<OrchestrationOptions, 'now'> = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { out(usage); return 0; }
  let path = 'auto', top = 3, apply = false, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) { err(usage); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--snapshot' && args[i + 1] && !args[i + 1].startsWith('-')) path = args[++i];
    else if (arg === '--top' && /^[1-8]$/.test(args[i + 1] ?? '')) top = Number(args[++i]);
    else { err(usage); return 2; }
  }
  try {
    const { snapshot, sources } = await readChiefOfStaffSnapshot(path, deps);
    const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    const ledger = await readSource(join(root, 'metrics/jobs.jsonl'), 16 * 1024 * 1024, false);
    const events = ledger.state !== 'healthy' ? null : ledger.text.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line) as unknown; } catch { return null; }
    });
    const result = await orchestrateFleet({ snapshot, events, top, apply,
      sourcesHealthy: !Object.values(sources).some(s => s === 'unavailable' || s === 'degraded') }, {
      ...deps, directory: deps.directory ?? join(root, 'queue/specialists'),
      now: deps.now ? () => deps.now!().getTime() : undefined,
      session: deps.session ?? (apply ? { lane: process.env.PHM_AGENTNET_LANE ?? '',
        sessionId: process.env.PHM_AGENTNET_SESSION_ID ?? '', token: readEnvironmentCredential('PHM_AGENTNET_SESSION_TOKEN') ?? '' } : undefined),
      owner: deps.owner ?? (apply ? ownerThreadOptions({}) : undefined),
    });
    out(json ? JSON.stringify({ ...result, sources }) : result.brief);
    return result.ok ? 0 : 1;
  } catch { err('orchestrate: evidence, host context or coordination state unavailable'); return 1; }
}
