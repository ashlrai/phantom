/** View model for GET /api/verse/fleet/runtime-identity. Declared here on purpose: the route is a separate change. */
export type Unknown = 'unknown';
export interface RuntimeIdentityView {
  generatedAt: string;
  host: string;
  platform: string;
  asOf: string;
  installedVersion: string;
  sourceVersion: string;
  versionDrift: boolean;
  tailnetName: string;
  fleetState: { ageSeconds: number | Unknown; stale: boolean | Unknown };
  reasons: string[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' && v !== '' ? v : 'unknown');

export function narrowRuntimeIdentity(raw: unknown): RuntimeIdentityView | null {
  if (!object(raw) || raw.v !== 1 || typeof raw.generatedAt !== 'string' || !object(raw.identity)) return null;
  const id = raw.identity;
  const fs = object(id.fleetState) ? id.fleetState : {};
  return {
    generatedAt: raw.generatedAt,
    host: str(id.host),
    platform: str(id.platform),
    asOf: str(id.asOf),
    installedVersion: str(id.installedVersion),
    sourceVersion: str(id.sourceVersion),
    versionDrift: id.versionDrift === true,
    tailnetName: str(id.tailnetName),
    fleetState: {
      ageSeconds: typeof fs.ageSeconds === 'number' && Number.isFinite(fs.ageSeconds) && fs.ageSeconds >= 0 ? fs.ageSeconds : 'unknown',
      stale: typeof fs.stale === 'boolean' ? fs.stale : 'unknown',
    },
    reasons: Array.isArray(id.reasons) ? id.reasons.filter((r): r is string => typeof r === 'string' && r !== '') : [],
  };
}

export function formatAge(ageSeconds: number | Unknown): string {
  if (ageSeconds === 'unknown') return 'unknown';
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m old`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h old`;
  return `${Math.floor(ageSeconds / 86400)}d old`;
}
