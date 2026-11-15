import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubPrivateText } from '../util/scrub.js';

export interface HandoffFile {
  folder: string;
  name: string;
  size: number;
  modifiedAt: string;
  preview: string;
}

// Read complete, bounded files before redaction: cutting a token at a byte
// boundary before scrubbing could expose a secret-shaped prefix.
const MAX_BYTES = 256 * 1024;
const MAX_PER_FOLDER = 200;
const FOLDER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

async function readBounded(path: string, failed: () => void): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) return null;
    return buffer.subarray(0, used).toString('utf8');
  } catch { failed(); return null; } finally { await file?.close().catch(failed); }
}

async function folderFiles(handoff: string, folder: string, failed: () => void, readDir: typeof readdir): Promise<HandoffFile[]> {
  const dir = join(handoff, folder);
  let picked: { name: string; stat: Stats }[];
  try {
    const entries = await readDir(dir, { withFileTypes: true });
    picked = (await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !entry.name.endsWith('.md')) return null;
      try {
        const stat = await lstat(join(dir, entry.name));
        return stat.isFile() && stat.size <= MAX_BYTES ? { name: entry.name, stat } : null;
      } catch { failed(); return null; }
    }))).filter((row): row is { name: string; stat: Stats } => row !== null)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name))
      .slice(0, MAX_PER_FOLDER);
  } catch { failed(); return []; }
  const rows = await Promise.all(picked.map(async ({ name, stat }) => {
    const content = await readBounded(join(dir, name), failed);
    if (content === null) return null;
    return { folder: scrubPrivateText(folder), name: scrubPrivateText(name), size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      preview: scrubPrivateText(content).replace(/\s+/g, ' ').trim().slice(0, 240) };
  }));
  return rows.filter((row): row is HandoffFile => row !== null);
}

export interface HandoffReadResult {
  handoffs: HandoffFile[];
  state: 'complete' | 'absent' | 'unavailable' | 'partial';
}

export async function readHandoffFiles(
  root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'),
  readDir: typeof readdir = readdir,
): Promise<HandoffReadResult> {
  const handoff = join(root, 'handoff');
  let failure = false;
  const failed = (): void => { failure = true; };
  let names: string[];
  try {
    names = await readDir(handoff);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { handoffs: [], state: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unavailable' };
  }
  const folders = (await Promise.all(names.map(async name => {
    if (!FOLDER_NAME.test(name)) return null;
    try {
      return (await lstat(join(handoff, name))).isDirectory() ? name : null;
    } catch { failed(); return null; }
  }))).filter((name): name is string => name !== null);
  const rows = await Promise.all(folders.map(folder => folderFiles(handoff, folder, failed, readDir)));
  const handoffs = rows.flat().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)
    || a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  return { handoffs, state: failure ? (handoffs.length ? 'partial' : 'unavailable') : 'complete' };
}

export async function listHandoffFiles(root?: string): Promise<HandoffFile[]> {
  return (await readHandoffFiles(root)).handoffs;
}
