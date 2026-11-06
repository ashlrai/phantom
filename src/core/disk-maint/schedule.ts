/**
 * Scheduled disk maintenance: a per-user launchd agent (macOS) or systemd
 * user timer (Linux) that runs `phm disk-maint` daily, sharing the steward
 * schedule's unit generation. Report-only by default; `--apply` is chosen
 * explicitly at install time. Nothing runs as root or touches system paths,
 * and the job carries no --allow flags: gated classes stay off.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dailyUserSchedule, type ScheduleUnit } from '../steward/schedule.js';

export const DISK_MAINT_LABEL = 'ai.ashlr.phm.disk-maint';

export function diskMaintSchedule(opts: { phmPath: string; nodePath?: string; apply: boolean; hour?: number; platform?: NodeJS.Platform; home?: string }): ScheduleUnit[] {
  const home = opts.home ?? homedir();
  return dailyUserSchedule({
    label: DISK_MAINT_LABEL,
    fileStem: 'phm-disk-maint',
    command: ['disk-maint', ...(opts.apply ? ['--apply'] : []), '--json'],
    description: 'Phantom disk maintenance (rebuildable reclaim)',
    minute: 43,
    log: join(home, '.ashlr', 'logs', 'disk-maint.jsonl'),
  }, opts);
}
