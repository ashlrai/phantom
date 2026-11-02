/** Planning only. No provisioning, host inspection, credentials, or registry I/O. */
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
const MEMBERSHIP_USAGE = 'Usage: phm node join [--name <id>] [--owner person|team|org:<id>] [--json] | node status [--json] | node leave [--json]';

/** join / status / leave: thin argv handling, logic in src/core/drive/nodes/join.ts. */
async function cmdNodeMembership(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const fail = (error: string, fix: string, code: number): number => {
    if (json) console.log(JSON.stringify({ error, fix }));
    else console.error(`error: ${error}\nfix: ${fix}`);
    return code;
  };
  const opts: { name?: string; owner?: string } = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    const key = arg === '--name' ? 'name' : arg === '--owner' ? 'owner' : null;
    if (!key || args[0] !== 'join' || args[i + 1] === undefined || args[i + 1]!.startsWith('--')) {
      return fail(`Unexpected argument "${arg}".`, MEMBERSHIP_USAGE, 2);
    }
    opts[key] = args[++i]!;
  }
  const core = await import('../core/drive/nodes/join.js');
  try {
    if (args[0] === 'heartbeat-run') { await core.runHeartbeat(); return 0; }
    const result = args[0] === 'join' ? core.nodeJoin(opts) : args[0] === 'status' ? core.nodeStatus() : core.nodeLeave();
    if (json) { console.log(JSON.stringify(result)); return 0; }
    const r = result as Record<string, unknown>;
    if (args[0] === 'leave') console.log(r['action'] === 'left' ? `Left the fleet as ${String(r['nodeId'])}.` : 'This machine is not joined; nothing to do.');
    else if (r['state'] === 'live') {
      const o = r['owner'] as { kind: string; id: string };
      console.log(`${args[0] === 'join' ? (r['action'] === 'joined' ? 'Joined' : 'Already joined') : 'Live'}: ${String(r['nodeId'])} (owner ${o.kind}:${o.id}, gh ${String(r['ghUser'])}), leader ${String(r['leader'] ?? 'none')}, ${(r['peers'] as unknown[]).length} node(s) registered.`);
    } else console.log(`Not live (${String(r['state'])}). ${String(r['fix'])}`);
    return 0;
  } catch (err) {
    if (err instanceof core.NodeJoinError) return fail(err.message, err.fix, 1);
    return fail(err instanceof Error ? err.message : String(err), 'Run `phm node status` to inspect the registry, then retry.', 1);
  }
}

export async function cmdNode(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\nPlanning stub only. No VM creation, login, or registry calls.\n${MEMBERSHIP_USAGE}\nMembership reuses this machine's gh login; no token is copied, stored or sent.`);
    return 0;
  }
  if (args[0] === 'join' || args[0] === 'status' || args[0] === 'leave' || args[0] === 'heartbeat-run') return cmdNodeMembership(args);
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
