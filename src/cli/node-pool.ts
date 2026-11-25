import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { validId } from '../core/drive/nodes/state.js';
import { readNodeCapacity } from '../core/drive/nodes/capacity.js';
import { ashlrHome } from '../core/cloud/store.js';
import { callPool, configurePool, readPoolConfig, serveNodeRpc, type NodeRpcRequest, type PoolConfig } from '../core/drive/nodes/pool-host.js';
import { callNodeSsh, sshApprovalStep, validSshHost } from '../core/drive/nodes/ssh.js';
import { probeNodeLanes, runNodeWorker } from '../core/drive/nodes/worker.js';

export function hasNodePool(): boolean { return existsSync(join(ashlrHome(), 'node-pool', 'config.json')); }

/** Local argument and identity refusals: fixed operator-facing strings, safe to show verbatim. */
class PoolUsageError extends Error {}

/** Missing pool config is an operational state, not bad usage: name it truthfully. */
class PoolNotConfigured extends Error {}

/** True when this Mac's standalone registry already holds node records. */
function standaloneNodesPresent(): boolean {
  try {
    const state = JSON.parse(readFileSync(join(ashlrHome(), 'nodes', 'nodes.json'), 'utf8')) as { nodes?: unknown } | null;
    const nodes = state?.nodes;
    return Array.isArray(nodes) && nodes.length > 0;
  } catch { return false; }
}

/** The no-config refusal names the real state instead of the generic pool mask. */
function poolConfigMissing(): string {
  return standaloneNodesPresent()
    ? 'This Mac uses the standalone node registry, which has no pool witness; this command runs only inside a configured multi-Mac pool.'
    : 'This Mac has no node pool configuration; this command runs only inside a configured multi-Mac pool.';
}

function flags(args: string[], values: string[], booleans: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (out.has(key)) throw new PoolUsageError('Duplicate node pool flag');
    if (key === '--json' || booleans.includes(key)) out.set(key, '');
    else if (values.includes(key) && args[i + 1] && !args[i + 1]!.startsWith('--')) out.set(key, args[++i]!);
    else throw new PoolUsageError('Invalid node pool flags; run phm node --help');
  }
  return out;
}
function configFrom(f: Map<string, string>, role: PoolConfig['role']): PoolConfig {
  return { role, node: f.get('--node') ?? '', owner: f.get('--owner') ?? '', primary: f.get('--primary') ?? '', backup: f.get('--backup') ?? '' };
}
async function readRequest(): Promise<NodeRpcRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 128 * 1024) throw new Error('Node RPC request too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as NodeRpcRequest;
}

