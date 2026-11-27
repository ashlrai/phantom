import * as path from 'node:path';
import type { AttentionEvalReport } from './attention.js';
import { asRecord, loadJsonReports, resolveEvalAshlrRoot, writeJsonFileAtomic } from './dataset-jsonl.js';

export interface AttentionReportStoreOptions {
  rootDir?: string;
}

export function attentionEvalRoot(opts: AttentionReportStoreOptions = {}): string {
  return path.join(resolveEvalAshlrRoot(opts.rootDir), 'eval', 'attention');
}

export function attentionReportsDir(opts: AttentionReportStoreOptions = {}): string {
  return path.join(attentionEvalRoot(opts), 'reports');
}

export function saveAttentionReport(
  report: AttentionEvalReport,
  opts: AttentionReportStoreOptions = {},
): string {
  const file = path.join(attentionReportsDir(opts), `${safeReportId(report.id)}.json`);
  writeJsonFileAtomic(file, report);
  return file;
}

function isAttentionEvalReport(value: unknown): value is AttentionEvalReport {
  const rec = asRecord(value);
  return rec !== undefined && rec['schemaVersion'] === 1 && typeof rec['id'] === 'string';
}

export function loadAttentionReports(
  opts: AttentionReportStoreOptions = {},
): AttentionEvalReport[] {
  return loadJsonReports(attentionReportsDir(opts), isAttentionEvalReport, (r) => r.generatedAt);
}

function safeReportId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `attention-${Date.now().toString(36)}`;
}
