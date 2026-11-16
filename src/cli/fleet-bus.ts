import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { BusBoard } from '../core/fleet/bus-board.js';
import { SharedStore } from '../core/fleet/shared-store.js';
import type { AshlrConfig } from '../core/types.js';

export const usage = `Usage: phm bus thread create <title> [--peer <id>] [--json]
       phm bus thread join|read|hops|receipts <thread-id> [--peer <id>] [--json]
       phm bus thread pending <thread-id> [--peer <id>] [--json]
       phm bus thread ack <thread-id> <delivery-id> [--peer <id>] [--json]
       phm bus thread post <thread-id> <body> [--peer <id>] [--json]
       phm bus thread list [--peer <id>] [--json]
       phm bus task create <thread-id> <fleet-item-id> <title> [--peer <id>] [--json]
       phm bus task list <thread-id> [--peer <id>] [--json]
       phm bus task claim|renew|release <task-id> [--peer <id>] [--json]
       phm bus task handoff <task-id> <peer-id> [--peer <id>] [--json]

phm fleet bus ... is the same board. phm bus send|inbox|ack is the separate
durable mailbox (phm bus send --help). --root <abs> and --queue-root <abs>
override the default private coordination paths. Quote titles and bodies as one
argument; -- permits content beginning with -. Output is JSON. Peer labels are
cooperative routing labels, never identities; fleet claims grant no execution
authority.`;

const ARITIES: Record<string, number> = {
  'thread:create': 1, 'thread:join': 1, 'thread:post': 2,
  'thread:read': 1, 'thread:pending': 1, 'thread:list': 0, 'thread:hops': 1, 'thread:ack': 2, 'thread:receipts': 1,
  'task:create': 3, 'task:list': 1, 'task:claim': 1,
  'task:handoff': 2, 'task:renew': 1, 'task:release': 1,
};

const PEER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const SAFE_ERRORS = new Set([
  'Fleet event bus is disabled', 'Thread missing or peer has not joined',
  'Thread not found', 'Task not found', 'Task claim conflict',
  'Fleet item already has a board task', 'Fleet claim conflict or queue unavailable',
  'Only the current owner can hand off', 'Only the current owner can renew',
  'Fleet handoff conflict or lease unavailable', 'Fleet lease unavailable', 'Fleet release refused',
  'Invalid bus identifier', 'Invalid bus peer identifier', 'Invalid bus state',
  'Invalid bus members', 'Invalid bus task reference', 'Invalid bus task claim',
  'Invalid bus delivery', 'Invalid bus receipt', 'Bus delivery not found', 'Invalid bus envelope', 'Bus content must be 1..16384 bytes',
  'Bus peer is absent from the peer registry', 'Bus storage is busy or unavailable',
  'Bus storage is full', 'Bus storage lock lost', 'Bus storage must be private, owned, and not linked',
  'Shared bus storage requires an absolute path and trustedCoherentStorage:true',
]);

interface Parsed {
  command: string;
  values: string[];
  peer?: string;
  root?: string;
  queueRoot?: string;
  help: boolean;
}

function parse(args: readonly string[]): Parsed | null {
  const positional: string[] = [];
  const flags = new Set<string>();
  const parsed: Parsed = { command: '', values: [], help: false };
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg.startsWith('-')) {
      const flag = arg === '-h' ? '--help' : arg;
      if (flags.has(flag) || !['--peer', '--root', '--queue-root', '--json', '--help'].includes(flag)) return null;
      flags.add(flag);
      if (flag === '--peer' || flag === '--root' || flag === '--queue-root') {
        const value = args[++i];
        if (value === undefined) return null;
        if (flag === '--peer') {
          if (PEER_ID.exec(value)?.[0] !== value) return null;
          parsed.peer = value;
        } else {
          if (!isAbsolute(value)) return null;
          if (flag === '--root') parsed.root = value; else parsed.queueRoot = value;
        }
      }
      if (flag === '--help') parsed.help = true;
    } else positional.push(arg);
  }
  parsed.command = `${positional[0]}:${positional[1]}`;
  parsed.values = positional.slice(2);
  if (!parsed.help && (!Object.hasOwn(ARITIES, parsed.command) || parsed.values.length !== ARITIES[parsed.command])) {
    return null;
  }
  return parsed;
}

export interface FleetBusDeps {
  loadConfig?: () => AshlrConfig;
  out?: (text: string) => void;
}

/** Local coordination only: this command never dispatches work or grants authority. */
export async function cmdFleetBus(args: string[], deps: FleetBusDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => console.log(text));
  const parsed = parse(args);
  if (!parsed) {
    out(JSON.stringify({ ok: false, error: 'Invalid bus arguments', usage }));
    return 2;
  }
  if (parsed.help) {
    out(usage);
    return 0;
  }
  try {
    const cfg = (deps.loadConfig ?? loadConfigReadOnlyStrict)();
    const shared = cfg.fleet?.sharedQueue;
    let root = join(ashlrHome(), 'bus');
    let queueRoot = join(ashlrHome(), 'fleet', 'bus-queue');
    if (shared?.mode === 'filesystem') {
      if (shared.trustedCoherentStorage !== true || !shared.path || !isAbsolute(shared.path)) {
        throw new Error('Shared bus storage requires an absolute path and trustedCoherentStorage:true');
      }
      queueRoot = shared.path;
      root = join(queueRoot, 'bus');
    }
    if (parsed.root !== undefined) root = parsed.root;
    if (parsed.queueRoot !== undefined) queueRoot = parsed.queueRoot;
    const actor = parsed.peer ?? shared?.machineId ?? hostname();
    const board = new BusBoard({ root, fleet: new SharedStore(queueRoot, shared?.leaseMs), cfg });
    const [first, second, third] = parsed.values;
    let result: unknown;
    switch (parsed.command) {
      case 'thread:create': result = board.createThread(actor, first!); break;
      case 'thread:join': result = board.joinThread(actor, first!); break;
      case 'thread:post': result = await board.post(actor, first!, second!); break;
      case 'thread:read': result = board.readThread(actor, first!); break;
      case 'thread:pending': result = board.readThread(actor, first!, true); break;
      case 'thread:list': result = board.listThreads(actor); break;
      case 'thread:ack': result = board.acknowledge(actor, first!, second!); break;
      case 'thread:receipts': result = board.receipts(actor, first!); break;
      case 'thread:hops': result = board.hops(actor, first!); break;
      case 'task:create': result = board.createTask(actor, first!, second!, third!); break;
      case 'task:list': result = board.listTasks(actor, first!); break;
      case 'task:claim': result = board.claimTask(actor, first!); break;
      case 'task:handoff': result = board.handoffTask(actor, first!, second!); break;
      case 'task:renew': result = board.renewTask(actor, first!); break;
      case 'task:release': result = board.releaseTask(actor, first!); break;
    }
    out(JSON.stringify({ ok: true, result }));
    return 0;
  } catch (error) {
    // Filesystem, config and queue errors can contain private paths or peer
    // content. Only fixed, known validation messages may cross the boundary.
    const message = error instanceof Error && SAFE_ERRORS.has(error.message)
      ? error.message : 'Bus operation failed; check configuration and private storage';
    out(JSON.stringify({ ok: false, error: message }));
    return 1;
  }
}
