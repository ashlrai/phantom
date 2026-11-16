/**
 * report-ledger-files.ts — deterministic 07:30/20:00 ET report-file builder
 * (RQ-REPORTS-NO-GROK-1 report-file slice, recovered from PR #4284).
 *
 * An agent must be able to build the due recorded-activity report files
 * without any model or network: <runsDir>/export/report-0730.md and
 * report-2000.md from metrics/jobs.jsonl alone. This restores the original
 * ET-slot contract — America/New_York day/minute math, the 07:25 and 19:55
 * build times (five minutes ahead of the 07:30 / 20:00 read times the files
 * are named for), the versioned marker and the day-gated idempotent write —
 * on top of the recovered ledger (report-ledger.ts). The original PR's world
 * model, intents and gh Actions evidence are NOT collected here; every file
 * carries an explicit ledger-only coverage line.
 *
 * Honesty rules carried over: a missing ledger renders 'unavailable' with
 * unknown counts, a truncated tail 'incomplete' (lower bound), and the marker
 * must match BOTH slot and ET day — a report written for another slot can
 * never suppress this slot's build. Per-slot failures land in the entry, not
 * the caller; this module never throws.
 */

import { join } from 'node:path';

import {
  ensurePrivateDirectory,
  readPrivateFileCapped,
  writePrivateFileAtomic,
} from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import { buildReportLedger, renderReportLedgerText, type ReportLedger } from './report-ledger.js';

export const REPORT_LEDGER_FILES_SCHEMA = 'ashlr.fleet-report-ledger-files/v1' as const;
export const REPORT_SLOTS = ['0730', '2000'] as const;
export type ReportSlot = (typeof REPORT_SLOTS)[number];
/** Build times (America/New_York) and the read-time label the file is named for. */
export const REPORT_SLOT_TIMES: Readonly<Record<ReportSlot, { buildHour: number; buildMinute: number; label: string }>> = {
  '0730': { buildHour: 7, buildMinute: 25, label: '07:30' },
  '2000': { buildHour: 19, buildMinute: 55, label: '20:00' },
};
const REPORT_TZ = 'America/New_York';
const REPORT_READ_BYTES = 8 * 1024;
const MARKER = /^<!--\s*ashlr\.fleet-report-ledger-files\/v1\s+slot=(\d{4})\s+day=(\d{4}-\d{2}-\d{2})\s+generatedAt=(\S+)\s*-->/;

// ---------------------------------------------------------------------------
// Slot math (America/New_York)
// ---------------------------------------------------------------------------

const ET_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** The local day and minutes-after-midnight in America/New_York for `now`. */
export function reportClockEt(now: Date): { day: string; minutes: number } {
  const parts = ET_FORMAT.formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

/** Slots whose ET build time has already passed today, in order. */
export function dueReportSlots(now: Date): ReportSlot[] {
  const { minutes } = reportClockEt(now);
  return REPORT_SLOTS.filter((slot) => {
    const at = REPORT_SLOT_TIMES[slot];
    return minutes >= at.buildHour * 60 + at.buildMinute;
  });
}

export function reportPath(runsDir: string, slot: ReportSlot): string {
  return join(runsDir, 'export', `report-${slot}.md`);
}

/**
 * The slot, ET day and build stamp a written report covers, from its marker
 * comment; null when absent. Only the first lines are inspected.
 */
export function reportLedgerMarker(content: string): { slot: string; day: string; generatedAt: string } | null {
  const match = MARKER.exec(content.split('\n', 3).join('\n'));
  if (!match) return null;
  return { slot: match[1]!, day: match[2]!, generatedAt: match[3]! };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Marker + heading + coverage line over the plain ledger summary. */
export function renderReportLedgerFile(slot: ReportSlot, day: string, report: ReportLedger): string {
  return [
    `<!-- ${REPORT_LEDGER_FILES_SCHEMA} slot=${slot} day=${day} generatedAt=${report.generatedAt} -->`,
    `# Recorded fleet activity — ${REPORT_SLOT_TIMES[slot].label} ET report · ${day}`,
    '',
    'Coverage: jobs ledger only — the world model, leader intents and Actions runs are not collected in this build.',
    '',
    renderReportLedgerText(report),
    '',
  ].join('\n');
}

export type ReportFileOutcome = 'wrote' | 'skipped' | 'failed';

export interface ReportFileEntry {
  slot: ReportSlot;
  path: string;
  outcome: ReportFileOutcome;
  /** 'already-built-today' or scrubbed, bounded error text. */
  reason: string | null;
  bytes: number | null;
}

export interface BuildReportLedgerFilesOptions {
  runsDir: string;
  /** 'auto' builds every slot due today not yet built; a slot name builds it now. */
  slot?: ReportSlot | 'auto';
  force?: boolean;
  now?: Date;
}

/**
 * Build the due reports under <runsDir>/export/. Idempotent per ET day unless
 * `force`. Never throws; per-slot failures land in the entry, not the caller.
 */
export async function buildReportLedgerFiles(opts: BuildReportLedgerFilesOptions): Promise<{ schema: typeof REPORT_LEDGER_FILES_SCHEMA; day: string; entries: ReportFileEntry[] }> {
  const now = opts.now ?? new Date();
  const { day } = reportClockEt(now);
  const wanted: ReportSlot[] = opts.slot === undefined || opts.slot === 'auto'
    ? dueReportSlots(now)
    : [opts.slot];
  const entries: ReportFileEntry[] = [];
  for (const slot of wanted) {
    const path = reportPath(opts.runsDir, slot);
    const existing = readPrivateFileCapped(path, REPORT_READ_BYTES);
    const marker = existing === null || existing.truncated ? null : reportLedgerMarker(existing.text);
    if (!opts.force && marker !== null && marker.slot === slot && marker.day === day) {
      entries.push({ slot, path, outcome: 'skipped', reason: 'already-built-today', bytes: existing?.bytes ?? null });
      continue;
    }
    try {
      const report = await buildReportLedger({ runsDir: opts.runsDir, now });
      const body = renderReportLedgerFile(slot, day, report);
      ensurePrivateDirectory(join(opts.runsDir, 'export'));
      writePrivateFileAtomic(path, body);
      entries.push({ slot, path, outcome: 'wrote', reason: null, bytes: Buffer.byteLength(body) });
    } catch (err) {
      const reason = scrubSecrets(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
      entries.push({ slot, path, outcome: 'failed', reason, bytes: null });
    }
  }
  return { schema: REPORT_LEDGER_FILES_SCHEMA, day, entries };
}
