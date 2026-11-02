/**
 * One JSON document per forum root. Writes are atomic and serialized in
 * this process. The file holds posts, never keys.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FORUM_CHANNELS, FORUM_OWNER, type ForumState } from './types.js';

const FILE = 'forum.json';
const chains = new Map<string, Promise<unknown>>();

export function emptyState(now: string): ForumState {
  return {
    v: 1,
    channels: FORUM_CHANNELS.map((channel) => ({ ...channel, createdAt: now })),
    threads: [],
    posts: [],
    invites: [],
    principals: [{ principal: FORUM_OWNER, humanId: FORUM_OWNER }],
    bridges: [],
    wakes: [],
    postTimes: [],
    lastStandupAt: null,
  };
}

export function withForumLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(root) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  chains.set(root, run.then(() => undefined, () => undefined));
  return run;
}

export async function readState(root: string, now: string): Promise<{ ok: true; state: ForumState; stored: boolean } | { ok: false; reason: 'unavailable' }> {
  try {
    const raw = await readFile(join(root, FILE), 'utf8');
    const parsed = JSON.parse(raw) as ForumState;
    if (parsed?.v !== 1 || !Array.isArray(parsed.posts) || !Array.isArray(parsed.channels)) return { ok: false, reason: 'unavailable' };
    return { ok: true, state: parsed, stored: true };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : '';
    if (code === 'ENOENT') return { ok: true, state: emptyState(now), stored: false };
    return { ok: false, reason: 'unavailable' };
  }
}

export async function writeState(root: string, state: ForumState): Promise<{ ok: true } | { ok: false; reason: 'unavailable' }> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, FILE);
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temp, path);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
