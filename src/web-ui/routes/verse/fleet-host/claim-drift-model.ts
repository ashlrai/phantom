/** Pure display model for the claim-store drift card. The API body is
 * untrusted at this boundary: any bad shape parses to null. */
export type ClaimDriftState = 'VERIFIED' | 'DRIFT' | 'UNKNOWN';
export type ClaimDriftKind = 'bus-only' | 'coord-only' | 'owner mismatch';

export interface ClaimDriftDisplayRow {
  kind: ClaimDriftKind;
  id: string;
  owner: string;
  busOwner?: string;
  coordOwner?: string;
  leaseUntil: string;
}

export interface ClaimDriftView {
  state: ClaimDriftState;
  asOf: string;
  matched: number;
  missing: string[];
  busOnly: number;
  coordOnly: number;
  ownerMismatch: number;
  rows: ClaimDriftDisplayRow[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

function parseRows(v: unknown, kind: ClaimDriftKind): ClaimDriftDisplayRow[] | null {
  if (!Array.isArray(v)) return null;
  const out: ClaimDriftDisplayRow[] = [];
  for (const r of v) {
    if (!isObj(r) || !str(r.id) || !str(r.owner) || !str(r.leaseUntil)) return null;
    out.push({
      kind, id: r.id, owner: r.owner, leaseUntil: r.leaseUntil,
      ...(str(r.busOwner) ? { busOwner: r.busOwner } : {}),
      ...(str(r.coordOwner) ? { coordOwner: r.coordOwner } : {}),
    });
  }
  return out;
}

export function parseClaimDrift(body: unknown): ClaimDriftView | null {
  if (!isObj(body) || !isObj(body.drift)) return null;
  const d = body.drift;
  if (d.state !== 'VERIFIED' && d.state !== 'DRIFT' && d.state !== 'UNKNOWN') return null;
  if (!str(d.asOf) || !Number.isFinite(Date.parse(d.asOf))) return null;
  if (typeof d.matched !== 'number' || !Number.isFinite(d.matched)) return null;
  if (!Array.isArray(d.missing) || !d.missing.every(str)) return null;
  const busOnly = parseRows(d.busOnly, 'bus-only');
  const coordOnly = parseRows(d.coordOnly, 'coord-only');
  const ownerMismatch = parseRows(d.ownerMismatch, 'owner mismatch');
  if (!busOnly || !coordOnly || !ownerMismatch) return null;
  return {
    state: d.state, asOf: d.asOf, matched: d.matched, missing: d.missing,
    busOnly: busOnly.length, coordOnly: coordOnly.length, ownerMismatch: ownerMismatch.length,
    rows: [...ownerMismatch, ...busOnly, ...coordOnly],
  };
}

export function claimDriftHeadline(d: ClaimDriftView): { text: string; tone: 'ok' | 'bad' | 'unknown' } {
  const asOf = `as of ${d.asOf}`;
  if (d.state === 'VERIFIED') return { text: `Claim stores agree (${d.matched} live claims) ${asOf}`, tone: 'ok' };
  if (d.state === 'DRIFT') {
    return {
      text: `Claim stores disagree: ${d.busOnly} bus-only, ${d.coordOnly} coord-only, ${d.ownerMismatch} owner mismatch ${asOf}`,
      tone: 'bad',
    };
  }
  return { text: `Claim stores unknown: ${d.missing.join(', ') || 'sources'} unreadable ${asOf}`, tone: 'unknown' };
}
