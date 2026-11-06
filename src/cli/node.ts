import { NODE_FLEET_USAGE, NODE_FLEET_VERBS } from './node-fleet-usage.js';

/** `bootstrap` is planning only: no provisioning, host inspection, credentials, or registry I/O.
 * The other verbs (see node-fleet.ts) are the local node registry, router and job leases.
 */
export function nodeBootstrapPlan() {
  return {
    schemaVersion: 1,
    dryRun: true,
    executable: false,
    registry: { status: 'stub', dependency: 'RQ-DRIVER-NODES-1-LEASE' },
    template: 'contrib/nodes/lima/phantom-node.yaml',
    steps: [
      'Check MEMORY P0: reserve at least 30% host RAM after guest RAM and measured overhead; refuse stale or unknown capacity.',
      'Check disk: reserve the full 40 GiB guest disk plus image/cache space while keeping at least 20 GB host free; keep 20 GB guest free before jobs.',
      'Validate the template with limactl validate in a dedicated, clean LIMA_HOME; inspect the effective configuration for host mounts and overrides.',
      'After capacity checks, manually create one persistent Linux VM per node; no VM is created by this command.',
      'Install a reviewed Phantom build and Node >=22.15.0 inside the guest; transfer only reviewed source, never host auth files or secrets.',
      'Complete supported vendor device-code login inside the guest via RQ-PHM-CONNECT-WIZARD; unsupported vendors remain disconnected. Never touch host ~/.codex.',
      'Registry join (STUB): submit node identity, Linux architecture, capabilities and available capacity to the NODES-1 registry through its approved enrollment flow.',
      'Lease handshake (STUB): await registry acceptance, obtain a fenced lease and publish heartbeats; advertise ready only after acceptance and health checks.',
      'Before each job recheck capacity and lease validity; on Stop, expired lease or lost registry connectivity, stop admission and fence running work. Never self-renew offline.',
    ],
  } as const;
}

const USAGE = 'Usage: phm node bootstrap --dry-run [--json]';

export async function cmdNode(args: string[]): Promise<number> {
  if (!args.includes('--help') && !args.includes('-h') &&
      (['pool', 'rpc', 'watch', 'worker'].includes(args[0] ?? '') || (args[0] === 'join' && args.includes('--primary')))) {
    return (await import('./node-pool.js')).cmdNodePool(args[0]!, args.slice(1));
  }
  if (args[0] === 'lanes' && !args.includes('--help') && !args.includes('-h')) {
    const extra = args.slice(1).filter(a => a !== '--json');
    if (extra.length || args.slice(1).filter(a => a === '--json').length > 1) {
      console.error('Usage: phm node lanes [--json]');
      return 2;
    }
    const { localLanePlan, localLaneConfigPath } = await import('../core/drive/nodes/local-model-caps.js');
    const probe = localLanePlan();
    const out = { schemaVersion: 1, command: 'lanes', configPath: localLaneConfigPath(), ...probe };
    if (args.includes('--json')) console.log(JSON.stringify(out));
    else {
      const p = probe.plan;
      console.log(`config: ${probe.config ? `enabled=${probe.config.enabled}` : probe.configError ? `invalid (${probe.configError})` : `absent (${out.configPath})`}`);
      console.log(`ram: ${(p.ramBytes / 1024 ** 3).toFixed(0)} GB, envelope ${(p.budgetBytes / 1024 ** 3).toFixed(1)} GB`);
      if (p.model) console.log(`model: ${p.model.id} (${p.model.repo}) ctx=${p.model.servedContext} tiers=${p.model.tiers.join('+') || 'none'} slots=${p.slots}`);
      console.log(`caps: ${p.suggestedCaps || 'none'}${p.backoff ? ` — held: ${p.backoffReason}` : ''}`);
      for (const r of p.rejected) console.log(`  rejected ${r.id}: ${r.reason}`);
    }
    return 0;
  }
  const fleetVerb = NODE_FLEET_VERBS.find(verb => verb === args[0]);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\nbootstrap is a planning stub: no VM creation, login, or registry calls.\n\n${NODE_FLEET_USAGE}\n\nMulti-Mac pool (explicit team SSH aliases only):
phm node pool --role primary|backup --node <id> --owner <scope> --primary <alias> --backup <alias> --json
phm node join --node <id> --owner <scope> --primary <alias> --backup <alias> --json
phm node watch [--once] --json
phm node worker --runner /absolute/host-owned-runner --json
phm node rpc --json (SSH stdin endpoint)
phm node lanes [--json] (local oMLX lane plan: model pick, caps, backoff)`);
    return 0;
  }
  if (fleetVerb) return (await import('./node-fleet.js')).cmdNodeFleet(fleetVerb, args.slice(1));
  const json = args.includes('--json');
  const flags = args.slice(1);
  if (args[0] !== 'bootstrap' || !flags.includes('--dry-run') ||
      flags.some((flag) => flag !== '--dry-run' && flag !== '--json') ||
      new Set(flags).size !== flags.length) {
    const error = `Node bootstrap is dry-run only. ${USAGE}`;
    if (json) console.log(JSON.stringify({ error, executable: false }));
    else console.error(error);
    return 2;
  }
  const plan = nodeBootstrapPlan();
  if (json) console.log(JSON.stringify(plan));
  else {
    console.log('Node bootstrap plan (dry-run only; registry integration is a stub).');
    console.log(`Template: ${plan.template}`);
    plan.steps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
  }
  return 0;
}
