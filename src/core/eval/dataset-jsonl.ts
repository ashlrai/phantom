/** Shared validation, storage, and formatting helpers for evaluation modules. */
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

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface VersionedDatasetItem {
  kind: 'meta' | 'entry';
  rec: Record<string, unknown>;
  line: number;
}

/** Yield validated v=1 dataset JSONL records, enforcing single leading meta line. */
export function* iterVersionedDatasetLines(
  text: string,
  file: string,
  metaOrderError: string,
): Generator<VersionedDatasetItem> {
  let seenMeta = false;
  let seenEntry = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const line = i + 1;
    const rec = parseDatasetLine(raw, file, line);
    if (rec['v'] !== 1) fail(file, line, `unsupported v ${JSON.stringify(rec['v'])}`);
    if (rec['kind'] === 'meta') {
      if (seenEntry) fail(file, line, metaOrderError);
      if (seenMeta) fail(file, line, 'duplicate meta line');
      seenMeta = true;
      yield { kind: 'meta', rec, line };
      continue;
    }
    seenEntry = true;
    yield { kind: 'entry', rec, line };
  }
}

/** Resolve the Phantom state root (explicit rootDir > ASHLR_HOME > ~/.ashlr). */
export function resolveEvalAshlrRoot(rootDir?: string): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

/** Atomic write via temp sibling + rename with best-effort cleanup on failure. */
export function writeTextFileAtomic(file: string, text: string): void {
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

export function writeJsonFileAtomic(file: string, value: unknown): void {
  writeTextFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Load valid JSON report files from a directory sorted ascending by `sortKey`. */
export function loadJsonReports<T>(
  dir: string,
  accept: (value: unknown) => value is T,
  sortKey: (report: T) => string,
): T[] {
  if (!existsSync(dir)) return [];
  const reports: T[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as unknown;
      if (accept(parsed)) reports.push(parsed);
    } catch {
      // skip malformed files
    }
  }
  return reports.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

export const formatEvalPct = (n: number): string => `${(n * 100).toFixed(1)}%`;
export const formatEvalUsd = (n: number): string => `$${n.toFixed(2)}`;
export const formatEvalMinutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;
