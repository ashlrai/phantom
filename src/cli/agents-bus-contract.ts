import { busV2ContractSummary } from '../core/agents/bus-v2-schema.js';

const HELP = `ashlr agents bus contract [--json]

Print the Agent Bus v2 contract version, providers, body kinds, work statuses and
claim key forms. Read-only: no network, no store access. Spec: docs/AGENT-BUS.md ("v2").`;

/** `ashlr agents ...`. Only `bus contract` exists; help and bad usage never touch the bus. */
export async function runAgentsCli(
  args: string[],
  out: (text: string) => void = console.log,
  err: (text: string) => void = console.error,
): Promise<number> {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { out(HELP); return 0; }
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest.length !== 2 || rest[0] !== 'bus' || rest[1] !== 'contract' || args.length - rest.length > 1) {
    err(json ? JSON.stringify({ error: 'invalid-argument' }) : HELP);
    return 2;
  }
  const c = busV2ContractSummary();
  if (json) { out(JSON.stringify(c)); return 0; }
  out([
    `Agent Bus contract ${c.schemaVersion}`,
    `providers:    ${c.providers.join(', ')}`,
    `body kinds:   ${c.bodyKinds.join(', ')}`,
    `work status:  ${c.workStatuses.join(', ')}`,
    `wake kinds:   ${c.wakeKinds.join(', ')}`,
    `claim keys:   ${c.claimKeyForms.join('  ')}`,
    `lease ms:     ${c.claimLeaseMs.min}..${c.claimLeaseMs.max}`,
    'Claims coordinate; they grant no execution authority.',
  ].join('\n'));
  return 0;
}
