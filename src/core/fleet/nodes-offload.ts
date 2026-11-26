/**
 * core/fleet/nodes-offload.ts: `phm nodes offload`, an opt-in rule that sends a
 * ready job to another computer when this one would hold the launch.
 *
 * The rule: this computer's guard is busy (over load, or the memory gate says
 * hold) AND another computer passes `phm nodes doctor` with a free slot for the
 * job's lane -> pick that computer, record one typed event with the reason.
 * Otherwise the job keeps waiting here. It never touches a job that is already
 * running, never plans more jobs than a computer has free slots, and shows a
 * fact it cannot read as "unknown" (an unknown host guard offloads nothing).
 *
 * Default is off. Dry-run (and an off setting) records nothing. A recorded
 * event is the decision only: handing the job to the other computer is the
 * node dispatch step, which this module does not run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import type { QueueOrderJob, QueueOrderV1 } from '../queue/order-types.js';
import { hostLoadTone, type HostLoad } from './host-load.js';
import type { LoadAdmission } from './load-owners.js';
import type { EngineAdmissionView } from './engine-admission-view.js';
import { readNodesDoctor, type DoctorNode, type NodesDoctor, type NodesDoctorDeps } from './nodes-doctor.js';
import { PLAN_JOB_LIMIT } from './nodes-plan.js';
import { UNKNOWN } from './runtime-identity.js';
import { capServesLane, readNodesView, type NodeRow, type NodesView } from './nodes-view.js';

export const NODES_OFFLOAD_SCHEMA = 'phantom.nodes-offload.v1';
export const NODES_OFFLOAD_EVENT_SCHEMA = 'phantom.nodes-offload-event.v1';
export const NODES_OFFLOAD_SETTING_SCHEMA = 'phantom.nodes-offload-setting.v1';

export type HoldReason = 'load' | 'memory';
export interface HostGuard {
  /** busy: this computer would hold a launch. fine: it would launch. unknown: a reading is missing and nothing says busy. */
  state: 'busy' | 'fine' | 'unknown';
  reasons: HoldReason[];
  /** Plain words. */
  why: string;
}
export interface OffloadMove { job: string; lane: string; node: string; reasons: HoldReason[]; why: string }
export interface OffloadStay { job: string; lane: string; why: string }
export interface NodesOffload {
  schema: typeof NODES_OFFLOAD_SCHEMA;
  schemaVersion: 1;
  asOf: string;
  /** The saved setting; off unless someone turned it on. */
  enabled: boolean;
  /** dry-run records nothing. live: the setting is on and moves were recorded as events. */
  mode: 'dry-run' | 'live';
  host: HostGuard;
  moves: OffloadMove[];
  stays: OffloadStay[];
  /** Events written this run (0 for a dry run or an off setting). */
  recorded: number;
  /** One plain sentence. */
  summary: string;
  /** Gaps in the evidence, in plain words. */
  reasons: string[];
}
export interface NodesOffloadEvent {
  schema: typeof NODES_OFFLOAD_EVENT_SCHEMA;
  schemaVersion: 1;
  at: string;
  job: string;
  lane: string;
  from: string;
  to: string;
  reasons: HoldReason[];
  why: string;
}

// ── Pure: would this computer hold a launch? ───────────────────────────────────────────────────────────────

export interface HostGuardInputs { load: HostLoad; admission: LoadAdmission; memory: EngineAdmissionView }

export function assessHostGuard({ load, admission, memory }: HostGuardInputs): HostGuard {
  const reasons: HoldReason[] = [];
  const words: string[] = [];
  // The launch guard's own word wins; the load ratio only speaks when the guard says nothing.
  if (admission.state === 'waiting') { reasons.push('load'); words.push(`launch guard is waiting${admission.why ? ` (${admission.why})` : ': machine busy'}`); }
  else if (admission.state === 'unknown' && hostLoadTone(load.ratio) === 'bad') { reasons.push('load'); words.push(`load is ${load.ratio!.toFixed(1)}x the cores`); }
  if (memory.gated && memory.allowed === false) { reasons.push('memory'); words.push(`memory gate holds launches${memory.reason ? ` (${memory.reason})` : ''}`); }
  if (reasons.length) return { state: 'busy', reasons, why: `This computer would hold a launch: ${words.join('; ')}.` };
  const loadKnown = admission.state === 'open' || load.ratio !== null;
  const memoryKnown = !memory.gated || memory.allowed !== null;
  if (loadKnown && memoryKnown) return { state: 'fine', reasons: [], why: 'This computer would launch now.' };
  const missing = [...(loadKnown ? [] : ['load']), ...(memoryKnown ? [] : ['memory'])].join(' and ');
  return { state: 'unknown', reasons: [], why: `This computer's ${missing} could not be read; nothing is moved.` };
}

