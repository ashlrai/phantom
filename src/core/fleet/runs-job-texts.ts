import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isFleetJobId } from './runs-job-detail.js';

export interface FleetJobTextV1 {
  v: 1;
  job: string;
  kind: 'notes' | 'prompt';
  state: 'ok' | 'missing' | 'unreadable';
  source: 'notes' | 'body' | null;
  bytes: number | null;
  truncated: boolean;
  text: string;
}

/** Read bounded, no-follow artifacts; notes fall back to the retained body only when absent. */
export async function getFleetJobText(job: string, kind: 'notes' | 'prompt', options: {
  runsDir?: string; maxBytes?: number;
} = {}): Promise<FleetJobTextV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  if (kind !== 'notes' && kind !== 'prompt') throw new Error('invalid fleet job text kind');
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const requested = options.maxBytes ?? 65536;
  const maxBytes = Number.isSafeInteger(requested) && requested >= 0 ? requested : 65536;
  const result: FleetJobTextV1 = { v: 1, job, kind, state: 'unreadable', source: null, bytes: null, truncated: false, text: '' };
  try {
    let path = join(runsDir, `${job}.${kind === 'notes' ? 'notes.md' : 'prompt'}`);
    let source: FleetJobTextV1['source'] = kind === 'notes' ? 'notes' : null;
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (kind !== 'notes' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      path = join(runsDir, `${job}.body.md`);
      source = 'body';
      info = await lstat(path);
    }
    if (!info.isFile()) return result;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return result;
      result.bytes = stat.size;
      result.truncated = stat.size > maxBytes;
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      result.text = buffer.toString('utf8', 0, bytesRead)
        .replace(/((?:token=|key=|Bearer ))[^\r\n]*/gi, '$1…')
        .replace(/[A-Za-z0-9_-]{40,}/g, '…');
      result.state = 'ok';
      result.source = source;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    result.state = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
    result.source = null;
    result.text = '';
  }
  return result;
}
