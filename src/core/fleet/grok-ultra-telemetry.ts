import { createHash } from 'node:crypto';
import { buildGrokUltraRunway, validGrokUltraReading } from './grok-ultra-runway.js';
import type { GrokUltraRunway } from './grok-ultra-types.js';

export type GrokUltraEmission = 'sent' | 'disabled' | 'failed';

/** Public ingestion only. Never obtains a personal API key or an app credential.
 * GET/status never calls this; the manual record command emits after persistence.
 */
export async function emitGrokUltraRunway(
  runway: GrokUltraRunway,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<GrokUltraEmission> {
  const key = env['PHANTOM_POSTHOG_PROJECT_KEY'];
  if (!key) return 'disabled';
  const host = env['PHANTOM_POSTHOG_HOST'] ?? 'https://us.i.posthog.com';
  if (!/^phc_[A-Za-z0-9_-]{1,200}$/.test(key) ||
    !['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(host) ||
    !validGrokUltraReading(runway.latest) || !Number.isFinite(Date.parse(runway.checkedAt)) ||
    !['current', 'stale'].includes(runway.state)) return 'failed';
  // Explicit numeric projection: even an extended fleet document cannot leak
  // claims, messages, local paths or account identifiers into analytics.
  const reading = runway.latest;
  const safe = buildGrokUltraRunway([reading], Date.parse(runway.checkedAt));
  if (safe.state !== 'current' && safe.state !== 'stale') return 'failed';
  const properties: Record<string, string | number | boolean | null> = {
    distinct_id: 'phantom-fleet-grok-ultra', $process_person_profile: false,
    source: reading.source, observed_at: reading.timestamp, target_at: safe.targetAt,
    remaining_points: reading.remainingPoints, total_points: reading.totalPoints,
    state: safe.state, collection_mode: 'manual',
  };
  for (const k of ['h1', 'h6', 'h24'] as const) {
    const burn = runway.burnPointsPerHour[k];
    const landing = runway.projectedRemainingPoints[k];
    properties[`burn_points_per_hour_${k}`] = typeof burn === 'number' && Number.isFinite(burn) ? burn : null;
    properties[`projected_remaining_points_${k}`] = typeof landing === 'number' && Number.isFinite(landing) ? landing : null;
  }
  properties.ideal_points_per_hour = safe.idealPointsPerHour;
  // Stable UUID makes an idempotent manual retry the same PostHog event.
  const hex = createHash('sha256').update(JSON.stringify(reading)).digest('hex').slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  try {
    const response = await request(`${host}/i/v0/e/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ api_key: key, event: 'phantom_grok_ultra_runway', uuid,
        timestamp: reading.timestamp, properties }),
    });
    await response.body?.cancel();
    return response.ok ? 'sent' : 'failed';
  } catch { return 'failed'; }
}
