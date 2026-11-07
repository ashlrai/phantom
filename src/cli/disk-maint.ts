/**
 * `phm disk-maint` - standing disk maintenance for the fleet host.
 *
 * Dry run by default: plans every reclaim class, prints the bytes each would
 * free, touches nothing. `--apply` runs the plan - rotating and compressing
 * quiet logs, pruning dead session leftovers, stale staging and recovery
 * dirs, and removing merged worktrees through `git worktree remove` - then
 * prints the bytes actually freed per class. `--only` narrows the run to
 * named classes; `--allow venvs|hub-claude` opts in the gated rebuildables.
 *
 * The protect-list (src/core/disk-maint/protect.ts) is unconditional: no flag
 * reaches ~/.codex*, HF/oMLX/model weights, Docker, client trees, ~/Documents,
 * git internals, auth or secrets. DISKGUARD's 100 GB reuse line is reported
 * for context and never changed. `phm disk-maint schedule` installs the
 * daily launchd/systemd job.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';
import {
  ALL_CLASSES, GATED_CLASSES, planDiskMaint,
  resolveMaintRoots, type DiskMaintPlan, type MaintClassId, type MaintDeps, type MaintPolicy,
  type MaintRoots,
} from '../core/disk-maint/plan.js';
import { applyDiskMaint, type ApplyDeps } from '../core/disk-maint/apply.js';
import { diskMaintSchedule } from '../core/disk-maint/schedule.js';
import { installScheduleUnits } from './steward.js';

const USAGE =
  'usage: phm disk-maint [--apply] [--json] [--only <class>]... [--allow <class>]... ' +
  '[--compress-days N] [--prune-days N]\n' +
  '       phm disk-maint schedule [--install] [--apply] [--hour 0-23]\n' +
  `classes: ${ALL_CLASSES.join(', ')}  (gated: ${[...GATED_CLASSES].join(', ')})`;

type Output = { log: (message: string) => void; error: (message: string) => void };

export interface DiskMaintCliDeps extends ApplyDeps {
  output?: Output;
  platform?: NodeJS.Platform;
  phmPath?: string;
  built?: () => boolean;
  /** Plan-side injections (tests): jobs ledger, pins, free-space, measure. */
  plan?: Omit<MaintDeps, 'roots' | 'only' | 'allow' | 'policy' | 'now' | 'deadlineMs'>;
  deadlineMs?: number;
}

const gb = (bytes: number): string => `${Math.round((bytes / 1e9) * 10) / 10} GB`;

function schedule(argv: string[], deps: DiskMaintCliDeps): number {
  const out = deps.output ?? { log: console.log, error: console.error };
  let hour: number | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!['--hour', '--install', '--apply'].includes(arg) || flags.has(arg)) {
      out.error(`error: unknown or repeated argument: ${arg}\n${USAGE}`);
      return 2;
    }
    flags.add(arg);
    if (arg === '--hour') {
      const value = argv[++i];
      if (value === undefined || !/^\d{1,2}$/.test(value) || Number(value) > 23) {
        out.error('error: --hour requires an integer from 0 to 23');
        return 2;
      }
      hour = Number(value);
    }
  }
  try {
    const phmPath = deps.phmPath ?? fileURLToPath(new URL('../../bin/ashlr', import.meta.url));
    const units = diskMaintSchedule({ phmPath, apply: flags.has('--apply'), hour, platform: deps.platform });
    if (!flags.has('--install')) {
      for (const unit of units) out.log(`# ${unit.path}\n${unit.contents}`);
      out.log('Re-run with --install to enable (report-only unless --apply).');
      return 0;
    }
    if (process.getuid?.() === 0) throw new Error('Install disk-maint as a regular user, not root.');
    const built = deps.built ?? (() => existsSync(fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))));
    if (!built()) throw new Error('Compiled CLI missing; run npm run build before installing the schedule.');
    const code = installScheduleUnits(units, { logName: 'disk-maint.jsonl' });
    if (code !== 0) return code;
    out.log(`disk-maint scheduled daily (${flags.has('--apply') ? 'apply' : 'report-only'}).`);
    return 0;
  } catch (error) {
    out.error(`error: ${(error as Error).message}`);
    return 1;
  }
}

/** Human view: one line per class, refused evidence, then the freed total. */
export function formatDiskMaint(plan: DiskMaintPlan, applied?: Awaited<ReturnType<typeof applyDiskMaint>>): string[] {
  const lines: string[] = [applied ? 'disk maintenance - applied' : 'disk maintenance - dry run, deletes nothing'];
  const freeGb = applied ? applied.freeGb : plan.freeGb;
  lines.push(`free now: ${freeGb === null ? 'unknown' : `${freeGb} GB`} (DISKGUARD reuse line: ${plan.diskguardReuseOnlyGb} GB, unchanged)`);
  if (plan.jobsSource !== 'healthy') lines.push(`jobs ledger ${plan.jobsSource === 'missing' ? 'missing' : 'unreadable'} - worktrees stay kept, logs fall to orphan ages`);
  const results = new Map(applied?.classes.map(c => [c.id, c]) ?? []);
  for (const cls of plan.classes) {
    const result = results.get(cls.id);
    const tag = cls.gated && !cls.enabled ? ` - gated, ${cls.note ?? 'off'}` : '';
    const freed = result ? ` - freed ${gb(result.freedBytes)}${result.failures ? `, ${result.failures} failed` : ''}${result.refusals ? `, ${result.refusals} refused` : ''}` : '';
    lines.push(`${cls.id}: ${cls.candidates.length} items, ${gb(cls.bytes)}${cls.complete ? '' : ' (partial scan)'}${tag}${freed}`);
    for (const r of result?.results ?? []) {
      if (r.status === 'done') lines.push(`  done: ${r.path} - ${gb(r.freedBytes)}${r.detail ? ` (${r.detail})` : ''}`);
      else if (r.status === 'failed') lines.push(`  FAILED: ${r.path} - ${r.detail ?? 'error'}`);
      else lines.push(`  refused: ${r.path} - ${r.detail ?? 'protected'}`);
    }
  }
  if (plan.refused.length) lines.push(`protect-list refusals during scan: ${plan.refused.length}`);
  if (applied) lines.push(`freed: ${gb(applied.totals.freedBytes)} total${applied.totals.failures ? ` (${applied.totals.failures} failures)` : ''}`);
  else lines.push(`reclaimable: ${gb(plan.totals.bytes)} across ${plan.totals.candidates} items${plan.totals.complete ? '' : ' (partial scan - byte counts are floors)'} - re-run with --apply`);
  return lines;
}

