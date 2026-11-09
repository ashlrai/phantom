/** Fleet actions are audited proposals only; this module never applies them. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { fsyncDirectory } from '../util/durability.js';

const VERBS = ['pause', 'resume', 'kill', 'reassign', 'set-slot', 'vision-edit'] as const;
function refuse(): never { throw new Error('invalid or unavailable fleet action intent'); }
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export function recordFleetAction(verb: string, dryRun: boolean, requestedPath?: string) {
  if (!VERBS.some((allowed) => allowed === verb) || dryRun !== true) refuse();
  const home = homedir();
  const queue = join(home, '.ashlr', 'router-queue');
  const leader = join(home, '.ashlr', 'vision', 'leader');
  const target = resolve(requestedPath ?? queue);
  if (![queue, leader].some((root) => within(root, target))) refuse();
  // Inspect each existing component from HOME. Missing descendants are allowed,
  // but symlinks (even ones pointing back inside the scope) are never targets.
  let cursor = home;
  for (const component of relative(home, target).split(sep)) {
    cursor = join(cursor, component);
    try { if (lstatSync(cursor).isSymbolicLink()) refuse(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // The operator must provision the queue; a job HOME cannot initialize it.
  if (!assurePrivateStoragePath(queue, 'directory', 'inspect-existing', { anchorPath: home }).ok) refuse();
  const lock = acquireLocalStoreLock(join(queue, '.actions.lock'), 2_000, { anchorPath: queue, exactPrivateStorage: true });
  if (!lock) refuse();
  try {
    const path = join(queue, 'actions.jsonl');
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 ||
        !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: home }).ok) refuse();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const intent = { v: 1, id: randomUUID(), at: new Date().toISOString(), verb, target, dryRun: true, status: 'intent' };
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) refuse();
      const bytes = Buffer.from(`${JSON.stringify(intent)}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) refuse();
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDirectory(queue);
    return intent;
  } finally { releaseLocalStoreLock(lock); }
}
