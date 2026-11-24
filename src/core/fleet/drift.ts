import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readManifestFiles, readPinnedNames } from './bin-diff.js';

const run = promisify(execFile);

/** same: identical bytes. repo_newer: live copy is older than the repo. live_only: live has something the repo does not (no repo source, or a local edit newer than the repo change). missing: not installed. */
export type DriftState = 'same' | 'repo_newer' | 'live_only' | 'missing';

export interface DriftFile {
  file: string;
  /** Repo-relative source, null when the manifest lists the file without a repo copy. */
  source: string | null;
  state: DriftState;
  /** Sync never writes these; the reason says why in plain words. */
  protectedReason: string | null;
  sourceSha256: string | null;
  liveSha256: string | null;
  /** ISO commit time of the newest repo change to the source; null when git cannot say. */
  repoChangedAt: string | null;
}

export interface DriftReport {
  schema: 'fleet.drift.v1';
  readOnly: true;
  asOf: string;
  repo: string;
  runtimeDir: string;
  files: DriftFile[];
  counts: Record<DriftState, number>;
  /** Files whose live copy is not the repo copy: everything except `same`. */
  notLive: number;
}

export interface DriftDeps {
  now?: () => Date;
  /** ISO time of the newest commit touching `source`, or null. */
  lastChange?: (repo: string, source: string) => Promise<string | null>;
}

const PROTECTED_NAME = [
  [/(^|[-_.])(sandbox|seatbelt)|\.sb$/i, 'sandbox profile'],
  [/^leader|[-_]leader|mason-inbox/i, 'leader prompt or wrapper'],
  [/publish|release/i, 'publish or release script'],
] as const;

/** Why sync must leave this file alone, or null when it may be copied. */
export function protectedReason(file: string, item: { class?: unknown; sha256?: unknown }, pinnedNames: Set<string>): string | null {
  if (item.class === 'pinned') return 'pinned by the manifest (ops-owned)';
  if (typeof item.sha256 === 'string') return 'has a recorded sha pin';
  if (pinnedNames.has(file)) return 'listed in SHA256SUMS';
  for (const [pattern, why] of PROTECTED_NAME) if (pattern.test(file)) return why;
  return null;
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function readIfPresent(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function gitLastChange(repo: string, source: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', repo, 'log', '-1', '--format=%cI', '--', source], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch { return null; }
}

/** The fleet runtime directory: ASHLR_RUNS_BIN, else ~/.ashlr-runs/bin (the manifest's runs-bin root). */
export const defaultRuntimeDir = (): string => resolve(process.env.ASHLR_RUNS_BIN || resolve(homedir(), '.ashlr-runs/bin'));

/** The checkout that owns fleet/manifest.json: the working directory or its parents, else the one this code ships in. */
export async function findFleetRepo(from = process.cwd()): Promise<string | null> {
  const starts = [from, dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      if (await access(resolve(dir, 'fleet/manifest.json')).then(() => true, () => false)) return dir;
      if (dirname(dir) === dir) break;
    }
  }
  return null;
}

/** Read-only: hash every runs-bin file phantom owns against the installed copy. Writes nothing. */
export async function fleetDrift(repo: string, runtimeDir: string, deps: DriftDeps = {}): Promise<DriftReport> {
  const [items, pinnedNames] = await Promise.all([readManifestFiles(repo), readPinnedNames(resolve(runtimeDir, 'SHA256SUMS'))]);
  const lastChange = deps.lastChange ?? gitLastChange;
  const root = resolve(repo);
  const files: DriftFile[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || item.root !== 'runs-bin') continue;
    const source = typeof item.src === 'string' ? item.src : null;
    const file = typeof item.name === 'string' ? item.name : source ? basename(source) : '';
    if (!file || basename(file) !== file || (source !== null && !resolve(root, source).startsWith(root + '/'))) throw new Error('Invalid fleet manifest path');
    const sourceData = source ? await readFile(resolve(root, source)) : null;
    const livePath = resolve(runtimeDir, file);
    const liveData = await readIfPresent(livePath);
    const sourceSha256 = sourceData ? sha(sourceData) : null;
    const liveSha256 = liveData ? sha(liveData) : null;
    const repoChangedAt = source ? await lastChange(root, source) : null;
    let state: DriftState;
    if (liveData === null) state = 'missing';
    else if (sourceSha256 === null) state = 'live_only';
    else if (sourceSha256 === liveSha256) state = 'same';
    else {
      // A differing live file edited after the newest repo change carries work the repo lacks.
      const liveMtime = (await stat(livePath)).mtimeMs;
      state = repoChangedAt && liveMtime > Date.parse(repoChangedAt) ? 'live_only' : 'repo_newer';
    }
    files.push({ file, source, state, protectedReason: protectedReason(file, item, pinnedNames), sourceSha256, liveSha256, repoChangedAt });
  }
  const counts: Record<DriftState, number> = { same: 0, repo_newer: 0, live_only: 0, missing: 0 };
  for (const f of files) counts[f.state]++;
  return {
    schema: 'fleet.drift.v1', readOnly: true, asOf: (deps.now?.() ?? new Date()).toISOString(),
    repo: root, runtimeDir: resolve(runtimeDir), files, counts, notLive: files.length - counts.same,
  };
}

/** One digest line naming merged fleet files that are not live yet; null when everything is live or the check cannot run. */
export function notLiveLine(report: DriftReport): string | null {
  const stale = report.files.filter(f => (f.state === 'repo_newer' || f.state === 'missing') && f.source);
  if (stale.length === 0) return null;
  const names = stale.slice(0, 3).map(f => f.file).join(', ');
  return `Not live yet: ${stale.length} merged fleet file${stale.length === 1 ? '' : 's'} (${names}${stale.length > 3 ? ', …' : ''}). Run phm fleet drift.`;
}
