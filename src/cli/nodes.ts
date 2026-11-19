/** `phm nodes [--json] [--can-take <lane>]`: one read-only row per known computer. Thin: core/fleet/nodes-view.ts does the work. */
import { validCap } from '../core/drive/nodes/state.js';
import { readQueueOrder } from '../core/queue/order.js';
import { readNodesPlan, type NodesPlan } from '../core/fleet/nodes-plan.js';
import { chooseNodeForLane, defaultNodesViewDeps, nodesThatCanTake, readNodesView, type NodeRow, type NodesViewDeps } from '../core/fleet/nodes-view.js';

const USAGE = `Usage: phm nodes [--json] [--can-take <lane>]
       phm nodes plan [--json]

One row per known computer: reachable or not, whether Phantom is running there,
free memory, CPU headroom, lanes, running jobs and a plain-words state.
--can-take <lane> lists only the computers that can take a job for that lane now.
It recommends a ready remote computer, then this computer if no remote is ready.
plan: how many more jobs each computer could take now, and which queued job fits
which computer. It only plans; it launches, moves and stops nothing.
Read only: it changes no network, security or pool setting.`;

const unknownOr = <T>(value: T | 'unknown', show: (known: T) => string): string => (value === 'unknown' ? 'unknown' : show(value));

function line(node: NodeRow): string {
  return [
    `${node.name}${node.isSelf ? ' (this computer)' : ''}: ${node.state}`,
    `memory free ${unknownOr(node.freeMemoryBytes, bytes => `${(bytes / 1024 ** 3).toFixed(1)} GB`)}`,
    `CPU free ${unknownOr(node.cpuHeadroomPercent, percent => `${percent}%`)}`,
    `lanes ${unknownOr(node.lanes, lanes => lanes.join(',') || 'none')}`,
    `jobs ${unknownOr(node.jobsRunning, jobs => String(jobs.length))}`,
  ].join(' | ');
}

const slotWords = (slots: number | 'unknown'): string => (slots === 'unknown' ? 'slots unknown' : `${slots} ${slots === 1 ? 'slot' : 'slots'}`);

function planText(plan: NodesPlan): string {
  const rows = plan.nodes.map(n => `${n.online === true ? '●' : n.online === false ? '○' : '?'} ${n.name}: ${slotWords(n.suggested_slots)} | ${n.why}`);
  const jobs = plan.assignable.length ? plan.assignable.map(a => `${a.job} -> ${a.node}`) : [plan.unassigned === 'unknown' ? 'Queued jobs unknown.' : 'No queued job fits a computer now.'];
  return [...rows, '', ...jobs, ...plan.reasons.map(reason => `note: ${reason}`)].join('\n');
}

/** `phm nodes plan [--json]`: read only; plans and never launches, moves or stops anything. */
async function cmdNodesPlan(args: string[], deps: NodesViewDeps, readQueue: typeof readQueueOrder): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const plan = await readNodesPlan({ view: deps, readQueue: () => readQueue() });
  console.log(args.length ? JSON.stringify(plan, null, 2) : planText(plan));
  return 0;
}

export async function cmdNodes(args: string[], deps: NodesViewDeps = defaultNodesViewDeps(), readQueue: typeof readQueueOrder = readQueueOrder): Promise<number> {
  if (args[0] === 'plan') return args.slice(1).includes('--help') ? (console.log(USAGE), 0) : cmdNodesPlan(args.slice(1), deps, readQueue);
  let json = false;
  let lane: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json' && !json) json = true;
    else if (arg === '--can-take' && lane === null && validCap(args[i + 1])) lane = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  const view = readNodesView(deps);
  const nodes = lane === null ? view.nodes : nodesThatCanTake(view, lane);
  const placement = lane === null ? null : chooseNodeForLane(view, lane);
  if (json) {
    console.log(JSON.stringify({ ...view, ...(lane === null ? {} : { canTake: lane, placement }), nodes }, null, 2));
    return 0;
  }
  const empty = lane === null ? 'No computers known.' : `No computer can take a ${lane} job now. Run \`phm nodes\` to see why.`;
  const choice = placement?.node ? [`Suggested computer: ${placement.node}. ${placement.explanation}`] : [];
  const only = lane === null && nodes.length === 1 && nodes[0]!.isSelf ? ['Only this Mac.'] : [];
  console.log([...choice, ...(nodes.length ? nodes.map(line) : [empty]), ...only, ...view.reasons.map(reason => `note: ${reason}`)].join('\n'));
  return 0;
}
