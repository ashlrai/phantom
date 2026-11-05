import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { callPool, configurePool, readPoolConfig, serveNodeRpc, type NodeRpcRequest, type PoolConfig } from '../core/drive/nodes/pool-host.js';
import { callNodeSsh, sshApprovalStep, validSshHost } from '../core/drive/nodes/ssh.js';
import { probeNodeLanes, runNodeWorker } from '../core/drive/nodes/worker.js';

export function hasNodePool(): boolean { return existsSync(join(ashlrHome(), 'node-pool', 'config.json')); }

function flags(args: string[], values: string[], booleans: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (out.has(key)) throw new Error('Duplicate node pool flag');
    if (key === '--json' || booleans.includes(key)) out.set(key, '');
    else if (values.includes(key) && args[i + 1] && !args[i + 1]!.startsWith('--')) out.set(key, args[++i]!);
    else throw new Error('Invalid node pool flags; run phm node --help');
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
    if (verb === 'pool' || (verb === 'join' && args.includes('--primary'))) {
      const f = flags(args, ['--role', '--node', '--owner', '--primary', '--backup']);
      const role = verb === 'join' ? 'worker' : f.get('--role') as PoolConfig['role'];
      const config = configFrom(f, role);
      if (!validSshHost(config.primary) || !validSshHost(config.backup)) throw new Error('Use explicit team SSH config aliases for --primary and --backup');
      if (role === 'worker') {
        const lanes = probeNodeLanes();
        try {
          const result = callPool(config, 'join', ['--node', config.node, '--caps', lanes.join(',')]);
          if (result.demoted || !result.result['session']) throw new Error('Node registration held');
          // Registration proves the route, then release it so worker can establish its own session.
          callPool(config, 'leave', ['--node', config.node, '--session', String(result.result['session'])]);
          configurePool(config);
          emit({ schemaVersion: 1, registered: true, lanes, ...result.result });
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
    if (!config) throw new Error('Configure this Mac with phm node pool or phm node join --primary first');
    if (verb === 'rpc') {
      flags(args, []);
      emit(serveNodeRpc(config, await readRequest()));
      return 0;
    }
    if (verb === 'watch') {
      const f = flags(args, [], ['--once']);
      if (config.role === 'worker') throw new Error('Only primary and backup watch the runner heartbeat');
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
      const f = flags(args, ['--runner']);
      const runner = f.get('--runner');
      if (!runner) throw new Error('Worker requires --runner /absolute/host-owned-runner');
      emit({ schemaVersion: 1, ...await runNodeWorker(config, runner) });
      return 0;
    }
    const result = callPool(config, verb, args);
    emit({ schemaVersion: 1, command: verb, active: result.active, epoch: result.epoch, demoted: result.demoted, ...result.result });
    return result.demoted ? 1 : 0;
  } catch {
    emit({ schemaVersion: 1, error: 'Node pool operation refused or unavailable. Check configuration, local sign-in and SSH device approvals. Primary admission requires the backup witness.' });
    return 1;
  }
}
