import { NODE_FLEET_USAGE, NODE_FLEET_VERBS, nodeFleetVerbUsage } from './node-fleet-usage.js';

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

const NODE_POOL_HEADER = 'Multi-Mac pool (explicit team SSH aliases only):';
const NODE_HELP_POINTER = 'All node commands: phm node --help';

/** The non-fleet node commands, one line each, exactly as `phm node --help`
 * lists them. Per-verb help shows only the matching lines, so the two can
 * never drift apart. */
const NODE_EXTRA_USAGE = `phm node pool --role primary|backup --node <id> --owner <scope> --primary <alias> --backup <alias> --json
phm node join [--node <id>] --owner <scope> --primary <alias> --backup <alias> --json
phm node join --json (repeat on an already configured Mac)
phm node watch [--once] --json
phm node worker --runner /absolute/host-owned-runner [--light] --json
phm node run-once [--json] < request.json (reviewed runner stdin endpoint)
phm node light restock [--apply] --json (bounded muse slice; preview by default)
phm node light status --json (observed completions)
phm node light run (fixed recipe runner stdin protocol)
phm node rpc --json (SSH stdin endpoint)
phm node lanes [--json] (local oMLX lane plan: model pick, caps, backoff)
phm node capacity [--node <id>] [--out <file>] [--previous <file>] [--json] (measured agents runnable now per harness)
phm node measure [--json] (print the measured --capacity sample for phm node beat)
phm node route --capacity <file>... --costs <file> --jobs <file> [--outcomes <file>] [--outcomes-ledger] [--runs-dir <dir>] [--nodes <file>] [--exhausted <p,p>] [--json] (node, provider, model scoring; --outcomes-ledger derives lane merge tallies from metrics/jobs.jsonl)
phm node self-update [--owner <scope>] [--target <x.y.z>] [--json] (plan only: per-node phm version drift)
phm node bridge [--owner <scope>] [--apply] [--json] (ready.tsv rows that would offload to nodes and why; dry run by default)`;

/** Usage lines for the given extra verbs, in command-list order. */
function extraUsageLines(...verbs: string[]): string {
  return NODE_EXTRA_USAGE.split('\n')
    .filter(line => verbs.some(verb => line.startsWith(`phm node ${verb} `)))
    .join('\n');
}

/** The pool enrollment cluster: config, join, watch, worker and the runner
 * stdin endpoints — the commands a multi-Mac setup runs together. */
const NODE_POOL_USAGE = `${NODE_POOL_HEADER}\n${extraUsageLines('pool', 'join', 'watch', 'worker', 'run-once', 'rpc')}`;

/**
 * Help scoped to the verb the user asked about, so `phm node join --help`
 * leads with join's usage instead of the whole command list. Returns null for
 * bare or unknown verbs, which keep the full list. Usage texts that live in
 * the delegated modules are imported lazily: `phm node --help` itself never
 * loads them.
 */
async function scopedNodeHelp(
  verb: string | undefined,
  args: string[],
  fleetVerb: (typeof NODE_FLEET_VERBS)[number] | undefined,
): Promise<string | null> {
  if (!verb || verb.startsWith('-')) return null;
  const pointer = `\n\n${NODE_HELP_POINTER}`;
  if (verb === 'join' && (args.includes('--primary') || args.includes('--backup'))) {
    return `${NODE_POOL_USAGE}${pointer}`;
  }
  if (fleetVerb) {
    const usage = nodeFleetVerbUsage(fleetVerb);
    if (usage) return `${usage}${pointer}`;
  }
  switch (verb) {
    case 'bootstrap':
      return `${USAGE}\nbootstrap is a planning stub: no VM creation, login, or registry calls.${pointer}`;
    case 'capacity':
    case 'route':
      return `${(await import('./node-capacity.js')).NODE_CAPACITY_USAGE}${pointer}`;
    case 'measure':
      return `${(await import('./node-measure.js')).NODE_MEASURE_USAGE}${pointer}`;
    case 'self-update':
      return `${(await import('./node-self-update.js')).SELF_UPDATE_USAGE}${pointer}`;
    case 'pool':
    case 'watch':
    case 'worker':
    case 'run-once':
    case 'rpc':
      return `${NODE_POOL_USAGE}${pointer}`;
    case 'light':
    case 'lanes':
      return `${extraUsageLines(verb)}${pointer}`;
    default:
      return null;
  }
}