export async function cmdNodePool(verb: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (value: unknown) => console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  try {
    if (verb === 'pool' || (verb === 'join' && !args.some(a => /^--(?:caps|slots)(?:=|$)/.test(a)))) {
      const f = flags(args, [...(verb === 'pool' ? ['--role'] : []), '--node', '--owner', '--primary', '--backup']);
      const role = verb === 'join' ? 'worker' : f.get('--role') as PoolConfig['role'];
      const existing = verb === 'join' ? readPoolConfig() : null;
      const config = existing ?? configFrom(f, role);
      if (!existing && verb === 'join' && !f.has('--node')) config.node = hostname().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
      if (existing && ['--role', '--node', '--owner', '--primary', '--backup'].some(key => f.has(key) && f.get(key) !== existing[key.slice(2) as keyof PoolConfig])) throw new PoolUsageError('Join cannot change pool identity');
      if (!validSshHost(config.primary) || !validSshHost(config.backup)) throw new PoolUsageError('Use explicit team SSH config aliases for --primary and --backup');
      if (config.primary === config.backup || !validId(config.owner) || !validId(config.node)) throw new PoolUsageError('Invalid node pool identity');
      if (verb === 'pool' && config.role !== 'primary' && config.role !== 'backup') throw new PoolUsageError('phm node pool --role must be primary or backup');
      if (verb === 'join') {
        const capacity = readNodeCapacity();
        const lanes = probeNodeLanes();
        try {
          const result = callPool(config, 'join', ['--node', config.node, '--caps', lanes.join(','), '--slots', String(capacity.slots)]);
          if (result.demoted || !result.result['session']) throw new Error('Node registration held');
          // Registration proves the route, then release it so worker can establish its own session.
          callPool(config, 'leave', ['--node', config.node, '--session', String(result.result['session'])]);
          if (!existing) configurePool(config);
          emit({ schemaVersion: 1, registered: true, role: config.role, lanes, capacity, ready: !capacity.held && lanes.length > 0,
            next: 'phm node worker --runner /absolute/host-owned-runner --json', ...result.result });
          return 0;
        } catch {
          emit({ schemaVersion: 1, registered: false, approvalSteps: [sshApprovalStep(config.primary), sshApprovalStep(config.backup)] });
          return 1;
        }
      }
      configurePool(config);
      emit({ schemaVersion: 1, configured: true, role, approvalSteps: [sshApprovalStep(config.primary), sshApprovalStep(config.backup)] });
      return 0;
    }
    const config = readPoolConfig();
    if (!config) throw new PoolNotConfigured(poolConfigMissing());
    if (verb === 'rpc') {
      flags(args, []);
      emit(serveNodeRpc(config, await readRequest()));
      return 0;
    }
    if (verb === 'watch') {
      const f = flags(args, [], ['--once']);
      if (config.role === 'worker') throw new PoolUsageError('Only primary and backup watch the runner heartbeat');
      do {
        const envelope: NodeRpcRequest = { kind: config.role === 'primary' ? 'witness' : 'client',
          request: { origin: config.role, action: 'heartbeat' } };
        const result = config.role === 'primary' ? callNodeSsh(config.backup, envelope) : serveNodeRpc(config, envelope);
        // Witness snapshots contain private run state and are never printed.
        const reported = config.role === 'primary' ? (result as { reply: unknown }).reply : result;
        emit(reported);
        if (f.has('--once')) break;
        await new Promise(resolve => setTimeout(resolve, 5000));
      } while (!f.has('--once'));
      return 0;
    }
    if (verb === 'worker') {
      const f = flags(args, ['--runner'], ['--light']);
      const runner = f.get('--runner');
      if (!runner) throw new PoolUsageError('Worker requires --runner /absolute/host-owned-runner');
      emit({ schemaVersion: 1, ...await runNodeWorker(config, runner, f.has('--light')) });
      return 0;
    }
    const result = callPool(config, verb, args);
    emit({ schemaVersion: 1, command: verb, active: result.active, epoch: result.epoch, demoted: result.demoted, ...result.result,
      ...(verb === 'status' ? { capacity: readNodeCapacity() } : {}) });
    return result.demoted ? 1 : 0;
  } catch (error) {
    // Usage refusals name the actual problem; anything else (SSH, witness,
    // store, runner) stays masked behind the fixed pool message.
    if (error instanceof PoolUsageError) {
      emit({ schemaVersion: 1, command: verb, error: { code: 'usage', message: error.message, fix: 'Run: phm node --help' } });
      return 2;
    }
    if (error instanceof PoolNotConfigured) {
      emit({ schemaVersion: 1, command: verb, error: { code: 'error', message: error.message,
        fix: 'Configure this Mac with phm node join --owner <scope> --primary <alias> --backup <alias>, or use the standalone verbs (phm node --help).' } });
      return 1;
    }
    emit({ schemaVersion: 1, command: verb, error: { code: 'error',
      message: 'Node pool operation refused or unavailable. First join requires --owner <scope> --primary <alias> --backup <alias>. On configured Macs use phm node join --json. Check local sign-in and SSH approvals; primary admission requires the backup witness.',
      fix: 'Run: phm node --help' } });
    return 1;
  }
}
