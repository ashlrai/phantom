/** Local wire contract: the web bundle never imports the core projection. */
export interface ReturnRow {
  claimId: string;
  repo: string;
  result: 'VERIFIED' | 'BLOCKED';
  evidenceKind: 'pr' | 'tests' | 'artifact' | 'dependency';
  pr: number | null;
  head: string | null;
  evidence: string;
  from: string;
  at: string;
  expiresAt: string;
}

export interface ReturnsResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  source: string;
  asOf: string;
  state: 'known' | 'unknown';
  returns: ReturnRow[];
  unparsed: number;
  reason?: string;
}

export const RETURNS_UNKNOWN_REASON = 'coordination ledger: reader failed';
export type ParsedReturns = {
  state: 'known' | 'unknown';
  rows: ReturnRow[];
  dropped: number;
  unparsed: number;
  reason: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 300): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function validRow(row: unknown): row is ReturnRow {
  if (!record(row) || !text(row.claimId, 128) || !text(row.repo, 220)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(row.repo)
    || !text(row.from, 200) || !text(row.evidence) || !date(row.at) || !date(row.expiresAt)) return false;
  if (row.result !== 'VERIFIED' && row.result !== 'BLOCKED') return false;
  if (typeof row.evidenceKind !== 'string' || !['pr', 'tests', 'artifact', 'dependency'].includes(row.evidenceKind)) return false;
  if ((row.result === 'BLOCKED') !== (row.evidenceKind === 'dependency')) return false;
  return row.evidenceKind === 'pr'
    ? count(row.pr) && row.pr > 0 && typeof row.head === 'string' && /^[a-fA-F0-9]{7,40}$/.test(row.head)
    : row.pr === null && row.head === null;
}

/** Reject malformed envelopes; count and drop malformed rows independently. */
export function parseReturns(body: unknown): ParsedReturns {
  const unknown: ParsedReturns = { state: 'unknown', rows: [], dropped: 0, unparsed: 0, reason: 'invalid results response' };
  if (!record(body) || body.v !== 1 || body.authority !== 'none'
    || !date(body.generatedAt) || !date(body.asOf) || !text(body.source, 100)
    || (body.state !== 'known' && body.state !== 'unknown') || !Array.isArray(body.returns)
    || !count(body.unparsed)) return unknown;
  const rows = body.returns.filter(validRow);
  return {
    state: body.state as 'known' | 'unknown',
    rows: body.state === 'known' ? rows : [],
    dropped: body.returns.length - rows.length,
    unparsed: body.unparsed,
    reason: body.state === 'unknown' ? RETURNS_UNKNOWN_REASON : '',
  };
}

export function returnsHeadline(parsed: ParsedReturns): { text: string; tone: 'neutral' | 'success' | 'danger' } {
  if (parsed.state === 'unknown') return { text: `Results unknown: ${parsed.reason}`, tone: 'neutral' };
  const verified = parsed.rows.filter(row => row.result === 'VERIFIED').length;
  const blocked = parsed.rows.length - verified;
  return { text: `${verified} verified, ${blocked} blocked`, tone: blocked > 0 ? 'danger' : verified > 0 ? 'success' : 'neutral' };
}
