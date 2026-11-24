import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { BusBoard, type BusBoardDeliveryFilter, type BusBoardReceiptFilter } from '../core/fleet/bus-board.js';
import { SharedStore } from '../core/fleet/shared-store.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import type { AshlrConfig } from '../core/types.js';

export const usage = `Usage: phm bus thread create <title> [--peer <id>] [--json]
       phm bus thread join <thread-id> [--peer <id>] [--json]
       phm bus thread read|pending|hops <thread-id> [--peer <id>] [--contains <text>] [--since <15m|2h|1d|ISO|ms>] [--before <15m|2h|1d|ISO|ms>] [--json]
       phm bus thread receipts <thread-id> [--peer <id>] [--since <15m|2h|1d|ISO|ms>] [--before <15m|2h|1d|ISO|ms>] [--json]
       phm bus thread ack <thread-id> <delivery-id> [--peer <id>] [--json]
       phm bus thread post <thread-id> <body> [--peer <id>] [--json]
       phm bus thread list [--peer <id>] [--contains <text>] [--json]
       phm bus board pending [--peer <id>] [--all] [--job <id>] [--contains <text>] [--since <15m|2h|1d|ISO|ms>] [--before <15m|2h|1d|ISO|ms>] [--json]
       phm bus task create <thread-id> <fleet-item-id> <title> [--peer <id>] [--json]
       phm bus task list <thread-id> [--peer <id>] [--contains <text>] [--json]
       phm bus task claim|renew|release <task-id> [--peer <id>] [--json]
       phm bus task handoff <task-id> <peer-id> [--peer <id>] [--json]

phm fleet bus ... is the same board. phm bus send|inbox|ack is the separate
durable mailbox (phm bus send --help). --root <abs> and --queue-root <abs>
override the default private coordination paths. Quote titles and bodies as one
argument; -- permits content beginning with -. Output is JSON. Peer labels are
cooperative routing labels, never identities; fleet claims grant no execution
authority.

board pending digests one peer's unacknowledged deliveries and per-task hold
state; --all instead returns the fleet-wide digest every thread member shares
(the same read fleet_bus_board and comms inbox's board source project, reported
under peers rather than peer). --job keeps only threads carrying a task whose
fleet item id cites it. --contains, --since and --before are the same rules
every other bus read applies — the normalized needle over scrubbed display
text, and the [since, before) window on each row's recorded timestamp —
scoped to the fields each read carries: thread read, pending and hops take
all three on each delivery's createdAt and post text, thread receipts takes
--since/--before on receivedAt, and thread/task list take --contains on the
stored title. Tasks and threads record no timestamp, so a time bound is
valid only where a recorded time exists; --job and --all remain board
pending only, and a filter valid nowhere on the command is a usage error.`;

const ARITIES: Record<string, number> = {
  'thread:create': 1, 'thread:join': 1, 'thread:post': 2,
  'thread:read': 1, 'thread:pending': 1, 'thread:list': 0, 'thread:hops': 1, 'thread:ack': 2, 'thread:receipts': 1,
  'board:pending': 0,
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
  all?: boolean;
  job?: string;
  contains?: string;
  since?: string;
  before?: string;
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
      if (flags.has(flag) ||
        !['--peer', '--root', '--queue-root', '--json', '--help', '--all', '--job', '--contains', '--since', '--before'].includes(flag)) return null;
      flags.add(flag);
      if (['--peer', '--root', '--queue-root', '--job', '--contains', '--since', '--before'].includes(flag)) {
        const value = args[++i];
        if (value === undefined) return null;
        if (flag === '--peer') {
          if (PEER_ID.exec(value)?.[0] !== value) return null;
          parsed.peer = value;
        } else if (flag === '--root') {
          if (!isAbsolute(value)) return null;
          parsed.root = value;
        } else if (flag === '--queue-root') {
          if (!isAbsolute(value)) return null;
          parsed.queueRoot = value;
        } else if (flag === '--job') parsed.job = value;
        else if (flag === '--contains') parsed.contains = value;
        else if (flag === '--before') parsed.before = value;
        else parsed.since = value;
      }
      if (flag === '--help') parsed.help = true;
      if (flag === '--all') parsed.all = true;
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
  // Each board read takes only the filters its stored rows carry: deliveries
  // and receipts keep a recorded-time window, deliveries and titles keep the
  // --contains text rule, and --job/--all stay board pending's own flags.
  // Anywhere else a flag is refused rather than silently dropped, and --all
  // leaves no single peer view for --peer to select.
  const TIME_FILTERED = new Set(['board:pending', 'thread:read', 'thread:pending', 'thread:hops', 'thread:receipts']);
  const TEXT_FILTERED = new Set(['board:pending', 'thread:read', 'thread:pending', 'thread:hops', 'thread:list', 'task:list']);
  if ((parsed.all === true && parsed.command !== 'board:pending') ||
    (parsed.job !== undefined && parsed.command !== 'board:pending') ||
    ((parsed.since !== undefined || parsed.before !== undefined) && !TIME_FILTERED.has(parsed.command)) ||
    (parsed.contains !== undefined && !TEXT_FILTERED.has(parsed.command)) ||
    (parsed.command === 'board:pending' && parsed.all === true && parsed.peer !== undefined)) {
    out(JSON.stringify({ ok: false, error: 'Invalid bus arguments', usage }));
    return 2;
  }
  let boardSinceMs: number | undefined;
  let boardBeforeMs: number | undefined;
  if (parsed.since !== undefined) {
    const ms = parseSince(parsed.since);
    if (ms === null) {
      out(JSON.stringify({ ok: false, error: 'Invalid bus arguments', usage }));
      return 2;
    }
    boardSinceMs = ms;
  }
  if (parsed.before !== undefined) {
    const ms = parseSince(parsed.before);
    if (ms === null) {
      out(JSON.stringify({ ok: false, error: 'Invalid bus arguments', usage }));
      return 2;
    }
    boardBeforeMs = ms;
  }
  const deliveryFilter: BusBoardDeliveryFilter = {
    ...(boardSinceMs === undefined ? {} : { sinceMs: boardSinceMs }),
    ...(boardBeforeMs === undefined ? {} : { beforeMs: boardBeforeMs }),
    ...(parsed.contains === undefined ? {} : { contains: parsed.contains }),
  };
  const receiptFilter: BusBoardReceiptFilter = {
    ...(boardSinceMs === undefined ? {} : { sinceMs: boardSinceMs }),
    ...(boardBeforeMs === undefined ? {} : { beforeMs: boardBeforeMs }),
  };
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
      case 'thread:read': result = board.readThread(actor, first!, false, deliveryFilter); break;
      case 'thread:pending': result = board.readThread(actor, first!, true, deliveryFilter); break;
      case 'thread:list': result = board.listThreads(actor, parsed.contains); break;
      case 'thread:ack': result = board.acknowledge(actor, first!, second!); break;
      case 'thread:receipts': result = board.receipts(actor, first!, receiptFilter); break;
      case 'thread:hops': result = board.hops(actor, first!, deliveryFilter); break;
      case 'board:pending':
        result = parsed.all === true
          ? board.pendingAll(Date.now(), parsed.job, parsed.contains, boardSinceMs, boardBeforeMs)
          : board.pending(actor, Date.now(), parsed.job, parsed.contains, boardSinceMs, boardBeforeMs);
        break;
      case 'task:create': result = board.createTask(actor, first!, second!, third!); break;
      case 'task:list': result = board.listTasks(actor, first!, parsed.contains); break;
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
