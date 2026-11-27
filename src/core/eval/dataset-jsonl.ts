/** Shared JSONL dataset validation and file-store helpers for eval modules. */
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

export interface VersionedJsonlRow {
  rec: Record<string, unknown>;
  line: number;
}

export interface VersionedJsonlDatasetOptions<TMeta> {
  itemKind: string;
  initialMeta: TMeta;
  parseMeta: (rec: Record<string, unknown>, line: number) => TMeta;
}

/**
 * Parse a v=1 line-oriented eval dataset with an optional leading `meta` row,
 * blank/comment skipping, and a sha256 digest of the exact input text.
 */
export function parseVersionedJsonlDataset<TMeta>(
  text: string,
  file: string,
  opts: VersionedJsonlDatasetOptions<TMeta>,
): { meta: TMeta; rows: VersionedJsonlRow[]; sha256: string } {
  let meta: TMeta = opts.initialMeta;
  let seenMeta = false;
  const rows: VersionedJsonlRow[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const line = i + 1;
    const rec = parseDatasetLine(raw, file, line);
    if (rec['v'] !== 1) fail(file, line, `unsupported v ${JSON.stringify(rec['v'])}`);
    if (rec['kind'] === 'meta') {
      if (rows.length > 0) fail(file, line, `meta must precede ${opts.itemKind} lines`);
      if (seenMeta) fail(file, line, 'duplicate meta line');
      seenMeta = true;
      meta = opts.parseMeta(rec, line);
      continue;
    }
    if (rec['kind'] !== undefined && rec['kind'] !== opts.itemKind) {
      fail(file, line, `unknown kind ${JSON.stringify(rec['kind'])}`);
    }
    rows.push({ rec, line });
  }
  return { meta, rows, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** Resolve the eval storage root: explicit override, then ASHLR_HOME, else ~/.ashlr. */
export function evalAshlrRoot(rootDir?: string): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

/** Atomic text write via a same-directory dot-prefixed temp file and rename. */
export function writeEvalFileAtomic(file: string, text: string): void {
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

/** Load valid JSON reports from `dir`, ignoring malformed files, sorted ascending by timestamp. */
export function loadEvalJsonReports<T>(
  dir: string,
  guard: (value: unknown) => value is T,
  timestampOf: (report: T) => string,
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
  return reports.sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
}
