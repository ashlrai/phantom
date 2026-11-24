/** Free lane slots held by finished jobs: SIGTERM each observed stray through stopStray (dry run unless --apply). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultStrayReaders, readStraySlots, STRAY_ID_PATTERN } from '../core/fleet/stray-slots.js';
import { stopStray, StrayStopError, type StrayStopDeps } from '../core/fleet/stray-stop.js';
import { actOnStuckJobs, defaultRunsDir, stuckNote, type StuckActionDeps, type StuckActionResult } from '../core/fleet/running-stuck.js';
import { scrubSecrets } from '../core/util/scrub.js';

const DEFAULT_MAX = 20;
const usage = `Usage: ashlr fleet stray-stop [--json] [--apply] [--stuck] [--lane NAME ...] [--max N] [--runs-dir DIR]
  --apply         Send SIGTERM to each stray, one at a time (default: dry run, no signals).
  --stuck         With --apply, also close ghost run markers and stop stuck jobs (4 per run, TERM then KILL after 60 s); the self-tick does this on its own. See phm jobs stuck.
  --lane NAME     Select an exact lane; repeat to select multiple lanes (default: all).
  --max N         Stop at most N strays per run, 1..50 (default: ${DEFAULT_MAX}).
  --runs-dir DIR  Write the stop ledger to DIR/stray-stops.jsonl (default: ASHLR_RUNS_DIR or ~/.ashlr-runs).
Each stop re-reads the evidence and refuses a pid that is no longer a stray. Never signals this process, its parent or pid <= 1.`;

export interface StrayStopPlanned { lane: string; job: string; pid: number; ageSeconds: number | null }
export interface StrayStopOutcome { lane: string; job: string; pid: number; result: 'signalled' | 'already-gone' | 'refused' | 'failed'; code?: string }
export interface StrayStopCliV1 {
  /** ok=false means the evidence could not be read; `reason` says why in plain words. */
  v: 1; ok: boolean; reason?: string; stuck?: { ghostsClosed: number; stuckStopped: number; skipped: number; note: string }; checked: { lanes: number; strays: number }; mode: 'dry-run' | 'apply'; planned: StrayStopPlanned[]; results: StrayStopOutcome[];
  summary: { planned: number; signalled: number; alreadyGone: number; refused: number; failed: number; capped: boolean };
}

export type StuckStepDeps = Omit<StuckActionDeps, 'lane'>;
export async function cmdFleetStrayStop(args: string[], deps: Partial<StrayStopDeps> & { stuck?: StuckStepDeps; output?: (text: string) => void; error?: (text: string) => void } = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { output(usage); return 0; }
  let json = false;
  let apply = false;
  let stuckFlag = false;
  let max: number | undefined;
  let runsDir: string | undefined;
  const lanes = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--stuck' && !stuckFlag) stuckFlag = true;
    else if (arg === '--lane' && next !== undefined && STRAY_ID_PATTERN.test(next)) { lanes.add(next); i++; }
    else if (arg === '--max' && max === undefined && next !== undefined && /^\d{1,2}$/.test(next) && +next >= 1 && +next <= 50) { max = +next; i++; }
    else if (arg === '--runs-dir' && runsDir === undefined && next !== undefined && next !== '' && !next.startsWith('--')) { runsDir = next; i++; }
    else { error(`${usage}\n`); return 2; }
  }
  const stopDeps: StrayStopDeps = {
    readStraySlots: deps.readStraySlots ?? (() => readStraySlots(defaultStrayReaders)),
    kill: deps.kill ?? ((pid, signal) => process.kill(pid, signal)),
    now: deps.now ?? (() => new Date()),
    ledgerFile: deps.ledgerFile ?? join(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'stray-stops.jsonl'),
  };
  const limit = max ?? DEFAULT_MAX;
  let found: StrayStopPlanned[];
  let checked = { lanes: 0, strays: 0 };
  try {
    const report = await stopDeps.readStraySlots();
    const scoped = report.lanes.filter(l => !lanes.size || lanes.has(l.lane));
    found = scoped.flatMap(l => l.strays.map(s => ({ lane: l.lane, job: s.job, pid: s.pid, ageSeconds: s.ageSeconds })));
    checked = { lanes: scoped.length, strays: found.length };
  } catch (cause) {
    // Always say why: the self-tick records this output instead of a null report.
    const reason = scrubSecrets(`could not read the process and job evidence: ${cause instanceof Error && cause.message ? cause.message : 'unknown error'}`.slice(0, 200));
    const failed: StrayStopCliV1 = { v: 1, ok: false, reason, checked, mode: apply ? 'apply' : 'dry-run', planned: [], results: [],
      summary: { planned: 0, signalled: 0, alreadyGone: 0, refused: 0, failed: 0, capped: false } };
    if (json) output(JSON.stringify(failed)); else output(`Stray stop failed: ${reason}`);
    return 1;
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
  // Running jobs whose process is gone (ghosts) or silent for too long (stuck). Only with --apply, and only
  // when asked for (--stuck) or wired in by the self-tick (deps.stuck); never from a bare test or dry run.
  let stuck: StuckActionResult | undefined;
  let stuckNoteText: string | undefined;
  if (apply && (deps.stuck || stuckFlag)) {
    try {
      stuck = await actOnStuckJobs({ runsDir: runsDir ?? defaultRunsDir(), ...deps.stuck, lane: lanes.size === 1 ? [...lanes][0] : undefined });
      stuckNoteText = stuckNote(stuck);
    } catch { stuckNoteText = 'could not read the run markers'; }
  }
  const count = (r: StrayStopOutcome['result']) => results.filter(x => x.result === r).length;
  const out: StrayStopCliV1 = {
    v: 1, ok: true, checked, mode: apply ? 'apply' : 'dry-run', planned, results,
    ...(stuck ? { stuck: { ghostsClosed: stuck.closed.length, stuckStopped: stuck.stopped.length, skipped: stuck.skipped.length, note: stuckNoteText! } } : {}),
    summary: { planned: planned.length, signalled: count('signalled'), alreadyGone: count('already-gone'), refused: count('refused'), failed: count('failed'), capped: found.length > limit },
  };
  if (json) output(JSON.stringify(out));
  else {
    const lines = planned.map(p => `${apply ? '' : 'would stop '}${p.lane} ${p.job} pid=${p.pid} age=${p.ageSeconds ?? 'unknown'}s`
      + (apply ? ` -> ${results.find(r => r.pid === p.pid && r.lane === p.lane && r.job === p.job)?.result ?? ''}` : ''));
    const s = out.summary;
    lines.push(`Checked ${checked.lanes} lane(s): ${checked.strays} stray(s) found.`);
    lines.push(apply
      ? `Stray stop: ${s.signalled} signalled, ${s.alreadyGone} already gone, ${s.refused} refused, ${s.failed} failed.`
      : `Dry run: ${s.planned} stray(s) planned; pass --apply to stop them.`);
    if (stuckNoteText) lines.push(`Stuck jobs: ${stuckNoteText}.`);
    if (s.capped) lines.push(`Capped at ${limit} per run; rerun for the rest.`);
    output(scrubSecrets(lines.join('\n')));
  }
  return count('failed') > 0 ? 1 : 0;
}
