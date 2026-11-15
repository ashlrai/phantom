import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export type BinDiffState = 'in-sync' | 'drifted' | 'missing' | 'pinned';
export interface BinDiffEntry {
  file: string;
  source: string;
  status: BinDiffState;
  sourceSha256: string;
  liveSha256: string | null;
}

/** Compare manifest-backed source files without modifying either tree. */
export async function fleetBinDiff(repo: string, bin: string, pins: string) {
  const manifest: unknown = JSON.parse(await readFile(resolve(repo, 'fleet/manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('files' in manifest) || !Array.isArray(manifest.files)) throw new Error('Invalid fleet manifest');
  let pinText: string;
  try { pinText = await readFile(pins, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    pinText = '';
  }
  const pinned = new Set<string>();
  for (const line of pinText.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-fA-F0-9]{64})\s+[*]?([^\s]+)\s*$/.exec(line);
    if (!match) throw new Error('Invalid SHA256 pin file');
    pinned.add(basename(match[2]!));
  }
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const files: BinDiffEntry[] = [];
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || item.root !== 'runs-bin' || typeof item.src !== 'string') continue;
    const source = item.src;
    const file = item.name ?? basename(source);
    if (typeof file !== 'string' || basename(file) !== file || resolve(repo, source).startsWith(resolve(repo) + '/') === false) throw new Error('Invalid fleet manifest path');
    const sourceSha256 = hash(await readFile(resolve(repo, source)));
    let liveSha256: string | null;
    try { liveSha256 = hash(await readFile(resolve(bin, file))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      liveSha256 = null;
    }
    const status: BinDiffState = item.class === 'pinned' || typeof item.sha256 === 'string' || pinned.has(file) ? 'pinned'
      : liveSha256 === null ? 'missing' : liveSha256 === sourceSha256 ? 'in-sync' : 'drifted';
    files.push({ file, source, status, sourceSha256, liveSha256 });
  }
  const counts = { 'in-sync': 0, drifted: 0, missing: 0, pinned: 0 };
  for (const file of files) counts[file.status]++;
  return { schema: 'fleet.bin-diff.v1' as const, readOnly: true as const, pinsFile: pins, files, counts };
}
