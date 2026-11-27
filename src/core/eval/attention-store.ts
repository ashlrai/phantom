import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AttentionEvalReport } from './attention.js';
import { atomicWriteText, resolveEvalRoot } from './dataset-jsonl.js';

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
  atomicWriteText(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}

export function loadAttentionReports(
  opts: AttentionReportStoreOptions = {},
): AttentionEvalReport[] {
  const dir = attentionReportsDir(opts);
  if (!existsSync(dir)) return [];
  const reports: AttentionEvalReport[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as AttentionEvalReport;
      if (parsed?.schemaVersion === 1 && typeof parsed.id === 'string') reports.push(parsed);
    } catch {
      // ignore malformed reports
    }
  }
  return reports.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

function safeReportId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `attention-${Date.now().toString(36)}`;
}
