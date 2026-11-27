/** Shared validation, persistence, and formatting helpers for eval modules. */
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

/** Resolve the Phantom state root (explicit override, then ASHLR_HOME, then ~/.ashlr). */
export function resolveAshlrRoot(rootDir?: string): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

/** Atomic write via sibling temp file + rename, with best-effort cleanup on failure. */
export function atomicWriteFile(file: string, text: string): void {
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

export function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Load and validate every `.json` report in `dir`, skipping malformed entries. */
export function loadJsonDirReports<T>(
  dir: string,
  accept: (parsed: unknown) => parsed is T,
  sortKey: (report: T) => string,
): T[] {
  if (!existsSync(dir)) return [];
  const reports: T[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      if (accept(parsed)) reports.push(parsed);
    } catch {
      // skip malformed files
    }
  }
  return reports.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

export function formatEvalPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatEvalUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatEvalMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}
