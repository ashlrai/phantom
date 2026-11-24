import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { AshlrConfig } from '../../types.js';

const path = z.string().max(4096).refine(v => isAbsolute(v) && !/[\0\r\n]/.test(v));
export const liveSourcesSchema = z.object({
  codexCmpHome: path.optional(), codexPersonalHome: path.optional(), accountsRoot: path.optional(),
  codexSeatMap: z.record(z.string().min(1).max(256), z.enum(['codex-personal', 'codex-cmp'])).optional(),
  operatorPageFallback: z.boolean().optional(),
  anthropicCost: z.object({
    adminKeyHandle: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    creditUsd: z.number().finite().positive(),
    windowStart: z.string().datetime().refine(v => v.endsWith('T00:00:00.000Z') || v.endsWith('T00:00:00Z')),
  }).strict().optional(),
}).strict();
export type LiveSourcesConfig = z.infer<typeof liveSourcesSchema>;

export function liveSourceOptions(cfg: AshlrConfig, env: NodeJS.ProcessEnv = process.env): LiveSourcesConfig {
  const parsed = liveSourcesSchema.safeParse(cfg.usage?.liveSources);
  const config = parsed.success ? parsed.data : {};
  return { ...config,
    codexCmpHome: env.PHANTOM_SENSOR_CODEX_CMP_HOME ?? config.codexCmpHome,
    codexPersonalHome: env.PHANTOM_SENSOR_CODEX_PERSONAL_HOME ?? config.codexPersonalHome,
    accountsRoot: env.PHANTOM_RESOURCE_LIVE_ACCOUNTS_ROOT ?? config.accountsRoot };
}
