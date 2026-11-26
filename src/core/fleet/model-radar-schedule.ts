import { homedir } from 'node:os';
import { join } from 'node:path';
import { dailyUserSchedule } from '../steward/schedule.js';

export function modelRadarSchedule(opts: Parameters<typeof dailyUserSchedule>[1]) {
  return dailyUserSchedule({
    label: 'ai.ashlr.phm.model-radar', fileStem: 'phm-model-radar',
    command: ['models', 'radar', '--fetch', '--propose', '--json'],
    description: 'Phantom official-source model radar', minute: 47,
    log: join(opts.home ?? homedir(), '.ashlr', 'logs', 'model-radar.jsonl'),
  }, opts);
}
