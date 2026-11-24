/**
 * `phm fleet reverts` — 72h-window revert scan, read-only unless `--record`.
 *
 * Feeds gh-shaped merged-PR exports and a local checkout's ref history into
 * the revert detector (`revert.scan.v1`): which merged PRs were reverted
 * within 72h of merge — the hold-rate evidence the router consumes. Never
 * fetches, merges or queues; `--record` is the only write, appending the
 * detected `RevertOutcomeRecord`s to the revert-outcomes ledger so
 * `revertedPrKeys` (lesson withholding) can see git-history reverts. An
 * unreadable export or unresolvable ref degrades the report instead of
 * implying coverage.
 */
import { open } from 'node:fs/promises';
import {
  buildRevertScanReport,
  formatRevertScanReport,
  type RevertScanReport,
} from '../core/improve/revert-scan.js';
import {
  recordRevertOutcomes,
  type RevertRecordResult,
} from '../core/improve/revert-ledger.js';
import type { RevertOutcomeRecord } from '../core/improve/reverted.js';
import type { ObserveExec } from '../core/improve/observe.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PRS_FILES = 8;

const usage = `Usage: phm fleet reverts --repo-dir <dir> --prs <file> [--prs <file>]... [--ref <ref>] [--record] [--json]

Revert-outcome scan: checks merged PRs from gh-shaped exports
against a local checkout's history for reverts landing within 72h of merge
(the RevertOutcomeRecord evidence the router's hold-rate signal reads).
Never fetches, merges or queues; fetch the ref yourself first —
the report names exactly which ref and head commit were scanned.

  --repo-dir <dir>   Git checkout to scan (required).
  --prs <file>       gh-shaped merged-PR export (JSON array or JSONL);
                     repeatable, at most ${MAX_PRS_FILES}. Produce with:
                     gh pr list --state merged --json url,number,mergeCommit,mergedAt --limit 1000
  --ref <ref>        Git ref to scan (default: origin/HEAD, then HEAD).
  --record           Append detected RevertOutcomeRecords to the
                     revert-outcomes ledger
                     ($ASHLR_HOME/improve/revert-outcomes.jsonl); recorded
                     reverts feed revertedPrKeys (lesson withholding).
                     Default off — the scan stays read-only.
  --json             One JSON object on stdout.`;

async function readText(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, stat.size, 0);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface FleetRevertsDeps {
  read?: (path: string) => Promise<string | null>;
  exec?: ObserveExec;
  record?: (records: readonly RevertOutcomeRecord[]) => RevertRecordResult;
}

interface Parsed {
  json: boolean;
  record: boolean;
  repoDir?: string;
  prs: string[];
  ref?: string;
}

function parseArgs(args: string[]): Parsed | null {
  const parsed: Parsed = { json: false, record: false, prs: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    const take = (): string | null => {
      if (next === undefined || next.startsWith('--')) return null;
      i += 1;
      return next;
    };
    if (arg === '--json' && !parsed.json) parsed.json = true;
    else if (arg === '--record' && !parsed.record) parsed.record = true;
    else if (arg === '--repo-dir' && parsed.repoDir === undefined) {
      const value = take();
      if (value === null) return null;
      parsed.repoDir = value;
    } else if (arg === '--prs') {
      if (parsed.prs.length >= MAX_PRS_FILES) return null;
      const value = take();
      if (value === null) return null;
      parsed.prs.push(value);
    } else if (arg === '--ref' && parsed.ref === undefined) {
      const value = take();
      if (value === null) return null;
      parsed.ref = value;
    } else return null;
  }
  return parsed;
}

export async function cmdFleetReverts(args: string[], deps: FleetRevertsDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed || parsed.repoDir === undefined || parsed.prs.length === 0) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const read = deps.read ?? readText;
  const texts: (string | null)[] = [];
  for (const path of parsed.prs) texts.push(await read(path));
  const unreadable = texts.filter((t) => t === null).length;
  const report: RevertScanReport = buildRevertScanReport({
    repoDir: parsed.repoDir,
    ref: parsed.ref ?? null,
    prs: texts,
    exec: deps.exec,
  });
  // --record is the only write: detected records go to the revert-outcomes
  // ledger so revertedPrKeys and the router outcome fold see reverts no
  // other journal named. A corrupt ledger refuses the append and fails the
  // command — evidence is never written over.
  let recorded: RevertRecordResult | { error: string } | null = null;
  if (parsed.record) {
    const record = deps.record ?? ((records: readonly RevertOutcomeRecord[]) => recordRevertOutcomes(records));
    try {
      recorded = record(report.reverts);
    } catch (err) {
      recorded = { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  }
  if (unreadable > 0) {
    process.stderr.write(`warning: ${unreadable} --prs file(s) unreadable\n`);
  }
  if (recorded !== null && 'error' in recorded) {
    process.stderr.write(`revert ledger: ${recorded.error}\n`);
  }
  const body = recorded === null ? report : { ...report, recorded };
  process.stdout.write(parsed.json ? `${JSON.stringify(body)}\n` : `${formatRevertScanReport(report)}${recorded === null ? '' : `\n${recordedLine(recorded)}`}\n`);
  // Every export unreadable means zero evidence; scan errors or a refused
  // ledger write mean unknown, not clean.
  return report.errors.length > 0 || unreadable === parsed.prs.length || (recorded !== null && 'error' in recorded) ? 1 : 0;
}

function recordedLine(recorded: RevertRecordResult | { error: string }): string {
  if ('error' in recorded) return 'revert ledger: append refused (detail on stderr)';
  return `revert ledger: appended ${recorded.appended} record(s)` +
    `${recorded.duplicates > 0 ? `, ${recorded.duplicates} duplicate(s) skipped` : ''}`;
}
