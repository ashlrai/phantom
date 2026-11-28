/** Shared validation, path, and atomic persistence helpers for src/core/eval. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export function fail(file: string, line: number, why: string): never {
  throw new Error(`${file}:${line}: ${why}`);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function optString(file: string, line: number, rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(file, line, `bad ${key}`);
  return v;
}

export function parseDatasetLine(raw: string, file: string, line: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(file, line, 'not JSON');
  }
  const rec = asRecord(value);
  if (!rec) fail(file, line, 'line must be an object');
  return rec;
}

/** Parse non-empty, non-comment JSONL lines and verify each carries `v: 1`. */
export function parseV1DatasetLines(text: string, file: string): Array<{ line: number; rec: Record<string, unknown> }> {
  const out: Array<{ line: number; rec: Record<string, unknown> }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const line = i + 1;
    const rec = parseDatasetLine(raw, file, line);
    if (rec['v'] !== 1) fail(file, line, `unsupported v ${JSON.stringify(rec['v'])}`);
    out.push({ line, rec });
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Resolve the eval state root: explicit override, then ASHLR_HOME, then ~/.ashlr. */
export function resolveEvalRoot(rootDir?: string): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

/** Atomically write UTF-8 text via a sibling temporary file and rename. */
export function atomicWriteEvalFile(file: string, text: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

export function atomicWriteEvalJson(file: string, value: unknown): void {
  atomicWriteEvalFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Load matching JSON reports from `dir`, skipping malformed files, sorted ascending by `sortKey`. */
export function loadEvalJsonReports<T>(
  dir: string,
  accept: (value: unknown) => value is T,
  sortKey: (report: T) => string,
): T[] {
  if (!existsSync(dir)) return [];
  const reports: T[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown;
      if (accept(parsed)) reports.push(parsed);
    } catch {
      // skip malformed files
    }
  }
  return reports.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

/** Return true when `targetPath` resolves inside `baseDir` (or equals it when `allowEqual` is true). */
export function isPathWithinDir(targetPath: string, baseDir: string, allowEqual = false): boolean {
  const resolved = path.resolve(targetPath);
  const base = path.resolve(baseDir);
  if (allowEqual && resolved === base) return true;
  return resolved.startsWith(base + path.sep);
}