export async function cmdDiskMaint(args: string[], deps: DiskMaintCliDeps = {}): Promise<number> {
  const out = deps.output ?? { log: console.log, error: console.error };
  // --help anywhere wins before any flag pair is acted on: a typo'd --aply
  // used to run a silent dry run; --apply --help must never delete.
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    out.log('phm disk-maint - standing disk maintenance for the fleet host.\n' + USAGE + '\n' +
      'Dry run unless --apply. Reclaims rebuildable bytes only: rotates and\n' +
      'compresses quiet logs, prunes dead agent session leftovers, stale\n' +
      'staging and recovery dirs, and removes merged worktrees via git.\n' +
      'Never touches ~/.codex*, model weights, Docker, client trees,\n' +
      '~/Documents, git internals, auth or secrets - no flag unprotects them.\n' +
      '`schedule` prints or installs the daily launchd/systemd timer.');
    return 0;
  }
  const [sub, ...rest] = args;
  if (sub === 'schedule') return schedule(rest, deps);
  const argv = args;
  let apply = false;
  let json = false;
  const only = new Set<MaintClassId>();
  const allow = new Set<string>();
  const policy: Partial<MaintPolicy> = {};
  const rootOverrides: Partial<MaintRoots> = {};
  const ROOT_FLAGS: Record<string, 'home' | 'runsDir' | 'ashlrDir' | 'wtDir' | 'sideProjectsDir' | 'hubDir'> = {
    '--home': 'home', '--runs-dir': 'runsDir', '--ashlr-dir': 'ashlrDir',
    '--wt-dir': 'wtDir', '--side-projects': 'sideProjectsDir', '--hub-dir': 'hubDir',
  };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (seen.has(arg)) { out.error(`error: duplicate option: ${arg}\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--only' || arg === '--allow') {
      const value = argv[++i];
      if (!value) { out.error(`error: ${arg} needs a class name\n${USAGE}`); return 2; }
      for (const name of value.split(',')) {
        if (arg === '--allow') {
          if (!GATED_CLASSES.has(name as MaintClassId)) { out.error(`error: --allow only takes: ${[...GATED_CLASSES].join(', ')}\n${USAGE}`); return 2; }
          allow.add(name);
        } else {
          if (!ALL_CLASSES.includes(name as MaintClassId)) { out.error(`error: unknown class: ${name}\n${USAGE}`); return 2; }
          only.add(name as MaintClassId);
        }
      }
    } else if (arg === '--compress-days' || arg === '--prune-days') {
      const value = argv[++i];
      if (!value || !/^\d{1,4}$/.test(value) || Number(value) < 1) { out.error(`error: ${arg} needs a positive day count\n${USAGE}`); return 2; }
      if (arg === '--compress-days') policy.compressAfterDays = Number(value);
      else policy.deleteAfterDays = Number(value);
    } else if (ROOT_FLAGS[arg]) {
      const value = argv[++i];
      if (!value || !isAbsolute(value)) { out.error(`error: ${arg} needs an absolute path\n${USAGE}`); return 2; }
      rootOverrides[ROOT_FLAGS[arg]!] = value;
    } else {
      out.error(`error: ${arg.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (policy.compressAfterDays !== undefined && policy.deleteAfterDays !== undefined && policy.compressAfterDays >= policy.deleteAfterDays) {
    out.error('error: --compress-days must be below --prune-days');
    return 2;
  }
  const roots = deps.roots ?? resolveMaintRoots(rootOverrides);
  const plan = await planDiskMaint({
    ...deps.plan, roots, only: only.size ? only : undefined, allow, policy, now: deps.now,
    deadlineMs: deps.deadlineMs,
  });
  const applied = apply ? await applyDiskMaint(plan, { roots, runner: deps.runner, now: deps.now, readJobs: deps.readJobs, freeBytes: deps.freeBytes }) : undefined;
  if (json) {
    out.log(JSON.stringify(sanitizePublicJson({ ...plan, apply, ...(applied ? { freeGb: applied.freeGb, results: applied.classes, totals: { ...plan.totals, freedBytes: applied.totals.freedBytes, failures: applied.totals.failures } } : {}) }), null, 2));
  } else {
    for (const line of formatDiskMaint(plan, applied)) out.log(line);
  }
  return (applied?.totals.failures ?? 0) > 0 ? 1 : 0;
}
