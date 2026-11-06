/** One command a host timer can run: free disk below the lane freeze line (or --force) → wt-cache, then worktree-stale. */
import { appendFile, mkdir, readFile, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetWorktreeStale } from './fleet-worktree-stale.js';
import { cmdFleetWtCache } from './fleet-wt-cache.js';
import { FLEET_DISK_LANE_FREEZE_GB, parseLaneDiskLines } from './fleet-disk.js';

const USAGE =
  'Usage: ashlr fleet disk-sweep [--force] [--apply] [--log] [--json] | --history [N] [--json]\n' +
  'When free disk is below the lane freeze line (compact.lanes.raise_freeze_below_gb in ~/.ashlr-runs/queue/budget-overrides.json, default 60 GB), or with --force, runs `fleet wt-cache` then `fleet worktree-stale` and prints one line per step with the GB freed. Dry run unless --apply, which is passed to both steps. Add --log to save the result; use --history [N] to show the last N results (default 10). Exits 0 ok, 1 on failure, 2 bad usage.';

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

function runsDir(): string {
  return process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

function logPath(): string { return join(runsDir(), 'queue', 'disk-sweep.jsonl'); }

async function defaultFreezeBelowGb(): Promise<number> {
  const text = await readFile(join(runsDir(), 'queue', 'budget-overrides.json'), 'utf8').catch(() => '');
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
  let historyCount: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!['--force', '--apply', '--json', '--log', '--history'].includes(token)) {
      console.error(`error: ${token.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${token}\n${USAGE}`);
      return 2;
    }
    if (flags.has(token)) {
      console.error(`error: duplicate option: ${token}\n${USAGE}`);
      return 2;
    }
    flags.add(token);
    if (token === '--history') {
      historyCount = 10;
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        if (!/^[1-9]\d*$/.test(next) || !Number.isSafeInteger(Number(next))) {
          console.error('error: history count must be a positive integer');
          return 2;
        }
        historyCount = Number(next);
        i++;
      }
    }
  }
  if (historyCount !== undefined) {
    if (flags.has('--force') || flags.has('--apply') || flags.has('--log')) {
      console.error('error: --history cannot be combined with --force, --apply or --log');
      return 2;
    }
    try {
      const text = await readFile(logPath(), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const lines = text.split('\n').filter(line => line.trim()).slice(-historyCount);
      if (flags.has('--json')) process.stdout.write(JSON.stringify(lines.map(line => JSON.parse(line))) + '\n');
      else if (lines.length) process.stdout.write(lines.join('\n') + '\n');
      return 0;
    } catch {
      console.error('error: could not read disk sweep history');
      return 1;
    }
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
  let logFailed = false;
  if (flags.has('--log')) {
    try {
      await mkdir(join(runsDir(), 'queue'), { recursive: true });
      const { generatedAt, apply: applied, freeGb: free, swept: didSweep, freedGb: freed, steps: results } = view;
      await appendFile(logPath(), JSON.stringify({ generatedAt, apply: applied, freeGb: free, swept: didSweep, freedGb: freed, steps: results }) + '\n');
    } catch {
      console.error('error: could not write disk sweep log');
      logFailed = true;
    }
  }
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify(view, null, 2) + '\n');
  } else if (!swept) {
    console.log(`disk ok: ${view.freeGb} GB free, at or above the ${freezeBelowGb} GB line. Nothing to do (--force to sweep anyway).`);
  } else {
    for (const s of steps) console.log(`${s.name}: ${s.code === 0 ? 'ok' : `FAILED (exit ${s.code})`}, ${s.freedGb} GB ${apply ? 'freed' : 'can be freed'}`);
    console.log(`freed: ${freedGb} GB${apply ? '' : ' (dry run; add --apply to delete)'}`);
  }
  return logFailed || steps.some(s => s.ran && s.code !== 0) ? 1 : 0;
}
