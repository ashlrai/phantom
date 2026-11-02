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

export async function cmdNode(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\nPlanning stub only. No VM creation, login, or registry calls.`);
    return 0;
  }
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
