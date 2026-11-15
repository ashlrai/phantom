/** Host sensor handoff. This file is measurement input, never a model instruction.
 * Missing overall-limit attribution stays unknown; scoped model % is not used. */
import { join } from 'node:path';
import { readPrivateFileCapped } from '../verse/preferences.js';
import { routingDir } from './budget-store.js';
import { fableBillingStopped } from './fable-billing-stop.js';
import { planFable, type FableWork, type FableWeeklyReading, type FablePlan } from './fable-orchestrator.js';
export function readFableAdmission(work: FableWork, nowMs = Date.now(), root = routingDir()): FablePlan {
  let reading: FableWeeklyReading | null = null;
  let share = 0;
  try {
    const file = readPrivateFileCapped(join(root, 'fable-weekly.json'), 4096);
    if (file && !file.truncated) {
      const input = JSON.parse(file.text) as Record<string, unknown>;
      if (input.schemaVersion === 1 && input.source === 'claude-usage' && input.unit === 'overall-weekly-percent' &&
        typeof input.sharePercent === 'number' && input.reading && typeof input.reading === 'object') {
        const candidate = input.reading as FableWeeklyReading;
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(candidate.resetAtMs);
        const part = (type: string) => parts.find(value => value.type === type)?.value;
        if (part('weekday') === 'Fri' && part('hour') === '18' && part('minute') === '00') {
          reading = candidate; share = input.sharePercent;
        }
      }
    }
  } catch { /* Absent or malformed measurement cannot admit subscription work. */ }
  return planFable(work, reading, share, fableBillingStopped(root), nowMs);
}