export async function cmdNode(args: string[]): Promise<number> {
  if (args[0] === 'run-once' && !args.includes('--help') && !args.includes('-h')) {
    return (await import('./node-run-once.js')).cmdNodeRunOnce(args.slice(1));
  }
  if (args[0] === 'light' && !args.includes('--help') && !args.includes('-h')) {
    return (await import('./node-light.js')).cmdNodeLight(args.slice(1));
  }
  // Only first pool enrollment (`--primary`) must bypass the standalone parser:
  // --primary/--backup are not node-fleet flags. Every other join form — bare,
  // --json-only or explicit — reaches cmdNodeFleet, which delegates to the pool
  // only when a pool config exists and otherwise answers with the standalone
  // registry's own usage error.
  if (!args.includes('--help') && !args.includes('-h') &&
      (['pool', 'rpc', 'watch', 'worker'].includes(args[0] ?? '') || (args[0] === 'join' && args.includes('--primary')))) {
    return (await import('./node-pool.js')).cmdNodePool(args[0]!, args.slice(1));
  }
  if ((args[0] === 'capacity' || args[0] === 'route') && !args.includes('--help') && !args.includes('-h')) {
    const m = await import('./node-capacity.js');
    return args[0] === 'capacity' ? m.cmdNodeCapacity(args.slice(1)) : m.cmdNodeRoute(args.slice(1));
  }
  if (args[0] === 'measure' && !args.includes('--help') && !args.includes('-h')) {
    return (await import('./node-measure.js')).cmdNodeMeasure(args.slice(1));
  }
  if (args[0] === 'self-update' && !args.includes('--help') && !args.includes('-h')) {
    return (await import('./node-self-update.js')).cmdNodeSelfUpdate(args.slice(1));
  }
  if (args[0] === 'lanes' && !args.includes('--help') && !args.includes('-h')) {
    const extra = args.slice(1).filter(a => a !== '--json');
    if (extra.length || args.slice(1).filter(a => a === '--json').length > 1) {
      const lanesUsage = 'Usage: phm node lanes [--json]';
      if (args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, command: 'lanes',
        error: { code: 'usage', message: lanesUsage, fix: 'Run: phm node --help' } }));
      else console.error(lanesUsage);
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
    // `bridge` owns its --help text (it adds the dry-run note); every other
    // verb gets help scoped to what was asked. Bare and unknown verbs keep
    // the full command list.
    if (args[0] === 'bridge') return (await import('./node-bridge.js')).cmdNodeBridge(args.slice(1));
    const help = await scopedNodeHelp(args[0], args, fleetVerb);
    console.log(help ?? `${USAGE}\nbootstrap is a planning stub: no VM creation, login, or registry calls.\n\n${NODE_FLEET_USAGE}\n\n${NODE_POOL_HEADER}\n${NODE_EXTRA_USAGE}`);
    return 0;
  }
  // `beat --watch` / `renew --watch` are dispatcher-level keep-alives, not
  // fleet flags: each loops the ordinary verb (pool-aware through the same
  // dispatch) until stopped.
  if (fleetVerb === 'beat' && args.slice(1).includes('--watch')) {
    return (await import('./node-beat-watch.js')).cmdNodeBeatWatch(args.slice(1));
  }
  if (fleetVerb === 'renew' && args.slice(1).includes('--watch')) {
    return (await import('./node-renew-watch.js')).cmdNodeRenewWatch(args.slice(1));
  }
  if (args[0] === 'bridge') return (await import('./node-bridge.js')).cmdNodeBridge(args.slice(1));
  if (fleetVerb) return (await import('./node-fleet.js')).cmdNodeFleet(fleetVerb, args.slice(1));
  const json = args.includes('--json');
  const flags = args.slice(1);
  const bootstrap = args[0] === 'bootstrap';
  const dryRun = flags.includes('--dry-run') &&
    flags.every((flag) => flag === '--dry-run' || flag === '--json') &&
    new Set(flags).size === flags.length;
  if (bootstrap && dryRun) {
    const plan = nodeBootstrapPlan();
    if (json) console.log(JSON.stringify(plan));
    else {
      console.log('Node bootstrap plan (dry-run only; registry integration is a stub).');
      console.log(`Template: ${plan.template}`);
      plan.steps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
    }
    return 0;
  }
  // Only `bootstrap --dry-run` is a valid leftover. Bare `phm node`, stray
  // flags and unknown verbs get the command list, never bootstrap's contract.
  const error = bootstrap ? `Node bootstrap is dry-run only. ${USAGE}`
    : args.length === 0 || args[0]!.startsWith('-') ? 'Usage: phm node <command> [arguments] [--json]. Run: phm node --help for the command list.'
    : `Unknown node command '${args[0]}'. Run: phm node --help`;
  if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'node',
    error: { code: 'usage', message: error, fix: 'Run: phm node --help' },
    ...(bootstrap ? { executable: false } : {}) }));
  else console.error(error);
  return 2;
}
