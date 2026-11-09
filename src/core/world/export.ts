/** One export file for consumers that do not call MCP. Tokens are not written. */
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { listCoordination } from '../agents/claim-store.js';
import type { WorldModel } from './types.js';

export const WORLD_EXPORT_SCHEMA = 'ashlr.world-export/v1' as const;

export function worldExportPath(override?: string): string {
  const env = process.env['ASHLR_WORLD_EXPORT'];
  if (override && isAbsolute(override) && !override.includes('\0')) return override;
  if (typeof env === 'string' && isAbsolute(env) && !env.includes('\0')) return env;
  return join(homedir(), '.ashlr-runs', 'export', 'world.json');
}

/** Best effort. A failed write does not change the in-memory snapshot. */
export function writeWorldExport(model: WorldModel, options: { path?: string; nowMs?: number } = {}): { path: string; written: boolean } {
  const path = worldExportPath(options.path);
  try {
    const existing = (() => { try { return lstatSync(path); } catch { return null; } })();
    if (existing?.isSymbolicLink()) return { path, written: false };
    const directory = join(path, '..');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const claims = listCoordination(undefined, options.nowMs ?? Date.now());
    const body = {
      schema: WORLD_EXPORT_SCHEMA,
      generatedAt: model.generatedAt,
      world: model,
      claims: {
        source: claims.source,
        items: claims.claims.filter((row) => row.live).map((row) => ({
          claimId: row.sourceId, lane: row.owner, key: row.key, repo: row.repo,
          branch: row.branch, started: row.started, leaseUntil: row.leaseUntil,
        })),
      },
    };
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
    return { path, written: true };
  } catch {
    return { path, written: false };
  }
}
