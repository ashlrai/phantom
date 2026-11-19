import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import type { HostLoadReport } from './host-load.js';

/**
 * Who owns the machine's load, by producer, and what the admission guard says about it. Read-only: it reads the
 * grouped host report, queue/admission-ctl.json and the job logs' modified times. It never kills, probes or calls a model.
 */
export const LOAD_OWNERS_SCHEMA = 'host.load.owners.v1';
export const IDLE_LOG_MINUTES = 45;
/** ps CPU (100 = one busy core) below which a job is not "using CPU". */
export const IDLE_CPU_PERCENT = 5;

export type LoadProducerId = 'dispatchd-jobs' | 'claude-loop' | 'devin-cloud' | 'local-models' | 'guardian' | 'other';
const PRODUCERS: ReadonlyArray<{ id: LoadProducerId; name: string; fleet: boolean }> = [
  { id: 'dispatchd-jobs', name: 'fleet jobs', fleet: true },
  { id: 'claude-loop', name: 'Claude loop jobs', fleet: true },
  { id: 'devin-cloud', name: 'Devin cloud jobs', fleet: true },
  { id: 'local-models', name: 'local model', fleet: false },
  { id: 'guardian', name: 'main guardian', fleet: false },
  { id: 'other', name: 'other', fleet: false },
];
const producerOfJob = (job: string): LoadProducerId =>
  /^RQ-CL-/.test(job) ? 'claude-loop' : /^RQ-(?:DVL|DEVINCLOUD)-/.test(job) ? 'devin-cloud' : 'dispatchd-jobs';

export interface LoadProducer {
  id: LoadProducerId; name: string; cpuPercent: number;
  /** Whole points of the machine's CPU use; the producers sum to exactly 100 (0 each when nothing is running). */
  sharePercent: number;
  /** That share of load1, one decimal; null when load1 is unknown. */
  loadPoints: number | null;
}
export interface LoadAdmission {
  state: 'waiting' | 'open' | 'unknown';
  /** The guard's own reason, plain characters only. */
  why: string | null; settleSeconds: number | null; load1: number | null; ownedLoad1: number | null;
}
export interface IdleJob { job: string; cpuPercent: number; idleMinutes: number }
export interface LoadOwners {
  schema: typeof LOAD_OWNERS_SCHEMA; version: 1;
  /** One plain line, shared by the CLI and the Fleet card. */
  summary: string;
  /** The one thing to do about it. */
  nextStep: string;
  /** Share of CPU use that is fleet jobs, whole points. */
  fleetSharePercent: number;
  admission: LoadAdmission;
  producers: LoadProducer[];
  /** Jobs with no log output for IDLE_LOG_MINUTES that still use CPU. */
  idleJobs: IdleJob[];
}

