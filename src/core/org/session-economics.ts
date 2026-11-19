import { z } from 'zod';

// Recovered from ashlrai/phantom PR #5809 (head 57bd29084a9359e13cad8a55db44fa43cb8aa2bd), path
// src/core/org/session-economics.ts. Pure: no I/O, no provider calls, no launches. Output is advice only.

const num = z.number().finite().nonnegative();
const sample = z.object({
  batchDepth: num.int().min(10).max(1000),
  fanOut: num.int().max(32),
  completed: num.int().positive(),
  tokens: num.positive(),
  elapsedMs: num.positive(),
  setupTokens: num,
}).strict();
// Ceilings are caller-supplied fields only: nothing here infers an allowance or a subscription reserve.
const vitals = z.object({
  queued: num.int(),
  liveClaims: num.int(),
  tokenCeiling: num,
  fanOutCeiling: num.int().max(32),
  warm: sample.nullable(),
  fresh: z.array(sample).max(32),
}).strict();

export type SessionSample = z.infer<typeof sample>;
export type SessionAction = 'keep' | 'spawn' | 'drain' | 'retire' | 'hold';
export interface SessionSizing {
  action: SessionAction;
  sizing: { batchDepth: number; fanOut: number; plannedTasks: number; tokensPerTask: number } | null;
}

/**
 * Compare observed useful tasks per token, amortizing fresh setup tokens across the planned batch.
 * Ties on tokens per task go to measured throughput. Unknown evidence yields `hold`, never free capacity.
 */
export function sizeWorkerSession(raw: unknown): SessionSizing {
  const parsed = vitals.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid session vitals.');
  const v = parsed.data;
  if (v.queued === 0) return { action: v.liveClaims > 0 ? 'drain' : 'retire', sizing: null };
  const options = [
    // A warm session has already paid its setup, so its setup cost is zero from here on.
    ...(v.warm ? [{ ...v.warm, action: 'keep' as const, setupTokens: 0 }] : []),
    ...v.fresh.map(value => ({ ...value, action: 'spawn' as const })),
  ].map(value => {
    const plannedTasks = Math.min(v.queued, value.batchDepth);
    return {
      ...value,
      plannedTasks,
      tokensPerTask: value.tokens / value.completed + value.setupTokens / plannedTasks,
      tasksPerMs: value.completed / value.elapsedMs,
    };
  }).filter(value => value.fanOut <= v.fanOutCeiling && value.tokensPerTask * value.plannedTasks <= v.tokenCeiling)
    .sort((a, b) => a.tokensPerTask - b.tokensPerTask || b.tasksPerMs - a.tasksPerMs);
  const best = options[0];
  if (!best) return { action: 'hold', sizing: null };
  // Live claims mean a fresh session must not imply replacing running work: drain instead.
  return {
    action: v.liveClaims > 0 && best.action === 'spawn' ? 'drain' : best.action,
    sizing: { batchDepth: best.batchDepth, fanOut: best.fanOut, plannedTasks: best.plannedTasks, tokensPerTask: best.tokensPerTask },
  };
}
