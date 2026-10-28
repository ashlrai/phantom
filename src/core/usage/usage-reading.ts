import { z } from 'zod';

const timestamp = z.string().refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const nullableTimestamp = timestamp.nullable();
const base = {
  pool: z.enum(['grok-ultra', 'codex-cmp', 'codex-personal', 'claude-max', 'terra', 'terra@personal', 'terra@cmp']),
  pctUsed: z.number().finite().min(0).max(100).nullable(),
  resetAt: nullableTimestamp,
  source: z.enum(['grok-reader', 'codex-reader', 'codex-cmp-reader', 'codex-personal-reader', 'claude-max-reader', 'terra-reader']),
  fetchedAt: timestamp,
};

/** Strict v1 shapes emitted by the usage readers and the signal journal. */
export const usageReadingV1Schema = z.union([
  z.object(base).strict(),
  z.object({ ...base, terraResetAt: nullableTimestamp }).strict(),
  z.object({
    ...base,
    writtenAt: timestamp,
    event: z.enum(['dispatch-start', 'pr-merge', '429', 'limit-message', 'manual-reading']),
    burnRatePctPerHour: z.number().finite().nonnegative().nullable(),
    projected100At: nullableTimestamp,
    cutActive: z.boolean(),
  }).strict(),
]);