// ── Pure: which ready jobs would move, and where ───────────────────────────────────────────────────────────

export interface OffloadInputs {
  host: HostGuard;
  view: NodesView;
  doctor: NodesDoctor;
  queue: QueueOrderV1 | null;
  /** Jobs that already have an offload event. */
  recorded: ReadonlySet<string>;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The job lanes this computer can serve: the advertised caps a doctor-ready
 * lane vouches for. Provider lanes share their cap name; `local-model` is the
 * report category for the oMLX family (`omlx`, `omlx-<tier>`), so it serves
 * exactly the advertised omlx caps — never the category name or a `pack:*`
 * runner cap. A lane the node did not advertise serves nothing: the worker's
 * requires check would refuse the job. */
function servableLanes(row: NodeRow, report: DoctorNode): Set<string> {
  const lanes = new Set<string>();
  if (row.lanes === UNKNOWN) return lanes;
  for (const check of report.lanes) {
    if (check.status !== 'ready') continue;
    for (const cap of row.lanes) if (capServesLane(cap, check.lane)) lanes.add(cap);
  }
  return lanes;
}

function candidates(view: NodesView, doctor: NodesDoctor, reasons: string[]): Array<{ row: NodeRow; lanes: Set<string>; slots: number }> {
  const out: Array<{ row: NodeRow; lanes: Set<string>; slots: number }> = [];
  for (const row of view.nodes) {
    if (row.isSelf) continue;
    const report = doctor.nodes.find(n => n.name === row.name);
    if (!report) continue;
    if (!report.ready) { reasons.push(`${row.name} does not pass \`phm nodes doctor\` yet${report.unknowns.length ? ' (some facts are unknown)' : ''}`); continue; }
    if (row.stateCode !== 'ready' || row.reachable !== true) { reasons.push(`${row.name} is not ready: ${row.state}`); continue; }
    if (typeof row.freeSlots !== 'number') { reasons.push(`${row.name}: free slots unknown`); continue; }
    if (row.freeSlots > 0) out.push({ row, lanes: servableLanes(row, report), slots: row.freeSlots });
  }
  return out;
}

export function planOffload(input: OffloadInputs): { moves: OffloadMove[]; stays: OffloadStay[]; reasons: string[] } {
  const { host, view, doctor, queue, recorded } = input;
  const reasons: string[] = [];
  const moves: OffloadMove[] = [];
  const stays: OffloadStay[] = [];
  if (!queue) return { moves, stays, reasons: ['queue unreadable; ready jobs unknown'] };
  const jobs: QueueOrderJob[] = queue.jobs.slice(0, PLAN_JOB_LIMIT);
  if (queue.jobs.length > PLAN_JOB_LIMIT) reasons.push(`only the first ${PLAN_JOB_LIMIT} of ${queue.jobs.length} ready jobs were looked at`);
  const running = new Set(view.nodes.flatMap(n => (n.jobsRunning === UNKNOWN ? [] : n.jobsRunning)));
  const pool = host.state === 'busy' ? candidates(view, doctor, reasons) : [];
  for (const job of jobs) {
    const stay = (why: string) => stays.push({ job: job.id, lane: job.lane, why });
    if (running.has(job.id)) { stay('already running; running jobs are never moved'); continue; }
    if (recorded.has(job.id)) { stay('already chosen for another computer'); continue; }
    if (host.state === 'fine') { stay('this computer would launch it'); continue; }
    if (host.state === 'unknown') { stay('this computer\'s guard is unknown; waiting here'); continue; }
    const open = pool.filter(c => c.slots > 0 && c.lanes.has(job.lane)).sort((a, b) => b.slots - a.slots || (a.row.name < b.row.name ? -1 : 1))[0];
    if (!open) { stay(`no ready computer has a free ${job.lane} slot; waiting here`); continue; }
    open.slots -= 1;
    moves.push({ job: job.id, lane: job.lane, node: open.row.name, reasons: host.reasons, why: `${host.reasons.join(' and ')} on this computer; ${open.row.name} passes the doctor with a free ${job.lane} slot` });
  }
  return { moves, stays, reasons: [...new Set(reasons)] };
}

// ── Setting and events (the only writes) ───────────────────────────────────────────────────────────────────

const settingPath = () => join(ashlrHome(), 'nodes-offload.json');
const eventsPath = () => join(ashlrHome(), 'nodes-offload-events.jsonl');

/** Off unless the file says `enabled: true`; an unreadable file is off. */
export function readOffloadEnabled(path = settingPath()): boolean {
  try { return (JSON.parse(readFileSync(path, 'utf8')) as { enabled?: unknown }).enabled === true; } catch { return false; }
}

export function writeOffloadEnabled(enabled: boolean, now = new Date(), path = settingPath()): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema: NODES_OFFLOAD_SETTING_SCHEMA, enabled, updatedAt: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Job ids that already have an event, so a second run does not record the same choice twice. */
export function readRecordedOffloads(path = eventsPath()): Set<string> {
  const jobs = new Set<string>();
  if (!existsSync(path)) return jobs;
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      try { const event = JSON.parse(line) as Partial<NodesOffloadEvent>; if (event.schema === NODES_OFFLOAD_EVENT_SCHEMA && typeof event.job === 'string') jobs.add(event.job); } catch { /* skip a bad line */ }
    }
  } catch { /* unreadable: nothing recorded */ }
  return jobs;
}

