/** Local wire contract for GET /api/verse/fleet/coordination-claims/returns/verify:
 * GitHub's verdict on each VERIFIED pr receipt. The web bundle never imports
 * the core check; a malformed answer parses to null and is never shown green. */
import type { ReturnRow } from './returns-model.js';

const VERDICTS = ['merged-at-head', 'merged-other-head', 'open', 'closed-unmerged', 'unknown'] as const;
export type VerifyVerdict = typeof VERDICTS[number];
/** The fixed reason codes of return-pr-check.ts; any other text is discarded. */
const REASONS = ['invalid-repo', 'read-failed', 'unparseable', 'deadline'];

export interface VerifyChecked {
  repo: string;
  pr: number;
  head: string | null;
  verdict: VerifyVerdict;
  reason: string | null;
}

export interface ParsedVerify {
  asOf: string;
  checked: VerifyChecked[];
  /** Why a check with every row merged can still be incomplete. */
  notes: string[];
  complete: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function checkedRow(row: unknown): VerifyChecked | null {
  if (!record(row) || typeof row.repo !== 'string' || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(row.repo)
    || !count(row.pr) || row.pr < 1
    || (row.head !== null && (typeof row.head !== 'string' || !/^[a-fA-F0-9]{7,40}$/.test(row.head)))) return null;
  const verdict = VERDICTS.find(v => v === row.verdict);
  if (verdict === undefined) return null;
  const reason = typeof row.reason === 'string' && REASONS.includes(row.reason) ? row.reason : null;
  return { repo: row.repo, pr: row.pr, head: row.head, verdict, reason };
}

/** Any malformed envelope or row rejects the whole answer: a partial verdict list could hide a failure. */
export function parseVerify(body: unknown): ParsedVerify | null {
  if (!record(body) || body.v !== 1 || body.authority !== 'none'
    || typeof body.asOf !== 'string' || !Number.isFinite(Date.parse(body.asOf))
    || (body.returnsState !== 'known' && body.returnsState !== 'unknown')
    || !record(body.coverage) || !count(body.unparsed) || !count(body.skipped)
    || typeof body.truncated !== 'boolean' || typeof body.complete !== 'boolean'
    || !Array.isArray(body.checked)) return null;
  const checked: VerifyChecked[] = [];
  for (const raw of body.checked) {
    const row = checkedRow(raw);
    if (row === null) return null;
    checked.push(row);
  }
  const notes: string[] = [];
  if (body.returnsState === 'unknown') notes.push('ledger unreadable');
  if (body.truncated) notes.push('more receipts than the check limit');
  if (count(body.coverage.omitted) && body.coverage.omitted > 0) notes.push(`${plural(body.coverage.omitted, 'receipt')} omitted`);
  if (body.unparsed > 0) notes.push(`${plural(body.unparsed, 'receipt')} unparsed`);
  if (count(body.nonCurrentReceipts) && body.nonCurrentReceipts > 0) notes.push(`${plural(body.nonCurrentReceipts, 'receipt')} not current`);
  // The server's flag is necessary, not sufficient: the rows shown must agree with it.
  const complete = body.complete && body.returnsState === 'known' && !body.truncated
    && checked.every(row => row.verdict === 'merged-at-head');
  return { asOf: body.asOf, checked, notes, complete };
}

/** GitHub's verdict for one strip row, joined on repo (case-insensitive) + pr + head. */
export function verdictFor(parsed: ParsedVerify, row: ReturnRow): VerifyChecked | null {
  if (row.result !== 'VERIFIED' || row.evidenceKind !== 'pr') return null;
  const head = row.head?.toLowerCase() ?? null;
  return parsed.checked.find(c => c.pr === row.pr && c.repo.toLowerCase() === row.repo.toLowerCase()
    && (c.head?.toLowerCase() ?? null) === head) ?? null;
}

export function verdictLabel(checked: VerifyChecked): string {
  return checked.verdict === 'unknown' ? `unknown (${checked.reason ?? 'no reason given'})` : checked.verdict;
}

export function verifyHeadline(parsed: ParsedVerify): { text: string; tone: 'neutral' | 'success' | 'danger' } {
  const n = parsed.checked.length;
  if (parsed.complete) {
    return n === 0 ? { text: 'No VERIFIED PR receipts to check on GitHub', tone: 'neutral' }
      : { text: `GitHub agrees with all ${plural(n, 'receipt')}`, tone: 'success' };
  }
  const merged = parsed.checked.filter(row => row.verdict === 'merged-at-head').length;
  const unknown = parsed.checked.filter(row => row.verdict === 'unknown').length;
  const text = `GitHub check incomplete: ${merged} merged at head, ${n - merged - unknown} other, ${unknown} unknown`;
  return { text: parsed.notes.length > 0 ? `${text} (${parsed.notes.join(', ')})` : text, tone: 'danger' };
}
