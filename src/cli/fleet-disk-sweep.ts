/** One command a host timer can run: free disk below the lane freeze line (or --force) → wt-cache, then worktree-stale. */
import { readFile, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetWorktreeStale } from './fleet-worktree-stale.js';
import { cmdFleetWtCache } from './fleet-wt-cache.js';
import { FLEET_DISK_LANE_FREEZE_GB, parseLaneDiskLines } from './fleet-disk.js';

const USAGE =
  'Usage: ashlr fleet disk-sweep [--force] [--apply] [--json]\n' +
  'When free disk is below the lane freeze line (compact.lanes.raise_freeze_below_gb in ~/.ashlr-runs/queue/budget-overrides.json, default 60 GB), or with --force, runs `fleet wt-cache` then `fleet worktree-stale` and prints one line per step with the GB freed. Dry run unless --apply, which is passed to both steps. Exits 0 ok, 1 when a step failed, 2 bad usage.';

const GB = 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface SweepStepResult { code: number; freedGb: number }
export interface SweepStep { name: 'wt-cache' | 'worktree-stale'; ran: boolean; code: number | null; freedGb: number }

export interface FleetDiskSweepView {
  v: 1;
  generatedAt: string;
  apply: boolean;
  force: boolean;
  freeGb: number | null;
  freezeBelowGb: number;
  /** false when free disk is at or above the freeze line and --force is absent. */
  swept: boolean;
  steps: SweepStep[];
  freedGb: number;
}

export interface FleetDiskSweepDeps {
  /** Free GB on the volume holding the worktrees; null when unreadable. */
  freeGb?: () => Promise<number | null>;
  /** Freeze line in GB; defaults to the budget-overrides.json value or 60. */
  freezeBelowGb?: () => Promise<number>;
  /** In-process wt-cache step; receives whether to apply. */
  wtCache?: (apply: boolean) => Promise<SweepStepResult>;
  /** In-process worktree-stale step; receives whether to apply. */
  worktreeStale?: (apply: boolean) => Promise<SweepStepResult>;
  now?: () => number;
}

async function defaultFreeGb(): Promise<number | null> {
  try {
    const s = await statfs(homedir());
    return Number(s.bavail) * Number(s.bsize) / GB;
  } catch {
    return null;
  }
}

async function defaultFreezeBelowGb(): Promise<number> {
  const runs = process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const text = await readFile(join(runs, 'queue', 'budget-overrides.json'), 'utf8').catch(() => '');
  return text ? parseLaneDiskLines(text).freezeBelowGb : FLEET_DISK_LANE_FREEZE_GB;
}

/** Runs a step handler with its own output captured; returns its exit code and stdout. */
async function captured(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { out += String(chunk); return true; }) as typeof process.stdout.write;
  console.log = () => {};
  try {
    return { code: await run(), out };
  } finally {
    process.stdout.write = realWrite;
    console.log = realLog;
  }
}

const defaultWtCache = async (apply: boolean): Promise<SweepStepResult> => {
  const { code, out } = await captured(() => cmdFleetWtCache(['--json', ...(apply ? ['--apply'] : [])]));
  let freedGb = 0;
  try { freedGb = Number((JSON.parse(out) as { freeGb?: number }).freeGb) || 0; } catch { /* failed run prints no JSON */ }
  return { code, freedGb };
};

// worktree-stale reports no sizes, so its GB is the free-disk change measured by the caller.
const defaultWorktreeStale = async (apply: boolean): Promise<SweepStepResult> =>
  ({ code: (await captured(() => cmdFleetWorktreeStale(apply ? ['--apply'] : []))).code, freedGb: Number.NaN });

export async function cmdFleetDiskSweep(args: string[], deps: FleetDiskSweepDeps = {}): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    return 0;
  }
  const flags = new Set<string>();
  for (const token of args) {
    if (!['--force', '--apply', '--json'].includes(token)) {
      console.error(`error: ${token.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${token}\n${USAGE}`);
      return 2;
    }
    if (flags.has(token)) {
      console.error(`error: duplicate option: ${token}\n${USAGE}`);
      return 2;
    }
    flags.add(token);
  }
  const apply = flags.has('--apply');
  const force = flags.has('--force');
  const freeGb = deps.freeGb ?? defaultFreeGb;
  const before = await freeGb().catch(() => null);
  const freezeBelowGb = await (deps.freezeBelowGb ?? defaultFreezeBelowGb)().catch(() => FLEET_DISK_LANE_FREEZE_GB);
  // Unreadable free space sweeps: better a needless dry run than a full disk.
  const swept = force || before === null || before < freezeBelowGb;

  const steps: SweepStep[] = [];
  const plan: Array<[SweepStep['name'], (a: boolean) => Promise<SweepStepResult>]> = [
    ['wt-cache', deps.wtCache ?? defaultWtCache],
    ['worktree-stale', deps.worktreeStale ?? defaultWorktreeStale],
  ];
  let last = before;
  for (const [name, run] of plan) {
    if (!swept) { steps.push({ name, ran: false, code: null, freedGb: 0 }); continue; }
    let result: SweepStepResult;
    try {
      result = await run(apply);
    } catch {
      result = { code: 1, freedGb: 0 };
    }
    let freed = result.freedGb;
    if (Number.isNaN(freed)) {
      const now = apply ? await freeGb().catch(() => null) : null;
      freed = now !== null && last !== null ? Math.max(0, now - last) : 0;
      if (now !== null) last = now;
    }
    steps.push({ name, ran: true, code: result.code, freedGb: round1(freed) });
  }

  const freedGb = round1(steps.reduce((sum, s) => sum + s.freedGb, 0));
  const view: FleetDiskSweepView = {
    v: 1, generatedAt: new Date((deps.now ?? Date.now)()).toISOString(), apply, force,
    freeGb: before === null ? null : round1(before), freezeBelowGb, swept, steps, freedGb,
  };
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify(view, null, 2) + '\n');
  } else if (!swept) {
    console.log(`disk ok: ${view.freeGb} GB free, at or above the ${freezeBelowGb} GB line. Nothing to do (--force to sweep anyway).`);
  } else {
    for (const s of steps) console.log(`${s.name}: ${s.code === 0 ? 'ok' : `FAILED (exit ${s.code})`}, ${s.freedGb} GB ${apply ? 'freed' : 'can be freed'}`);
    console.log(`freed: ${freedGb} GB${apply ? '' : ' (dry run; add --apply to delete)'}`);
  }
  return steps.some(s => s.ran && s.code !== 0) ? 1 : 0;
}
