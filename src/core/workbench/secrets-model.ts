import { scrubSecrets } from '../util/scrub-secrets.js';

export interface SecretCustody { name: string; scope: string | null; ageMs: number | null; lastRotated: string | null }
export interface SecretsReading { v: 1; state: 'ok' | 'unknown'; secrets: SecretCustody[] }
const record = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
function label(raw: unknown): string | null {
  // Reject terminal control characters in metadata labels.
  // eslint-disable-next-line no-control-regex
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 160 && !/[\u0000-\u001f\u007f]/.test(raw)
    ? scrubSecrets(raw) : null;
}
function timestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
/** Construct fresh rows, never spread source objects, including nested value fields. */
export function projectSecrets(raw: unknown, now = Date.now()): SecretsReading {
  const rows = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.secrets) ? raw.secrets : null;
  if (!rows || rows.length > 10_000) return { v: 1, state: 'unknown', secrets: [] };
  const secrets: SecretCustody[] = [];
  for (const row of rows) {
    if (!record(row)) continue;
    const name = label(row.name);
    if (!name) continue;
    const created = timestamp(row.createdAt ?? row.created_at);
    // On a second projection preserve only validated, finite age measurements.
    const ageMs = created ? Math.max(0, now - Date.parse(created))
      : typeof row.ageMs === 'number' && Number.isFinite(row.ageMs) && row.ageMs >= 0 ? row.ageMs : null;
    secrets.push({ name, scope: label(row.scope), ageMs,
      lastRotated: timestamp(row.lastRotated ?? row.last_rotated ?? row.rotated_at) });
  }
  return { v: 1, state: record(raw) && raw.state === 'unknown' ? 'unknown' : 'ok', secrets };
}