export interface LoadOwnerInputs {
  admission?: Partial<LoadAdmission> | null;
  /** Job id to the time its log last changed (ms); a missing job has no known log. */
  logMtimes?: ReadonlyMap<string, number>;
  now?: number;
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const plain = (text: string): string => text.replace(/[^\w .,:;()%+/=-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Pure: the admission state in the guard's own fields (why, settle_s, load1, owned_load1). Anything else is unknown. */
export function parseAdmissionCtl(text: string | null): LoadAdmission {
  let raw: Record<string, unknown> | null = null;
  try { const value: unknown = JSON.parse(text ?? 'null'); raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { /* unknown */ }
  if (!raw) return { state: 'unknown', why: null, settleSeconds: null, load1: null, ownedLoad1: null };
  const why = typeof raw.why === 'string' && plain(raw.why) ? plain(raw.why) : null;
  const settleSeconds = num(raw.settle_s);
  return { state: why !== null || (settleSeconds ?? 0) > 0 ? 'waiting' : 'open', why, settleSeconds, load1: num(raw.load1), ownedLoad1: num(raw.owned_load1) };
}

/** Pure: groups a host load report by producer and writes the plain-words answer. */
export function summarizeLoadOwners(report: HostLoadReport, input: LoadOwnerInputs = {}): LoadOwners {
  const now = input.now ?? Date.now();
  const cpu = new Map<LoadProducerId, number>(PRODUCERS.map(p => [p.id, 0]));
  const add = (id: LoadProducerId, value: number) => cpu.set(id, (cpu.get(id) ?? 0) + value);
  const idleJobs: IdleJob[] = [];
  for (const group of report.groups) {
    // Items are capped at five outside fleet workers, so the remainder of a group stays with the group's own producer.
    let counted = 0;
    for (const item of group.items) {
      if (group.id === 'fleet-workers') {
        add(producerOfJob(item.name), item.cpuPercent); counted += item.cpuPercent;
        const changed = input.logMtimes?.get(item.name);
        const idleMinutes = changed === undefined ? 0 : Math.floor((now - changed) / 60_000);
        if (item.cpuPercent >= IDLE_CPU_PERCENT && idleMinutes > IDLE_LOG_MINUTES) idleJobs.push({ job: item.name, cpuPercent: item.cpuPercent, idleMinutes });
      } else if (/guardian/i.test(item.name)) { add('guardian', item.cpuPercent); counted += item.cpuPercent; }
    }
    add(group.id === 'local-models' ? 'local-models' : group.id === 'fleet-workers' ? 'dispatchd-jobs' : 'other', Math.max(0, group.cpuPercent - counted));
  }
  const total = [...cpu.values()].reduce((sum, v) => sum + v, 0);
  // Largest remainder, so the whole points add up to exactly 100.
  const exact = PRODUCERS.map(p => (total > 0 ? (100 * cpu.get(p.id)!) / total : 0));
  const shares = exact.map(Math.floor);
  let left = total > 0 ? 100 - shares.reduce((sum, v) => sum + v, 0) : 0;
  for (const [, i] of exact.map((v, index) => [v - Math.floor(v), index] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])) {
    if (left-- <= 0) break;
    shares[i]!++;
  }
  const producers: LoadProducer[] = PRODUCERS.map((p, i) => ({
    id: p.id, name: p.name, cpuPercent: Math.round(cpu.get(p.id)! * 10) / 10, sharePercent: shares[i]!,
    loadPoints: report.load1 === null ? null : Math.round((report.load1 * shares[i]!) / 10) / 10,
  }));
  const fleetSharePercent = producers.filter((_, i) => PRODUCERS[i]!.fleet).reduce((sum, p) => sum + p.sharePercent, 0);
  const admission: LoadAdmission = { state: 'unknown', why: null, settleSeconds: null, load1: null, ownedLoad1: null, ...input.admission };
  const top = [...producers].filter(p => p.sharePercent > 0).sort((a, b) => (a.id === 'other' ? 1 : 0) - (b.id === 'other' ? 1 : 0) || b.sharePercent - a.sharePercent)[0];
  const ownedPercent = admission.ownedLoad1 !== null && admission.load1 !== null && admission.load1 > 0
    ? Math.min(100, Math.round((100 * admission.ownedLoad1) / admission.load1)) : fleetSharePercent;
  const topWords = top ? `top owner: ${top.name} ${top.sharePercent}%` : 'top owner: none (nothing is using the processor)';
  const idle = idleJobs.sort((a, b) => b.idleMinutes - a.idleMinutes)[0];
  const state = admission.state === 'unknown'
    ? `load: ${report.load1 === null ? 'unknown' : Math.round(report.load1)}, ${ownedPercent}% fleet jobs; ${topWords}`
    : `${admission.state === 'waiting' ? `waiting${admission.why ? ` (${admission.why})` : ': machine busy'}` : 'open: starting jobs'}, ${ownedPercent}% of the load is fleet jobs; ${topWords}`;
  const summary = idle ? `${state}; job ${idle.job} has had no log output for ${idle.idleMinutes} minutes but still uses ${idle.cpuPercent}% CPU` : state;
  const nextStep = idle ? `Look at job ${idle.job}: it may be stuck. Its log is ${join('~/.ashlr-runs', `${idle.job}.log`)}.`
    : admission.state === 'waiting' && top && !PRODUCERS.find(p => p.id === top.id)!.fleet && top.id !== 'other'
      ? `Pause or quit the ${top.name}; the fleet starts more jobs once load drops.`
      : admission.state === 'waiting' ? 'Wait: the fleet will start more jobs once load drops.'
        : 'Nothing to do.';
  return { schema: LOAD_OWNERS_SCHEMA, version: 1, summary, nextStep, fleetSharePercent, admission, producers, idleJobs };
}

/** The impure half: admission-ctl.json and each fleet job's log time. Never throws; a missing file is unknown. */
export function readLoadOwnerInputs(report: HostLoadReport, runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): LoadOwnerInputs {
  const file = readStableRegularFile(join(runsDir, 'queue', 'admission-ctl.json'), { anchorPath: runsDir, maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024 });
  const logMtimes = new Map<string, number>();
  for (const job of report.groups.find(g => g.id === 'fleet-workers')?.items ?? []) {
    try {
      const stat = lstatSync(join(runsDir, `${job.name}.log`));
      if (stat.isFile()) logMtimes.set(job.name, stat.mtimeMs);
    } catch { /* No log: the job is not flagged idle. */ }
  }
  return { admission: parseAdmissionCtl(file.ok ? file.text : null), logMtimes };
}
