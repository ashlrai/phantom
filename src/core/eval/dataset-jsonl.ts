/** Shared validation and persistence helpers for evaluation modules. */
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

/** Resolve the Phantom state root (`rootDir` override -> `ASHLR_HOME` -> `~/.ashlr`). */
export function resolveEvalRoot(rootDir?: string): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

let atomicWriteSeq = 0;

/** Atomically write UTF-8 text via a sibling temporary file + rename. */
export function writeTextAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${++atomicWriteSeq}.tmp`);
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

/** Atomically write pretty-printed JSON with a trailing newline. */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Load and sort validated JSON report files from a directory, ignoring malformed entries. */
export function loadJsonReports<T>(
  dir: string,
  guard: (value: unknown) => value is T,
  compare: (a: T, b: T) => number,
): T[] {
  if (!existsSync(dir)) return [];
  const reports: T[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown;
      if (guard(parsed)) reports.push(parsed);
    } catch {
      // ignore malformed reports
    }
  }
  return reports.sort(compare);
}
