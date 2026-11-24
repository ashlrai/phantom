/**
 * Recorded local-generator selection, recovered from PR #5952
 * (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886), `selectLocalCandidate` in
 * src/core/providers/coding-cli/catalog.ts.
 *
 * Provenance and limits: a pure function over a catalog the caller already
 * parsed. It runs no CLI, probes no provider, reads no auth home, downloads
 * nothing and reads no live inventory. Every answer is a RECORDED fit: a
 * listed, unverified or rejected row stays that way, and no model flag is
 * produced. The memory fraction is the source's historical heuristic, supplied
 * explicitly by the caller. It is not a live safety measurement or a routing rule.
 */

import type { CodingCliCatalog, TierCandidate } from './catalog.js';

/** The source helper's fraction. A recorded heuristic only; callers must pass their own. */
export const HISTORICAL_RECORDED_MEMORY_FRACTION = 0.6;

/** `recorded-size-within-budget`: recorded sizeGb <= budget. `recorded-size-unknown`: no recorded size. */
export type RecordedFitEvidence = 'recorded-size-within-budget' | 'recorded-size-unknown';

export interface RecordedLocalSelection {
  /** Copy of the catalog row. accountStatus is kept as recorded. */
  candidate: TierCandidate;
  evidence: RecordedFitEvidence;
}

export interface RecordedLocalFitOptions {
  /** Caller-supplied RAM in GB. The recorded machine.ramGb is deliberately not used. */
  ramGb: number;
  /** Share of ramGb a recorded size may use, in (0, 1]. Required; no default is applied. */
  memoryFraction: number;
}

export interface RecordedLocalFit {
  provenance: { source: string; observedAt: string; /** Always false: recorded data, not installed or probed. */ live: false };
  ramGb: number;
  memoryFraction: number;
  memoryBudgetGb: number;
  /** Largest recorded size within budget. Never a row with unknown size. */
  selected: RecordedLocalSelection | null;
  /** Best row with no recorded size, reported apart from `selected`. Not treated as fitting. */
  indeterminate: RecordedLocalSelection | null;
  excluded: { embedding: number; oversized: number };
  explanation: string;
}

function fail(detail: string): never {
  throw new Error(`recorded local fit: ${detail}`);
}

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${name} must be a finite number >= 0`);
  return value;
}

/** Code-unit comparison, so tie breaks do not depend on the host locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Select the largest recorded local generator within `memoryFraction` of the
 * supplied RAM. Embedding rows are excluded. Equal sizes sort by name, then
 * backend. Rows with no recorded size go to `indeterminate`.
 *
 * Throws on a malformed catalog or on non-finite or negative numbers. It never
 * coerces a missing size to zero.
 */
export function selectRecordedLocalFit(catalog: CodingCliCatalog, options: RecordedLocalFitOptions): RecordedLocalFit {
  const { ramGb, memoryFraction } = options;
  finiteNonNegative(ramGb, 'ramGb');
  if (typeof memoryFraction !== 'number' || !Number.isFinite(memoryFraction) || memoryFraction <= 0 || memoryFraction > 1) {
    fail('memoryFraction must be in (0, 1]');
  }
  const rows: unknown = catalog?.tiers?.local;
  if (!Array.isArray(rows)) fail('catalog.tiers.local must be an array');

  const memoryBudgetGb = ramGb * memoryFraction;
  const verified: TierCandidate[] = [];
  const unknown: TierCandidate[] = [];
  const excluded = { embedding: 0, oversized: 0 };

  for (const row of rows as TierCandidate[]) {
    if (typeof row !== 'object' || row === null) fail('tier row must be an object');
    if (row.task !== undefined && row.task !== 'generate' && row.task !== 'embed') fail('tier row task must be generate or embed');
    if (row.sizeGb !== undefined) finiteNonNegative(row.sizeGb, 'tier row sizeGb');
    if (row.task === 'embed') excluded.embedding += 1;
    else if (row.sizeGb === undefined) unknown.push(row);
    else if (row.sizeGb <= memoryBudgetGb) verified.push(row);
    else excluded.oversized += 1;
  }

  // Descending recorded size, then name, then backend. Same order for any input order.
  verified.sort((a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0) || compareText(a.candidate, b.candidate) || compareText(a.backend, b.backend));
  unknown.sort((a, b) => compareText(a.candidate, b.candidate) || compareText(a.backend, b.backend));

  const first = verified[0];
  const selected = first ? { candidate: { ...first }, evidence: 'recorded-size-within-budget' as const } : null;
  const firstUnknown = unknown[0];
  const indeterminate = firstUnknown ? { candidate: { ...firstUnknown }, evidence: 'recorded-size-unknown' as const } : null;

  const label = (row: TierCandidate): string =>
    `${row.backend}/${row.candidate} (${row.sizeGb === undefined ? 'size unknown' : `recorded ${row.sizeGb} GB`}, accountStatus ${row.accountStatus})`;
  const head = `Recorded only, not installed, accepted or live; recorded ${catalog.observedAt} from ${catalog.source}; ` +
    `budget ${memoryBudgetGb} GB (${ramGb} GB supplied RAM x ${memoryFraction} caller-supplied fraction).`;
  const body = first ? ` Selected ${label(first)}: recorded size fits the budget.` : ' No recorded size fits the budget.';
  const tail = firstUnknown ? ` Indeterminate ${label(firstUnknown)}: size unknown, not treated as fitting.` : '';

  return {
    provenance: { source: catalog.source, observedAt: catalog.observedAt, live: false },
    ramGb,
    memoryFraction,
    memoryBudgetGb,
    selected,
    indeterminate,
    excluded,
    explanation: head + body + tail,
  };
}
