import { runAgentsChat } from './agents-chat.js';
import { isAbsolute } from 'node:path';
import { cmdAgents } from './agents.js';
import { busV2ContractSummary } from '../core/agents/bus-v2-schema.js';
import { listChannelRegistry, probeRegisteredChannel } from '../core/agents/channel-registry.js';
import { CHANNEL_IDS, type ChannelId } from '../core/agents/channel-policy.js';
import { readFleetEdges } from '../core/fleet/fleet-edges.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { AGENTS_BUS_UNIFIED_HELP, AGENTS_BUS_UNIFIED_VERBS, runAgentsBusUnified } from './agents-bus-unified.js';

const HELP = `ashlr agents list|show <id>|validate <id>|versions <id> [--json]
ashlr agents chat list|read <outcome:id|run:id> --channel <channel> [--after <cursor>] [--limit <1-100>] [--from <agent>] [--exclude-from <agent>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--id <id>] [--in-reply-to <id>] [--json]
ashlr agents mesh status [--root <abs>] [--json]
ashlr agents edges [--json]
ashlr agents messages [--since 1h] [--before <10m|2h|1d|ISO>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--in-reply-to <id>] [--limit N] [--json]
ashlr agents conversations [--agent <name>] [--waiting] [--blocked] [--state <waiting|answered|blocked|done>] [--job <id>] [--waiting-on <name>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--limit <1..1024>] [--json]
ashlr agents roster [--principal <id>|--all-owners] [--json]
ashlr agents bus contract [--json]
ashlr agents bus channels list [--json]
ashlr agents bus channels test <id> [--root <abs>] [--json]
ashlr agents apps [<id> <verb>] [--json]  (docs/AGENT-APPS.md)
${AGENTS_BUS_UNIFIED_HELP}

Profile verbs read ~/.phantom/agents (docs/AGENT-PROFILES.md).
Print the Agent Bus v2 contract version, providers, body kinds, work statuses and
claim key forms. The contract command is read-only. channels list reports which
adapters are registered. channels test bus and channels test handoff record one
local probe in the private store. Other channels stay refused. No network.
Spec: docs/AGENT-BUS.md ("v2").`;

/** Contract print is read-only. Channel probes write only to the local bus store. */
export async function runAgentsCli(
  args: string[],
  out: (text: string) => void = console.log,
  err: (text: string) => void = console.error,
): Promise<number> {
  if (args[0] === 'chat') return runAgentsChat(args.slice(1), out, err);
  if (!args.length || ['help', '--help', '-h'].includes(args[0]!)) { out(HELP); return 0; }
  if (['list', 'show', 'validate', 'versions'].includes(args[0]!)) return cmdAgents(args, out, err);
  if (args[0] === 'apps') return (await import('./agents-apps.js')).runAgentsAppsCli(args.slice(1), out, err);
  if (args[0] === 'bus' && AGENTS_BUS_UNIFIED_VERBS.has(args.find((arg, i) => i > 0 && arg !== '--json') ?? '')) {
    return runAgentsBusUnified(args.slice(1), out, err);
  }
  const json = args.includes('--json');
  if (args.filter(arg => arg === '--json').length > 1) {
    err(json ? JSON.stringify({ error: 'invalid-argument' }) : HELP);
    return 2;
  }
  let root: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--root') {
      const value = args[i + 1];
      if (!value || !isAbsolute(value) || value.includes('\0')) {
        err(json ? JSON.stringify({ error: 'invalid-argument' }) : HELP);
        return 2;
      }
      root = value;
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  if (rest.length === 1 && rest[0] === 'edges' && root === undefined) {
    const result = readFleetEdges();
    out(JSON.stringify(sanitizePublicJson(result), null, json ? undefined : 2));
    return result.source === 'unavailable' ? 1 : 0;
  }
  if (rest.length === 2 && rest[0] === 'mesh' && rest[1] === 'status') {
    const { readAgentMesh } = await import('../core/agents/mesh.js');
    const result = readAgentMesh({ root });
    out(json ? JSON.stringify(result) : result.status !== 'ok' ? 'Mesh unavailable: ' + result.status : result.agents.map(row =>
      [row.address, row.lane, row.status, row.lastSeen === null ? 'unknown' : new Date(row.lastSeen).toISOString(),
        row.currentTask ?? '-'].join('  ')).join('\n') || 'No known agents.');
    return result.status === 'ok' ? 0 : 1;
  }
  if (rest[0] === 'bus' && rest[1] === 'channels') {
    if (rest.length === 3 && rest[2] === 'list' && root === undefined) {
      const channels = listChannelRegistry();
      const result = { dryRun: false, channels };
      out(json ? JSON.stringify(result) : channels.map(channel => `${channel.id}: ${channel.adapterRegistered ? 'adapter registered' : 'no adapter registered'}`).join('\n'));
      return 0;
    }
    if (rest.length === 4 && rest[2] === 'test' && CHANNEL_IDS.some(id => id === rest[3])) {
      const result = { id: rest[3], ...(await probeRegisteredChannel(rest[3] as ChannelId, root ? { root } : {})) };
      out(json ? JSON.stringify(result) : `${result.id}: ${result.reason}`);
      return 0;
    }
  }
  if (rest.length !== 2 || rest[0] !== 'bus' || rest[1] !== 'contract' || root !== undefined || args.filter(arg => arg !== '--json').length !== rest.length) {
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
