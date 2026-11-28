/**
 * Path, ledger and idempotency guards for autofix.
 * Never reads keychain, chat.db, TCC databases, ~/.codex or secret files.
 */
import { join } from 'node:path';

import { scrubSecrets } from '../util/scrub-secrets.js';
import {
  LEDGER_NAME, isAutofixRecord, isFixResult, isFixerId,
  type AutofixHost, type ExecResult, type FixResult, type FixerId, type LedgerLine,
} from './types.js';

const FORBIDDEN = [
  /(?:^|\/)\.codex(?:\/|$)/,
  /(?:^|\/)chat\.db$/,
  /(?:^|\/)TCC\.db$/,
  /(?:^|\/)Keychains(?:\/|$)/,
  /(?:^|\/)secrets(?:\/|$)/,
];

const FORBIDDEN_EXEC_BIN = /^(kill|pkill|killall)$/;

export const REFUSED_EXEC: Readonly<ExecResult> = Object.freeze({ code: 1, stdout: '', stderr: 'refused' });

export function forbiddenPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  return FORBIDDEN.some((re) => re.test(norm));
}

export function assertAllowedPath(path: string): void {
  if (forbiddenPath(path)) throw new Error('refused path');
}

/** Refuse empty commands, forbidden paths, or process-killing binaries. */
export function isForbiddenExecArgv(argv: readonly string[]): boolean {
  return argv.length === 0 || argv.some((arg) => forbiddenPath(arg) || FORBIDDEN_EXEC_BIN.test(arg));
}

export function ledgerPath(runsDir: string): string {
  return join(runsDir, 'ledger', LEDGER_NAME);
}

export function launchdRunsLedgerPath(runsDir: string): string {
  return join(runsDir, 'ledger', 'launchd-runs.jsonl');
}

export function securityReportsDir(runsDir: string): string {
  return join(runsDir, 'ledger', 'autofix-security');
}

export function safeReportToken(value: string, max?: number): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return max === undefined ? safe : safe.slice(0, max);
}

export function parseJsonlRecords<T>(
  text: string | null,
  parseEntry: (value: unknown) => T | null,
): T[] {
  if (!text) return [];
  const rows: T[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const row = parseEntry(JSON.parse(trimmed));
      if (row !== null) rows.push(row);
    } catch {
      /* A corrupt line does not grant a second action. */
    }
  }
  return rows;
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
  if (isAutofixRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function readLedger(text: string | null): LedgerLine[] {
  return parseJsonlRecords(text, (parsed): LedgerLine | null => {
    if (!isAutofixRecord(parsed)) return null;
    if (!isFixerId(parsed.fixer) || typeof parsed.target !== 'string'
      || typeof parsed.action !== 'string' || !isFixResult(parsed.result)
      || typeof parsed.ts !== 'string') return null;
    return {
      ts: parsed.ts,
      fixer: parsed.fixer,
      target: parsed.target,
      action: parsed.action,
      before: parsed.before,
      after: parsed.after,
      result: parsed.result,
    };
  });
}

const TERMINAL: ReadonlySet<FixResult> = new Set([
  'applied', 'refused_admitted', 'refused_stale', 'refused_operator', 'detect-only', 'refused',
]);

/** Same fixer, target, action and before-state already recorded as a terminal result. */
function alreadyRecorded(lines: readonly LedgerLine[], line: Pick<LedgerLine, 'fixer' | 'target' | 'action' | 'before'>): LedgerLine | null {
  const key = stable(line.before);
  for (let i = lines.length - 1; i >= 0; i--) {
    const prior = lines[i]!;
    if (prior.fixer === line.fixer && prior.target === line.target && prior.action === line.action
      && TERMINAL.has(prior.result) && stable(prior.before) === key) return prior;
  }
  return null;
}

/** Return a skipped ledger line carrying the prior outcome when this action was already recorded. */
export function skipIfRecorded(lines: readonly LedgerLine[], line: LedgerLine): LedgerLine | null {
  const prior = alreadyRecorded(lines, line);
  return prior ? ledgerLine(line.ts, line.fixer, line.target, line.action, line.before, prior.after, 'skipped') : null;
}

/** Handle the shared dry-run and idempotency gate before executing a mutating autofix action. */
export function planOrSkip(
  ctx: { dryRun: boolean; ledger: readonly LedgerLine[] },
  ts: string,
  fixer: FixerId,
  target: string,
  action: string,
  before: unknown,
  after: unknown,
): { done: true; line: LedgerLine } | { done: false; planned: LedgerLine } {
  if (ctx.dryRun) {
    return { done: true, line: ledgerLine(ts, fixer, target, action, before, after, 'dry-run') };
  }
  const planned = ledgerLine(ts, fixer, target, action, before, after, 'applied');
  const skipped = skipIfRecorded(ctx.ledger, planned);
  if (skipped) return { done: true, line: skipped };
  return { done: false, planned };
}

export function appendLedger(host: AutofixHost, line: LedgerLine): void {
  const text = scrubSecrets(JSON.stringify(line));
  host.appendFile(ledgerPath(host.runsDir()), `${text}\n`);
}

export function scrubText(text: string, max = 2000): string {
  return scrubSecrets(text).slice(0, max);
}