export function recordOffloadMoves(moves: OffloadMove[], from: string, now: Date, path = eventsPath()): number {
  if (!moves.length) return 0;
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const events: NodesOffloadEvent[] = moves.map(m => ({ schema: NODES_OFFLOAD_EVENT_SCHEMA, schemaVersion: 1, at: now.toISOString(), job: m.job, lane: m.lane, from, to: m.node, reasons: m.reasons, why: m.why }));
  appendFileSync(path, events.map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
  return events.length;
}

// ── Read every source through its seam ─────────────────────────────────────────────────────────────────────

export interface NodesOffloadDeps extends NodesDoctorDeps {
  readQueue(): Promise<QueueOrderV1>;
  readHost(): HostGuardInputs;
  readEnabled?: () => boolean;
  readRecorded?: () => Set<string>;
  record?: (moves: OffloadMove[], from: string, now: Date) => number;
  now?: () => Date;
}

/** Never throws. `dryRun` or an off setting records nothing. */
export async function readNodesOffload(deps: NodesOffloadDeps, opts: { dryRun: boolean }): Promise<NodesOffload> {
  const now = (deps.now ?? (() => new Date()))();
  const enabled = (deps.readEnabled ?? readOffloadEnabled)();
  let host: HostGuard;
  try { host = assessHostGuard(deps.readHost()); } catch { host = { state: 'unknown', reasons: [], why: 'This computer\'s guard could not be read; nothing is moved.' }; }
  const view = readNodesView(deps.view);
  const doctor = await readNodesDoctor(deps);
  const queue = await deps.readQueue().catch(() => null);
  const recorded = (deps.readRecorded ?? readRecordedOffloads)();
  const plan = planOffload({ host, view, doctor, queue, recorded });
  const live = enabled && !opts.dryRun;
  const written = live ? (deps.record ?? recordOffloadMoves)(plan.moves, view.self, now) : 0;
  const n = plan.moves.length;
  const summary = host.state !== 'busy' ? `${host.why} No job moves.`
    : n === 0 ? `${host.why} No computer is ready, so ${plan.stays.length ? 'jobs keep waiting here' : 'nothing is queued'}.`
      : !enabled ? `Offload is off. ${count(n, 'job would', 'jobs would')} move if you run \`phm nodes offload on\`.`
        : live ? `${count(written, 'job', 'jobs')} chosen for another computer.` : `${count(n, 'job would', 'jobs would')} move (dry run, nothing recorded).`;
  return { schema: NODES_OFFLOAD_SCHEMA, schemaVersion: 1, asOf: view.asOf, enabled, mode: live ? 'live' : 'dry-run', host, moves: plan.moves, stays: plan.stays, recorded: written, summary, reasons: [...view.reasons, ...plan.reasons] };
}

export function offloadText(report: NodesOffload): string {
  return [
    `Offload is ${report.enabled ? 'on' : 'off'}${report.mode === 'dry-run' ? ' (dry run)' : ''}.`,
    report.summary,
    ...report.moves.map(m => `  ${m.job} -> ${m.node}: ${m.why}`),
    ...report.stays.slice(0, 10).map(s => `  ${s.job} stays: ${s.why}`),
    ...(report.stays.length > 10 ? [`  ...and ${report.stays.length - 10} more stay here.`] : []),
    ...report.reasons.map(r => `note: ${r}`),
  ].join('\n');
}
