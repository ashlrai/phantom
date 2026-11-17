import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ashlrHome } from '../cloud/store.js';
import { routeIdSchema } from '../routing/decision-schema.js';
import { readBoundedRouterFile, type RouterOutcome } from './outcomes.js';

export const routerWeightSchema = z.object({ schema: z.literal('router.weights.v1'), work_class: routeIdSchema,
  lane: routeIdSchema, weight: z.number().min(0).max(1), evidence_n: z.number().int().nonnegative(), updated_at: z.string().datetime() }).strict();
export type RouterWeight = z.infer<typeof routerWeightSchema>;
export interface WeightProposal extends RouterWeight { refused: boolean; reason: 'insufficient-evidence' | null }
export const routerWeightsPath = (rootDir = ashlrHome()): string => join(rootDir, 'router/weights.json');

export async function readRouterWeights(rootDir?: string): Promise<RouterWeight[]> {
  try {
    const parsed = z.array(routerWeightSchema).max(4096).safeParse(JSON.parse(await readBoundedRouterFile(routerWeightsPath(rootDir)) ?? 'null'));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}

export function proposeRouterWeights(outcomes: readonly RouterOutcome[], current: readonly RouterWeight[] = [],
  opts: { minSamples?: number; maxShift?: number; now?: string } = {}): WeightProposal[] {
  const min = opts.minSamples ?? 20, shift = opts.maxShift ?? 0.1;
  if (!Number.isSafeInteger(min) || min < 1 || !Number.isFinite(shift) || shift <= 0 || shift > 1) throw new Error('Invalid tuning bounds');
  const now = opts.now ?? new Date().toISOString();
  const groups = new Map<string, { work_class: string; lane: string; known: boolean[] }>();
  for (const o of outcomes) {
    if (!routeIdSchema.safeParse(o.work_class).success || !routeIdSchema.safeParse(o.lane).success) continue;
    const work_class = o.work_class!, lane = o.lane!, key = JSON.stringify([work_class, lane]);
    const g = groups.get(key) ?? { work_class, lane, known: [] };
    if (o.merged !== null) g.known.push(o.merged);
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const weight = current.find(w => w.work_class === g.work_class && w.lane === g.lane)?.weight ?? 0.5;
    const refused = g.known.length < min;
    const target = g.known.filter(Boolean).length / g.known.length;
    return { schema: 'router.weights.v1' as const, work_class: g.work_class, lane: g.lane,
      weight: refused ? weight : Math.max(0, Math.min(1, weight + Math.max(-shift, Math.min(shift, target - weight)))),
      evidence_n: g.known.length, updated_at: now, refused, reason: refused ? 'insufficient-evidence' as const : null };
  });
}

export async function applyRouterWeights(proposals: readonly WeightProposal[], current: readonly RouterWeight[], rootDir?: string): Promise<void> {
  const weights = [...current];
  for (const { refused, reason: _reason, ...row } of proposals) {
    if (refused) continue;
    routerWeightSchema.parse(row);
    const index = weights.findIndex(w => w.lane === row.lane && w.work_class === row.work_class);
    if (index < 0) weights.push(row); else weights[index] = row;
  }
  const file = routerWeightsPath(rootDir), tmp = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(tmp, JSON.stringify(weights, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, file); }
  finally { await unlink(tmp).catch(() => undefined); }
}
