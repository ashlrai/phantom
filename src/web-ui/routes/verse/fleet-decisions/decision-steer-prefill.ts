import type { holdRows, repeatedSkips } from './fleet-decisions-model.js';

export function repeatSteerPrefill(row: ReturnType<typeof repeatedSkips>[number]): string {
  return `Bet '${row.title.slice(0, 120)}' has been skipped ${row.runs} ticks in a row since ${row.since.slice(0, 80)}: ${row.reason.slice(0, 160)}. Drop it or unblock it.`;
}

export function holdSteerPrefill(row: ReturnType<typeof holdRows>[number]): string {
  return `Bet '${row.title.slice(0, 120)}' (${row.repo.slice(0, 60)}) is held (${row.holdKind.slice(0, 40)}): ${row.reason.slice(0, 100)}. Next eligible ${(row.nextEligibleAt || 'unknown').slice(0, 60)}. Keep the hold or release it.`;
}
