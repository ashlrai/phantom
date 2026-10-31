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
  bytes: number | null;
  truncated: boolean;
  text: string;
}

/** Read only the two whitelisted artifacts, bounded and without following symlinks. */
export async function getFleetJobText(job: string, kind: 'notes' | 'prompt', options: {
  runsDir?: string; maxBytes?: number;
} = {}): Promise<FleetJobTextV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  if (kind !== 'notes' && kind !== 'prompt') throw new Error('invalid fleet job text kind');
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const requested = options.maxBytes ?? 65536;
  const maxBytes = Number.isSafeInteger(requested) && requested >= 0 ? requested : 65536;
  const result: FleetJobTextV1 = { v: 1, job, kind, state: 'unreadable', bytes: null, truncated: false, text: '' };
  try {
    const path = join(runsDir, `${job}.${kind === 'notes' ? 'notes.md' : 'prompt'}`);
    if (!(await lstat(path)).isFile()) return result;
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
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    result.state = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
    result.text = '';
  }
  return result;
}
