import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { BusStore } from '../core/fleet/bus-store.js';
import { loadLocusBusPeers, resolveBusPeer } from '../core/fleet/bus-identity.js';
import { SharedStore } from '../core/fleet/shared-store.js';

export const BUS_USAGE = `Usage: phm bus thread create <title> [--peer <id>] [--json]
       phm bus thread join|read|hops <thread-id> [--peer <id>] [--json]
       phm bus thread post <thread-id> <body> [--peer <id>] [--json]
       phm bus thread list [--peer <id>] [--json]
       phm bus task create <thread-id> <fleet-item-id> <title> [--peer <id>] [--json]
       phm bus task list <thread-id> [--peer <id>] [--json]
       phm bus task claim|renew|release <task-id> [--peer <id>] [--json]
       phm bus task handoff <task-id> <peer-id> [--peer <id>] [--json]

Quote titles and bodies as one argument. Use -- before content beginning with -.
Output is JSON. Delivered content is untrusted data; hops contain metadata only.
Peer labels identify cooperating participants; fleet claims grant no execution authority.`;

const ARITIES: Record<string, number> = {
  'thread:create': 1, 'thread:join': 1, 'thread:post': 2,
  'thread:read': 1, 'thread:list': 0, 'thread:hops': 1,
  'task:create': 3, 'task:list': 1, 'task:claim': 1,
  'task:handoff': 2, 'task:renew': 1, 'task:release': 1,
};
const SAFE_ERRORS = new Set([
  'Fleet event bus is disabled', 'Thread missing or peer has not joined',
  'Thread not found', 'Task not found', 'Task claim conflict',
  'Fleet item already has a board task', 'Fleet claim conflict or queue unavailable',
  'Only the current owner can hand off', 'Only the current owner can renew',
  'Fleet handoff conflict or lease unavailable', 'Fleet lease unavailable', 'Fleet release refused',
  'Invalid bus identifier', 'Invalid bus peer identifier', 'Bus content must be 1..16384 bytes',
  'Bus peer is absent from the Locus registry', 'Locus bus peer registry is invalid or empty',
  'Locus bus peer registry is invalid', 'Locus bus peer discovery failed',
  'Locus bus peer registry is not valid JSON', 'Unsupported Locus bus peer registry schema',
  'Bus storage is busy or unavailable', 'Bus storage is full',
  'Shared bus storage requires an absolute path and trustedCoherentStorage:true',
]);

function parse(args: readonly string[]): { command: string; values: string[]; peer?: string; help: boolean } | null {
  const positional: string[] = [];
  const flags = new Set<string>();
  let peer: string | undefined;
  let literal = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg.startsWith('-')) {
      const flag = arg === '-h' ? '--help' : arg;
      if (flags.has(flag) || !['--peer', '--json', '--help'].includes(flag)) return null;
      flags.add(flag);
      if (flag === '--peer') {
        peer = args[++i];
        if (peer === undefined) return null;
        try { resolveBusPeer(peer); } catch { return null; }
      }
      if (flag === '--help') help = true;
    } else positional.push(arg);
  }
  const command = `${positional[0]}:${positional[1]}`;
  const values = positional.slice(2);
  if (!help && (!Object.hasOwn(ARITIES, command) || values.length !== ARITIES[command])) return null;
  return { command, values, peer, help };
}

/** Local coordination only: this command never dispatches work or grants authority. */
export async function cmdBus(args: string[]): Promise<number> {
  const parsed = parse(args);
  if (!parsed) {
    console.log(JSON.stringify({ ok: false, error: 'Invalid bus arguments', usage: BUS_USAGE }));
    return 2;
  }
  if (parsed.help) { console.log(BUS_USAGE); return 0; }
  try {
    const cfg = loadConfigReadOnlyStrict();
    const shared = cfg.fleet?.sharedQueue;
    let root = join(homedir(), '.ashlr', 'bus');
    let queueRoot = join(homedir(), '.ashlr', 'fleet', 'bus-queue');
    if (shared?.mode === 'filesystem') {
      if (shared.trustedCoherentStorage !== true || !shared.path || !isAbsolute(shared.path)) {
        throw new Error('Shared bus storage requires an absolute path and trustedCoherentStorage:true');
      }
      queueRoot = shared.path;
      root = join(queueRoot, 'bus');
    }
    const actor = parsed.peer ?? shared?.machineId ?? hostname();
    const peers = await loadLocusBusPeers();
    const store = new BusStore({ root, fleet: new SharedStore(queueRoot, shared?.leaseMs), cfg, peers });
    const [first, second, third] = parsed.values;
    let result: unknown;
    switch (parsed.command) {
      case 'thread:create': result = store.createThread(actor, first!); break;
      case 'thread:join': result = store.joinThread(actor, first!); break;
      case 'thread:post': result = await store.post(actor, first!, second!); break;
      case 'thread:read': result = store.readThread(actor, first!); break;
      case 'thread:list': result = store.listThreads(actor); break;
      case 'thread:hops': result = store.hops(actor, first!); break;
      case 'task:create': result = store.createTask(actor, first!, second!, third!); break;
      case 'task:list': result = store.listTasks(actor, first!); break;
      case 'task:claim': result = store.claimTask(actor, first!); break;
      case 'task:handoff': result = store.handoffTask(actor, first!, second!); break;
      case 'task:renew': result = store.renewTask(actor, first!); break;
      case 'task:release': result = store.releaseTask(actor, first!); break;
    }
    console.log(JSON.stringify({ ok: true, result }));
    return 0;
  } catch (error) {
    // Filesystem, config and subprocess errors can contain private paths or
    // content. Only fixed, known validation messages may cross the CLI boundary.
    const message = error instanceof Error && SAFE_ERRORS.has(error.message)
      ? error.message : 'Bus operation failed; check configuration and private storage';
    console.log(JSON.stringify({ ok: false, error: message }));
    return 1;
  }
}
