/**
 * Scheduled pass^k eval: a per-user launchd agent (macOS) or systemd user
 * timer (Linux) that runs `phm eval passk --json` nightly, sharing the
 * steward/disk-maint schedule's unit generation. The job runs the pinned
 * golden set with the default lane (loopback-only local model) unless the
 * operator installed a different schedule command; no flags reach gated
 * resources, and nothing runs as root.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dailyUserSchedule, type ScheduleUnit } from '../steward/schedule.js';

export const EVAL_PASSK_LABEL = 'ai.ashlr.phm.eval-passk';

export function evalPassKSchedule(opts: { phmPath: string; nodePath?: string; hour?: number; platform?: NodeJS.Platform; home?: string }): ScheduleUnit[] {
  const home = opts.home ?? homedir();
  return dailyUserSchedule({
    label: EVAL_PASSK_LABEL,
    fileStem: 'phm-eval-passk',
    command: ['eval', 'passk', '--json'],
    description: 'Phantom pass^k golden-task eval (offline lane/model reliability)',
    minute: 58,
    log: join(home, '.ashlr', 'logs', 'eval-passk.jsonl'),
  }, opts);
}
