/** `phm nodes [--json] [--can-take <lane>]`: one read-only row per known computer. Thin: core/fleet/nodes-view.ts does the work. */
import { validCap } from '../core/drive/nodes/state.js';
import { readQueueOrder } from '../core/queue/order.js';
import { readNodesPlan, type NodesPlan } from '../core/fleet/nodes-plan.js';
import { defaultNodeProbe, doctorText, readNodesDoctor, type NodeProbe } from '../core/fleet/nodes-doctor.js';
import { offloadText, readNodesOffload, writeOffloadEnabled, readOffloadEnabled, type NodesOffloadDeps } from '../core/fleet/nodes-offload.js';
import { poolText, readNodesPool } from '../core/fleet/nodes-pool.js';
import { readHostLoad } from '../core/fleet/host-load.js';
import { parseAdmissionCtl } from '../core/fleet/load-owners.js';
import { readEngineAdmission } from '../core/fleet/engine-admission-view.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chooseNodeForLane, defaultNodesViewDeps, nodesThatCanTake, readNodesView, type NodeRow, type NodesViewDeps } from '../core/fleet/nodes-view.js';

const USAGE = `Usage: phm nodes [--json] [--discover] [--can-take <lane>]
       phm nodes pool [--json]
       phm nodes plan [--json]
       phm nodes doctor [--node <name>] [--json]
       phm nodes offload [--dry-run] [--json]
       phm nodes offload on|off

One row per known computer: reachable or not, whether Phantom is running there,
free memory, CPU headroom, lanes, running jobs and a plain-words state.
--can-take <lane> lists only the computers that can take a job for that lane now.
--discover also lists Tailscale computers that have not joined, each with the one command to join it
(run "phm node join" on that computer). JSON adds "discovered" with the same rows.
It recommends a ready remote computer, then this computer if no remote is ready.
pool: your Macs as one pool (this Mac first): online, offline or unknown, free slots,
running jobs, load, free memory and disk, whether offload is on, when it was last seen,
and one total line such as "2 Macs, 11 free slots". Offload is known only for this Mac.
plan: how many more jobs each computer could take now, and which queued job fits
which computer. It only plans; it launches, moves and stops nothing.
doctor: what each joined computer is missing before it can take jobs: reachable,
which lane CLIs (claude, codex, devin, gemini, local model) are installed and
signed in, which ashlrai repo clones exist and free disk, with one fix line per gap.
Other computers show unknown where they cannot be checked yet.
offload: opt-in, off by default. When this computer would hold a launch (over load
or memory held) and another computer passes doctor with a free slot, a ready job is
chosen for that computer and one event records why. Running jobs never move, a
computer never gets more jobs than its free slots, and with no ready computer the
job keeps waiting here. --dry-run only shows what would move. on|off flips the setting.
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

/** `phm nodes doctor [--node <name>] [--json]`: read only readiness check per joined computer. */
async function cmdNodesDoctor(args: string[], deps: NodesViewDeps, probe: NodeProbe): Promise<number> {
  let json = false, node: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json' && !json) json = true;
    else if (arg === '--node' && node === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) node = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  const report = await readNodesDoctor({ view: deps, probe }, node);
  if (node !== undefined && !report.nodes.length) { console.error(`No computer named ${node}. Run \`phm nodes\` to list them.`); return 1; }
  console.log(json ? JSON.stringify(report, null, 2) : doctorText(report));
  return 0;
}

/** `phm nodes pool [--json]`: read only; the joined Macs as one pool. */
function cmdNodesPool(args: string[], deps: NodesViewDeps): number {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const pool = readNodesPool({ view: deps });
  console.log(args.length ? JSON.stringify(pool, null, 2) : poolText(pool));
  return 0;
}

/** The real host guard reading: load average, the launch guard's file and the memory gate. */
function defaultReadHost(): ReturnType<NodesOffloadDeps['readHost']> {
  const runs = process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const file = readStableRegularFile(join(runs, 'queue', 'admission-ctl.json'), { anchorPath: runs, maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024 });
  return { load: readHostLoad(), admission: parseAdmissionCtl(file.ok ? file.text : null), memory: readEngineAdmission() };
}

/** `phm nodes offload [--dry-run] [--json]` and `phm nodes offload on|off`. */
async function cmdNodesOffload(args: string[], deps: NodesViewDeps, readQueue: typeof readQueueOrder, probe: NodeProbe, offload: Partial<NodesOffloadDeps>): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  if (args.length === 1 && (args[0] === 'on' || args[0] === 'off')) {
    writeOffloadEnabled(args[0] === 'on');
    console.log(args[0] === 'on' ? 'Offload is on. Run `phm nodes offload --dry-run` to see what would move.' : 'Offload is off.');
    return 0;
  }
  let json = false, dryRun = false;
  for (const arg of args) {
    if (arg === '--json' && !json) json = true;
    else if (arg === '--dry-run' && !dryRun) dryRun = true;
    else { console.error(USAGE); return 2; }
  }
  const report = await readNodesOffload({ view: deps, probe, readQueue: () => readQueue(), readHost: defaultReadHost, readEnabled: readOffloadEnabled, ...offload }, { dryRun });
  console.log(json ? JSON.stringify(report, null, 2) : offloadText(report));
  return 0;
}

export async function cmdNodes(args: string[], deps: NodesViewDeps = defaultNodesViewDeps(), readQueue: typeof readQueueOrder = readQueueOrder, probe: NodeProbe = defaultNodeProbe, offload: Partial<NodesOffloadDeps> = {}): Promise<number> {
  if (args[0] === 'offload') return cmdNodesOffload(args.slice(1), deps, readQueue, probe, offload);
  if (args[0] === 'pool') return cmdNodesPool(args.slice(1), deps);
  if (args[0] === 'doctor') return cmdNodesDoctor(args.slice(1), deps, probe);
  if (args[0] === 'plan') return args.slice(1).includes('--help') ? (console.log(USAGE), 0) : cmdNodesPlan(args.slice(1), deps, readQueue);
  let json = false, discover = false;
  let lane: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json' && !json) json = true;
    else if (arg === '--discover' && !discover) discover = true;
    else if (arg === '--can-take' && lane === null && validCap(args[i + 1])) lane = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  const view = readNodesView(deps);
  const nodes = lane === null ? view.nodes : nodesThatCanTake(view, lane);
  const placement = lane === null ? null : chooseNodeForLane(view, lane);
  const discovered = discover ? view.nodes.filter(node => !node.joined) : [];
  if (json) {
    console.log(JSON.stringify({ ...view, ...(discover ? { discovered } : {}), ...(lane === null ? {} : { canTake: lane, placement }), nodes }, null, 2));
    return 0;
  }
  const empty = lane === null ? 'No computers known.' : `No computer can take a ${lane} job now. Run \`phm nodes\` to see why.`;
  const choice = placement?.node ? [`Suggested computer: ${placement.node}. ${placement.explanation}`] : [];
  const only = lane === null && nodes.length === 1 && nodes[0]!.isSelf ? ['Only this Mac.'] : [];
  const found = discover ? ['', discovered.length ? 'Not joined (on your Tailscale network):' : 'No computers waiting to join.',
    ...discovered.map(node => `${node.name} (${node.reachable === true ? 'online' : node.reachable === false ? 'offline' : 'unknown'}): not joined. On ${node.name}, run: ${node.joinCommand}`)] : [];
  console.log([...choice, ...(nodes.length ? nodes.map(line) : [empty]), ...found, ...only, ...view.reasons.map(reason => `note: ${reason}`)].join('\n'));
  return 0;
}
