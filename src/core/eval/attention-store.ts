import * as path from 'node:path';
import type { AttentionEvalReport } from './attention.js';
import {
  asRecord,
  evalAshlrRoot,
  loadSortedEvalJsonFiles,
  writeEvalFileAtomically,
} from './dataset-jsonl.js';

export interface AttentionReportStoreOptions {
  rootDir?: string;
}

export function attentionEvalRoot(opts: AttentionReportStoreOptions = {}): string {
  return path.join(evalAshlrRoot(opts.rootDir), 'eval', 'attention');
}

export function attentionReportsDir(opts: AttentionReportStoreOptions = {}): string {
  return path.join(attentionEvalRoot(opts), 'reports');
}

export function saveAttentionReport(
  report: AttentionEvalReport,
  opts: AttentionReportStoreOptions = {},
): string {
  const id = safeReportId(report.id);
  const file = path.join(attentionReportsDir(opts), `${id}.json`);
  writeEvalFileAtomically(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}

function isAttentionEvalReport(value: unknown): value is AttentionEvalReport {
  const rec = asRecord(value);
  return rec !== undefined && rec['schemaVersion'] === 1 && typeof rec['id'] === 'string';
}

export function loadAttentionReports(
  opts: AttentionReportStoreOptions = {},
): AttentionEvalReport[] {
  return loadSortedEvalJsonFiles(
    attentionReportsDir(opts),
    isAttentionEvalReport,
    (report) => report.generatedAt,
  );
}

function safeReportId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `attention-${Date.now().toString(36)}`;
}
