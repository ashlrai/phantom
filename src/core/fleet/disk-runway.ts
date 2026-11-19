/**
 * Disk runway: how many hours of free disk are left before launches freeze.
 *
 * One read-only answer for `phm disk runway`, GET /api/verse/fleet/disk-runway and the Leader alert:
 * free GB now, GB lost per hour over the last 6 hours, hours until the 60 GB launch freeze, how many
 * worktrees there are, and the ten largest grouped by the `phm disk --plan` classifier (#7115, reused
 * through readDiskPlan; there is no second classifier). Nothing here deletes anything.
 *
 * Free-disk readings come from the fleet sampler's history plus one live reading (readDiskSamples).
 * The alert pass posts one plain line when hours-to-freeze drops under 6, then stays quiet until the
 * runway clears; state lives next to the plan-pace alerts in the Leader folder.
 */
import { join } from 'node:path';
import { FLEET_DISK_LANE_FREEZE_GB } from '../../cli/fleet-disk.js';
import { WORKTREE_RESULTS, type PlanFolder, type WorktreeResult } from '../disk-maint/removal-plan.js';
import type { DiskPlanReportV1 } from '../disk-maint/removal-plan.js';
import type { HostDiskSample } from './host-top-view.js';

export const DISK_RUNWAY_SCHEMA = 'fleet.disk-runway.v1';
export const DISK_RUNWAY_WINDOW_HOURS = 6;
export const DISK_RUNWAY_ALERT_HOURS = 6;
/** Two readings closer than this say nothing reliable about a rate. */
const MIN_SPAN_HOURS = 0.25;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export const RESULT_WORDS: Record<WorktreeResult, string> = {
  'pr-merged': 'merged PR', empty: 'empty', 'publish-aborted': 'unpublished', 'pr-closed': 'closed PR',
  'pr-open': 'open PR', running: 'running', unknown: 'unknown',
};
/** The three groups the operator asked about come first. */
const GROUP_ORDER: readonly WorktreeResult[] = ['pr-merged', 'empty', 'publish-aborted',
  ...WORKTREE_RESULTS.filter(r => r !== 'pr-merged' && r !== 'empty' && r !== 'publish-aborted')];

export interface DiskRunwayGroup { result: WorktreeResult; label: string; count: number; gb: number; folders: PlanFolder[] }

export interface DiskRunwayV1 {
  schema: typeof DISK_RUNWAY_SCHEMA;
  generatedAt: string;
  freeGb: number | null;
  /** Readings inside the window, the live one included. */
  samples: number;
  windowHours: number;
  /** GB of free disk lost per hour; negative when free space grew; null with fewer than two spread-out readings. */
  gbPerHour: number | null;
  freezeGb: number;
  /** 0 when already at or under the freeze; null when unknown or not falling. */
  hoursToFreeze: number | null;
  status: 'frozen' | 'falling' | 'steady' | 'unknown';
  worktrees: number;
  /** Finished folders the removal plan calls safe; "could free" only, nothing is removed. */
  reclaim: { count: number; gb: number };
  /** The ten largest worktrees, grouped by result. */
  groups: DiskRunwayGroup[];
  /** The one plain sentence the CLI prints first and the desktop shows. */
  sentence: string;
  gaps: string[];
}

/** Rate and hours-to-freeze from the readings in the last 6 hours. Pure. */
export function diskRunwayTrend(samples: readonly HostDiskSample[], nowMs: number, freezeGb = FLEET_DISK_LANE_FREEZE_GB):
  Pick<DiskRunwayV1, 'freeGb' | 'samples' | 'gbPerHour' | 'hoursToFreeze' | 'status'> {
  const cutoff = nowMs - DISK_RUNWAY_WINDOW_HOURS * 3_600_000;
  const byAt = new Map<number, number>();
  for (const { at, freeGb } of samples) {
    if (Number.isFinite(at) && Number.isFinite(freeGb) && at >= 0 && freeGb >= 0 && at * 1000 <= nowMs && at * 1000 >= cutoff) byAt.set(at, freeGb);
  }
  const rows = [...byAt].sort((a, b) => a[0] - b[0]);
  const first = rows[0], last = rows.at(-1);
  if (!first || !last) return { freeGb: null, samples: 0, gbPerHour: null, hoursToFreeze: null, status: 'unknown' };
  const spanHours = (last[0] - first[0]) / 3600;
  const rate = spanHours >= MIN_SPAN_HOURS ? (first[1] - last[1]) / spanHours : null;
  const freeGb = round1(last[1]);
  const base = { freeGb, samples: rows.length, gbPerHour: rate === null ? null : round1(rate) };
  if (last[1] <= freezeGb) return { ...base, hoursToFreeze: 0, status: 'frozen' };
  if (rate === null) return { ...base, hoursToFreeze: null, status: 'unknown' };
  if (rate > 0.1) return { ...base, hoursToFreeze: round1((last[1] - freezeGb) / rate), status: 'falling' };
  return { ...base, hoursToFreeze: null, status: 'steady' };
}

