import * as path from 'node:path';
import type { AttentionEvalReport } from './attention.js';
import { asRecord, loadJsonReports, resolveEvalRoot, writeJsonAtomic } from './dataset-jsonl.js';

export interface AttentionReportStoreOptions {
  rootDir?: string;
}

function attentionEvalRoot(opts: AttentionReportStoreOptions = {}): string {
  return path.join(resolveEvalRoot(opts.rootDir), 'eval', 'attention');
}

function attentionReportsDir(opts: AttentionReportStoreOptions = {}): string {
  return path.join(attentionEvalRoot(opts), 'reports');
}

export function saveAttentionReport(
  report: AttentionEvalReport,
  opts: AttentionReportStoreOptions = {},
): string {
  const dir = attentionReportsDir(opts);
  const id = safeReportId(report.id);
  const file = path.join(dir, `${id}.json`);
  writeJsonAtomic(file, report);
  return file;
}

function isAttentionEvalReport(value: unknown): value is AttentionEvalReport {
  const rec = asRecord(value);
  return rec !== undefined && rec['schemaVersion'] === 1 && typeof rec['id'] === 'string';
}

export function loadAttentionReports(
  opts: AttentionReportStoreOptions = {},
): AttentionEvalReport[] {
  return loadJsonReports(
    attentionReportsDir(opts),
    isAttentionEvalReport,
    (a, b) => a.generatedAt.localeCompare(b.generatedAt),
  );
}

function safeReportId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `attention-${Date.now().toString(36)}`;
}
