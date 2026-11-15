export interface SurfaceOwnerRow {
  surface: string;
  owner: string;
  ownerSource: 'advisory-claim' | 'none';
  liveClaims: { id: string; agent: string; expiresInSeconds: number }[];
  lastLanded: { jobId: string; pr: number | null; date: string } | null;
  reasons: string[];
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const surfaces = new Set(['slack-bridge', 'imessage-bridge', 'dot-handoff', 'coordination']);

export function parseSurfaceOwners(body: unknown): SurfaceOwnerRow[] {
  if (!object(body) || body.v !== 1 || body.authority !== 'none' || !Array.isArray(body.surfaces)) return [];
  const rows: SurfaceOwnerRow[] = [];
  for (const raw of body.surfaces) {
    if (!object(raw) || raw.schemaVersion !== 1 || raw.authority !== 'none'
      || typeof raw.surface !== 'string' || !surfaces.has(raw.surface)
      || typeof raw.asOf !== 'string' || !Number.isFinite(Date.parse(raw.asOf))
      || typeof raw.owner !== 'string' || (raw.ownerSource !== 'advisory-claim' && raw.ownerSource !== 'none')
      || !Array.isArray(raw.liveClaims) || !strings(raw.reasons) || !strings(raw.scannedPaths)) continue;
    const liveClaims: SurfaceOwnerRow['liveClaims'] = [];
    for (const claim of raw.liveClaims) {
      if (object(claim) && typeof claim.id === 'string' && typeof claim.agent === 'string'
        && typeof claim.expiresInSeconds === 'number' && Number.isSafeInteger(claim.expiresInSeconds) && claim.expiresInSeconds >= 0) {
        liveClaims.push({ id: claim.id, agent: claim.agent, expiresInSeconds: claim.expiresInSeconds });
      }
    }
    if (liveClaims.length !== raw.liveClaims.length) continue;
    if (raw.ownerSource === 'advisory-claim' && (liveClaims.length !== 1 || liveClaims[0]?.agent !== raw.owner)) continue;
    const landed = raw.lastLanded;
    if (landed !== null && (!object(landed) || typeof landed.jobId !== 'string'
      || typeof landed.date !== 'string' || !Number.isFinite(Date.parse(landed.date)) || typeof landed.path !== 'string'
      || (landed.pr !== null && !(typeof landed.pr === 'number' && Number.isSafeInteger(landed.pr) && landed.pr > 0)))) continue;
    rows.push({ surface: raw.surface, owner: raw.owner, ownerSource: raw.ownerSource, liveClaims,
      lastLanded: object(landed) ? { jobId: landed.jobId as string, pr: landed.pr as number | null, date: landed.date as string } : null,
      reasons: raw.reasons.slice(0, 5).map(r => r.slice(0, 200)) });
  }
  return rows;
}

export function surfaceOwnerLine(row: SurfaceOwnerRow): string {
  if (row.owner === 'UNKNOWN') return `unknown${row.reasons[0] ? `: ${row.reasons[0]}` : ''}`;
  if (row.ownerSource !== 'advisory-claim') return 'no live claim';
  return `${row.owner} (advisory claim, expires in ${Math.ceil((row.liveClaims[0]?.expiresInSeconds ?? 0) / 60)}m)`;
}
