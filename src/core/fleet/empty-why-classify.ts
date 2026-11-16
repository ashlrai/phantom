export const FLEET_EMPTY_WHY_LOG_LINES = 60;
export const FLEET_EMPTY_WHY_REASONS = ['lint-env', 'interrupted', 'blocked', 'limit', 'other'] as const;
export type FleetEmptyWhyReason = (typeof FLEET_EMPTY_WHY_REASONS)[number];

// Checked in order; the first match wins.
const RULES: ReadonlyArray<readonly [FleetEmptyWhyReason, RegExp]> = [
  ['lint-env', /eslint|lib\/cli/i],
  ['interrupted', /\bexit(?:ed|\s+code|\s+status)?\b\D{0,12}130\b/i],
  ['blocked', /\bblocked\b|not implemented|\bincomplete\b/i],
  ['limit', /usage limit|rate[ -]?limit/i],
];

/** Pure: tag one log by its last lines. */
export function classifyEmptyLog(log: string | null): FleetEmptyWhyReason {
  if (log === null) return 'other';
  const tail = log.split('\n').slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n');
  return RULES.find(([, re]) => re.test(tail))?.[0] ?? 'other';
}
