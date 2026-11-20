/**
 * The answers ledger: one append-only JSON line per answer Mason gives to an ask
 * (`asks-ledger.jsonl` beside NEEDS-MASON.md), with who answered, through which
 * channel and when. It is written only by answerAsk, after the same
 * `needs_mason.resolved` bus event every surface already emits.
 *
 * Two kinds of answer carry more than a word:
 *  - usage: "40" is stored as a usage reading with source=mason and its own
 *    timestamp. readMasonUsage hands the newest one to the usage reader and the
 *    spend guard, which decide for themselves whether it is fresh enough.
 *  - credit-decision: "yes" / "no" / "later" to a payment ask about a pool's credit is stored as a typed decision
 *    (readCreditDecision) that other tools may read; nothing is spent and no lane target changes here.
 *  - approval: "yes" or "no" is stored as an approval record and nothing else.
 *    This module spends nothing and makes no billing call.
 * Never put a secret in a reply; a reply is a word or a percent.
 */
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ASKS_LEDGER_FILE = 'asks-ledger.jsonl';

export type AskLedgerType = 'answer' | 'usage-reading' | 'approval' | 'credit-decision';
export interface AskLedgerRecord {
  schema: 'asks.ledger.v1';
  type: AskLedgerType;
  askId: string;
  kind: string;
  /** The ask's subject (a usage pool, an approval name), or null. */
  subject: string | null;
  /** The surface the answer came through: cli, phone, desktop, telegram, ... */
  channel: string;
  /** Always mason: only a verified-Mason source reaches the ledger. */
  source: 'mason';
  /** ISO time of the answer. */
  at: string;
  reply: string;
  /** usage-reading and credit-decision. */
  pool?: string;
  pctUsed?: number;
  /** approval and credit-decision. A `yes` means "use it": the record spends nothing and changes no lane. */
  decision?: 'yes' | 'no' | 'later';
}

export interface AskLedgerInput {
  askId: string; kind: string; subject: string | null; reply: string; channel: string; at: string;
}

/** The record an answer becomes: usage and approval asks get their typed form. */
export function askLedgerRecordOf(input: AskLedgerInput): AskLedgerRecord {
  const base = {
    schema: 'asks.ledger.v1' as const, askId: input.askId, kind: input.kind, subject: input.subject,
    channel: input.channel, source: 'mason' as const, at: input.at, reply: input.reply,
  };
  if (input.kind === 'usage' && input.subject) return { ...base, type: 'usage-reading', pool: input.subject, pctUsed: Number(input.reply) };
  if (input.kind === 'approval' && (input.reply === 'yes' || input.reply === 'no' || input.reply === 'later')) {
    return { ...base, type: 'approval', decision: input.reply };
  }
  if (input.kind === 'payment' && input.subject && (input.reply === 'yes' || input.reply === 'no' || input.reply === 'later')) {
    return { ...base, type: 'credit-decision', pool: input.subject, decision: input.reply };
  }
  return { ...base, type: 'answer' };
}

const runsDirOf = (runsDir?: string): string => runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
const fileOf = (runsDir: string): string => join(runsDir, ASKS_LEDGER_FILE);

/** Append one record. False when it could not be written; never throws, never rewrites a line. */
export function appendAskLedger(runsDir: string, record: AskLedgerRecord): boolean {
  try {
    mkdirSync(runsDir, { recursive: true });
    appendFileSync(fileOf(runsDir), `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'a' });
    return true;
  } catch { return false; }
}

/** Every readable record, oldest first. A missing file is empty; a damaged line is skipped, not guessed. */
export function readAskLedger(runsDir?: string): AskLedgerRecord[] {
  const path = fileOf(runsDirOf(runsDir));
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!fstatSync(fd).isFile()) return []; } finally { closeSync(fd); }
    const records: AskLedgerRecord[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Partial<AskLedgerRecord> | null;
        if (row && row.schema === 'asks.ledger.v1' && row.source === 'mason' && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))) {
          records.push(row as AskLedgerRecord);
        }
      } catch { /* one bad line must not hide the rest */ }
    }
    return records;
  } catch { return []; }
}

export interface MasonUsageReading {
  pool: string;
  pctUsed: number;
  source: 'mason';
  channel: string;
  /** When Mason gave the number: the reading's timestamp. */
  fetchedAt: string;
  ageMs: number;
}

/** Mason's newest stated usage for a pool, or null. Age is reported, never judged: the guard owns its own freshness limit. */
export function readMasonUsage(pool: string, options: { runsDir?: string; now?: () => number } = {}): MasonUsageReading | null {
  let newest: AskLedgerRecord | null = null;
  for (const row of readAskLedger(options.runsDir)) {
    if (row.type !== 'usage-reading' || row.pool !== pool || typeof row.pctUsed !== 'number'
      || !(row.pctUsed >= 0 && row.pctUsed <= 100)) continue;
    if (!newest || Date.parse(row.at) >= Date.parse(newest.at)) newest = row;
  }
  if (!newest) return null;
  return {
    pool, pctUsed: newest.pctUsed!, source: 'mason', channel: newest.channel, fetchedAt: new Date(newest.at).toISOString(),
    ageMs: Math.max(0, (options.now ?? Date.now)() - Date.parse(newest.at)),
  };
}

export interface CreditDecision { pool: string; decision: 'yes' | 'no' | 'later'; askId: string; channel: string; at: string }

/** Mason's newest answer to a credit ask for a pool (`yes` = use it), or null when none was given. Reads only. */
export function readCreditDecision(pool: string, options: { runsDir?: string } = {}): CreditDecision | null {
  let newest: AskLedgerRecord | null = null;
  for (const row of readAskLedger(options.runsDir)) {
    if (row.type !== 'credit-decision' || row.pool !== pool || !(row.decision === 'yes' || row.decision === 'no' || row.decision === 'later')) continue;
    if (!newest || Date.parse(row.at) >= Date.parse(newest.at)) newest = row;
  }
  return newest ? { pool, decision: newest.decision!, askId: newest.askId, channel: newest.channel, at: new Date(newest.at).toISOString() } : null;
}
