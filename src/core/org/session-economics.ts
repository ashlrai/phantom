import { z } from 'zod';
const n = z.number().finite().nonnegative();
const sample = z.object({
  batchDepth: n.int().min(10).max(1000), fanOut: n.int().max(32),
  completed: n.int().positive(), tokens: n.positive(), elapsedMs: n.positive(), setupTokens: n,
}).strict();
const vitals = z.object({
  queued: n.int(), liveClaims: n.int(), tokenCeiling: n, fanOutCeiling: n.int().max(32),
  warm: sample.nullable(), fresh: z.array(sample).max(32),
}).strict();
/** Compare observed useful tasks/token, amortizing fresh setup across the remaining batch. */
export function sizeWorkerSession(raw: unknown) {
  const parsed = vitals.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid session vitals.');
  const v = parsed.data;
  if (v.queued === 0) return { action: v.liveClaims ? 'drain' : 'retire', sizing: null };
  const candidates = [ ...(v.warm ? [{ ...v.warm, action: 'keep' as const, setupTokens: 0 }] : []),
    ...v.fresh.map(value => ({ ...value, action: 'spawn' as const })) ].map(value => {
    const depth = Math.min(v.queued, value.batchDepth);
    return { ...value, plannedTasks: depth, tokensPerTask: value.tokens / value.completed + value.setupTokens / depth, tasksPerMs: value.completed / value.elapsedMs };
  }).filter(value => value.fanOut <= v.fanOutCeiling && value.tokensPerTask * value.plannedTasks <= v.tokenCeiling)
    .sort((a, b) => a.tokensPerTask - b.tokensPerTask || b.tasksPerMs - a.tasksPerMs);
  const best = candidates[0];
  if (!best) return { action: 'hold', sizing: null }; // Unknown evidence is not free capacity.
  return { action: v.liveClaims && best.action === 'spawn' ? 'drain' : best.action,
    sizing: { batchDepth: best.batchDepth, fanOut: best.fanOut, plannedTasks: best.plannedTasks, tokensPerTask: best.tokensPerTask } };
}
