/** Shared dataset parsing, record validation, and JSON persistence helpers for src/core/eval/. */
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

export interface VersionedJsonlDatasetSpec<TMeta, TItem> {
  itemKind: string;
  initialMeta: TMeta;
  parseMeta: (rec: Record<string, unknown>, file: string, line: number) => TMeta;
  parseItem: (rec: Record<string, unknown>, file: string, line: number, seen: Set<string>) => TItem;
  emptyMessage?: string;
}

export function parseVersionedJsonlDataset<TMeta, TItem>(
  text: string,
  file: string,
  spec: VersionedJsonlDatasetSpec<TMeta, TItem>,
): { meta: TMeta; items: TItem[]; sha256: string } {
  let meta = spec.initialMeta;
  let seenMeta = false;
  const items: TItem[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const line = i + 1;
    const rec = parseDatasetLine(raw, file, line);
    if (rec.v !== 1) fail(file, line, `unsupported v ${JSON.stringify(rec.v)}`);
    if (rec.kind === 'meta') {
      if (items.length > 0) fail(file, line, `meta must precede ${spec.itemKind} lines`);
      if (seenMeta) fail(file, line, 'duplicate meta line');
      seenMeta = true;
      meta = spec.parseMeta(rec, file, line);
      continue;
    }
    if (rec.kind !== undefined && rec.kind !== spec.itemKind) {
      fail(file, line, `unknown kind ${JSON.stringify(rec.kind)}`);
    }
    items.push(spec.parseItem(rec, file, line, seen));
  }
  if (spec.emptyMessage !== undefined && items.length === 0) {
    fail(file, 0, spec.emptyMessage);
  }
  return {
    meta,
    items,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

/** Resolve the Phantom state root for eval stores (`rootDir` -> `ASHLR_HOME` -> `~/.ashlr`). */
export function evalAshlrRoot(rootDir?: string): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

/** Atomically write a UTF-8 file via sibling `.tmp` + rename, cleaning up on failure. */
export function writeEvalFileAtomically(file: string, text: string): void {
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

/** Load and parse valid `.json` files in a directory, sorted ascending by timestamp. */
export function loadSortedEvalJsonFiles<T>(
  dir: string,
  accept: (value: unknown) => value is T,
  timestampOf: (item: T) => string,
): T[] {
  if (!existsSync(dir)) return [];
  const items: T[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as unknown;
      if (accept(parsed)) items.push(parsed);
    } catch {
      // skip malformed files
    }
  }
  return items.sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
}