const hoursWord = (h: number): string => `${h < 10 ? h : Math.round(h)} h`;

/** "Disk: 98 GB free, falling 19 GB an hour, 2 h to the launch freeze". Unknown is said as unknown. */
export function diskRunwaySentence(t: Pick<DiskRunwayV1, 'freeGb' | 'gbPerHour' | 'hoursToFreeze' | 'status' | 'freezeGb'>): string {
  if (t.freeGb === null) return 'Disk: free space unknown';
  const parts = [`${Math.round(t.freeGb)} GB free`];
  if (t.status === 'frozen') parts.push(`under the ${t.freezeGb} GB launch freeze`);
  else {
    if (t.gbPerHour !== null && t.gbPerHour > 0.1) parts.push(`falling ${Math.round(t.gbPerHour)} GB an hour`);
    else if (t.gbPerHour !== null) parts.push('not falling');
    if (t.hoursToFreeze !== null) parts.push(`${hoursWord(t.hoursToFreeze)} to the launch freeze`);
  }
  return `Disk: ${parts.join(', ')}`;
}

/** Fold readings and the #7115 removal plan into the report. Pure. */
export function buildDiskRunway(samples: readonly HostDiskSample[], plan: DiskPlanReportV1 | null, nowMs: number, freezeGb = FLEET_DISK_LANE_FREEZE_GB): DiskRunwayV1 {
  const trend = diskRunwayTrend(samples, nowMs, freezeGb);
  const groups: DiskRunwayGroup[] = [];
  for (const result of GROUP_ORDER) {
    const folders = (plan?.report.largest ?? []).filter(f => f.result === result);
    if (folders.length) groups.push({ result, label: RESULT_WORDS[result], count: folders.length, gb: round1(folders.reduce((s, f) => s + (f.gb ?? 0), 0)), folders });
  }
  const gaps = [...(plan?.gaps ?? [])];
  if (plan === null) gaps.push('Worktrees could not be read.');
  if (trend.samples < 2) gaps.push('Fewer than two free-disk readings in the last 6 hours, so the rate is unknown.');
  const reclaim = { count: plan?.report.plan.count ?? 0, gb: Math.round(plan?.report.plan.gb ?? 0) };
  return {
    schema: DISK_RUNWAY_SCHEMA, generatedAt: new Date(nowMs).toISOString(), ...trend,
    windowHours: DISK_RUNWAY_WINDOW_HOURS, freezeGb, worktrees: plan?.report.folders ?? 0, reclaim, groups,
    sentence: diskRunwaySentence({ ...trend, freezeGb }), gaps,
  };
}

export interface DiskRunwayDeps {
  now?: number;
  runsDir?: string;
  /** Injected readings; default is the sampler history plus one live reading. */
  samples?: () => Promise<HostDiskSample[]>;
  /** Injected removal plan; default is `phm disk --plan` (readDiskPlan). */
  plan?: () => Promise<DiskPlanReportV1>;
}

