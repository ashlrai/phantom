import { cmdAgents } from './agents.js';
import { busV2ContractSummary } from '../core/agents/bus-v2-schema.js';

import { CHANNEL_IDS } from '../core/agents/channel-policy.js';

const HELP = `ashlr agents list|show <id>|validate <id>|versions <id> [--json]
ashlr agents bus contract [--json]
ashlr agents bus channels list [--json]
ashlr agents bus channels test <id> [--json]

Profile verbs read ~/.phantom/agents (docs/AGENT-PROFILES.md).

Print the Agent Bus v2 contract version, providers, body kinds, work statuses and
claim key forms. Read-only: no network, no store access. Spec: docs/AGENT-BUS.md ("v2").`;

/** `ashlr agents ...`: profile verbs and `bus` inspection; help and bad usage never touch the bus or network. */
export async function runAgentsCli(
  args: string[],
  out: (text: string) => void = console.log,
  err: (text: string) => void = console.error,
): Promise<number> {
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { out(HELP); return 0; }
  if (['list', 'show', 'validate', 'versions'].includes(args[0]!)) return cmdAgents(args, out, err);
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (args.length - rest.length <= 1 && rest[0] === 'bus' && rest[1] === 'channels') {
    if (rest.length === 3 && rest[2] === 'list') {
      const result = { dryRun: true, channels: CHANNEL_IDS.map((id) => ({ id, adapterRegistered: false })) };
      out(json ? JSON.stringify(result) : result.channels.map((c) => `${c.id}: no adapter registered`).join('\n'));
      return 0;
    }
    if (rest.length === 4 && rest[2] === 'test' && CHANNEL_IDS.some((id) => id === rest[3])) {
      const result = { id: rest[3], dryRun: true, status: 'refused', reason: 'No channel adapter is registered.' };
      out(json ? JSON.stringify(result) : `${result.id}: ${result.reason}`);
      return 0;
    }
  }
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
