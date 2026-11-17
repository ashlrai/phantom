import { homedir } from 'node:os';
import { join } from 'node:path';
import { dailyUserSchedule } from '../steward/schedule.js';

export function catalogSchedule(opts: Parameters<typeof dailyUserSchedule>[1]) {
  return dailyUserSchedule({
    label: 'ai.ashlr.phm.router-catalog', fileStem: 'phm-router-catalog',
    command: ['router', 'catalog', 'refresh', '--json'],
    description: 'Phantom router catalog refresh', minute: 43, weekday: 1,
    log: join(opts.home ?? homedir(), '.ashlr', 'logs', 'router-catalog.jsonl'),
  }, opts);
}
