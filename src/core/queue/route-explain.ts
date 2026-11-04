import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Counts accepted pool changes, excluding initial assignment and held proposals. */
export async function explainRoutes(root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), now = Date.now() / 1000) {
  try {
    const state: Record<string, { pool: string; decided_at: number; moves: number[] }> = JSON.parse(
      await readFile(join(root, 'queue', 'route-state.json'), 'utf8'),
    );
    const lines = Object.entries(state).map(([job, receipt]) => {
      if (typeof receipt.pool !== 'string' || !Number.isFinite(receipt.decided_at)
        || !Array.isArray(receipt.moves) || receipt.moves.some(t => !Number.isFinite(t))) {
        throw new Error('Invalid route receipt');
      }
      return { job, pool: receipt.pool, decidedAt: receipt.decided_at,
        'route-moves-per-hour': receipt.moves.filter(t => t > now - 3600 && t <= now).length };
    });
    return { available: true, 'route-moves-per-hour': lines.reduce((sum, line) => sum + line['route-moves-per-hour'], 0), lines };
  } catch {
    return { available: false, 'route-moves-per-hour': null, lines: [] };
  }
}
