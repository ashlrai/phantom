/** Free lane slots held by finished jobs: SIGTERM each observed stray through stopStray (dry run unless --apply). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultStrayReaders, readStraySlots, STRAY_ID_PATTERN } from '../core/fleet/stray-slots.js';
import { stopStray, StrayStopError, type StrayStopDeps } from '../core/fleet/stray-stop.js';
import { scrubSecrets } from '../core/util/scrub.js';

const DEFAULT_MAX = 20;
const usage = `Usage: ashlr fleet stray-stop [--json] [--apply] [--lane NAME ...] [--max N] [--runs-dir DIR]
  --apply         Send SIGTERM to each stray, one at a time (default: dry run, no signals).
  --lane NAME     Select an exact lane; repeat to select multiple lanes (default: all).
  --max N         Stop at most N strays per run, 1..50 (default: ${DEFAULT_MAX}).
  --runs-dir DIR  Write the stop ledger to DIR/stray-stops.jsonl (default: ASHLR_RUNS_DIR or ~/.ashlr-runs).
Each stop re-reads the evidence and refuses a pid that is no longer a stray. Never signals this process, its parent or pid <= 1.`;

export interface StrayStopPlanned { lane: string; job: string; pid: number; ageSeconds: number | null }
export interface StrayStopOutcome { lane: string; job: string; pid: number; result: 'signalled' | 'already-gone' | 'refused' | 'failed'; code?: string }
export interface StrayStopCliV1 {
  v: 1; mode: 'dry-run' | 'apply'; planned: StrayStopPlanned[]; results: StrayStopOutcome[];
  summary: { planned: number; signalled: number; alreadyGone: number; refused: number; failed: number; capped: boolean };
}

export async function cmdFleetStrayStop(args: string[], deps: Partial<StrayStopDeps> = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return 0; }
  let json = false;
  let apply = false;
  let max: number | undefined;
  let runsDir: string | undefined;
  const lanes = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--lane' && next !== undefined && STRAY_ID_PATTERN.test(next)) { lanes.add(next); i++; }
    else if (arg === '--max' && max === undefined && next !== undefined && /^\d{1,2}$/.test(next) && +next >= 1 && +next <= 50) { max = +next; i++; }
    else if (arg === '--runs-dir' && runsDir === undefined && next !== undefined && next !== '' && !next.startsWith('--')) { runsDir = next; i++; }
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  const stopDeps: StrayStopDeps = {
    readStraySlots: deps.readStraySlots ?? (() => readStraySlots(defaultStrayReaders)),
    kill: deps.kill ?? ((pid, signal) => process.kill(pid, signal)),
    now: deps.now ?? (() => new Date()),
    ledgerFile: deps.ledgerFile ?? join(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'stray-stops.jsonl'),
  };
  const limit = max ?? DEFAULT_MAX;
  let found: StrayStopPlanned[];
  try {
    const report = await stopDeps.readStraySlots();
    found = report.lanes.filter(l => !lanes.size || lanes.has(l.lane))
      .flatMap(l => l.strays.map(s => ({ lane: l.lane, job: s.job, pid: s.pid, ageSeconds: s.ageSeconds })));
  } catch {
    process.stderr.write('error: fleet stray-stop unavailable\n'); return 1;
  }
  const planned = found.slice(0, limit);
  const results: StrayStopOutcome[] = [];
  if (apply) {
    for (const p of planned) {
      const id = { lane: p.lane, job: p.job, pid: p.pid };
      if (p.pid <= 1 || p.pid === process.pid || p.pid === process.ppid) { results.push({ ...id, result: 'refused', code: 'protected-pid' }); continue; }
      try { results.push({ ...id, result: (await stopStray({ action: 'stop', ...id }, stopDeps)).result }); }
      catch (error) {
        results.push(error instanceof StrayStopError ? { ...id, result: 'refused', code: error.code } : { ...id, result: 'failed' });
      }
    }
  }
  const count = (r: StrayStopOutcome['result']) => results.filter(x => x.result === r).length;
  const out: StrayStopCliV1 = {
    v: 1, mode: apply ? 'apply' : 'dry-run', planned, results,
    summary: { planned: planned.length, signalled: count('signalled'), alreadyGone: count('already-gone'), refused: count('refused'), failed: count('failed'), capped: found.length > limit },
  };
  if (json) console.log(JSON.stringify(out));
  else {
    const lines = planned.map(p => `${apply ? '' : 'would stop '}${p.lane} ${p.job} pid=${p.pid} age=${p.ageSeconds ?? 'unknown'}s`
      + (apply ? ` -> ${results.find(r => r.pid === p.pid && r.lane === p.lane && r.job === p.job)?.result ?? ''}` : ''));
    const s = out.summary;
    lines.push(apply
      ? `Stray stop: ${s.signalled} signalled, ${s.alreadyGone} already gone, ${s.refused} refused, ${s.failed} failed.`
      : `Dry run: ${s.planned} stray(s) planned; pass --apply to stop them.`);
    if (s.capped) lines.push(`Capped at ${limit} per run; rerun for the rest.`);
    console.log(scrubSecrets(lines.join('\n')));
  }
  return count('failed') > 0 ? 1 : 0;
}
