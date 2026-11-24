/**
 * Path, ledger and idempotency guards for autofix.
 * Never reads keychain, chat.db, TCC databases, ~/.codex or secret files.
 */
import { join } from 'node:path';

import { scrubSecrets } from '../util/scrub-secrets.js';
import { LEDGER_NAME, type AutofixHost, type FixResult, type FixerId, type LedgerLine } from './types.js';

const FORBIDDEN = [
  /(?:^|\/)\.codex(?:\/|$)/,
  /(?:^|\/)chat\.db$/,
  /(?:^|\/)TCC\.db$/,
  /(?:^|\/)Keychains(?:\/|$)/,
  /(?:^|\/)secrets(?:\/|$)/,
];

export function forbiddenPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  return FORBIDDEN.some((re) => re.test(norm));
}

export function ledgerPath(runsDir: string): string {
  return join(runsDir, 'ledger', LEDGER_NAME);
}

export function ledgerLine(
  ts: string,
  fixer: FixerId,
  target: string,
  action: string,
  before: unknown,
  after: unknown,
  result: FixResult,
): LedgerLine {
  return { ts, fixer, target, action, before, after, result };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key]);
    return out;
  }
  return value;
}

export function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function readLedger(text: string | null): LedgerLine[] {
  if (!text) return [];
  const lines: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<LedgerLine>;
      if (typeof parsed.fixer === 'string' && typeof parsed.target === 'string'
        && typeof parsed.action === 'string' && typeof parsed.result === 'string'
        && typeof parsed.ts === 'string') {
        lines.push({
          ts: parsed.ts,
          fixer: parsed.fixer as FixerId,
          target: parsed.target,
          action: parsed.action,
          before: parsed.before,
          after: parsed.after,
          result: parsed.result as FixResult,
        });
      }
    } catch {
      /* A corrupt line does not grant a second action. */
    }
  }
  return lines;
}

const TERMINAL: ReadonlySet<FixResult> = new Set([
  'applied', 'refused_admitted', 'refused_stale', 'refused_operator', 'detect-only', 'refused',
]);

/** Same fixer, target, action and before-state already recorded as a terminal result. */
export function alreadyRecorded(lines: readonly LedgerLine[], line: Pick<LedgerLine, 'fixer' | 'target' | 'action' | 'before'>): LedgerLine | null {
  const key = stable(line.before);
  for (let i = lines.length - 1; i >= 0; i--) {
    const prior = lines[i]!;
    if (prior.fixer === line.fixer && prior.target === line.target && prior.action === line.action
      && TERMINAL.has(prior.result) && stable(prior.before) === key) return prior;
  }
  return null;
}

export function appendLedger(host: AutofixHost, line: LedgerLine): void {
  const text = scrubSecrets(JSON.stringify(line));
  host.appendFile(ledgerPath(host.runsDir()), `${text}\n`);
}

export function scrubText(text: string, max = 2000): string {
  return scrubSecrets(text).slice(0, max);
}