async function readSamples(deps: DiskRunwayDeps): Promise<HostDiskSample[]> {
  if (deps.samples) return deps.samples();
  const { readDiskSamples } = await import('./host-top.js');
  const { homedir } = await import('node:os');
  return readDiskSamples(deps.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'));
}

/** Read the readings, then the worktrees. Reads only; a failed reader shows as unknown, never zero. */
export async function readDiskRunway(deps: DiskRunwayDeps = {}): Promise<DiskRunwayV1> {
  const nowMs = deps.now ?? Date.now();
  const samples = await readSamples(deps).catch(() => []);
  let plan: DiskPlanReportV1 | null = null;
  try {
    plan = await (deps.plan ?? (async () => (await import('../../cli/disk.js')).readDiskPlan({
      now: nowMs, ...(deps.runsDir ? { runsRoot: deps.runsDir } : {}),
    })))();
  } catch { plan = null; }
  return buildDiskRunway(samples, plan, nowMs);
}

/** Plain lines for `phm disk runway`. Pure. */
export function formatDiskRunway(r: DiskRunwayV1): string[] {
  const lines = [r.sentence];
  lines.push(`free now: ${r.freeGb === null ? 'unknown' : `${r.freeGb} GB`}`);
  lines.push(`rate over the last ${r.windowHours} h: ${r.gbPerHour === null ? 'unknown' : r.gbPerHour > 0.1 ? `${r.gbPerHour} GB an hour` : 'not falling'}`);
  lines.push(`hours to the ${r.freezeGb} GB launch freeze: ${r.status === 'frozen' ? 'already there' : r.hoursToFreeze === null ? (r.status === 'steady' ? 'not at this rate' : 'unknown') : r.hoursToFreeze}`);
  lines.push(`worktrees: ${r.worktrees}`);
  if (r.reclaim.count > 0) lines.push(`${r.reclaim.count} finished worktrees could free about ${r.reclaim.gb} GB`);
  if (r.groups.length) {
    lines.push('largest worktrees:');
    for (const g of r.groups) {
      lines.push(`  ${g.label} (${g.count}, ${g.gb} GB):`);
      for (const f of g.folders) lines.push(`    ${f.jobId}  ${f.gb === null ? 'size unknown' : `${f.gb} GB`}`);
    }
  }
  for (const gap of r.gaps) lines.push(`Note: ${gap}`);
  lines.push('Read-only: nothing was removed.');
  return lines;
}

/** The Leader chat line, or null when there is nothing to warn about. */
export function diskAlertLine(r: DiskRunwayV1): string | null {
  if (r.status !== 'frozen' && !(r.hoursToFreeze !== null && r.hoursToFreeze < DISK_RUNWAY_ALERT_HOURS)) return null;
  const when = r.status === 'frozen' ? `under the ${r.freezeGb} GB launch freeze` : `${hoursWord(r.hoursToFreeze!)} to the launch freeze`;
  const tail = r.reclaim.count > 0 ? `; ${r.reclaim.count} finished worktrees could free about ${r.reclaim.gb} GB` : '';
  return `Disk: ${when}${tail}`;
}

/** Alert memory: true from the moment a line is posted until the runway clears. */
export interface DiskAlertState { active: boolean }

/** Pure: the line to post now (once per episode) and the state after it is posted. Unknown keeps the state. */
export function diskAlertStep(r: DiskRunwayV1, state: DiskAlertState): { post: string | null; state: DiskAlertState } {
  const line = diskAlertLine(r);
  if (line !== null) return { post: state.active ? null : line, state: { active: true } };
  if (r.status === 'unknown') return { post: null, state };
  return { post: null, state: { active: false } };
}

export interface DiskAlertDeps {
  stateDir: string;
  /** Synchronous so the locked read-post-write section never yields. Throws when the post fails. */
  post(text: string): void;
  /** Fuller runway (with the removal plan) read only when a line is about to be posted. */
  detail?: () => Promise<DiskRunwayV1>;
}

/** Post the line once when the runway drops under 6 h; a failed post leaves the state, so the next tick retries. */
export async function postDiskAlert(runway: DiskRunwayV1, deps: DiskAlertDeps): Promise<string[]> {
  const [{ acquireLocalStoreLockWithOutcome, releaseLocalStoreLock }, prefs] = await Promise.all([
    import('./local-store-lock.js'), import('../verse/preferences.js'),
  ]);
  prefs.ensurePrivateDirectory(deps.stateDir);
  const path = join(deps.stateDir, 'disk-alert.json');
  const lock = acquireLocalStoreLockWithOutcome(`${path}.lock`);
  if (lock.state !== 'acquired') return [];
  try {
    let state: DiskAlertState = { active: false };
    try { state = { active: JSON.parse(prefs.readPrivateFileCapped(path, 4096)?.text ?? '{}').active === true }; } catch { /* damaged: worst case one repeat line */ }
    const step = diskAlertStep(runway, state);
    let text = step.post;
    if (text !== null && deps.detail) text = diskAlertLine(await deps.detail().catch(() => runway)) ?? text;
    if (text !== null) { try { deps.post(text); } catch { return []; } }
    if (step.state.active !== state.active) prefs.writePrivateFileAtomic(path, `${JSON.stringify(step.state)}\n`);
    return text === null ? [] : [text];
  } finally { releaseLocalStoreLock(lock.lock); }
}

/** Production wiring for the Leader tick: read the runway, post the line to the Leader thread when due. */
export async function runDefaultDiskAlert(): Promise<string[]> {
  const [{ postLeaderMessage }, memo, samples] = await Promise.all([
    import('../vision/leader-thread.js'), import('../vision/leader-memo.js'), readSamples({}).catch(() => []),
  ]);
  const nowMs = Date.now();
  // Cheap first: the removal plan (a git scan per folder) is read only when a line is about to post.
  return postDiskAlert(buildDiskRunway(samples, null, nowMs), {
    stateDir: memo.leaderRoot(),
    post: text => { postLeaderMessage({ channel: 'telegram', kind: 'update', text }); },
    detail: () => readDiskRunway({ now: nowMs, samples: async () => samples }),
  });
}
