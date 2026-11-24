/** Descriptor-bound tail read of the runs-dir dispatch event log. Read only. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dispatchEventsCandidates } from './dispatch-events-path.js';

const DISPATCH_EVENTS_TAIL = 8 * 1024 * 1024;

/** First readable candidate wins (queue first, root second); the logs are never merged. */
export async function readDispatchEventsLog(runsDir?: string): Promise<string | null> {
  for (const path of dispatchEventsCandidates(runsDir ?? join(homedir(), '.ashlr-runs'))) {
    const text = await readEventsTail(path);
    if (text !== undefined) return text;
  }
  return null;
}

/** Tail of one candidate; undefined when it is not a readable regular file (try the next). */
async function readEventsTail(path: string): Promise<string | null | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) return undefined;
      if (info.size <= 0) return null;
      const start = Math.max(0, info.size - DISPATCH_EVENTS_TAIL);
      const bytes = Buffer.alloc(Math.min(info.size, DISPATCH_EVENTS_TAIL));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const text = bytes.subarray(0, offset).toString('utf8');
      return start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text;
    } finally { await file.close(); }
  } catch { return undefined; }
}
