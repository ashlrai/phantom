import * as path from 'node:path';
import type { AttentionEvalReport } from './attention.js';
import { asRecord, atomicWriteJson, loadJsonDirReports, resolveAshlrRoot } from './dataset-jsonl.js';

export interface AttentionReportStoreOptions {
  rootDir?: string;
}

function attentionReportsDir(opts: AttentionReportStoreOptions = {}): string {
  return path.join(resolveAshlrRoot(opts.rootDir), 'eval', 'attention', 'reports');
}

export function saveAttentionReport(
  report: AttentionEvalReport,
  opts: AttentionReportStoreOptions = {},
): string {
  const file = path.join(attentionReportsDir(opts), `${safeReportId(report.id)}.json`);
  atomicWriteJson(file, report);
  return file;
}

function isAttentionEvalReport(value: unknown): value is AttentionEvalReport {
  const rec = asRecord(value);
  return rec !== undefined && rec['schemaVersion'] === 1 && typeof rec['id'] === 'string' && typeof rec['generatedAt'] === 'string';
}

export function loadAttentionReports(
  opts: AttentionReportStoreOptions = {},
): AttentionEvalReport[] {
  return loadJsonDirReports(attentionReportsDir(opts), isAttentionEvalReport, (report) => report.generatedAt);
}

function safeReportId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `attention-${Date.now().toString(36)}`;
}
