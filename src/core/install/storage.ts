import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class InstallError extends Error {}
export const fail = (message: string): never => { throw new InstallError(message); };
const forbidden = (path: string): boolean => path.split(sep).some(part => part.toLowerCase().startsWith('.codex'));

export async function projectDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  if (forbidden(absolute)) fail('Protected configuration directory refused.');
  const info = await lstat(absolute).catch(() => fail('Project directory must already exist.'));
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Project must be a regular directory.');
  const physical = await realpath(absolute);
  if (forbidden(physical)) fail('Protected configuration directory refused.');
  return physical;
}

/** Inspect every descendant before reading or replacing it; /tmp may itself be an OS alias. */
export async function guardPath(path: string, root: string): Promise<void> {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel.split(sep).some(p => p === '..') || forbidden(path)) fail('Unsafe install path.');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink !== 1) ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail('Unsafe install path.');
  }
}

export async function readText(path: string, root: string): Promise<string | null> {
  await guardPath(path, root);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) fail('Invalid or oversized install metadata.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) fail('Install metadata changed while reading.');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

export function objectFromJson(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('Invalid JSON configuration.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Configuration must be a JSON object.');
  return value as Record<string, unknown>;
}

/** Compare again immediately before replacement, preserving unrelated edits and a private backup. */
export async function replaceConfig(path: string, root: string, before: string | null, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.phm-install-${randomUUID()}.tmp`);
  try {
    await guardPath(path, root);
    if (await readText(path, root) !== before) fail('MCP configuration changed; retry installation.');
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (before !== null) await writeFile(`${path}.phm-${randomUUID()}.bak`, before, { flag: 'wx', mode: 0o600 });
    if (await readText(path, root) !== before) fail('MCP configuration changed; retry installation.');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
