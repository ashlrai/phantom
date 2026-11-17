import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decidePairing, type PairingLane } from '../routing/pairing.js';
import { validResetCalendarPool } from '../routing/reset-pressure.js';
import { loadRouteSources } from '../routing/decision-candidates.js';
import { decideRoute } from '../routing/decision.js';
import { modelModeTierSchema, routeRequestSchema, routeModelSchema } from '../routing/decision-schema.js';

/** Counts accepted pool changes, excluding initial assignment and held proposals. */
export async function explainRoutes(root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), now = Date.now() / 1000) {
  // Quality receipts are independent of per-job route residency and its move count.
  let laneQuality: unknown[] | null = null;
  let pairing: ReturnType<typeof decidePairing> | null = null;
  let decision: Awaited<ReturnType<typeof decideRoute>> | null = null;
  const sources = await loadRouteSources(root);
  const request = routeRequestSchema.safeParse(sources.request);
  if (request.success) decision = await decideRoute(request.data, sources, { backends: [], nowMs: now * 1000 });
  try {
    const input = JSON.parse(await readFile(join(root, 'queue', 'pairing-lanes.json'), 'utf8'));
    if (!Array.isArray(input?.lanes) || !input.lanes.every((row: PairingLane) => row &&
      typeof row.lane === 'string' && row.lane.trim() && ['frontier', 'cheap'].includes(row.laneClass) &&
      typeof row.available === 'boolean' && validResetCalendarPool(row.pool) &&
      (row.mode_tier == null || modelModeTierSchema.safeParse(row.mode_tier).success) &&
      (row.model == null || routeModelSchema.safeParse(row.model).success)) ||
      new Set(input.lanes.map((row: PairingLane) => row.lane)).size !== input.lanes.length) throw new Error('Invalid pairing lanes');
    pairing = decidePairing(input.lanes, now * 1000);
  } catch { /* Missing evidence stays unknown. */ }
  try {
    const controller = JSON.parse(await readFile(join(root, 'queue', 'fleet-controller.json'), 'utf8'));
    if (Array.isArray(controller?.quality_receipts)) laneQuality = controller.quality_receipts;
  } catch { /* Missing evidence stays unknown. */ }
  try {
    const state: Record<string, { pool: string; decided_at: number; moves: number[]; waste_reason?: string }> = JSON.parse(
      await readFile(join(root, 'queue', 'route-state.json'), 'utf8'),
    );
    const lines = Object.entries(state).map(([job, receipt]) => {
      if (typeof receipt.pool !== 'string' || !Number.isFinite(receipt.decided_at)
        || !Array.isArray(receipt.moves) || receipt.moves.some(t => !Number.isFinite(t))) {
        throw new Error('Invalid route receipt');
      }
      return { job, pool: receipt.pool, decidedAt: receipt.decided_at, wasteReason: typeof receipt.waste_reason === 'string' ? receipt.waste_reason : null,
        'route-moves-per-hour': receipt.moves.filter(t => t > now - 3600 && t <= now).length };
    });
    return { available: true, 'route-moves-per-hour': lines.reduce((sum, line) => sum + line['route-moves-per-hour'], 0), lines, laneQuality, pairing, decision };
  } catch {
    return { available: false, 'route-moves-per-hour': null, lines: [], laneQuality, pairing, decision };
  }
}
