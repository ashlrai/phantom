import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { validCap, validId } from '../core/drive/nodes/state.js';
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
/** True when the pool already holds a live session under this node id. `status`
 * is a read verb, so it answers even while the witness is demoted; any transport
 * failure reads as "not live" and the join attempt then reports the real
 * unreachable error itself. */
function poolNodeLive(config: PoolConfig): boolean {
  try {
    const view = callPool(config, 'status', []).result as { nodes?: unknown };
    return Array.isArray(view.nodes) && view.nodes.some(entry =>
      typeof entry === 'object' && entry !== null &&
      (entry as { nodeId?: unknown }).nodeId === config.node &&
      (entry as { live?: unknown }).live === true);
  } catch { return false; }
}
async function readRequest(): Promise<NodeRpcRequest | { kind: 'replica'; report?: unknown }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 128 * 1024) throw new Error('Node RPC request too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function cmdNodePool(verb: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (value: unknown) => console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  try {
    // Join has two forms that must not mix: enrollment flags --primary/
    // --backup (probe this machine's lanes and capacity, first join only)
    // and explicit router-client flags --caps/--slots (an existing pool
    // member re-pinning its registration). --caps/--slots flip the call to
    // the explicit path below, where leftover --primary/--backup would cross
    // SSH as a masked pool refusal — or, with no pool config yet, read as
    // "no node pool configuration". Refuse the mix by name before either.
    if (verb === 'join') {
      const has = (name: string) => args.some(a => a === name || a.startsWith(`${name}=`));
      if ((has('--primary') || has('--backup')) && (has('--caps') || has('--slots'))) {
        throw new PoolUsageError('Pool join cannot combine --primary/--backup enrollment flags with --caps/--slots explicit flags. Enrollment probes this machine\'s lanes and capacity itself: drop --caps/--slots to enroll, or drop --primary/--backup for an explicit join.');
      }
    }
    if (verb === 'pool' || (verb === 'join' && !args.some(a => /^--(?:caps|slots)(?:=|$)/.test(a)))) {
      const f = flags(args, [...(verb === 'pool' ? ['--role'] : []), '--node', '--owner', '--primary', '--backup']);
      const role = verb === 'join' ? 'worker' : f.get('--role') as PoolConfig['role'];
      const existing = verb === 'join' ? readPoolConfig() : null;
      const config = existing ?? configFrom(f, role);
      if (!existing && verb === 'join' && !f.has('--node')) config.node = hostname().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
      // Each identity refusal names its flag: a first enrollment that forgets
      // --owner or --node, reuses one SSH alias for both pool hosts, or repeats
      // a join with a changed flag must not dead-end on one generic message.
      const changed = existing && ['--role', '--node', '--owner', '--primary', '--backup']
        .find(key => f.has(key) && f.get(key) !== existing[key.slice(2) as keyof PoolConfig]);
      if (changed) throw new PoolUsageError(`Join cannot change pool identity; ${changed} differs from this computer's saved pool config.`);
      if (!validSshHost(config.primary) || !validSshHost(config.backup)) throw new PoolUsageError('Use explicit team SSH config aliases for --primary and --backup');
      if (config.primary === config.backup) throw new PoolUsageError('--primary and --backup must name two different SSH aliases.');
      if (!validId(config.owner)) throw new PoolUsageError(config.owner === ''
        ? 'Add --owner <scope>: the label this pool\'s jobs carry.'
        : '--owner is not a valid scope id.');
      if (!validId(config.node)) throw new PoolUsageError(verb === 'join' && !f.has('--node')
        ? 'This computer\'s hostname cannot form a node id; pass --node <id> explicitly.'
        : verb === 'pool' && !f.has('--node') ? 'Add --node <id>: the name this computer joins the pool under.'
        : '--node is not a valid node id.');
      if (verb === 'pool' && config.role !== 'primary' && config.role !== 'backup') throw new PoolUsageError('phm node pool --role must be primary or backup');
      if (verb === 'join') {
        const capacity = readNodeCapacity();
        const lanes = probeNodeLanes();
        // A live session already held under this node id — a running worker or
        // an unexpired join — makes the pool refuse the join, and that refusal
        // is indistinguishable from a transport failure over SSH. Ask the
        // pool's own status read first so the common repeat-join case names
        // its real fix instead of the generic approval steps.
        if (poolNodeLive(config)) {
          emit({ schemaVersion: 1, command: verb, registered: false,
            error: { code: 'node-live',
              message: `Node '${config.node}' already holds a live session in this pool — a running worker batch or an unexpired join.`,
              fix: 'Stop the worker or wait for the session to expire (about 30 seconds after its last heartbeat), then retry: phm node join --json. Check live sessions with: phm node status --json' } });
          return 1;
        }
        let result: ReturnType<typeof callPool>;
        try {
          result = callPool(config, 'join', ['--node', config.node, '--caps', lanes.join(','), '--slots', String(capacity.slots)]);
        } catch {
          emit({ schemaVersion: 1, command: verb, registered: false,
            error: { code: 'unreachable',
              message: 'Pool join did not complete: the primary or backup did not accept the request. Usual causes are SSH trust not yet approved on this computer, `phm` missing on a pool Mac\'s SSH PATH, or the backup witness being unreachable.',
              fix: 'Run the printed approval steps, then retry: phm node join --json' },
            approvalSteps: [sshApprovalStep(config.primary), sshApprovalStep(config.backup)] });
          return 1;
        }
        if (result.demoted || !result.result['session']) {
          emit({ schemaVersion: 1, command: verb, registered: false,
            error: { code: 'held',
              message: 'The pool answered but did not accept this node\'s registration — a live session may have appeared mid-join, or the witness moved.',
              fix: 'Check live sessions with: phm node status --json, then retry: phm node join --json' } });
          return 1;
        }
        // Registration proves the route, then release the probe session so the
        // worker can establish its own. A failed release only leaves the probe
        // session to expire on its own — enrollment itself already succeeded.
        let released = true;
        try {
          callPool(config, 'leave', ['--node', config.node, '--session', String(result.result['session'])]);
        } catch { released = false; }
        if (!existing) {
          try { configurePool(config); } catch {
            emit({ schemaVersion: 1, command: verb, registered: true, configured: false,
              error: { code: 'error',
                message: 'The node registered with the pool, but this computer\'s pool configuration could not be written.',
                fix: 'Check that the Phantom state directory is a private directory you own, then retry: phm node join --json' } });
            return 1;
          }
        }
        emit({ schemaVersion: 1, command: verb, registered: true, role: config.role, lanes, capacity,
          ready: !capacity.held && lanes.length > 0,
          ...(released ? {} : { note: 'the probe session was not released; it expires within about 30 seconds — a worker started now may report node-already-live once' }),
          next: 'phm node worker --runner /absolute/host-owned-runner --json', ...result.result });
        return 0;
      }
      configurePool(config);
      emit({ schemaVersion: 1, configured: true, role, approvalSteps: [sshApprovalStep(config.primary), sshApprovalStep(config.backup)] });
      return 0;
    }
    if (verb === 'replica') {
      const action = args[0];
      if (action !== 'status' && action !== 'sync') throw new PoolUsageError('Use phm node replica status|sync');
      const f = flags(args.slice(1), action === 'sync' ? ['--leader'] : []);
      const { fleetReplicaStatus, syncFleetReplica } = await import('../core/fleet/fleet-replica.js');
      const leader = f.get('--leader');
      if (leader !== undefined && !validSshHost(leader)) throw new PoolUsageError('Use an explicit SSH config alias for --leader');
      const result = action === 'sync' ? await syncFleetReplica({ leader, force: true }) : fleetReplicaStatus();
      emit({ schema: 'fleet.replica.status.v1', ...result });
      return action === 'sync' && (!result.leader || result.lastError || result.source?.stale) ? 1 : 0;
    }
    if (verb === 'rpc') {
      flags(args, []);
      const request = await readRequest();
      if (request?.kind === 'replica') {
        const { serveFleetReplica } = await import('../core/fleet/fleet-replica.js');
        emit(await serveFleetReplica(request));
        return 0;
      }
      const config = readPoolConfig();
      if (!config) throw new PoolNotConfigured(poolConfigMissing());
      emit(serveNodeRpc(config, request));
      return 0;
    }
    const config = readPoolConfig();
    if (!config) throw new PoolNotConfigured(poolConfigMissing());
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
    // An explicit join (--caps/--slots bypassed enrollment above) is the
    // router-client form: the pool-side parser still requires --node, pins
    // --owner to this pool's configured scope and bounds --caps/--slots, but
    // every one of those refusals crosses SSH masked as a witness demotion
    // ('held: inactive-runner'). Check the same contract here so the operator
    // gets the flag named at exit 2 before any dial — the rule the
    // enrollment branch's identity refusals already follow. Only the join
    // flags are read; every other parser refusal stays pool-masked like it is
    // for every verb on this path.
    if (verb === 'join') {
      const take = (name: string): string | undefined => {
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!;
          if (a === name) return args[i + 1];
          if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
        }
        return undefined;
      };
      for (const name of ['--node', '--owner', '--caps', '--slots']) {
        if (args.filter(a => a === name || a.startsWith(`${name}=`)).length > 1) {
          throw new PoolUsageError(`${name} was given more than once.`);
        }
      }
      const nodeId = take('--node');
      if (nodeId === undefined || nodeId.startsWith('--')) {
        throw new PoolUsageError('Explicit pool join needs --node <id>: it names the node this join enrolls under. Bare `phm node join --json` re-enrolls this computer with its probed lanes instead.');
      }
      if (!validId(nodeId)) throw new PoolUsageError('--node is not a valid node id.');
      const owner = take('--owner');
      if (owner !== undefined && !owner.startsWith('--') && owner !== config.owner) {
        throw new PoolUsageError(`--owner must be this pool's configured scope '${config.owner}'.`);
      }
      const caps = take('--caps');
      if (caps !== undefined && !caps.startsWith('--')) {
        const items = caps.split(',').map(c => c.trim()).filter(Boolean);
        if (items.length > 64 || !items.every(validCap)) {
          throw new PoolUsageError('--caps must be a comma-separated list of up to 64 capabilities.');
        }
      }
      const slots = take('--slots');
      if (slots !== undefined && !slots.startsWith('--') && (!/^\d{1,15}$/.test(slots) || Number(slots) > 64)) {
        throw new PoolUsageError('--slots must be an integer from 0 to 64.');
      }
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
